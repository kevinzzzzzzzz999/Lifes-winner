import Foundation
import UIKit
import WebKit
import PDFKit

/// Offline reading renditions, not an Office editor or a guarantee of Word's
/// original pagination. Uses public WebKit/UIKit printing APIs, never snapshots.
/// Apple: developer.apple.com/documentation/uikit/uiprintpagerenderer
/// Apple: developer.apple.com/documentation/uikit/uiprintformatter
@MainActor
enum OfficeDocumentRenderer {
    static func render(sourceURL: URL) async throws -> Data {
        let job = OfficeRenderJob(sourceURL: sourceURL)
        return try await withTaskCancellationHandler {
            try await job.run()
        } onCancel: {
            Task { @MainActor in job.cancel() }
        }
    }
}

enum OfficeRenderError: LocalizedError {
    case unsupported, unreadable, noWindow, timeout, incomplete, tooLarge, invalidSlides
    var errorDescription: String? {
        switch self {
        case .unsupported: String(localized: "此文件暂不能生成 Office 阅读版。请导出 PDF 后重试。")
        case .unreadable: String(localized: "无法完整读取 Office 文件；请确认文件未加密且可正常打开。")
        case .noWindow: String(localized: "请保持应用在前台，再生成 Office 阅读版。")
        case .timeout: String(localized: "文档排版超时，原文件保持不变；可导出 PDF 后再展开。")
        case .incomplete: String(localized: "未能完整生成文档页面，已停止添加；请导出 PDF 后重试。")
        case .tooLarge: String(localized: "文档超过本次阅读版处理范围，请拆分文件或导出 PDF。")
        case .invalidSlides: String(localized: "系统未提供完整的幻灯片页面，已停止展开；请从 PowerPoint 或 Keynote 导出 PDF。")
        }
    }
}

@MainActor
private final class OfficeRenderJob: NSObject, WKNavigationDelegate {
    let sourceURL: URL
    private var web: WKWebView?
    private var navigation: CheckedContinuation<Void, Error>?
    private var deadlineTask: Task<Void, Never>?
    private var cancelled = false
    private var expired = false
    private let deadline = Date().addingTimeInterval(180)
    private let maximumPages = 2_000

    init(sourceURL: URL) { self.sourceURL = sourceURL }

    func cancel() {
        cancelled = true
        web?.stopLoading()
        navigation?.resume(throwing: CancellationError()); navigation = nil
    }
    private func check() throws {
        if cancelled || Task.isCancelled { throw CancellationError() }
        if expired || Date() > deadline { throw OfficeRenderError.timeout }
    }
    func run() async throws -> Data {
        defer {
            deadlineTask?.cancel()
            web?.navigationDelegate = nil; web?.stopLoading(); web?.removeFromSuperview()
            web = nil
        }
        try check()
        let ext = sourceURL.pathExtension.lowercased()
        guard ["doc", "docx", "ppt", "pptx"].contains(ext), sourceURL.isFileURL else { throw OfficeRenderError.unsupported }
        let attributes = try sourceURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard attributes.isRegularFile == true else { throw OfficeRenderError.unreadable }
        guard (attributes.fileSize ?? 0) > 0, (attributes.fileSize ?? 0) <= 256 * 1024 * 1024 else { throw OfficeRenderError.tooLarge }
        let handle = try FileHandle(forReadingFrom: sourceURL)
        let header = try handle.read(upToCount: 8) ?? Data(); try handle.close()
        let zipped = header.starts(with: [0x50, 0x4b, 0x03, 0x04])
        let compound = header.starts(with: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
        guard ext.hasSuffix("x") ? zipped : compound else { throw OfficeRenderError.unreadable }
        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive })
            .flatMap(\.windows).first(where: { $0.isKeyWindow }) else { throw OfficeRenderError.noWindow }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // A file may refer to external images. This offline renderer does not
        // fetch any HTTP(S) resource or use the user's browsing cookies.
        guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "InkSpace.OfficeReading.Offline.v1",
            encodedContentRuleList: #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#) else { throw OfficeRenderError.incomplete }
        try check()
        configuration.userContentController.add(rules)
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1024, height: 1366), configuration: configuration)
        view.isUserInteractionEnabled = false
        view.navigationDelegate = self
        // Retain a real window association for WebKit's print process. Inserting
        // underneath the app content avoids presenting another editing surface.
        window.insertSubview(view, at: 0)
        web = view
        deadlineTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(180)) } catch { return }
            guard let self else { return }
            self.expired = true; self.web?.stopLoading()
            self.navigation?.resume(throwing: OfficeRenderError.timeout); self.navigation = nil
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            navigation = continuation
            view.loadFileURL(sourceURL, allowingReadAccessTo: sourceURL.deletingLastPathComponent())
        }
        try check()
        // Wait for the complete generated HTML and its local images; avoid a
        // first-screen capture or a fixed one-shot delay as the success signal.
        var stable = 0
        var previous = ""
        for _ in 0..<120 {
            try check()
            let state = try await view.evaluateJavaScript(#"JSON.stringify({ready:document.readyState,fonts:document.fonts?document.fonts.status:'loaded',pending:[...document.images].filter(i=>!i.complete).length,broken:[...document.images].filter(i=>i.complete&&i.naturalWidth===0).length,slides:document.querySelectorAll('div.slide').length,height:document.body?document.body.scrollHeight:0})"#) as? String ?? ""
            guard let data = state.data(using: .utf8), let values = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw OfficeRenderError.incomplete }
            if values["ready"] as? String == "complete", values["fonts"] as? String == "loaded",
               values["pending"] as? Int == 0, (values["height"] as? Double ?? 0) > 0 {
                if values["broken"] as? Int != 0 { throw OfficeRenderError.incomplete }
                stable = state == previous ? stable + 1 : 0
                if stable >= 3 { break }
            } else { stable = 0 }
            previous = state
            try await Task.sleep(for: .milliseconds(250))
        }
        guard stable >= 3 else { throw OfficeRenderError.incomplete }
        let isPresentation = ext == "ppt" || ext == "pptx"
        var paper = CGSize(width: 595.28, height: 841.89)
        var expectedSlides: Int?
        if isPresentation {
            let value = try await view.evaluateJavaScript(Self.prepareSlides) as? [String: Any]
            guard let count = value?["count"] as? Int, count > 0, count <= maximumPages,
                  let width = value?["width"] as? Double, let height = value?["height"] as? Double,
                  width.isFinite, height.isFinite, (72...20_000).contains(width), (72...20_000).contains(height),
                  value?["uniform"] as? Bool == true else { throw OfficeRenderError.invalidSlides }
            paper = CGSize(width: width, height: height); expectedSlides = count
        } else {
            guard try await view.evaluateJavaScript(Self.prepareWord) as? Bool == true else { throw OfficeRenderError.incomplete }
        }
        try await Task.sleep(for: .milliseconds(250))
        try check()
        let renderer = OfficePaperRenderer(paper)
        let formatter = view.viewPrintFormatter(); formatter.perPageContentInsets = .zero
        renderer.addPrintFormatter(formatter, startingAtPageAt: 0)
        let count = renderer.numberOfPages
        guard count > 0, count <= maximumPages else { throw OfficeRenderError.tooLarge }
        if let expectedSlides, count != expectedSlides { throw OfficeRenderError.invalidSlides }
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: count))
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData) else { throw OfficeRenderError.incomplete }
        var box = renderer.paperRect
        guard let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { throw OfficeRenderError.incomplete }
        for index in 0..<count {
            try check()
            context.beginPDFPage(nil)
            context.saveGState()
            context.translateBy(x: 0, y: paper.height); context.scaleBy(x: 1, y: -1)
            UIGraphicsPushContext(context)
            renderer.drawPage(at: index, in: renderer.paperRect)
            UIGraphicsPopContext()
            context.restoreGState(); context.endPDFPage()
            guard data.length <= 256 * 1024 * 1024 else { context.closePDF(); throw OfficeRenderError.tooLarge }
            // The PDF context is explicit and is not on UIKit's context stack
            // while yielding, so another main-actor drawing task cannot alter it.
            await Task.yield()
        }
        context.closePDF()
        try check()
        let result = data as Data
        guard let checkPDF = PDFDocument(data: result), checkPDF.pageCount == count,
              (0..<count).allSatisfy({ index in
                  guard let page = checkPDF.page(at: index) else { return false }
                  let rect = page.bounds(for: .mediaBox)
                  return abs(rect.width - paper.width) < 0.1 && abs(rect.height - paper.height) < 0.1
              }) else { throw OfficeRenderError.incomplete }
        return result
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.navigation?.resume(); self.navigation = nil
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.navigation?.resume(throwing: error); self.navigation = nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.navigation?.resume(throwing: error); self.navigation = nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              ["file", "about", "data", "blob", "applewebdata", "x-apple-ql-id"].contains(url.scheme?.lowercased() ?? "") else {
            decisionHandler(.cancel); return
        }
        if url.isFileURL {
            let allowed = sourceURL.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath().pathComponents
            let requested = url.standardizedFileURL.resolvingSymlinksInPath().pathComponents
            guard requested.count > allowed.count, Array(requested.prefix(allowed.count)) == allowed else {
                decisionHandler(.cancel); return
            }
        }
        // loadFileURL's explicit read-access directory also bounds subresource
        // and script file reads; no universal file access preference is enabled.
        decisionHandler(.allow)
    }

    private static let prepareWord = #"""
    (() => {
      const text = () => document.body.innerText.replace(/\s/g, '');
      const before = text();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while(walker.nextNode()) {
        const node = walker.currentNode;
        if (!['SCRIPT','STYLE'].includes(node.parentElement?.tagName) && node.textContent.includes('\f')) nodes.push(node);
      }
      for (const node of nodes) {
        const fragment = document.createDocumentFragment();
        node.textContent.split('\f').forEach((part,index) => {
          if(index) { const page = document.createElement('div'); page.style.cssText='break-before:page;page-break-before:always;height:0;'; fragment.append(page); }
          fragment.append(document.createTextNode(part));
        });
        node.replaceWith(fragment);
      }
      return before.length > 0 && before === text();
    })()
    """#
    private static let prepareSlides = #"""
    (() => {
      const slides = [...document.querySelectorAll('div.slide')];
      if(!slides.length) return {};
      const width = slides[0].offsetWidth, height = slides[0].offsetHeight;
      const uniform = slides.every(s => Math.abs(s.offsetWidth-width)<0.5 && Math.abs(s.offsetHeight-height)<0.5);
      const style = document.createElement('style');
      style.textContent='@media print {html,body {margin:0!important;padding:0!important;} div.loading-slide{display:none!important;} div.slide{margin:0!important;break-inside:avoid!important;page-break-inside:avoid!important;}}';
      document.head.append(style);
      slides.forEach((s,i) => {s.style.breakAfter=i===slides.length-1?'auto':'page';s.style.pageBreakAfter=i===slides.length-1?'auto':'always';});
      return {count:slides.length,width,height,uniform};
    })()
    """#
}

@MainActor
private final class OfficePaperRenderer: UIPrintPageRenderer {
    let bounds: CGRect
    init(_ size: CGSize) { bounds = CGRect(origin: .zero, size: size); super.init() }
    override var paperRect: CGRect { bounds }
    override var printableRect: CGRect { bounds }
}

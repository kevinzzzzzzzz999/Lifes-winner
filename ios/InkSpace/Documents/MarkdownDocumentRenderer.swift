import Foundation
import UIKit
import WebKit
import PDFKit

/// Private offscreen web content only receives escaped text and bounded data images.
/// It never receives vault read access and is torn down on success, timeout or cancellation.
@MainActor
final class MarkdownDocumentRenderer: NSObject, WKNavigationDelegate {
    private let bundle: Bundle
    private var webView: WKWebView?
    private var resourceURL: URL?
    private var snapshot: MarkdownDocumentSnapshot?
    private var assetLoader: (([MarkdownReference]) async throws -> MarkdownAssets)?
    private var continuation: CheckedContinuation<MarkdownPDFResult, Error>?
    private var timeout: Task<Void, Never>?
    private var worker: Task<Void, Never>?
    private var finished = false
    private var startDate = Date()

    init(bundle: Bundle = .main) { self.bundle = bundle; super.init() }

    func render(snapshot: MarkdownDocumentSnapshot,
                assets: @escaping ([MarkdownReference]) async throws -> MarkdownAssets) async throws -> MarkdownPDFResult {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard self.continuation == nil, !finished else {
                    continuation.resume(throwing: MarkdownDocumentError.renderingFailed); return
                }
                self.continuation = continuation
                self.snapshot = snapshot
                assetLoader = assets
                startDate = Date()
                timeout = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    guard !Task.isCancelled else { return }
                    self?.finish(.failure(MarkdownDocumentError.timedOut))
                }
                resourceURL = bundle.url(forResource: "index", withExtension: "html", subdirectory: "Markdown")
                    ?? bundle.url(forResource: "index", withExtension: "html", subdirectory: "Resources/Markdown")
                guard let resourceURL else { finish(.failure(MarkdownDocumentError.resourcesMissing)); return }
                let configuration = WKWebViewConfiguration()
                configuration.websiteDataStore = .nonPersistent()
                configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
                let view = WKWebView(frame: CGRect(x: 0, y: 0, width: MarkdownPrintRenderer.contentWidth, height: 768), configuration: configuration)
                view.isOpaque = true
                view.backgroundColor = .white
                view.scrollView.isScrollEnabled = false
                view.navigationDelegate = self
                webView = view
                view.loadFileURL(resourceURL, allowingReadAccessTo: resourceURL.deletingLastPathComponent().deletingLastPathComponent())
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard worker == nil, !finished, let snapshot, let assetLoader else { return }
        worker = Task { [weak self, weak webView] in
            guard let self, let webView else { return }
            do {
                let raw = try await webView.callAsyncJavaScript("return window.inkMarkdownReferences(text);",
                    arguments: ["text": snapshot.text], in: nil, contentWorld: .page)
                guard let dictionaries = raw as? [[String: Any]], dictionaries.count <= 4_096 else {
                    throw MarkdownDocumentError.renderingFailed
                }
                let references = try dictionaries.map { value -> MarkdownReference in
                    guard let key = value["key"] as? String, let href = value["href"] as? String,
                          let isImage = value["isImage"] as? Bool, let isWiki = value["isWiki"] as? Bool else {
                        throw MarkdownDocumentError.renderingFailed
                    }
                    return MarkdownReference(key: key, href: href, isImage: isImage, isWiki: isWiki)
                }
                let prepared = try await assetLoader(references)
                try Task.checkCancellation()
                guard !self.finished else { return }
                let rawLayout = try await webView.callAsyncJavaScript("return await window.inkMarkdownRender(text, prepared);",
                    arguments: ["text": snapshot.text, "prepared": ["images": prepared.images, "links": prepared.links,
                        "labels": ["missingImage": String(localized: "图片未加载：")]]],
                    in: nil, contentWorld: .page)
                guard let layout = rawLayout as? [String: Any], let height = layout["height"] as? Double,
                      height.isFinite, height >= 0, height <= 2_000 * 850 else { throw MarkdownDocumentError.tooManyPages }
                try Task.checkCancellation()
                guard !self.finished else { return }
                let result = try await self.capture(webView: webView, assets: prepared)
                self.finish(.success(result))
            } catch { self.finish(.failure(error)) }
        }
    }

    private func capture(webView: WKWebView, assets: MarkdownAssets) async throws -> MarkdownPDFResult {
        let printer = MarkdownPrintRenderer()
        printer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        let bodyPageCount = max(1, printer.numberOfPages)
        // UIKit's web print formatter drops HTML hyperlink annotations. An explicit
        // link directory preserves every safe target as a standard PDF link.
        let links = assets.links.sorted { $0.key < $1.key }
        let linksPerPage = 12
        let linkPageCount = (links.count + linksPerPage - 1) / linksPerPage
        let pageCount = bodyPageCount + linkPageCount
        guard pageCount <= 2_000 else { throw MarkdownDocumentError.tooManyPages }
        printer.prepare(forDrawingPages: NSRange(location: 0, length: bodyPageCount))
        let output = CFDataCreateMutable(nil, 0)!
        guard let consumer = CGDataConsumer(data: output) else { throw MarkdownDocumentError.renderingFailed }
        var paper = printer.paperRect
        guard let context = CGContext(consumer: consumer, mediaBox: &paper,
                                      [kCGPDFContextCreator: "人生赢家 Markdown 离线排版"] as CFDictionary) else {
            throw MarkdownDocumentError.renderingFailed
        }
        var closed = false
        defer { if !closed { context.closePDF() } }
        var annotations: [(Int, CGRect, URL)] = []
        for page in 0..<pageCount {
            try Task.checkCancellation()
            guard !finished, Date().timeIntervalSince(startDate) <= 30 else { throw MarkdownDocumentError.timedOut }
            context.beginPDFPage(nil)
            context.saveGState()
            context.translateBy(x: 0, y: paper.height)
            context.scaleBy(x: 1, y: -1)
            UIGraphicsPushContext(context)
            if page < bodyPageCount {
                printer.drawPage(at: page, in: paper)
            } else {
                let title = String(localized: "文中链接")
                (title as NSString).draw(at: CGPoint(x: 36, y: 36), withAttributes: [
                    .font: UIFont.boldSystemFont(ofSize: 23), .foregroundColor: UIColor.label])
                (String(localized: "轻点以下链接，可打开网页或 Obsidian 中的原文。") as NSString)
                    .draw(at: CGPoint(x: 36, y: 70), withAttributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: UIColor.darkGray])
                let first = (page - bodyPageCount) * linksPerPage
                for (row, index) in (first..<min(links.count, first + linksPerPage)).enumerated() {
                    let link = links[index]
                    let rowRect = CGRect(x: 36, y: 105 + CGFloat(row) * 53, width: paper.width - 72, height: 46)
                    let paragraph = NSMutableParagraphStyle()
                    paragraph.lineBreakMode = .byTruncatingMiddle
                    let label = String(link.key.dropFirst(link.key.hasPrefix("wiki:") ? 5 : 3))
                    ("\(index + 1). \(label)" as NSString).draw(in: rowRect, withAttributes: [
                        .font: UIFont.systemFont(ofSize: 13), .foregroundColor: UIColor.systemBlue,
                        .paragraphStyle: paragraph])
                    if let url = URL(string: link.value) {
                        annotations.append((page, CGRect(x: rowRect.minX, y: paper.height - rowRect.maxY,
                                                          width: rowRect.width, height: rowRect.height), url))
                    }
                }
            }
            UIGraphicsPopContext()
            context.restoreGState()
            context.endPDFPage()
            guard CFDataGetLength(output) <= 128 * 1_024 * 1_024 else { throw MarkdownDocumentError.tooLarge }
            // No UIKit graphics context remains on the stack across suspension.
            // UI cancellation and the deadline can run between expensive pages.
            await Task.yield()
        }
        context.closePDF(); closed = true
        try Task.checkCancellation()
        guard !finished, CFDataGetLength(output) <= 128 * 1_024 * 1_024,
              let document = PDFDocument(data: output as Data), document.pageCount == pageCount else {
            throw MarkdownDocumentError.renderingFailed
        }
        if let snapshot, snapshot.text.contains(where: { !$0.isWhitespace }),
           (document.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           assets.images.isEmpty { throw MarkdownDocumentError.renderingFailed }
        for (page, rect, url) in annotations {
            let annotation = PDFAnnotation(bounds: rect, forType: .link, withProperties: nil)
            annotation.action = PDFActionURL(url: url)
            let border = PDFBorder(); border.lineWidth = 0
            annotation.border = border
            document.page(at: page)?.addAnnotation(annotation)
        }
        let data: Data
        if annotations.isEmpty { data = output as Data }
        else {
            guard let annotated = document.dataRepresentation(), annotated.count <= 128 * 1_024 * 1_024,
                  let verified = PDFDocument(data: annotated), verified.pageCount == pageCount else {
                throw MarkdownDocumentError.renderingFailed
            }
            let actualLinks = (0..<pageCount).flatMap { verified.page(at: $0)?.annotations ?? [] }
                .compactMap { ($0.action as? PDFActionURL)?.url?.absoluteString }
            guard actualLinks.sorted() == annotations.map({ $0.2.absoluteString }).sorted() else {
                throw MarkdownDocumentError.renderingFailed
            }
            data = annotated
        }
        return MarkdownPDFResult(data: data, pageCount: pageCount, dependencyDigests: assets.dependencyDigests,
                                 rendererVersion: MarkdownDocumentService.rendererVersion, warnings: assets.warnings)
    }

    private func finish(_ result: Result<MarkdownPDFResult, Error>) {
        guard !finished else { return }
        finished = true
        timeout?.cancel(); timeout = nil
        worker?.cancel(); worker = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView = nil
        assetLoader = nil
        snapshot = nil
        let completion = continuation
        continuation = nil
        completion?.resume(with: result)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(.failure(MarkdownDocumentError.renderingFailed)) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // No links are activated during conversion, including external pages and vault files.
        decisionHandler(navigationAction.request.url?.standardizedFileURL == resourceURL?.standardizedFileURL ? .allow : .cancel)
    }
}

private final class MarkdownPrintRenderer: UIPrintPageRenderer {
    static let contentWidth: CGFloat = 595.28 - 72
    override var paperRect: CGRect { CGRect(x: 0, y: 0, width: 595.28, height: 841.89) }
    override var printableRect: CGRect { paperRect.insetBy(dx: 36, dy: 36) }
}

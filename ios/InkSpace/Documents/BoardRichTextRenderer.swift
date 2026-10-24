import Foundation
import UIKit
import WebKit
import PDFKit

extension BoardItem {
    var usesRichTextRendering: Bool {
        guard kind == .text || kind == .formula else { return false }
        if resolvedBoxTextFormat == "markdown" { return true }
        return resolvedBoxTextFormat == "richText" && (richTextHTML?.isEmpty == false || (text ?? "").contains("\\(") || (text ?? "").contains("\\[") || (text ?? "").contains("$"))
    }
}

struct BoardRichTextValue: Equatable {
    let html: String
    let text: String
    init(_ value: Any) throws {
        guard let object = value as? [String: Any], let html = object["html"] as? String,
              let text = object["text"] as? String, html.utf16.count <= 300_000,
              text.utf16.count <= 100_000, !html.contains("\0"), !text.contains("\0") else { throw BoardRichTextError.invalid }
        self.html = html; self.text = text
    }
}

enum BoardRichTextError: LocalizedError {
    case unavailable, invalid, timeout
    var errorDescription: String? {
        switch self {
        case .unavailable: String(localized: "表格预览暂不可用，原内容已保留。")
        case .invalid: String(localized: "内容过大或格式无效，未替换原内容。")
        case .timeout: String(localized: "表格排版超时，请重试；原内容已保留。")
        }
    }
}

/// Offline, nonpersistent page with no network or vault access. Both canvas and
/// editor use the same bounded sanitizer and math rules as the desktop app.
@MainActor final class BoardRichTextPage: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private let resourceURL: URL?
    private var loaded = false
    private var failure: Error?
    private var readyReply: ((Result<Void, Error>) -> Void)?
    private var scriptReply: ((Result<Any, Error>) -> Void)?
    private var deadline: Task<Void, Never>?
    private var closed = false
    init(bundle: Bundle = .main) {
        resourceURL = bundle.url(forResource: "index", withExtension: "html", subdirectory: "Math/RichText")
            ?? bundle.url(forResource: "index", withExtension: "html", subdirectory: "Resources/Math/RichText")
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        super.init(); webView.navigationDelegate = self
        webView.isOpaque = true; webView.backgroundColor = .white
        if let resourceURL { webView.loadFileURL(resourceURL, allowingReadAccessTo: resourceURL.deletingLastPathComponent().deletingLastPathComponent()) }
        else { failure = BoardRichTextError.unavailable }
    }
    func close() {
        closed = true; currentCall = nil; deadline?.cancel(); deadline = nil; webView.stopLoading(); webView.navigationDelegate = nil
        readyReply?(.failure(CancellationError())); readyReply = nil
        scriptReply?(.failure(CancellationError())); scriptReply = nil
    }
    private func ready() async throws {
        if closed { throw CancellationError() }; if let failure { throw failure }; if loaded { return }
        guard readyReply == nil else { throw BoardRichTextError.unavailable }
        try await withCheckedThrowingContinuation { continuation in
            readyReply = { continuation.resume(with: $0) }
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(12)); guard !Task.isCancelled else { return }
                self?.finishLoad(.failure(BoardRichTextError.timeout))
            }
        }
    }
    private func finishLoad(_ result: Result<Void, Error>) {
        deadline?.cancel(); deadline = nil
        switch result { case .success: loaded = true; case .failure(let error): failure = error }
        let reply = readyReply; readyReply = nil; reply?(result)
    }
    func call(_ code: String, arguments: [String: Any] = [:]) async throws -> Any {
        try await ready(); try Task.checkCancellation()
        guard !closed, scriptReply == nil else { throw BoardRichTextError.unavailable }
        return try await withCheckedThrowingContinuation { continuation in
            let token = UUID(); currentCall = token
            scriptReply = { continuation.resume(with: $0) }
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(12)); guard !Task.isCancelled else { return }
                self?.finishScript(.failure(BoardRichTextError.timeout), token: token)
            }
            webView.callAsyncJavaScript(code, arguments: arguments, in: nil, in: .page) { [weak self] result in self?.finishScript(result, token: token) }
        }
    }
    private var currentCall: UUID?
    private func finishScript(_ result: Result<Any, Error>, token: UUID) {
        guard currentCall == token else { return }; currentCall = nil
        deadline?.cancel(); deadline = nil; let reply = scriptReply; scriptReply = nil; reply?(result)
    }
    func pdf(configuration: WKPDFConfiguration) async throws -> Data {
        guard !closed, scriptReply == nil else { throw BoardRichTextError.unavailable }
        let value: Any = try await withCheckedThrowingContinuation { continuation in
            let token = UUID(); currentCall = token; scriptReply = { continuation.resume(with:$0) }
            deadline = Task { [weak self] in
                try? await Task.sleep(for:.seconds(12)); guard !Task.isCancelled else { return }
                self?.finishScript(.failure(BoardRichTextError.timeout),token:token)
            }
            webView.createPDF(configuration:configuration) { [weak self] result in
                self?.finishScript(result.map { $0 as Any },token:token)
            }
        }
        guard let data = value as? Data else { throw BoardRichTextError.invalid }; return data
    }
    func load(item: BoardItem, editable: Bool, width: Double? = nil) async throws -> [String: Any] {
        let result = try await call("return await inkRich.load(format,text,html,width,font,color,background,editable);", arguments: [
            "format": item.resolvedBoxTextFormat, "text": item.text ?? "", "html": item.richTextHTML ?? "", "width": width ?? max(160,min(2048,item.width-24)),
            "font": item.style?.fontSize ?? 16, "color": item.style?.textColor ?? "#17232e", "background": item.style?.fillColor ?? "#FFFFFF", "editable": editable])
        guard let value = result as? [String: Any] else { throw BoardRichTextError.invalid }; return value
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finishLoad(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finishLoad(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finishLoad(.failure(error)) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finishLoad(.failure(BoardRichTextError.unavailable)); if let currentCall { finishScript(.failure(BoardRichTextError.unavailable), token: currentCall) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url == resourceURL ? .allow : .cancel)
    }
}

@MainActor enum BoardRichTextRenderer {
    private static var idlePages: [BoardRichTextPage] = []
    static func normalize(html: String, text: String) async throws -> BoardRichTextValue {
        let page = BoardRichTextPage(); defer { page.close() }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await BoardRichTextValue(page.call("return inkRich.normalize(html,text);", arguments: ["html":html,"text":text]))
        } onCancel: {
            Task { @MainActor in page.close() }
        }
    }
    private static let bitmapQueue = DispatchQueue(label:"InkSpace.rich-text-bitmap",qos:.userInitiated)
    private static func bitmap(data:Data,size:CGSize,pixelLength:Int) async throws -> UIImage {
        try await withCheckedThrowingContinuation { continuation in
            bitmapQueue.async {
                guard let pdf = PDFDocument(data:data),let first = pdf.page(at:0) else { continuation.resume(throwing:BoardRichTextError.unavailable);return }
                let factor = CGFloat(max(16,min(4096,pixelLength))) / max(size.width,size.height)
                let image = first.thumbnail(of:CGSize(width:max(1,size.width*factor),height:max(1,size.height*factor)),for:.mediaBox)
                continuation.resume(returning:image)
            }
        }
    }
    static func render(item: BoardItem, pixelLength: Int, token: BoardPreviewCancellation,
                       completion: @escaping (Result<BoardPreviewImage, Error>) -> Void) {
        let page = idlePages.popLast() ?? BoardRichTextPage()
        var reusable = false
        let task = Task { @MainActor in
            defer {
                if reusable && !token.isCancelled && idlePages.count < 2 { idlePages.append(page) }
                else { page.close() }
            }
            do {
                let value = try await page.load(item: item, editable: false)
                guard !token.isCancelled, let width = value["width"] as? Double, let height = value["height"] as? Double,
                      width > 0, height > 0, width <= 4096, height <= 8192, width*height <= 8_000_000 else { throw BoardRichTextError.invalid }
                let size = CGSize(width: width,height: height); page.webView.frame.size = size
                let config = WKPDFConfiguration(); config.rect = CGRect(origin: .zero,size: size)
                let data = try await page.pdf(configuration: config)
                try Task.checkCancellation();guard !token.isCancelled else { throw CancellationError() }
                let image = try await bitmap(data:data,size:size,pixelLength:pixelLength)
                try Task.checkCancellation();guard !token.isCancelled else { throw CancellationError() }
                reusable = true
                completion(.success(BoardPreviewImage(image:image,revision:"rich-text")))
            } catch { completion(.failure(error)) }
        }
        token.onCancel { task.cancel(); Task { @MainActor in if !reusable { page.close() } } }
    }
}

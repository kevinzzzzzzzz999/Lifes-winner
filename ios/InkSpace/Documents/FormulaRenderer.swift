import Foundation
import UIKit
import WebKit
import PDFKit

enum FormulaRenderingError: LocalizedError {
    case resourcesMissing, invalidFormula(String), outputUnavailable, timedOut

    var errorDescription: String? {
        switch self {
        case .resourcesMissing: return String(localized: "离线公式资源缺失。请确保 Math 文件夹已随 App 打包；公式原文仍会保留。")
        case .invalidFormula(let message): return String(localized: "公式无法排版：\(message)")
        case .outputUnavailable: return String(localized: "公式预览暂不可用，已保留 LaTeX 原文。")
        case .timedOut: return String(localized: "公式排版暂时超时，请刷新预览后重试。")
        }
    }
}

/// Offline KaTeX -> WKWebView PDF capture -> UIImage. No file is written to the vault.
/// The canvas must display its saved LaTeX while loading or if completion returns an error.
@MainActor
final class FormulaRenderer: NSObject, WKNavigationDelegate {
    private struct Job {
        let id = UUID()
        let latex: String
        let fontSize: Double
        let colorHex: String
        let backgroundHex: String
        let completion: (Result<UIImage, Error>) -> Void
        var key: String { "\(fontSize)|\(colorHex)|\(backgroundHex)|\(latex)" }
    }

    private var webView: WKWebView
    private let resourceURL: URL?
    private let images = NSCache<NSString, UIImage>()
    private var costs: [String: Int] = [:]
    private var lru: [String] = []
    private let memoryBudget = 16 * 1_024 * 1_024
    private var queue: [Job] = []
    private var currentJob: Job?
    private var isReady = false
    private var loadingError: Error?
    private var timeout: Task<Void, Never>?

    init(bundle: Bundle = .main) {
        resourceURL = bundle.url(forResource: "index", withExtension: "html", subdirectory: "Math")
            ?? bundle.url(forResource: "index", withExtension: "html", subdirectory: "Resources/Math")
        webView = Self.makeWebView()
        super.init()
        images.totalCostLimit = memoryBudget
        images.countLimit = 64
        webView.navigationDelegate = self
        if let resourceURL {
            webView.loadFileURL(resourceURL, allowingReadAccessTo: resourceURL.deletingLastPathComponent())
        } else {
            loadingError = FormulaRenderingError.resourcesMissing
        }
    }

    private static func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 2_048, height: 1_024), configuration: configuration)
        view.isOpaque = true
        view.backgroundColor = .white
        view.scrollView.isScrollEnabled = false
        return view
    }

    func render(latexText: String, fontSize: Double = 28, colorHex: String = "#17232e",
                backgroundHex: String = "#FFFFFF", completion: @escaping (Result<UIImage, Error>) -> Void) {
        if let loadingError { completion(.failure(loadingError)); return }
        guard !latexText.isEmpty, latexText.count <= 20_000, fontSize.isFinite else {
            completion(.failure(FormulaRenderingError.invalidFormula(String(localized: "内容为空、过长或字号无效。")))); return
        }
        let job = Job(latex: latexText, fontSize: fontSize, colorHex: colorHex, backgroundHex: backgroundHex, completion: completion)
        if let image = images.object(forKey: job.key as NSString) {
            lru.removeAll { $0 == job.key }
            lru.append(job.key)
            completion(.success(image)); return
        }
        queue.append(job)
        pump()
    }

    func image(latexText: String) async throws -> UIImage {
        try await withCheckedThrowingContinuation { continuation in
            render(latexText: latexText) { continuation.resume(with: $0) }
        }
    }

    func clearCache() {
        images.removeAllObjects()
        costs.removeAll()
        lru.removeAll()
        if loadingError != nil, let resourceURL {
            // Replace the failed page, including any unresolved JavaScript promises,
            // instead of carrying its state through a reload of the same view.
            webView.stopLoading()
            webView.navigationDelegate = nil
            webView = Self.makeWebView()
            webView.navigationDelegate = self
            loadingError = nil
            isReady = false
            webView.loadFileURL(resourceURL, allowingReadAccessTo: resourceURL.deletingLastPathComponent())
        }
    }

    private func pump() {
        guard isReady, currentJob == nil, !queue.isEmpty else { return }
        let job = queue.removeFirst()
        currentJob = job
        timeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard !Task.isCancelled, self?.currentJob?.id == job.id else { return }
            self?.failAll(FormulaRenderingError.timedOut)
        }
        webView.callAsyncJavaScript(
            "return await window.inkSpaceRender(latexText, fontSize, colorHex, backgroundHex);",
            arguments: ["latexText": job.latex, "fontSize": job.fontSize, "colorHex": job.colorHex, "backgroundHex": job.backgroundHex],
            in: nil, in: .page
        ) { [weak self] result in
            guard let self, self.currentJob?.id == job.id else { return }
            switch result {
            case .failure(let error): self.finish(.failure(error), id: job.id)
            case .success(let value):
                guard let info = value as? [String: Any] else {
                    self.finish(.failure(FormulaRenderingError.outputUnavailable), id: job.id); return
                }
                if let error = info["error"] as? String {
                    self.finish(.failure(FormulaRenderingError.invalidFormula(Self.localizedRendererError(error))), id: job.id); return
                }
                guard let width = info["width"] as? Double, let height = info["height"] as? Double,
                      width > 0, height > 0, width <= 4_096, height <= 4_096,
                      width * height <= 4_000_000 else {
                    self.finish(.failure(FormulaRenderingError.outputUnavailable), id: job.id); return
                }
                self.capture(size: CGSize(width: width, height: height), id: job.id)
            }
        }
    }

    private static func localizedRendererError(_ message: String) -> String {
        // Match the renderer's stable protocol messages without translating user LaTeX or unknown diagnostics.
        switch message {
        case "公式为空或超过 20,000 字符。": return String(localized: "公式为空或超过 20,000 字符。")
        case "公式字号应在 10–96 之间。": return String(localized: "公式字号应在 10–96 之间。")
        case "公式颜色无效。": return String(localized: "公式颜色无效。")
        case "公式过大，请拆分成多个公式卡片。": return String(localized: "公式过大，请拆分成多个公式卡片。")
        default: return message
        }
    }

    private func capture(size: CGSize, id: UUID) {
        webView.frame.size = size
        let configuration = WKPDFConfiguration()
        configuration.rect = CGRect(origin: .zero, size: size)
        // PDF capture does not depend on displaying this web view above the native canvas.
        webView.createPDF(configuration: configuration) { [weak self] result in
            guard let self, self.currentJob?.id == id else { return }
            switch result {
            case .failure(let error): self.finish(.failure(error), id: id)
            case .success(let data):
                guard let document = PDFDocument(data: data), let page = document.page(at: 0) else {
                    self.finish(.failure(FormulaRenderingError.outputUnavailable), id: id); return
                }
                let image = page.thumbnail(of: CGSize(width: size.width * 2, height: size.height * 2), for: .mediaBox)
                self.finish(.success(image), id: id)
            }
        }
    }

    private func finish(_ result: Result<UIImage, Error>, id: UUID) {
        guard let job = currentJob, job.id == id else { return }
        timeout?.cancel()
        timeout = nil
        if case .success(let image) = result {
            let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? Int(image.size.width * image.size.height * 4)
            costs.removeValue(forKey: job.key)
            lru.removeAll { $0 == job.key }
            while !lru.isEmpty && (lru.count >= 64 || costs.values.reduce(0, +) + cost > memoryBudget) {
                let old = lru.removeFirst()
                images.removeObject(forKey: old as NSString)
                costs.removeValue(forKey: old)
            }
            if cost <= memoryBudget {
                images.setObject(image, forKey: job.key as NSString, cost: cost)
                costs[job.key] = cost
                lru.append(job.key)
            }
        }
        currentJob = nil
        job.completion(result)
        pump()
    }

    private func failAll(_ error: Error) {
        timeout?.cancel()
        timeout = nil
        loadingError = error
        isReady = false
        let jobs = (currentJob.map { [$0] } ?? []) + queue
        currentJob = nil
        queue.removeAll()
        jobs.forEach { $0.completion(.failure(error)) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isReady = true
        loadingError = nil
        pump()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failAll(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failAll(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failAll(FormulaRenderingError.outputUnavailable) }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let resourceURL, let target = navigationAction.request.url,
              target.isFileURL, target.standardizedFileURL == resourceURL.standardizedFileURL else {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
}

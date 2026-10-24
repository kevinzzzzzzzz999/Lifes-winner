import Foundation
import Observation
import UIKit
import WebKit

/// Retained ordinary websites, one view per provider. Website cookies stay in
/// WebKit's local store; choosing a service never reads account or chat content.
@MainActor @Observable final class ChatGPTWebSession: NSObject, WKNavigationDelegate, WKUIDelegate {
    private(set) var provider: AIWebProvider
    private(set) var loading = false
    private(set) var errorMessage: String?
    let downloads = WebDownloadStore()
    @ObservationIgnored private(set) var webView: WKWebView?
    @ObservationIgnored private var views: [AIWebProvider: WKWebView] = [:]
    @ObservationIgnored private var loadingStates: [AIWebProvider: Bool] = [:]
    @ObservationIgnored private var errors: [AIWebProvider: String] = [:]
    @ObservationIgnored private var pasteGeneration = UUID()
    @ObservationIgnored private let startOverride: URL?
    @ObservationIgnored private let dataStore: WKWebsiteDataStore
    @ObservationIgnored private let testOrigin: URL?

    init(provider: AIWebProvider? = nil, startURL: URL? = nil,
         dataStore: WKWebsiteDataStore? = nil, testingOrigin: URL? = nil) {
        self.provider = provider ?? AIWebProvider.selected()
        self.startOverride = startURL
        self.dataStore = dataStore ?? .default()
        self.testOrigin = testingOrigin
        super.init()
    }
    func selectProvider(_ value: AIWebProvider) {
        guard value != provider else { return }
        cancelPendingPaste()
        provider = value; webView = views[value]
        loading = loadingStates[value] ?? false; errorMessage = errors[value]
    }
    func view() -> WKWebView {
        if let webView { return webView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self; view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.accessibilityIdentifier = "chatgpt.webview"
        views[provider] = view; webView = view
        setState(for: view, loading: true, error: nil)
        view.load(URLRequest(url: startOverride ?? provider.startURL))
        return view
    }
    func reload() { cancelPendingPaste(); _ = view(); if let webView { setState(for: webView, loading: true, error: nil); webView.reload() } }
    func goBack() { cancelPendingPaste(); if webView?.canGoBack == true { webView?.goBack() } }
    func cancelPendingPaste() { pasteGeneration = UUID() }
    private func provider(for view: WKWebView) -> AIWebProvider? { views.first { $0.value === view }?.key }
    private func setState(for view: WKWebView, loading: Bool, error: String?) {
        guard let owner = provider(for: view) else { return }
        loadingStates[owner] = loading; errors[owner] = error
        if owner == provider { self.loading = loading; errorMessage = error }
    }
    func allowsNavigation(to url: URL, isMainFrame: Bool) -> Bool {
        allowsNavigation(to: url, isMainFrame: isMainFrame, provider: provider)
    }
    private func allowsNavigation(to url: URL, isMainFrame: Bool, provider: AIWebProvider) -> Bool {
        if let testOrigin, url.scheme == testOrigin.scheme, url.host == testOrigin.host, url.port == testOrigin.port { return true }
        return provider.allowsNavigation(to: url, isMainFrame: isMainFrame)
    }

    enum PasteAttempt { case requested, manual, cancelled }
    /// Only the explicit user button calls this, after copying its preview PNG.
    /// Public paste: is best effort. A successful invocation is not an upload or
    /// send receipt, so the UI always asks the user to confirm the attachment.
    func pasteCopiedImage(expectedChangeCount: Int) async -> PasteAttempt {
        guard let view = webView, let url = view.url, let selectorContract = provider.composerSelector(at: url) else { return .manual }
        let selected = provider, generation = pasteGeneration
        let originJSON = String(data: try! JSONEncoder().encode(selected.origin), encoding: .utf8)!
        let selectorJSON = String(data: try! JSONEncoder().encode(selectorContract), encoding: .utf8)!
        let script = """
        (() => {
          if (location.origin !== \(originJSON)) return false;
          const visible = e => { if (!e || e.disabled || e.readOnly || e.closest('[inert], [aria-hidden="true"]') || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden' || getComputedStyle(e).opacity === '0') return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
          const editors = Array.from(document.querySelectorAll(\(selectorJSON))).filter(visible);
          const editor = editors.includes(document.activeElement) ? document.activeElement : (editors.length === 1 ? editors[0] : null);
          if (!editor) return false;
          editor.focus(); return document.activeElement === editor;
        })()
        """
        let focused = (try? await view.evaluateJavaScript(script)) as? Bool ?? false
        guard generation == pasteGeneration, provider == selected, webView === view,
              let currentURL = view.url, selected.composerSelector(at: currentURL) == selectorContract,
              UIPasteboard.general.changeCount == expectedChangeCount else { return .cancelled }
        guard focused else { return .manual }
        let selector = #selector(UIResponderStandardEditActions.paste(_:))
        func responder(in node: UIView) -> UIResponder? {
            if node.isFirstResponder { return node }
            return node.subviews.lazy.compactMap { responder(in: $0) }.first
        }
        guard let target = responder(in: view), target.responds(to: selector),
              target.canPerformAction(selector, withSender: nil) else { return .manual }
        _ = target.perform(selector, with: nil)
        return .requested
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let owner = provider(for: webView) ?? provider
        // File CDN targets belong to an explicit download, not to the ordinary
        // AI page allowlist. WebKit carries this page's cookies itself.
        if action.shouldPerformDownload {
            guard permitsDownload(action, in: webView, provider: owner) else {
                setState(for: webView, loading: false, error: WebDownloadStore.text("此下载链接请用系统浏览器打开。", "Open this download link in the system browser."))
                decisionHandler(.cancel); return
            }
            decisionHandler(.download); return
        }
        guard let url = action.request.url,
              allowsNavigation(to: url, isMainFrame: action.targetFrame?.isMainFrame ?? true, provider: owner) else {
            if action.targetFrame?.isMainFrame != false {
                setState(for: webView, loading: false, error: String(localized: "此链接请用系统浏览器打开。网页登录遇到限制时，也可使用下方浏览器入口。"))
            }
            decisionHandler(.cancel); return
        }
        if action.targetFrame?.isMainFrame != false && webView === self.webView { cancelPendingPaste() }
        decisionHandler(.allow)
    }
    private func permitsDownload(_ action: WKNavigationAction, in view: WKWebView, provider: AIWebProvider) -> Bool {
        guard action.shouldPerformDownload, let url = action.request.url,
              let current = view.url, let source = WebDownloadStore.originURL(action.sourceFrame.securityOrigin),
              allowsNavigation(to: current, isMainFrame: true, provider: provider),
              allowsNavigation(to: source, isMainFrame: true, provider: provider) else { return false }
        if url.scheme?.lowercased() == "blob" {
            return WebDownloadStore.allowsBlob(url, currentURL: current, sourceURL: source, explicit: true) {
                allowsNavigation(to: $0, isMainFrame: true, provider: provider)
            }
        }
        return WebDownloadStore.isWebURL(url, httpsOnly: testOrigin == nil) &&
            (url.scheme?.lowercased() == "https" || testOrigin.map { WebDownloadStore.sameOrigin(url, $0) } == true)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let owner = provider(for: webView) ?? provider
        if WebDownloadStore.shouldDownloadResponse(response.response, canShowMIMEType: response.canShowMIMEType, isMainFrame: response.isForMainFrame) {
            guard let url = response.response.url, allowsNavigation(to: url, isMainFrame: true, provider: owner) else {
                setState(for: webView, loading: false, error: WebDownloadStore.text("此下载链接请用系统浏览器打开。", "Open this download link in the system browser."))
                decisionHandler(.cancel); return
            }
            decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, navigationAction action: WKNavigationAction, didBecome download: WKDownload) {
        guard let owner = provider(for: webView), permitsDownload(action, in: webView, provider: owner) else { download.cancel(nil); return }
        retainDownload(download, from: webView, owner: owner, blobOrigin: webView.url)
    }
    func webView(_ webView: WKWebView, navigationResponse response: WKNavigationResponse, didBecome download: WKDownload) {
        guard let owner = provider(for: webView), let url = response.response.url,
              allowsNavigation(to: url, isMainFrame: true, provider: owner),
              WebDownloadStore.shouldDownloadResponse(response.response, canShowMIMEType: response.canShowMIMEType, isMainFrame: response.isForMainFrame) else {
            download.cancel(nil); return
        }
        retainDownload(download, from: webView, owner: owner, blobOrigin: nil)
    }
    private func retainDownload(_ download: WKDownload, from view: WKWebView, owner: AIWebProvider, blobOrigin: URL?) {
        let testOrigin = self.testOrigin
        downloads.adopt(download, from: view, source: owner.title) { url in
            if url.scheme?.lowercased() == "blob", let blobOrigin,
               let embedded = URL(string: String(url.absoluteString.dropFirst(5))) {
                return WebDownloadStore.sameOrigin(embedded, blobOrigin)
            }
            return WebDownloadStore.isWebURL(url, httpsOnly: true) || testOrigin.map { WebDownloadStore.sameOrigin(url, $0) } == true
        }
        setState(for: view, loading: false, error: nil)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, allowsNavigation(to: url, isMainFrame: true, provider: provider(for: webView) ?? provider) { webView.load(action.request) }
        return nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === self.webView { cancelPendingPaste() }
        setState(for: webView, loading: true, error: nil)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { setState(for: webView, loading: false, error: nil) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error, view: webView) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error, view: webView) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView { cancelPendingPaste() }
        setState(for: webView, loading: false, error: String(localized: "网页进程已暂停，请点刷新继续。白板和临时截图保持不变。"))
    }
    private func failed(_ error: Error, view: WKWebView) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        setState(for: view, loading: false, error: String(localized: "AI 网页暂时无法加载。请检查网络后刷新，或用系统浏览器打开。"))
    }
}

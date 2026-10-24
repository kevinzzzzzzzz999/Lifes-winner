import Observation
import SwiftUI
import WebKit

@MainActor @Observable final class EmbeddedBrowserTab: NSObject, Identifiable, WKNavigationDelegate, WKUIDelegate {
    let id = UUID()
    private(set) var title = String(localized: "新标签页")
    private(set) var currentURL: URL?
    private(set) var loading = false
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var errorMessage: String?
    @ObservationIgnored private var retainedView: WKWebView?
    let textSelection = WebPageTextSelectionController()
    @ObservationIgnored weak var session: EmbeddedBrowserSession?
    @ObservationIgnored var onOpenTab: ((URL) -> Void)?

    func view() -> WKWebView {
        if let retainedView { return retainedView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        if #available(iOS 18.4, *) { configuration.webExtensionController = BrowserExtensionHost.shared.controller }
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.accessibilityIdentifier = "browser.webview"
        retainedView = web
        return web
    }
    func navigate(_ raw: String) {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        let url: URL?
        if input.contains("://") { url = URL(string: input) }
        else if !input.contains(where: \.isWhitespace), input.contains(".") { url = URL(string: "https://" + input) }
        else {
            var components = URLComponents(string: "https://www.google.com/search")!
            components.queryItems = [URLQueryItem(name: "q", value: input)]
            url = components.url
        }
        guard let url, Self.isWebURL(url) else {
            errorMessage = String(localized: "请输入 http 或 https 网页地址，或输入搜索词。"); return
        }
        open(url)
    }
    func open(_ url: URL) {
        guard Self.isWebURL(url) else { return }
        textSelection.finish()
        errorMessage = nil; loading = true; currentURL = url; title = url.host ?? String(localized: "网页")
        view().load(URLRequest(url: url))
    }
    func back() { if canGoBack { textSelection.finish(); view().goBack() } }
    func forward() { if canGoForward { textSelection.finish(); view().goForward() } }
    func reload() { textSelection.finish(); errorMessage = nil; if currentURL != nil { view().reload() } }
    func stop() { textSelection.finish(); retainedView?.stopLoading(); loading = false }
    func selectedText() async throws -> String {
        if textSelection.active { return textSelection.selectedText }
        let result = try await view().evaluateJavaScript("String(window.getSelection ? window.getSelection().toString() : '')")
        return String((result as? String ?? "").prefix(50_000)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    nonisolated static func isWebURL(_ url: URL) -> Bool {
        WebDownloadStore.isWebURL(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload {
            guard permitsDownload(action, in: webView) else {
                errorMessage = WebDownloadStore.text("此下载链接请用系统浏览器打开。", "Open this download link in the system browser.")
                decisionHandler(.cancel); return
            }
            decisionHandler(.download); return
        }
        guard let url = action.request.url, Self.isWebURL(url) else {
            if action.targetFrame?.isMainFrame != false {
                errorMessage = String(localized: "此链接需要其他应用。请用系统浏览器打开当前页面后继续。")
            }
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    private func permitsDownload(_ action: WKNavigationAction, in view: WKWebView) -> Bool {
        guard action.shouldPerformDownload, let url = action.request.url,
              let current = view.url, let source = WebDownloadStore.originURL(action.sourceFrame.securityOrigin),
              Self.isWebURL(current), Self.isWebURL(source) else { return false }
        if url.scheme?.lowercased() == "blob" {
            return WebDownloadStore.allowsBlob(url, currentURL: current, sourceURL: source, explicit: true, allowsOrigin: Self.isWebURL)
        }
        return Self.isWebURL(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if WebDownloadStore.shouldDownloadResponse(response.response, canShowMIMEType: response.canShowMIMEType, isMainFrame: response.isForMainFrame) {
            guard let url = response.response.url, Self.isWebURL(url) else { decisionHandler(.cancel); return }
            decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, navigationAction action: WKNavigationAction, didBecome download: WKDownload) {
        guard permitsDownload(action, in: webView) else { download.cancel(nil); return }
        retainDownload(download, from: webView, blobOrigin: webView.url)
    }
    func webView(_ webView: WKWebView, navigationResponse response: WKNavigationResponse, didBecome download: WKDownload) {
        guard let url = response.response.url, Self.isWebURL(url),
              WebDownloadStore.shouldDownloadResponse(response.response, canShowMIMEType: response.canShowMIMEType, isMainFrame: response.isForMainFrame) else {
            download.cancel(nil); return
        }
        retainDownload(download, from: webView, blobOrigin: nil)
    }
    private func retainDownload(_ download: WKDownload, from view: WKWebView, blobOrigin: URL?) {
        guard let store = session?.downloads else { download.cancel(nil); return }
        store.adopt(download, from: view, source: view.url?.host ?? String(localized: "网页")) { url in
            if url.scheme?.lowercased() == "blob", let blobOrigin,
               let embedded = URL(string: String(url.absoluteString.dropFirst(5))) {
                return WebDownloadStore.sameOrigin(embedded, blobOrigin)
            }
            return Self.isWebURL(url)
        }
        loading = false; errorMessage = nil
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, Self.isWebURL(url) { onOpenTab?(url) }
        return nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        textSelection.finish(); loading = true; errorMessage = nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false; currentURL = webView.url
        title = String((webView.title ?? webView.url?.host ?? String(localized: "网页")).prefix(120))
        canGoBack = webView.canGoBack; canGoForward = webView.canGoForward
        if #available(iOS 18.4, *) { BrowserExtensionHost.shared.controller.didChangeTabProperties([.URL, .title, .loading], for: self) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error, web: webView) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error, web: webView) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        textSelection.finish(); loading = false; errorMessage = String(localized: "网页已暂停，请刷新后继续。")
    }
    private func failed(_ error: Error, web: WKWebView) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        loading = false; canGoBack = web.canGoBack; canGoForward = web.canGoForward
        errorMessage = String(localized: "网页无法加载：\(error.localizedDescription)")
    }
}

@MainActor @Observable final class EmbeddedBrowserSession: NSObject {
    let downloads = WebDownloadStore()
    private(set) var tabs: [EmbeddedBrowserTab] = []
    var selectedID: UUID? {
        didSet {
            if oldValue != selectedID { tabs.first { $0.id == oldValue }?.textSelection.finish() }
            if #available(iOS 18.4, *), let tab = selectedTab {
                BrowserExtensionHost.shared.controller.didFocusWindow(self)
                BrowserExtensionHost.shared.controller.didActivateTab(tab, previousActiveTab: tabs.first { $0.id == oldValue })
            }
        }
    }
    var selectedTab: EmbeddedBrowserTab? { tabs.first { $0.id == selectedID } ?? tabs.first }
    override init() {
        super.init()
        if #available(iOS 18.4, *) { BrowserExtensionHost.shared.register(self) }
        addTab()
    }
    func addTab(url: URL? = nil) {
        guard tabs.count < 12 else { return }
        let tab = EmbeddedBrowserTab()
        tab.session = self
        tab.onOpenTab = { [weak self] url in self?.addTab(url: url) }
        tabs.append(tab)
        if #available(iOS 18.4, *) { BrowserExtensionHost.shared.controller.didOpenTab(tab) }
        selectedID = tab.id
        if let url { tab.open(url) }
    }
    func close(_ id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[index].stop()
        if #available(iOS 18.4, *) { BrowserExtensionHost.shared.controller.didCloseTab(tabs[index]) }
        tabs.remove(at: index)
        if tabs.isEmpty { addTab() }
        else if selectedID == id { selectedID = tabs[min(index, tabs.count - 1)].id }
    }
}

/// A user-requested, bounded snapshot stays over the exact web viewport. The
/// underlying page remains mounted, preserving forms, scroll position and login.
@MainActor @Observable final class WebPageTextSelectionController {
    private(set) var active = false
    private(set) var capturing = false
    private(set) var hasSelection = false
    private(set) var status = ""
    @ObservationIgnored private weak var web: WKWebView?
    @ObservationIgnored private weak var host: UIView?
    @ObservationIgnored private var surface: WebPageTextSelectionSurface?
    @ObservationIgnored private var requestID = UUID()
    @ObservationIgnored var onUpdate: (() -> Void)?
    @ObservationIgnored private var backgroundObserver: NSObjectProtocol?
    init() {
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.finish() }
        }
    }
    deinit { if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) } }
    var selectedText: String { surface?.selection.selectedText ?? "" }

    func bind(web: WKWebView, host: UIView) {
        if self.web !== web || self.host !== host { finish(); self.web = web; self.host = host }
    }
    func begin() {
        guard !active, !capturing, let web, let host, web.window != nil, UIApplication.shared.applicationState == .active,
              web.bounds.width.isFinite, web.bounds.height.isFinite, web.bounds.width >= 8, web.bounds.height >= 8 else { return }
        let size = web.bounds.size, offset = web.scrollView.contentOffset, zoom = web.scrollView.zoomScale
        let token = UUID(); requestID = token; capturing = true
        status = String(localized: "正在准备当前网页画面…"); onUpdate?()
        let configuration = WKSnapshotConfiguration()
        configuration.rect = web.bounds
        // At most six megapixels, including very tall or narrow split panes.
        let scale = min(2, 2600 / max(size.width, size.height), sqrt(6_000_000 / (size.width * size.height)))
        let displayScale = max(1, web.traitCollection.displayScale)
        configuration.snapshotWidth = NSNumber(value: Double(size.width * scale / displayScale))
        configuration.afterScreenUpdates = true
        web.takeSnapshot(with: configuration) { [weak self, weak web, weak host] image, error in
            guard let self, self.requestID == token else { return }
            self.capturing = false
            guard let web, let host, web.window != nil, UIApplication.shared.applicationState == .active, self.web === web, self.host === host,
                  web.bounds.size == size, web.scrollView.contentOffset == offset, web.scrollView.zoomScale == zoom else {
                self.finish(message: String(localized: "网页位置已变化，请停稳后重新选择。")); return
            }
            guard error == nil, let image, let pixels = image.cgImage,
                  max(pixels.width, pixels.height) <= 2700, pixels.width * pixels.height <= 6_050_000 else {
                self.finish(message: String(localized: "当前网页画面无法识别，请重试或直接长按网页文字。")); return
            }
            let surface = WebPageTextSelectionSurface(image: image, size: size)
            surface.frame = web.convert(web.bounds, to: host)
            surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            self.surface = surface; self.active = true; self.hasSelection = false
            surface.selection.onStatus = { [weak self] value in
                self?.status = value.replacingOccurrences(of: "白板", with: "画面").replacingOccurrences(of: "whiteboard", with: "view"); self?.onUpdate?()
            }
            surface.selection.onSelectionChanged = { [weak self] selected in self?.hasSelection = selected; self?.onUpdate?() }
            surface.onInvalidated = { [weak self] in self?.finish(message: String(localized: "窗口尺寸已变化，请重新选择画面文字。")) }
            host.addSubview(surface)
            surface.start(); self.onUpdate?()
        }
    }
    func copy() {
        guard surface?.selection.copySelection() == true else { return }
        status = String(localized: "已复制所选文字。"); onUpdate?()
    }
    func finish(message: String = "") {
        requestID = UUID(); capturing = false; active = false; hasSelection = false
        surface?.selection.tearDown(); surface?.removeFromSuperview(); surface = nil
        status = message; onUpdate?()
    }
    func geometryChanged() {
        guard let web, let host, let surface else { return }
        if surface.frame != web.convert(web.bounds, to: host) { finish(message: String(localized: "网页位置已变化，请重新选择画面文字。")) }
    }
    func bringToFront() { if let surface { host?.bringSubviewToFront(surface) } }
    func hitTest(_ point: CGPoint, from view: UIView, event: UIEvent?) -> UIView? {
        guard let surface else { return nil }
        return surface.hitTest(view.convert(point, to: surface), with: event)
    }
}

@MainActor private final class WebPageTextSelectionSurface: UIView {
    let imageView: UIImageView
    private let snapshotID = UUID()
    private let snapshotSize: CGSize
    private var started = false
    private var invalidationScheduled = false
    var onInvalidated: (() -> Void)?
    lazy var selection = BoardInlineTextSelection(content: self)
    init(image: UIImage, size: CGSize) {
        imageView = UIImageView(image: image); snapshotSize = size
        super.init(frame: CGRect(origin: .zero, size: size))
        isOpaque = true; backgroundColor = .systemBackground; clipsToBounds = true
        imageView.frame = bounds; imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        imageView.contentMode = .scaleToFill; addSubview(imageView)
        accessibilityIdentifier = "browser.textSelection.surface"
        selection.capture = { [weak self] _ in self?.imageView.image }
        selection.canInteract = { [weak self] point in self?.bounds.contains(point) ?? false }
    }
    required init?(coder: NSCoder) { fatalError("Use init(image:size:)") }
    func start() {
        started = true
        selection.update(BoardTextSelectionSnapshotKey(sessionID: snapshotID, boardID: snapshotID,
            size: snapshotSize, offset: .zero, zoom: 1, documentRevision: 0, updatedAt: .distantPast,
            previewEpoch: 0, imageRevision: 0, renderedRevision: 0))
        _ = selection.revealText()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard started, bounds.size != snapshotSize, !invalidationScheduled else { return }
        invalidationScheduled = true
        DispatchQueue.main.async { [weak self] in self?.onInvalidated?() }
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if started, window == nil { selection.tearDown() }
    }
}

private struct RetainedBrowserView: UIViewRepresentable {
    let tab: EmbeddedBrowserTab
    func makeUIView(context: Context) -> UIView { let host = UIView(); attach(to: host); return host }
    func updateUIView(_ host: UIView, context: Context) { attach(to: host) }
    static func dismantleUIView(_ host: UIView, coordinator: ()) {
        // The panel owns the session; hiding it releases only the selection pixels.
        host.subviews.compactMap { $0 as? WebPageTextSelectionSurface }.forEach { $0.selection.tearDown(); $0.removeFromSuperview() }
    }
    private func attach(to host: UIView) {
        let web = tab.view()
        tab.textSelection.bind(web: web, host: host)
        guard web.superview !== host else { return }
        host.subviews.forEach { $0.removeFromSuperview() }
        web.removeFromSuperview(); web.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: host.leadingAnchor), web.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            web.topAnchor.constraint(equalTo: host.topAnchor), web.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }
}

struct EmbeddedBrowserPanel: View {
    @Bindable var session: EmbeddedBrowserSession
    let canClip: Bool
    let fullScreen: Bool
    let onClip: (URL, String, String?) -> Bool
    let onFullScreen: () -> Void
    let onClose: () -> Void
    @State private var address = ""
    @State private var clipStatus = ""
    @State private var readingSelection = false
    @State private var showingExtensions = false
    @State private var showsDownloads = false
    @State private var importingClip = false
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(String(localized: "浏览器"), systemImage: "globe").font(.headline)
                Spacer()
                Button { showsDownloads = true } label: {
                    Image(systemName: session.downloads.activeCount > 0 ? "arrow.down.circle.fill" : "arrow.down.circle")
                }.accessibilityLabel(WebDownloadStore.text("下载", "Downloads")).accessibilityIdentifier("browser.downloads")
                Button { showingExtensions = true } label: { Image(systemName: "puzzlepiece.extension") }
                    .accessibilityLabel(String(localized: "管理浏览器扩展")).accessibilityIdentifier("browser.extensions")
                if !fullScreen {
                    Button(action: onFullScreen) { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                        .accessibilityLabel(String(localized: "网页全屏"))
                }
                Button(action: onClose) { Image(systemName: "xmark") }.accessibilityLabel(String(localized: "关闭浏览器面板"))
            }.padding(12)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(session.tabs) { tab in
                        HStack(spacing: 4) {
                            Button { session.selectedID = tab.id } label: { Text(tab.title).lineLimit(1).frame(maxWidth: 140) }
                            Button { session.close(tab.id) } label: { Image(systemName: "xmark").font(.caption) }
                                .accessibilityLabel(String(localized: "关闭标签页 \(tab.title)"))
                        }
                        .padding(.horizontal, 10).frame(minHeight: 44)
                        .background(session.selectedID == tab.id ? Color.teal.opacity(0.14) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    }
                    Button { session.addTab() } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                        .disabled(session.tabs.count >= 12).accessibilityLabel(String(localized: "新建标签页"))
                }.padding(.horizontal, 10)
            }
            if let tab = session.selectedTab {
                HStack(spacing: 8) {
                    Button { tab.back() } label: { Image(systemName: "chevron.left") }.disabled(!tab.canGoBack).accessibilityLabel(String(localized: "网页后退"))
                    Button { tab.forward() } label: { Image(systemName: "chevron.right") }.disabled(!tab.canGoForward).accessibilityLabel(String(localized: "网页前进"))
                    TextField(String(localized: "网址或搜索词"), text: $address)
                        .keyboardType(.webSearch).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder).focused($addressFocused).submitLabel(.go)
                        .onSubmit { addressFocused = false; tab.navigate(address) }
                        .accessibilityIdentifier("browser.address")
                    Button { tab.loading ? tab.stop() : tab.reload() } label: { Image(systemName: tab.loading ? "xmark" : "arrow.clockwise") }
                        .accessibilityLabel(tab.loading ? String(localized: "停止加载") : String(localized: "刷新网页"))
                }.padding(10)
                if tab.loading { ProgressView().frame(maxWidth: .infinity).padding(.bottom, 4) }
                if let error = tab.errorMessage { Text(error).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12) }
                ZStack {
                    RetainedBrowserView(tab: tab)
                    if tab.currentURL == nil {
                        ContentUnavailableView(String(localized: "打开网页"), systemImage: "globe", description: Text(String(localized: "输入网址或搜索词。可在白板旁阅读，再把链接或选中文字放入白板。")))
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider()
                footer(tab)
                    .onChange(of: tab.currentURL) { _, url in if !addressFocused { address = url?.absoluteString ?? "" } }
                    .onChange(of: session.selectedID) { _, _ in address = session.selectedTab?.currentURL?.absoluteString ?? ""; clipStatus = "" }
                    .onAppear { address = tab.currentURL?.absoluteString ?? "" }
            }
        }
        .buttonStyle(.borderless).background(.background)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.panel")
        .onDisappear { session.selectedTab?.textSelection.finish() }
        .sheet(isPresented: $showingExtensions) { BrowserExtensionManagerView() }
        .sheet(isPresented: $showsDownloads) { WebDownloadsView(store: session.downloads) }
        .fileImporter(isPresented: $importingClip, allowedContentTypes: [.json, .data], allowsMultipleSelection: false) { result in
            do {
                guard canClip, let file = try result.get().first else { return }
                let clip = try BrowserWebClip.read(from: file)
                clipStatus = onClip(clip.url, clip.title, clip.text) ? String(localized: "剪藏和来源链接已放入当前白板") : String(localized: "白板当前不能编辑，请开启编辑后重试。")
            } catch { clipStatus = error.localizedDescription }
        }
    }

    private func footer(_ tab: EmbeddedBrowserTab) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let url = tab.currentURL {
                HStack(spacing: 12) {
                    Button(tab.textSelection.active ? String(localized: "结束选字") : String(localized: "选择画面文字"),
                           systemImage: tab.textSelection.active ? "checkmark" : "text.viewfinder") {
                        addressFocused = false
                        if tab.textSelection.active { tab.textSelection.finish() } else { tab.textSelection.begin() }
                    }.disabled(tab.loading || tab.textSelection.capturing).accessibilityIdentifier("browser.selectText")
                    Button(String(localized: "复制所选"), systemImage: "doc.on.doc") { tab.textSelection.copy() }
                        .disabled(!tab.textSelection.hasSelection).accessibilityIdentifier("browser.copyText")
                    Spacer(minLength: 0)
                }.lineLimit(1).frame(minHeight: 36)
                Text(tab.textSelection.status.isEmpty ? String(localized: "长按网页正文选字；图片文字可用“选择画面文字”。") : tab.textSelection.status)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    .frame(height: 32, alignment: .leading)
                    .accessibilityIdentifier("browser.textSelection.status")
                HStack {
                    Menu {
                        Button(String(localized: "将链接放入白板"), systemImage: "link") {
                            clipStatus = onClip(url, tab.title, nil) ? String(localized: "链接已放入当前白板") : String(localized: "白板当前不能编辑，请开启编辑后重试。")
                        }
                        Button(String(localized: "将选中文字放入白板"), systemImage: "text.quote") {
                            guard !readingSelection else { return }
                            readingSelection = true
                            Task { @MainActor in
                                defer { readingSelection = false }
                                do {
                                    let selected = try await tab.selectedText()
                                    guard tab.currentURL == url else { clipStatus = String(localized: "网页已跳转，请重新选择后剪藏。"); return }
                                    guard !selected.isEmpty else { clipStatus = String(localized: "请先在网页长按选中文字，再使用此操作。"); return }
                                    clipStatus = onClip(url, tab.title, selected) ? String(localized: "选中文字和来源链接已放入白板") : String(localized: "白板当前不能编辑，请开启编辑后重试。")
                                } catch { clipStatus = String(localized: "未能读取选中文字，请在网页复制后使用白板的粘贴入口。") }
                            }
                        }
                    } label: { Label(String(localized: "放入白板"), systemImage: "square.and.arrow.down") }
                        .disabled(!canClip || readingSelection).accessibilityIdentifier("browser.clip")
                    Spacer()
                    ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel(String(localized: "分享当前链接"))
                    Link(String(localized: "系统浏览器"), destination: url)
                        .environment(\.openURL, OpenURLAction { .systemAction($0) })
                }
            }
            if !clipStatus.isEmpty { Text(clipStatus).font(.caption).foregroundStyle(.secondary) }
            Button(String(localized: "导入 Safari 剪藏文件"), systemImage: "square.and.arrow.down.on.square") { importingClip = true }
                .disabled(!canClip).accessibilityIdentifier("browser.importClip")
            DisclosureGroup(String(localized: "剪藏与扩展支持")) {
                Text(String(localized: "Safari 分享菜单中选择“人生赢家”，保存剪藏文件后在此导入。保留标题、来源链接与选中文字；不自动读取整页内容。浏览器扩展仅在此内置浏览器运行，点击右上角拼图管理。"))
                    .font(.caption).foregroundStyle(.secondary)
            }.font(.caption)
        }.padding(12)
    }
}

/// Keeps the document reader and any unsaved draft mounted while following a
/// web link. Wide iPads get a side panel; compact layouts get an in-app overlay.
private struct EmbeddedExternalLinkModifier: ViewModifier {
    @State private var session = EmbeddedBrowserSession()
    @State private var visible = false
    @State private var expanded = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var usesOverlay: Bool { expanded || horizontalSizeClass == .compact || UIDevice.current.userInterfaceIdiom == .phone }

    func body(content: Content) -> some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
                if visible && !usesOverlay {
                    Divider()
                    panel(fullScreen: false).frame(width: min(440, max(320, geometry.size.width * 0.4)))
                }
            }
            .overlay {
                if visible && usesOverlay { panel(fullScreen: true).background(.background) }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard EmbeddedBrowserTab.isWebURL(url) else { return .systemAction }
            session.selectedTab?.open(url)
            visible = true
            return .handled
        })
    }
    private func panel(fullScreen: Bool) -> some View {
        EmbeddedBrowserPanel(session: session, canClip: false, fullScreen: fullScreen,
            onClip: { _, _, _ in false }, onFullScreen: { expanded = true },
            onClose: { visible = false; expanded = false })
    }
}

extension View {
    func opensExternalLinksInApp() -> some View { modifier(EmbeddedExternalLinkModifier()) }
}

/// A bounded canvas companion: one live sandboxed page; inactive cards make no
/// network requests. Content stays below ink, controls remain above the canvas.
@MainActor final class BoardWebCanvasOverlay: UIView, WKNavigationDelegate, WKUIDelegate, UITextViewDelegate {
    let contentView = UIView()
    var onOpen: ((URL) -> Void)?
    private static weak var activeOverlay: BoardWebCanvasOverlay?
    private var webView: WKWebView?
    private let textSelection = WebPageTextSelectionController()
    private var activeID: UUID?
    private var activeURL: URL?
    private var boardID: UUID?
    private var canvasSessionID: UUID?
    private var enabled = false
    private var reading = false
    private var urls: [UUID: URL] = [:]
    private var frames: [UUID: CGRect] = [:]
    private var controls: [UUID: UIStackView] = [:]
    private var placeholders: [UUID: UILabel] = [:]
    private var textViews: [UUID: UITextView] = [:]
    private var textItems: [UUID: BoardItem] = [:]
    private var textZooms: [UUID: CGFloat] = [:]
    private var status = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false; contentView.clipsToBounds = true
        status.numberOfLines = 0; status.font = .systemFont(ofSize: 11)
        status.textColor = .secondaryLabel; status.backgroundColor = .secondarySystemBackground
        contentView.addSubview(status); status.isHidden = true
        textSelection.onUpdate = { [weak self] in
            guard let self, self.enabled, self.reading, self.activeID != nil, self.webView != nil else { return }
            if !self.textSelection.status.isEmpty { self.status.text = self.textSelection.status }
            else { self.status.text = String(localized: "长按正文选字，或点选字按钮识别网页图片。") }
            self.updateControls()
        }
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    func synchronize(store: BoardStore, zoom: CGFloat, offset: CGPoint) {
        if boardID != store.document.id || canvasSessionID != store.canvasSessionID {
            stop(); clearViews()
            boardID = store.document.id; canvasSessionID = store.canvasSessionID
            enabled = false; reading = false
        }
        let nextReading = store.usesPhoneInterface ? !store.phoneMarkupEnabled : store.isPadReading
        let nextEnabled = !store.isBusy && !store.reviewModeEnabled && (nextReading || store.mode == .arrange)
        // An inactive browser has no per-viewport work. Its static card remains
        // in the backdrop, and controls are rebuilt when reading resumes.
        guard nextEnabled else {
            if enabled { stop(); clearViews() }
            enabled = false; reading = nextReading
            if !isHidden { isHidden = true }
            if !contentView.isHidden { contentView.isHidden = true }
            return
        }
        if reading && !nextReading { stop() }
        enabled = true; reading = nextReading
        if isHidden { isHidden = false }
        if contentView.isHidden { contentView.isHidden = false }
        let visible = CGRect(x: offset.x / zoom, y: offset.y / zoom, width: bounds.width / zoom, height: bounds.height / zoom)
        let items = store.document.items.filter { $0.canvasWorldRect.intersects(visible) }
        let cards = Array(items.filter { BoardWebCardContent.isCard($0) && $0.width * zoom >= 188 && $0.height * zoom >= 150 }.prefix(8))
        let ids = Set(cards.map(\.id))
        for id in Array(controls.keys) where !ids.contains(id) {
            controls.removeValue(forKey: id)?.removeFromSuperview(); placeholders.removeValue(forKey: id)?.removeFromSuperview()
            urls[id] = nil; frames[id] = nil
        }
        if let activeID, !ids.contains(activeID) { stop() }
        for item in cards {
            let frame = CGRect(x: item.x * zoom - offset.x, y: item.y * zoom - offset.y, width: item.width * zoom, height: item.height * zoom)
            let body = CGRect(x: frame.minX + 6, y: frame.minY + 34, width: frame.width - 12, height: max(1, frame.height - 90))
            let url = BoardWebCardContent.safeURL(item.url ?? item.text)
            if activeID == item.id, url != activeURL { stop() }
            urls[item.id] = url; frames[item.id] = body
            let label = placeholders[item.id] ?? makePlaceholder(item.id)
            label.frame = body
            label.text = url == nil ? String(localized: "无效网页地址。请编辑为完整的 http / https 链接。") : reading ? String(localized: "点地球按钮，在白板内浏览网页。\n若网站拒绝嵌入，请用右侧按钮打开内部浏览器。") : String(localized: "拖动与缩放这个网页卡。\n切换阅读模式后可在卡片内浏览。")
            label.isHidden = item.id == activeID
            let control = controls[item.id] ?? makeControls(item.id)
            control.frame = CGRect(x: max(0, frame.minX + 6), y: max(0, min(bounds.maxY - 44, frame.maxY - 50)), width: min(220, frame.width - 12), height: 44)
            (control.arrangedSubviews.first as? UIButton)?.isEnabled = reading && url != nil
            (control.arrangedSubviews[1] as? UIButton)?.isEnabled = reading && activeID == item.id
            (control.arrangedSubviews.last as? UIButton)?.isEnabled = url != nil && onOpen != nil
            if activeID == item.id { placeActive(body) }
        }
        synchronizeText(items, zoom: zoom, offset: offset)
        updateControls()
    }
    private func makePlaceholder(_ id: UUID) -> UILabel {
        let label = UILabel(); label.numberOfLines = 0; label.textAlignment = .center
        label.font = .systemFont(ofSize: 13); label.textColor = .secondaryLabel; label.backgroundColor = .secondarySystemBackground
        contentView.addSubview(label); placeholders[id] = label; return label
    }
    private func makeControls(_ id: UUID) -> UIStackView {
        let controlBoardID = boardID, controlSessionID = canvasSessionID
        let browse = button("globe", String(localized: "浏览或暂停白板网页"), "web.inline.browse.\(id)") { [weak self] in
            guard let self, self.enabled, self.reading, self.boardID == controlBoardID,
                  self.canvasSessionID == controlSessionID, let url = self.urls[id] else { return }
            if self.activeID == id { self.stop() } else { self.activate(id, url: url) }
        }
        let reload = button("arrow.clockwise", String(localized: "重新加载网页"), "web.inline.reload.\(id)") { [weak self] in
            guard let self, self.enabled, self.reading, self.boardID == controlBoardID,
                  self.canvasSessionID == controlSessionID, self.activeID == id, let url = self.activeURL else { return }
            self.textSelection.finish()
            self.webView?.loadHTMLString(BoardWebCardContent.frameHTML(url), baseURL: nil)
        }
        let open = button("arrow.up.left.and.arrow.down.right", String(localized: "打开内部浏览器"), "web.inline.open.\(id)") { [weak self] in
            guard let self, self.enabled, self.boardID == controlBoardID,
                  self.canvasSessionID == controlSessionID, let url = self.urls[id] else { return }
            self.stop(); self.onOpen?(url)
        }
        let select = button("text.viewfinder", String(localized: "选择画面文字"), "web.inline.selectText.\(id)") { [weak self] in
            guard let self, self.enabled, self.reading, self.boardID == controlBoardID,
                  self.canvasSessionID == controlSessionID, self.activeID == id else { return }
            if self.textSelection.active { self.textSelection.finish() } else { self.textSelection.begin() }
        }
        let stack = UIStackView(arrangedSubviews: [browse, reload, select, open]); stack.axis = .horizontal; stack.distribution = .fillEqually
        stack.backgroundColor = .secondarySystemBackground; stack.layer.cornerRadius = 8; stack.clipsToBounds = true
        addSubview(stack); controls[id] = stack; return stack
    }
    private func button(_ symbol: String, _ label: String, _ identifier: String, action: @escaping () -> Void) -> UIButton {
        let result = UIButton(type: .system); result.setImage(UIImage(systemName: symbol), for: .normal)
        result.accessibilityLabel = label; result.accessibilityIdentifier = identifier
        result.addAction(UIAction { _ in action() }, for: .touchUpInside); return result
    }
    private func activate(_ id: UUID, url: URL) {
        Self.activeOverlay?.stop(); stop(); Self.activeOverlay = self
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true; configuration.mediaTypesRequiringUserActionForPlayback = .all
        let web = WKWebView(frame: .zero, configuration: configuration); web.navigationDelegate = self; web.uiDelegate = self
        web.accessibilityIdentifier = "web.inline.page"; web.isOpaque = true; web.backgroundColor = .white
        webView = web; activeID = id; activeURL = url; contentView.addSubview(web)
        textSelection.bind(web: web, host: contentView)
        status.text = String(localized: "若网页空白或拒绝嵌入，请用内部浏览器打开。")
        status.isHidden = false; contentView.bringSubviewToFront(status)
        placeholders[id]?.isHidden = true
        if let body = frames[id] { placeActive(body) }
        web.loadHTMLString(BoardWebCardContent.frameHTML(url), baseURL: nil); updateControls()
    }
    private func placeActive(_ body: CGRect) {
        let footer = min(44, max(22, body.height / 4))
        webView?.frame = CGRect(x: body.minX, y: body.minY, width: body.width, height: max(1, body.height - footer))
        status.frame = CGRect(x: body.minX, y: body.maxY - footer, width: body.width, height: footer)
        textSelection.geometryChanged(); textSelection.bringToFront()
    }
    private func updateControls() {
        for (id, stack) in controls {
            (stack.arrangedSubviews.first as? UIButton)?.setImage(UIImage(systemName: id == activeID ? "pause.fill" : "globe"), for: .normal)
            (stack.arrangedSubviews[1] as? UIButton)?.isEnabled = reading && id == activeID
            if let select = stack.arrangedSubviews[2] as? UIButton {
                select.isEnabled = reading && id == activeID && !textSelection.capturing
                select.setImage(UIImage(systemName: id == activeID && textSelection.active ? "checkmark" : "text.viewfinder"), for: .normal)
                select.accessibilityLabel = id == activeID && textSelection.active ? String(localized: "结束选字") : String(localized: "选择画面文字")
            }
        }
    }
    func stop() {
        textSelection.finish()
        webView?.stopLoading(); webView?.navigationDelegate = nil; webView?.uiDelegate = nil; webView?.removeFromSuperview(); webView = nil
        if let activeID { placeholders[activeID]?.isHidden = false }
        activeID = nil; activeURL = nil; status.isHidden = true; updateControls()
        if Self.activeOverlay === self { Self.activeOverlay = nil }
    }
    private func clearViews() {
        controls.values.forEach { $0.removeFromSuperview() }; controls.removeAll()
        placeholders.values.forEach { $0.removeFromSuperview() }; placeholders.removeAll()
        textViews.values.forEach { $0.removeFromSuperview() }; textViews.removeAll(); textItems.removeAll(); textZooms.removeAll(); urls.removeAll(); frames.removeAll()
    }
    func tearDown() { stop(); clearViews(); onOpen = nil; contentView.removeFromSuperview() }

    // The wrapper may navigate only its own about:blank top frame. HTTP(S) stays
    // in its sandboxed subframe; custom schemes/new windows/downloads are denied.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard enabled, reading, webView === self.webView else { decisionHandler(.cancel); return }
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == true { decisionHandler(url.absoluteString == "about:blank" ? .allow : .cancel) }
        else { decisionHandler(action.targetFrame != nil && BoardWebCardContent.safeURL(url.absoluteString) != nil ? .allow : .cancel) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard enabled, reading, webView === self.webView else { decisionHandler(.cancel); return }
        decisionHandler(response.canShowMIMEType ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard enabled, reading, webView === self.webView else { return }
        textSelection.finish()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard enabled, reading, webView === self.webView else { return }
        showFailure(error)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard enabled, reading, webView === self.webView else { return }
        showFailure(error)
    }
    private func showFailure(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        status.text = String(localized: "网页无法嵌入。请用内部浏览器打开，或重试。")
    }

    private func synchronizeText(_ items: [BoardItem], zoom: CGFloat, offset: CGPoint) {
        guard reading else { textViews.values.forEach { $0.isHidden = true }; return }
        let eligible = Array(items.filter { $0.kind == .text && !BoardWebCardContent.isCard($0) && !$0.usesMonospacedText && $0.width * zoom >= 100 && $0.height * zoom >= 60 }.prefix(24))
        let ids = Set(eligible.map(\.id))
        for id in Array(textViews.keys) where !ids.contains(id) { textViews.removeValue(forKey: id)?.removeFromSuperview(); textItems[id] = nil; textZooms[id] = nil }
        for item in eligible {
            let text = item.text ?? ""
            let view = textViews[item.id] ?? UITextView()
            if textItems[item.id] != item || textZooms[item.id] != zoom {
                let links = BoardTextWebLinks.links(text: text, html: item.richTextHTML)
                guard !links.isEmpty else { textViews.removeValue(forKey: item.id)?.removeFromSuperview(); textItems[item.id] = nil; textZooms[item.id] = nil; continue }
                let fontSize = item.style.map { CGFloat($0.fontSize ?? 16) * zoom } ?? min(24, max(9, 16 * zoom))
                let attributed = NSMutableAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: max(1, fontSize)), .foregroundColor: BoardStyledDrawing.color(item.style?.textColor) ?? UIColor.darkGray])
                for link in links { attributed.addAttribute(.link, value: link.url, range: link.range) }
                view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = false; view.delegate = self
                view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
                view.backgroundColor = BoardStyledDrawing.color(item.style?.fillColor) ?? .white
                view.linkTextAttributes = [.foregroundColor: UIColor(red: 0.1, green: 0.35, blue: 0.55, alpha: 1), .underlineStyle: NSUnderlineStyle.single.rawValue]
                view.attributedText = attributed; view.accessibilityIdentifier = "board.text.links.\(item.id)"
                contentView.addSubview(view); textViews[item.id] = view; textItems[item.id] = item; textZooms[item.id] = zoom
            }
            let frame = CGRect(x: item.x * zoom - offset.x, y: item.y * zoom - offset.y, width: item.width * zoom, height: item.height * zoom)
            if let style = item.style {
                let inner = style.shape == .ellipse ? frame.insetBy(dx: frame.width * 0.15, dy: frame.height * 0.15) : frame
                let inset = max(3, 12 * zoom), title = max(12, (style.fontSize.map { CGFloat($0) * zoom } ?? min(18, max(7, 13 * zoom))) * 1.4)
                view.frame = CGRect(x: inner.minX + inset, y: inner.minY + inset + title, width: max(0, inner.width - 2 * inset), height: max(0, inner.height - title - inset * 1.5))
            } else {
                let inset = min(14, max(3, 12 * zoom)), title = min(34, max(12, 28 * zoom))
                view.frame = CGRect(x: frame.minX + inset, y: frame.minY + title + inset, width: max(0, frame.width - 2 * inset), height: max(0, frame.height - title - 2 * inset))
            }
            view.isHidden = false
        }
        if let webView { contentView.bringSubviewToFront(webView); contentView.bringSubviewToFront(status); textSelection.bringToFront() }
    }
    func textView(_ textView: UITextView, shouldInteractWith url: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
        guard enabled, reading, textViews.values.contains(where: { $0 === textView }) else { return false }
        if let safe = BoardWebCardContent.safeURL(url.absoluteString) { stop(); onOpen?(safe) }; return false
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, enabled else { return nil }
        for stack in controls.values {
            if let hit = stack.hitTest(convert(point, to: stack), with: event), hit is UIControl { return hit }
        }
        guard reading else { return nil }
        if let hit = textSelection.hitTest(point, from: self, event: event) { return hit }
        if let webView, let hit = webView.hitTest(convert(point, to: webView), with: event) { return hit }
        for view in textViews.values where !view.isHidden && view.bounds.contains(convert(point, to: view)) {
            let local = convert(point, to: view), manager = view.layoutManager
            let glyph = manager.glyphIndex(for: local, in: view.textContainer)
            guard glyph < manager.numberOfGlyphs else { continue }
            let character = manager.characterIndexForGlyph(at: glyph)
            guard character < view.attributedText.length,
                  view.attributedText.attribute(.link, at: character, effectiveRange: nil) != nil,
                  manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: view.textContainer).insetBy(dx: -8, dy: -8).contains(local) else { continue }
            return view.hitTest(local, with: event)
        }
        return nil
    }
}

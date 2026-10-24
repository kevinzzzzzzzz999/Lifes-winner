import SwiftUI
import QuickLook
import WebKit

enum DocumentSelectionAction {
    case add, expand
    var confirmationTitle: String { self == .expand ? String(localized: "展开到当前白板") : String(localized: "添加到当前白板") }
}

struct VaultDocumentPicker: View {
    let library: DocumentLibrary
    let action: DocumentSelectionAction
    let onSelect: ([VaultDocument]) -> Void
    let onBrowseFiles: (String, [VaultDocument]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var currentPath = ""
    @State private var folders: [VaultFolder] = []
    @State private var documents: [VaultDocument] = []
    @State private var selectedDocuments: [String: VaultDocument] = [:]
    @State private var query = ""
    @State private var warning: String?
    @State private var isLoading = true
    @State private var refreshID = UUID()
    @State private var activeLoadID = UUID()
    @State private var showsSelection = false

    init(library: DocumentLibrary, initialPath: String = "", action: DocumentSelectionAction,
         onSelect: @escaping ([VaultDocument]) -> Void, onBrowseFiles: @escaping (String, [VaultDocument]) -> Void) {
        self.library = library; self.action = action; self.onSelect = onSelect; self.onBrowseFiles = onBrowseFiles
        _currentPath = State(initialValue: initialPath)
    }

    private var selected: [VaultDocument] { DocumentLibrary.sortedUnique(Array(selectedDocuments.values)) }
    private var searchQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var filteredDocuments: [VaultDocument] {
        let source = (showsSelection ? selected : documents).filter { action != .expand || !$0.isVideo }
        return searchQuery.isEmpty ? source : source.filter {
            $0.title.localizedCaseInsensitiveContains(searchQuery) || (showsSelection && $0.relativePath.localizedCaseInsensitiveContains(searchQuery))
        }
    }
    private var filteredFolders: [VaultFolder] {
        guard !showsSelection else { return [] }
        return searchQuery.isEmpty ? folders : folders.filter { $0.title.localizedCaseInsensitiveContains(searchQuery) }
    }
    private var allVisibleSelected: Bool {
        !filteredDocuments.isEmpty && filteredDocuments.allSatisfy { selectedDocuments[$0.relativePath] != nil }
    }
    private var breadcrumbPaths: [String] {
        let parts = currentPath.split(separator: "/")
        return parts.indices.map { parts[...$0].joined(separator: "/") }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                folderNavigation
                searchField
                selectionControls
                documentList
                confirmationControls
            }
            .navigationTitle(action == .expand ? String(localized: "展开资料") : String(localized: "添加资料"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() }.accessibilityIdentifier("documentPicker.close") }
                ToolbarItem(placement: .primaryAction) {
                    Button(String(localized: "刷新"), systemImage: "arrow.clockwise") { refreshID = UUID() }
                        .disabled(isLoading).accessibilityIdentifier("documentPicker.refresh")
                }
            }
            .task(id: currentPath + refreshID.uuidString) { await reload() }
        }
    }

    private var folderNavigation: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Button { navigate(to: (currentPath as NSString).deletingLastPathComponent) } label: {
                    Image(systemName: "chevron.left").frame(width: 44, height: 44)
                }
                .disabled(currentPath.isEmpty)
                .accessibilityLabel(String(localized: "上一级"))
                .accessibilityIdentifier("documentPicker.up")
                Divider().frame(height: 24)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Button { navigate(to: "") } label: {
                            Label(library.rootURL.lastPathComponent, systemImage: "folder").frame(minHeight: 44)
                        }
                        .accessibilityIdentifier("documentPicker.root")
                        ForEach(breadcrumbPaths, id: \.self) { path in
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            Button((path as NSString).lastPathComponent) { navigate(to: path) }
                                .frame(minHeight: 44)
                                .accessibilityIdentifier("documentPicker.breadcrumb.\(path)")
                        }
                    }.lineLimit(1).frame(minHeight: 44)
                }
            }
            HStack(spacing: 6) {
                Text(String(localized: "浏览位置")).foregroundStyle(.secondary)
                Text(currentPath.isEmpty ? String(localized: "仓库根目录") : currentPath).lineLimit(2)
            }.font(.caption).accessibilityElement(children: .combine)
                .accessibilityIdentifier("documentPicker.currentFolder")
        }
        .padding(.horizontal).padding(.top, 8)
        .accessibilityElement(children: .contain)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(showsSelection ? String(localized: "搜索已选文件") : String(localized: "搜索当前文件夹"), text: $query)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("documentPicker.search")
            if !query.isEmpty {
                Button(String(localized: "清除"), systemImage: "xmark.circle.fill") { query = "" }
                    .labelStyle(.iconOnly).foregroundStyle(.secondary).frame(width: 44, height: 44)
                    .accessibilityIdentifier("documentPicker.clearSearch")
            }
        }
        .padding(.horizontal, 12).frame(minHeight: 44).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal).padding(.top, 8)
    }

    private var selectionControls: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    showsSelection.toggle()
                    query = ""
                } label: {
                    Label(showsSelection ? String(localized: "返回文件夹") : String(localized: "已选 \(selectedDocuments.count) 个"), systemImage: showsSelection ? "folder" : "checkmark.circle")
                        .frame(minHeight: 44)
                }
                .accessibilityIdentifier("documentPicker.selection")
                Spacer()
                Button {
                    if allVisibleSelected {
                        for document in filteredDocuments { selectedDocuments.removeValue(forKey: document.relativePath) }
                    } else {
                        for document in filteredDocuments { selectedDocuments[document.relativePath] = document }
                    }
                } label: {
                    Text(allVisibleSelected ? String(localized: "取消当前选择") : String(localized: "全选当前文件")).frame(minHeight: 44)
                }
                .disabled(filteredDocuments.isEmpty || isLoading)
                .accessibilityIdentifier("documentPicker.selectAll")
            }
            if showsSelection {
                HStack {
                    Text(String(localized: "已选 \(selectedDocuments.count) 个")).foregroundStyle(.secondary)
                    Spacer()
                    Button { selectedDocuments.removeAll() } label: { Text(String(localized: "清空选择")).frame(minHeight: 44) }
                        .disabled(selectedDocuments.isEmpty || isLoading)
                        .accessibilityIdentifier("documentPicker.clearSelection")
                }
            }
        }
        .font(.subheadline).padding(.horizontal)
    }

    private var documentList: some View {
        List {
            if isLoading { ProgressView(String(localized: "正在读取当前文件夹…")) }
            if let warning { Text(warning).font(.footnote).foregroundStyle(.orange) }
            if !filteredFolders.isEmpty {
                Section(String(localized: "文件夹")) {
                    ForEach(filteredFolders) { folder in
                        Button { navigate(to: folder.relativePath) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder.fill").font(.title2).foregroundStyle(.blue).frame(width: 32)
                                Text(folder.title).foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            }.frame(minHeight: 44)
                        }
                        .accessibilityIdentifier("documentPicker.folder.\(folder.relativePath)")
                    }
                }
            }
            Section {
                ForEach(filteredDocuments) { document in fileRow(document) }
                if filteredDocuments.isEmpty && !isLoading {
                    Text(showsSelection ? (searchQuery.isEmpty ? String(localized: "还没有选中文件。返回文件夹后，轻点文件即可勾选。") : String(localized: "已选项目中没有匹配项。"))
                         : searchQuery.isEmpty ? (action == .expand ? String(localized: "此文件夹没有可展开的文档或图片。视频可通过添加资料放入白板。") : String(localized: "此文件夹没有支持的文档、图片或视频。"))
                         : String(localized: "当前文件夹没有匹配的文件。"))
                        .foregroundStyle(.secondary).font(.subheadline).padding(.vertical, 8)
                }
            } header: {
                Text(showsSelection ? String(localized: "已选文件 · 可跨文件夹选择") : String(localized: "文件"))
            } footer: {
                Text(showsSelection ? String(localized: "选择会保留。可以返回上层，再进入其他文件夹继续勾选。")
                     : String(localized: "轻点文件夹进入，轻点文件勾选。返回上层不会清空已选文件。"))
            }
        }
        .id(currentPath + String(showsSelection))
        .listStyle(.insetGrouped)
    }

    private func fileRow(_ document: VaultDocument) -> some View {
        let isSelected = selectedDocuments[document.relativePath] != nil
        return Button {
            if isSelected { selectedDocuments.removeValue(forKey: document.relativePath) }
            else { selectedDocuments[document.relativePath] = document }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                Image(systemName: document.symbol).font(.title2).foregroundStyle(documentTint(document)).frame(width: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(document.title).foregroundStyle(.primary).lineLimit(2)
                    Text(document.fileExtension.uppercased()).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                    if showsSelection {
                        Text(document.relativePath).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer()
                if document.requiresDownload {
                    Image(systemName: "icloud.and.arrow.down").accessibilityLabel(String(localized: "选中后自动下载"))
                }
            }.frame(minHeight: 44)
        }
        .disabled(isLoading)
        .accessibilityValue(isSelected ? String(localized: "已选择") : String(localized: "未选择"))
        .accessibilityIdentifier("documentPicker.file.\(document.relativePath)")
    }

    private var confirmationControls: some View {
        VStack(spacing: 8) {
            Button {
                onSelect(selected)
                dismiss()
            } label: {
                Text("\(action.confirmationTitle)（\(selectedDocuments.count)）").frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(selectedDocuments.isEmpty || isLoading)
            .accessibilityIdentifier("documentPicker.confirm")
            Button { onBrowseFiles(currentPath, selected) } label: {
                Label(String(localized: "浏览 iCloud 与其他位置"), systemImage: "icloud").frame(minHeight: 44)
            }
                .accessibilityIdentifier("documentPicker.browseFiles")
            Text(action == .expand ? String(localized: "所选资料会展开到当前白板；原件保留。可以跨文件夹选择，视频不能展开。") : String(localized: "所选资料会添加到当前白板；原件保留。可以跨文件夹选择，稍后再展开阅读。"))
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding().background(.bar)
    }

    private func documentTint(_ document: VaultDocument) -> Color {
        if document.isPDF { return .orange }
        if document.isImage { return .pink }
        if document.isVideo { return .indigo }
        if document.isExcel { return .green }
        if ["ppt", "pptx"].contains(document.fileExtension) { return .purple }
        return .blue
    }

    private func navigate(to path: String) {
        showsSelection = false
        query = ""
        guard path != currentPath else { return }
        folders = []
        documents = []
        warning = nil
        isLoading = true
        currentPath = path == "." ? "" : path
    }

    private func reload() async {
        let loadID = UUID()
        let path = currentPath
        activeLoadID = loadID
        isLoading = true
        warning = nil
        defer { if activeLoadID == loadID { isLoading = false } }
        let result = await library.listDirectory(relativePath: path)
        guard !Task.isCancelled, activeLoadID == loadID, currentPath == path else { return }
        folders = result.folders
        documents = result.documents
        warning = result.warning
        let available = Set(documents.map(\.relativePath))
        if result.warning == nil {
            selectedDocuments = selectedDocuments.filter { key, _ in
                let parent = (key as NSString).deletingLastPathComponent
                return parent != path || available.contains(key)
            }
        }
        for document in documents where selectedDocuments[document.relativePath] != nil {
            selectedDocuments[document.relativePath] = document
        }
    }
}

/// Quick Look previews the original URL. This wrapper makes no copy and performs no save-back.
/// Keep DocumentLibrary alive while this view is presented so its security scope remains valid.
struct VaultQuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url {
            context.coordinator.url = url
            controller.reloadData()
        }
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

/// Loads the original Office file in a retained, offline WebKit viewport.
/// Selection covers only that viewport; no conversion, layout injection, or save-back.
struct InlineOfficeReadingView: View {
    let url: URL
    var onOpenWeb: ((URL) -> Void)? = nil
    @State private var selection = OfficePreviewTextSelectionModel()
    @State private var showsPictures = false

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 12) {
                    Button {
                        if selection.active || selection.capturing { selection.controller?.finishSelection() }
                        else { selection.controller?.beginSelection() }
                    } label: {
                        Label(selection.active || selection.capturing ? String(localized: "结束选字") : String(localized: "选择画面文字"), systemImage: "text.viewfinder")
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .disabled(!selection.ready && !selection.active && !selection.capturing)
                    .accessibilityIdentifier("office.selectFrameText")
                    Button(String(localized: "复制所选文字")) { selection.controller?.copySelection() }
                        .frame(minHeight: 44).disabled(!selection.hasSelection)
                        .accessibilityIdentifier("office.copyFrameText")
                }.font(.subheadline).lineLimit(1).minimumScaleFactor(0.8)
                HStack(alignment: .top, spacing: 8) {
                    Text(selection.status.isEmpty ? String(localized: "可先滚动或缩放，再选择画面文字。") : selection.status)
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2, reservesSpace: true).frame(maxWidth: .infinity, minHeight: 32, alignment: .topLeading)
                        .accessibilityIdentifier("office.frameSelection.status")
                    if url.pathExtension.lowercased() == "xlsx" {
                        Button(String(localized: "表内图片"), systemImage: "photo.on.rectangle.angled") {
                            selection.controller?.finishSelection()
                            showsPictures = true
                        }.font(.subheadline).frame(minHeight: 44).accessibilityIdentifier("office.embeddedPictures")
                    }
                }
            }.padding(.horizontal, 12).padding(.vertical, 4)
            OfficeOriginalSelectionHost(url: url, selection: selection, onOpenWeb: onOpenWeb)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onDisappear { selection.controller?.finishSelection() }
        .fullScreenCover(isPresented: $showsPictures) { ExcelPicturesReadingView(url: url) }
        .onChange(of: url) { _, _ in showsPictures = false }
    }
}

@MainActor @Observable private final class OfficePreviewTextSelectionModel {
    var ready = false
    var active = false
    var capturing = false
    var hasSelection = false
    var status = ""
    @ObservationIgnored weak var controller: OfficeOriginalSelectionController?
}

private struct OfficeOriginalSelectionHost: UIViewControllerRepresentable {
    let url: URL
    let selection: OfficePreviewTextSelectionModel
    let onOpenWeb: ((URL) -> Void)?

    func makeUIViewController(context: Context) -> OfficeOriginalSelectionController {
        OfficeOriginalSelectionController(url: url, selection: selection, onOpenWeb: onOpenWeb)
    }
    func updateUIViewController(_ controller: OfficeOriginalSelectionController, context: Context) {
        controller.onOpenWeb = onOpenWeb
        controller.setURL(url)
    }
    static func dismantleUIViewController(_ controller: OfficeOriginalSelectionController, coordinator: ()) {
        controller.tearDown()
    }
}

@MainActor private final class OfficeOriginalSelectionController: UIViewController, WKNavigationDelegate, WKUIDelegate, QLPreviewControllerDataSource {
    private let selection: OfficePreviewTextSelectionModel
    var onOpenWeb: ((URL) -> Void)?
    private let surface = OfficePreviewTextSelectionSurface()
    private var web: WKWebView?
    private var fallback: QLPreviewController?
    private var url: URL
    private var requestID = UUID()
    private var loadID = UUID()
    private var viewportSize: CGSize?
    private var captureTask: Task<Void, Never>?
    private var captureDeadlineTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var deadlineTask: Task<Void, Never>?
    private var backgroundObserver: NSObjectProtocol?
    private var savedInteraction: Bool?
    private var savedAccessibilityHidden: Bool?
    private var stopped = false

    init(url: URL, selection: OfficePreviewTextSelectionModel, onOpenWeb: ((URL) -> Void)?) {
        self.url = url; self.selection = selection; self.onOpenWeb = onOpenWeb
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(url:selection:)") }
    deinit {
        captureTask?.cancel(); captureDeadlineTask?.cancel(); loadTask?.cancel(); deadlineTask?.cancel()
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "office.preview"
        surface.frame = view.bounds
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        surface.isHidden = true
        view.addSubview(surface)
        selection.controller = self
        surface.selector.onStatus = { [weak self] value in
            guard let self, self.selection.active, !self.stopped else { return }
            self.selection.status = value.replacingOccurrences(of: "白板", with: "画面")
                .replacingOccurrences(of: "whiteboard", with: "view")
        }
        surface.selector.onSelectionChanged = { [weak self] selected in
            guard let self, self.selection.active, !self.stopped else { return }
            self.selection.hasSelection = selected
        }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.finishSelection() }
        }
        loadOriginal()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let viewportSize, viewportSize != web?.bounds.size else { return }
        // Invalidate hit testing immediately; publish after SwiftUI's layout pass.
        surface.isUserInteractionEnabled = false
        let token = requestID
        DispatchQueue.main.async { [weak self] in
            guard let self, self.requestID == token else { return }
            self.finishSelection(message: String(localized: "窗口尺寸已变化，请重新选择画面文字。"))
        }
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        finishSelection()
    }

    func setURL(_ next: URL) {
        guard !stopped, url != next else { return }
        finishSelection(); url = next
        if isViewLoaded { loadOriginal() }
    }
    private func loadOriginal() {
        loadTask?.cancel(); deadlineTask?.cancel()
        let token = UUID(); loadID = token
        web?.navigationDelegate = nil; web?.uiDelegate = nil; web?.stopLoading(); web?.removeFromSuperview(); web = nil
        if let fallback {
            fallback.willMove(toParent: nil); fallback.view.removeFromSuperview(); fallback.removeFromParent()
            self.fallback = nil
        }
        selection.ready = false
        selection.status = String(localized: "正在准备当前预览画面…")
        guard url.isFileURL else { showFallback(); return }
        loadTask = Task { [weak self] in
            do {
                // Same network and cookie isolation as OfficeRenderJob. Apply
                // rules before loading; never inject print CSS or alter the DOM.
                guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(
                    forIdentifier: "InkSpace.OfficeReading.Offline.v1",
                    encodedContentRuleList: #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#) else {
                    throw URLError(.cannotLoadFromNetwork)
                }
                guard let self, !Task.isCancelled, !self.stopped, self.loadID == token else { return }
                let configuration = WKWebViewConfiguration()
                configuration.websiteDataStore = .nonPersistent()
                configuration.userContentController.add(rules)
                let web = WKWebView(frame: self.view.bounds, configuration: configuration)
                web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                web.accessibilityIdentifier = "office.originalWeb"
                web.navigationDelegate = self; web.uiDelegate = self
                self.web = web; self.view.insertSubview(web, belowSubview: self.surface)
                web.loadFileURL(self.url, allowingReadAccessTo: self.url.deletingLastPathComponent())
                self.deadlineTask = Task { [weak self, weak web] in
                    do { try await Task.sleep(for: .seconds(45)) } catch { return }
                    guard let self, self.loadID == token, self.web === web, !self.selection.ready else { return }
                    self.showFallback()
                }
            } catch {
                guard let self, !Task.isCancelled, !self.stopped, self.loadID == token else { return }
                self.showFallback()
            }
        }
    }
    private func showFallback() {
        guard !stopped, isViewLoaded else { return }
        finishSelection(message: String(localized: "当前预览暂不能选择画面文字，请直接长按可选原文。"))
        selection.ready = false
        loadID = UUID(); loadTask?.cancel(); deadlineTask?.cancel()
        web?.navigationDelegate = nil; web?.uiDelegate = nil; web?.stopLoading(); web?.removeFromSuperview(); web = nil
        guard fallback == nil else { return }
        let preview = QLPreviewController(); preview.dataSource = self
        fallback = preview; addChild(preview)
        preview.view.frame = view.bounds; preview.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.insertSubview(preview.view, belowSubview: surface); preview.didMove(toParent: self)
    }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard web === webView, !stopped else { return }
        finishSelection(); selection.ready = false
        selection.status = String(localized: "正在准备当前预览画面…")
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard web === webView, !stopped else { return }
        deadlineTask?.cancel(); deadlineTask = nil
        finishSelection(); selection.ready = true
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard web === webView, (error as NSError).code != NSURLErrorCancelled else { return }
        showFallback()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFail: navigation, withError: error)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if web === webView { showFallback() }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard web === webView, !stopped, let target = navigationAction.request.url else {
            decisionHandler(.cancel); return
        }
        if navigationAction.navigationType == .linkActivated, Self.isWebURL(target) {
            finishSelection(); decisionHandler(.cancel)
            onOpenWeb?(target)
            return
        }
        guard ["file", "about", "data", "blob", "applewebdata", "x-apple-ql-id"].contains(target.scheme?.lowercased() ?? "") else {
            decisionHandler(.cancel); return
        }
        if navigationAction.navigationType == .linkActivated {
            // Preserve in-document sheet/section anchors without letting the
            // offline preview become a browser or open a neighboring file.
            guard Self.documentURL(target) == Self.documentURL(webView.url ?? url) else {
                decisionHandler(.cancel); return
            }
        }
        if target.isFileURL {
            let allowed = url.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath().pathComponents
            let requested = target.standardizedFileURL.resolvingSymlinksInPath().pathComponents
            guard requested.count > allowed.count, Array(requested.prefix(allowed.count)) == allowed else {
                decisionHandler(.cancel); return
            }
        }
        finishSelection()
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard web === webView, !stopped, navigationAction.navigationType == .linkActivated,
              let target = navigationAction.request.url, Self.isWebURL(target) else { return nil }
        finishSelection(); onOpenWeb?(target)
        return nil
    }
    private static func isWebURL(_ target: URL) -> Bool {
        ["http", "https"].contains(target.scheme?.lowercased() ?? "") && target.host != nil
    }
    private static func documentURL(_ target: URL) -> URL? {
        var components = URLComponents(url: target, resolvingAgainstBaseURL: true)
        components?.fragment = nil
        return components?.url
    }

    func beginSelection() {
        guard !stopped, selection.ready, !selection.active, !selection.capturing, let web,
              web.window != nil, UIApplication.shared.applicationState == .active,
              presentedViewController == nil else { return }
        let size = web.bounds.size, offset = web.scrollView.contentOffset, zoom = web.scrollView.zoomScale
        let token = UUID()
        let key = BoardTextSelectionSnapshotKey(sessionID: token, boardID: token, size: size,
            offset: offset, zoom: zoom, documentRevision: 0, updatedAt: .distantPast,
            previewEpoch: 0, imageRevision: 0, renderedRevision: 0)
        guard key.isValid else { return }
        requestID = token; viewportSize = size
        selection.capturing = true
        selection.status = String(localized: "正在准备当前预览画面…")
        captureDeadlineTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, self.requestID == token, self.selection.capturing else { return }
            self.finishSelection(message: String(localized: "当前预览暂不能选择画面文字，请直接长按可选原文。"))
        }
        captureTask = Task { [weak self, weak web] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard let self, let web, !Task.isCancelled, self.requestID == token else { return }
            self.captureTask = nil
            let configuration = WKSnapshotConfiguration()
            configuration.rect = web.bounds
            configuration.snapshotWidth = NSNumber(value: Double(size.width * key.renderScale / max(1, web.traitCollection.displayScale)))
            configuration.afterScreenUpdates = true
            // The owned WebKit viewport supplies the pixels. No window capture,
            // remote Quick Look subtree, or first-page thumbnail is substituted.
            web.takeSnapshot(with: configuration) { [weak self, weak web] image, error in
                guard let self, self.requestID == token else { return }
                self.captureDeadlineTask?.cancel(); self.captureDeadlineTask = nil
                guard let web, self.web === web, !self.stopped, web.window != nil,
                      UIApplication.shared.applicationState == .active, self.presentedViewController == nil,
                      web.bounds.size == size, web.scrollView.contentOffset == offset, web.scrollView.zoomScale == zoom,
                      error == nil, let image, let pixels = image.cgImage,
                      max(pixels.width, pixels.height) <= 2700, pixels.width * pixels.height <= 6_050_000,
                      Self.hasVisibleContent(pixels) else {
                    self.finishSelection(message: String(localized: "当前预览暂不能选择画面文字，请直接长按可选原文。")); return
                }
                self.savedInteraction = web.isUserInteractionEnabled
                self.savedAccessibilityHidden = web.accessibilityElementsHidden
                web.isUserInteractionEnabled = false; web.accessibilityElementsHidden = true
                self.selection.capturing = false; self.selection.active = true; self.selection.hasSelection = false
                self.surface.isUserInteractionEnabled = true
                self.surface.show(image, key: key)
                self.view.bringSubviewToFront(self.surface)
            }
        }
    }
    private static func hasVisibleContent(_ image: CGImage) -> Bool {
        // Quick Look's remote rendering can report successful capture yet give
        // uniform pixels. Never replace a visible original with that blank image.
        var samples = [UInt8](repeating: 255, count: 64 * 64)
        return samples.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(data: bytes.baseAddress, width: 64, height: 64,
                bitsPerComponent: 8, bytesPerRow: 64, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
            let values = bytes.bindMemory(to: UInt8.self)
            return Int(values.max() ?? 0) - Int(values.min() ?? 0) > 8
        }
    }
    func copySelection() {
        guard selection.active, surface.selector.copySelection() else { return }
        selection.status = String(localized: "已复制所选文字。")
    }
    func finishSelection(message: String = "") {
        requestID = UUID(); captureTask?.cancel(); captureTask = nil; viewportSize = nil
        captureDeadlineTask?.cancel(); captureDeadlineTask = nil
        selection.active = false; selection.capturing = false; selection.hasSelection = false
        if isViewLoaded {
            surface.reset()
            if let savedInteraction { web?.isUserInteractionEnabled = savedInteraction }
            if let savedAccessibilityHidden { web?.accessibilityElementsHidden = savedAccessibilityHidden }
        }
        savedInteraction = nil; savedAccessibilityHidden = nil
        selection.status = message
    }
    func tearDown() {
        guard !stopped else { return }
        finishSelection(); stopped = true; loadID = UUID()
        loadTask?.cancel(); deadlineTask?.cancel()
        web?.navigationDelegate = nil; web?.uiDelegate = nil; web?.stopLoading()
        if isViewLoaded { surface.selector.tearDown() }
        if selection.controller === self { selection.controller = nil }
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver); self.backgroundObserver = nil }
    }
}

@MainActor private final class OfficePreviewTextSelectionSurface: UIView {
    private let imageView = UIImageView()
    lazy var selector = BoardInlineTextSelection(content: self)
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground; isOpaque = true; clipsToBounds = true
        accessibilityIdentifier = "office.textSelection.surface"
        imageView.frame = bounds; imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        imageView.contentMode = .scaleToFill
        addSubview(imageView)
        selector.capture = { [weak self] _ in self?.imageView.image }
        selector.canInteract = { [weak self] point in
            guard let self, !self.isHidden, self.isUserInteractionEnabled else { return false }
            return self.bounds.contains(point)
        }
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
    func show(_ image: UIImage, key: BoardTextSelectionSnapshotKey) {
        imageView.image = image; isHidden = false
        selector.update(key); _ = selector.revealText()
    }
    func reset() {
        // Reuse one analyzer/worker slot across repeated requests; cancellation
        // alone must not start overlapping VisionKit work for the next capture.
        selector.update(nil); imageView.image = nil; isHidden = true
    }
}

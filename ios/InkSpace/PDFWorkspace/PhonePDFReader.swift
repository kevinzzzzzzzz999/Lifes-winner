import SwiftUI
import PDFKit

/// A phone-sized reading surface over the same immutable sidecar used on iPad
/// and Mac. The pane's restricted access also rejects ink/text tool commands.
struct PhonePDFReader: View {
    @State private var pane: PDFWorkspacePane
    @State private var search = PhonePDFSearch()
    @State private var sheet: ReaderSheet?
    @State private var pageEntry = ""
    @State private var showsPageEntry = false
    @State private var closeWarning = false
    @State private var discardWarning = false
    @State private var note = ""
    @State private var preparingMark = false
    @State private var readingPublicationPending = false
    @State private var readTask = PhonePDFReadTask()
    @Environment(\.scenePhase) private var scenePhase
    let onClose: () -> Void
    var closeTitle: String = String(localized: "关闭")
    var sourceReference: PDFSourceReference?
    private struct NoteSelection {
        let id = UUID()
        let parts: [PDFReadingHighlight.Part]
        let sourceSHA256: String
    }
    private enum ReaderSheet: Identifiable {
        case search, marks, note(NoteSelection), ocr, outline, export(PDFFileExportRequest)
        var id: String {
            switch self {
            case .search: return "search"
            case .marks: return "marks"
            case .note(let selection): return "note-\(selection.id)"
            case .ocr: return "ocr"
            case .outline: return "outline"
            case .export(let request): return "export-\(request.id)"
            }
        }
    }

    init(rootURL: URL?, sourceURL: URL, page: Int = 1, sourceReference: PDFSourceReference? = nil, closeTitle: String? = nil, onClose: @escaping () -> Void) {
        _pane = State(initialValue: PDFWorkspacePane(rootURL: rootURL, sourceURL: sourceURL, page: page, access: .readingHighlights))
        self.onClose = onClose; self.sourceReference = sourceReference
        self.closeTitle = closeTitle ?? String(localized: "关闭")
    }
    private var busy: Bool { preparingMark || pane.isLoading || pane.isSaving || pane.hasPendingWrite || pane.interactionActive }
    private var closeBlocked: Bool { preparingMark || pane.isSaving || pane.hasPendingWrite || pane.interactionActive || !note.isEmpty }
    private var closeWarningTitle: String {
        if pane.hasPendingWrite || !note.isEmpty { return String(localized: "请先处理尚未保存的图层更改") }
        if pane.isSaving || preparingMark { return String(localized: "正在保存高亮或批注，请稍后返回") }
        return String(localized: "请先结束当前操作，再返回")
    }
    private var canMark: Bool { !pane.extensionMode && !pane.layerReplayActive && pane.rootURL != nil && pane.document != nil && !busy }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !pane.error.isEmpty { errorStatus }
                if pane.hasPendingWrite && pane.error.isEmpty { ProgressView().padding(4) }
                if pane.layerReplayActive {PDFLayerReplayControls(pane:pane)}
                if pane.extensionMode {PDFExtensionReader(pane:pane,store:pane.extensionStore,onExcerpt:nil)} else {
                PDFWorkspaceReader(pane: pane)
                    .overlay { if pane.document == nil && pane.isLoading { ProgressView() } }
                    .overlay { if pane.document == nil && !pane.isLoading { ContentUnavailableView(String(localized: "暂时无法打开 PDF"), systemImage: "doc", description: Text("请检查文件是否已下载，然后刷新重试。")) } }
                }
            }
            .background(.background)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) { PDFReadAloudControls(pane: pane); readingControls }
            }
            .navigationTitle(pane.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(closeTitle) {
                        if closeBlocked { closeWarning = true } else {
                            search.stop(); cancelRead(); pane.suspendReader(); pane.endReading(); onClose()
                        }
                    }.accessibilityIdentifier("phonePDF.close")
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { pane.chooseTool(.read); sheet = .export(.init(pane: pane)) } label: { Image(systemName: "square.and.arrow.down") }
                        .accessibilityLabel(String(localized: "导出 PDF")).accessibilityIdentifier("phonePDF.export")
                        .disabled(pane.document == nil || busy || pane.layerReplayActive || pane.extensionStore.busy || pane.extensionStore.pending != nil)
                    Button { pane.chooseTool(.read); sheet = .search } label: { Image(systemName: "magnifyingglass") }
                        .accessibilityLabel(String(localized: "搜索 PDF 文字")).accessibilityIdentifier("phonePDF.search")
                        .disabled(pane.document == nil || busy)
                    Button { pane.chooseTool(.read); sheet = .marks } label: { Image(systemName: "list.bullet.rectangle") }
                        .accessibilityLabel(String(localized: "高亮与批注")).accessibilityIdentifier("phonePDF.marks")
                        .disabled(pane.document == nil || busy)
                }
            }
            .sheet(item: $sheet) { target in
                switch target {
                case .search: PhonePDFSearchSheet(search: search, pane: pane)
                case .marks: PhonePDFMarksSheet(pane: pane)
                case .note(let selection): noteSheet(selection)
                case .ocr: LocalOCRView(rootURL: pane.rootURL, sourceURL: pane.sourceURL, page: pane.page)
                case .outline:PDFOutlineView(pane:pane)
                case .export(let request): PDFFileExportView(request: request)
                }
            }
            .alert(String(localized: "跳转到页码"), isPresented: $showsPageEntry) {
                TextField(String(localized: "页码"), text: $pageEntry).keyboardType(.numberPad)
                Button(String(localized: "取消"), role: .cancel) {}
                Button(String(localized: "前往")) { if let page = Int(pageEntry), (1...max(1,pane.pageCount)).contains(page) { pane.navigate(to: page) } }
            } message: { Text(String(localized: "输入 1 到 \(pane.pageCount) 之间的页码。")) }
            .alert(closeWarningTitle, isPresented: $closeWarning) { Button(String(localized: "继续阅读"), role: .cancel) {} }
            .confirmationDialog(String(localized: "放弃待发布更改？"), isPresented: $discardWarning, titleVisibility: .visible) {
                Button(String(localized: "放弃待发布更改"), role: .destructive) { Task { await pane.discardPending(); readingPublicationPending = false } }
            } message: { Text("已发布的记录仍保留；本机恢复副本不会删除。尚未发布的部分将不再重试。") }
        }
        .interactiveDismissDisabled(closeBlocked)
        .onAppear { pane.activateReader(); pane.pendingSourceReference = sourceReference; refreshRead() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { refreshRead() } }
        .onDisappear {
            search.stop(); cancelRead()
            // A background scene may remove its presentation while audio remains
            // active. Explicit close actions above always stop the reader.
            if scenePhase == .active {
                // Child sheets still depend on this PDF; only the reader's own
                // dismissal may release it. Pending edits retain their pane.
                if sheet?.id == nil && !closeBlocked { pane.suspendReader() }
                pane.endReading()
            }
        }
        .opensExternalLinksInApp()
    }
    private func refreshRead() { readTask.start { await pane.refresh() } }
    private func cancelRead() {
        // Invalidate the UI before cancellation can resume a queued read. The
        // repository worker keeps its security scope until its I/O really ends.
        pane.cancelRefresh(); readTask.cancel()
    }
    private var readingControls: some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Button { pane.navigate(to: pane.page - 1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .accessibilityLabel(String(localized: "上一页")).accessibilityIdentifier("phonePDF.previous").disabled(pane.page <= 1 || busy)
                Button { pageEntry = String(pane.page); showsPageEntry = true } label: {
                    Text(pane.pageCount > 0 ? "\(pane.page) / \(pane.pageCount)" : "—").font(.subheadline.monospacedDigit()).frame(minHeight: 44).contentShape(Rectangle())
                }.accessibilityLabel(String(localized: "跳转到页码")).accessibilityIdentifier("phonePDF.page").disabled(pane.pageCount == 0 || busy)
                Button { pane.navigate(to: pane.page + 1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .accessibilityLabel(String(localized: "下一页")).accessibilityIdentifier("phonePDF.next").disabled(pane.page >= pane.pageCount || busy)
                Spacer(minLength: 0)
                Button {
                    if pane.tool == .highlight { pane.chooseTool(.read) } else { highlightSelection(withNote: false) }
                } label: {
                    Label(pane.tool == .highlight ? String(localized: "完成") : String(localized: "高亮"), systemImage: pane.tool == .highlight ? "checkmark" : "highlighter")
                        .font(.subheadline.weight(.semibold)).padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                }.accessibilityIdentifier("phonePDF.highlight").disabled(!canMark)
                Menu {
                    Button(String(localized:"PDF 目录"),systemImage:"list.bullet.indent"){sheet = .outline}
                    Button(pane.extensionMode ? String(localized:"原页选字"):String(localized:"查看页内留白"),systemImage:"rectangle.split.1x2"){pane.chooseTool(.read);pane.extensionMode.toggle()}
                    Button(pane.layerReplayActive ? String(localized:"退出回放"):String(localized:"笔迹回放"),systemImage:"clock.arrow.circlepath"){pane.toggleLayerReplay()}
                    Button(String(localized: "为所选文字加批注"), systemImage: "text.bubble") { highlightSelection(withNote: true) }.disabled(!canMark)
                    Button(String(localized: "本机文字识别"), systemImage: "text.viewfinder") { pane.chooseTool(.read); sheet = .ocr }
                        .disabled(pane.document == nil || busy).accessibilityIdentifier("phonePDF.ocr")
                    Button(String(localized: "选择文字"), systemImage: "text.cursor") { pane.selectVisibleText() }
                        .disabled(pane.document == nil || busy || pane.layerReplayActive).accessibilityIdentifier("phonePDF.selectText")
                    Button(String(localized: "复制所选文字"), systemImage: "doc.on.doc") { pane.copyVisibleText() }
                        .disabled(pane.document == nil || busy || pane.layerReplayActive).accessibilityIdentifier("phonePDF.copySelectedText")
                    Button(String(localized: "区域高亮（扫描页）"), systemImage: "rectangle.dashed") { startAreaHighlight() }.disabled(!canMark)
                        .accessibilityIdentifier("phonePDF.areaHighlight")
                    Button(String(localized: "撤销"), systemImage: "arrow.uturn.backward") { Task { await pane.undo() } }.disabled(!pane.canUndo || busy)
                    Button(String(localized: "重做"), systemImage: "arrow.uturn.forward") { Task { await pane.redo() } }.disabled(!pane.canRedo || busy)
                    Button(String(localized: "刷新"), systemImage: "arrow.clockwise") { pane.chooseTool(.read); refreshRead() }.disabled(busy)
                } label: { Image(systemName: "ellipsis.circle").frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .accessibilityLabel(String(localized: "阅读选项")).accessibilityIdentifier("phonePDF.options")
            }.buttonStyle(.plain)
            Text(!pane.textSelectionStatus.isEmpty ? pane.textSelectionStatus : pane.tool == .highlight ? String(localized: "用手指拖出高亮区域，完成后自动回到阅读。") : pane.rootURL == nil ? String(localized: "请先授权 PDF 所在的资料文件夹，才能保存独立图层。") : String(localized: "长按选中文字，再点高亮。原 PDF 保持不变。"))
                // OCR progress must not resize the viewport that identifies its snapshot.
                .font(.caption2).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.bottom, 6)
                .accessibilityIdentifier("phonePDF.textSelectionStatus")
        }.padding(.horizontal, 4).background(.regularMaterial)
    }
    private var errorStatus: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(pane.error).font(.caption).foregroundStyle(.red).accessibilityIdentifier("phonePDF.status")
            if pane.hasPendingWrite {
                HStack {
                    Button(String(localized: "重试保存")) { Task {
                        await pane.retry()
                        if !pane.hasPendingWrite {
                            pane.chooseTool(.read)
                            if readingPublicationPending { readingPublicationPending = false; pane.pdfView?.clearSelection(); note = ""; sheet = nil }
                        }
                    } }.disabled(pane.isSaving).accessibilityIdentifier("phonePDF.retrySave")
                    Button(String(localized: "放弃待发布更改"), role: .destructive) { discardWarning = true }.disabled(pane.isSaving).accessibilityIdentifier("phonePDF.discardPending")
                }
                // This row is also embedded in the note Form. Automatic button
                // styling makes a Form row activate both actions on one tap.
                .buttonStyle(.bordered).font(.subheadline)
            }
        }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func highlightSelection(withNote: Bool) {
        guard canMark else { return }
        pane.chooseTool(.read)
        do {
            let parts = try PhonePDFSelection.capture(from: pane)
            if withNote {
                // The sheet owns this immutable selection snapshot. A previous
                // sheet's dismissal must never clear a newly presented quote.
                note = ""
                sheet = .note(NoteSelection(parts: parts, sourceSHA256: pane.sourceSHA256))
            }
            else { let sha = pane.sourceSHA256; Task { await save(parts, sourceSHA256: sha, note: "") } }
        } catch { pane.error = error.localizedDescription }
    }
    private func startAreaHighlight() {
        guard canMark else { return }
        preparingMark = true
        Task {
            defer { preparingMark = false }
            pane.pdfView?.clearSelection()
            if await pane.prepareReadingLayer() { pane.color = "#F2C94C"; pane.chooseTool(.highlight) }
        }
    }
    private func save(_ parts: [PDFReadingHighlight.Part], sourceSHA256: String, note: String) async {
        guard !preparingMark else { return }
        preparingMark = true; defer { preparingMark = false }
        do {
            guard pane.sourceSHA256 == sourceSHA256 else { throw PDFWorkspaceError.staleSource }
            guard await pane.prepareReadingLayer(), let layer = pane.selectedLayerID else { return }
            let marks = try PDFReadingHighlight.make(parts: parts, layerID: layer, sourceSHA256: sourceSHA256, note: note)
            readingPublicationPending = true
            if await pane.addReadingHighlights(marks) { readingPublicationPending = false; pane.pdfView?.clearSelection(); pane.error = ""; self.note = ""; sheet = nil }
            else if !pane.hasPendingWrite { readingPublicationPending = false }
        } catch { pane.error = error.localizedDescription }
    }
    private func noteSheet(_ selection: NoteSelection) -> some View {
        NavigationStack {
            Form {
                Section(String(localized: "选中文字")) { Text(selection.parts.map(\.text).joined(separator: "\n")).font(.callout).textSelection(.enabled).accessibilityIdentifier("phonePDF.selectedQuote") }
                Section(String(localized: "独立批注")) {
                    TextEditor(text: $note).frame(minHeight: 120).accessibilityIdentifier("phonePDF.note")
                    Text(String(localized: "\(note.unicodeScalars.count) / 4000 字符")).font(.caption).foregroundStyle(.secondary)
                }
                if !pane.error.isEmpty { errorStatus }
                Text("批注和高亮一起保存在独立图层；原 PDF 保持不变。").font(.caption).foregroundStyle(.secondary)
            }.navigationTitle(String(localized: "高亮与批注"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { note = ""; sheet = nil }.disabled(preparingMark || pane.isSaving || pane.hasPendingWrite) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "保存")) {
                            let draft = note
                            Task {
                                guard case .note(let active) = sheet, active.id == selection.id else { return }
                                await save(selection.parts, sourceSHA256: selection.sourceSHA256, note: draft)
                            }
                        }
                            .disabled(busy || note.unicodeScalars.count > 4000).accessibilityIdentifier("phonePDF.saveNote")
                    }
                }
        }.interactiveDismissDisabled(preparingMark || pane.isSaving || pane.hasPendingWrite || !note.isEmpty)
    }
}

/// One view-owned read, shared by appearance, foreground and explicit refresh.
/// A cancelled task may finish late; it must not release a newer read's handle.
@MainActor final class PhonePDFReadTask {
    private var task: Task<Void, Never>?
    private var generation = UUID()
    func start(_ operation: @escaping @MainActor () async -> Void) {
        guard task == nil else { return }
        let token = UUID(); generation = token
        task = Task {
            guard generation == token, !Task.isCancelled else { return }
            await operation()
            if generation == token { task = nil }
        }
    }
    func cancel() { generation = UUID(); task?.cancel(); task = nil }
}

@MainActor enum PhonePDFSelection {
    static func capture(from pane: PDFWorkspacePane) throws -> [PDFReadingHighlight.Part] {
        guard let view = pane.pdfView, let document = pane.document, let selection = view.currentSelection,
              let text = selection.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw SelectionError.empty }
        var parts: [PDFReadingHighlight.Part] = []
        for line in selection.selectionsByLine() {
            for page in line.pages {
                guard page.document === document else { throw PDFWorkspaceError.staleSource }
                let crop = view.convert(page.bounds(for: .cropBox), from: page)
                let selected = view.convert(line.bounds(for: page), from: page).intersection(crop)
                guard crop.width > 0, crop.height > 0, !selected.isNull, selected.width > 0, selected.height > 0 else { continue }
                let x = max(0,Double((selected.minX-crop.minX)/crop.width)), y = max(0,Double((selected.minY-crop.minY)/crop.height))
                let rect = PDFWorkspaceRect(x:x,y:y,width:min(1-x,Double(selected.width/crop.width)),height:min(1-y,Double(selected.height/crop.height)))
                guard rect.isValid else { continue }
                parts.append(.init(page:document.index(for:page)+1,rect:rect,text:line.string ?? ""))
                guard parts.count <= PDFReadingHighlight.maximumParts else { throw PDFWorkspaceError.tooLarge }
            }
        }
        guard !parts.isEmpty, parts.contains(where: { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { throw SelectionError.empty }
        return parts
    }
    private enum SelectionError: LocalizedError {
        case empty
        var errorDescription: String? { String(localized: "请先长按选中 PDF 文字。扫描页没有可选文字时，可在阅读选项中使用区域高亮。") }
    }
}

@MainActor @Observable final class PhonePDFSearch: NSObject {
    var query = ""
    private(set) var matches: [PDFSelection] = []
    private(set) var isSearching = false
    private(set) var limited = false
    private(set) var didSearch = false
    @ObservationIgnored private weak var document: PDFDocument?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var generation = UUID()
    func start(in document: PDFDocument?) {
        stop(); matches = []; limited = false; didSearch = true
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty, term.unicodeScalars.count <= 200, let document else { return }
        self.document = document; isSearching = true
        let token = generation
        observers = [
            NotificationCenter.default.addObserver(forName: .PDFDocumentDidFindMatch, object: document, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    guard let self, self.generation == token, self.isSearching,
                          let selection = notification.userInfo?["PDFDocumentFoundSelection"] as? PDFSelection,
                          selection.pages.first?.document === self.document else { return }
                    self.matches.append(selection)
                    if self.matches.count >= 200 { self.limited = true; self.stop() }
                }
            },
            NotificationCenter.default.addObserver(forName: .PDFDocumentDidEndFind, object: document, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.generation == token else { return }; self.isSearching = false
                }
            }
        ]
        document.beginFindString(term, withOptions: [.caseInsensitive, .diacriticInsensitive])
    }
    func stop() {
        generation = UUID()
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        document?.cancelFindString(); document = nil; isSearching = false
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

}

private struct PhonePDFSearchSheet: View {
    @Bindable var search: PhonePDFSearch
    let pane: PDFWorkspacePane
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                HStack {
                    TextField(String(localized: "搜索 PDF 文字"), text: $search.query).submitLabel(.search).onSubmit { search.start(in: pane.document) }.accessibilityIdentifier("phonePDF.searchQuery")
                    Button(String(localized: "搜索")) { search.start(in: pane.document) }.disabled(search.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || search.query.unicodeScalars.count > 200).accessibilityIdentifier("phonePDF.runSearch")
                }
                if search.isSearching { ProgressView() }
                if search.didSearch && !search.isSearching && search.matches.isEmpty { Text("没有匹配文字。扫描页可能没有文字层。").foregroundStyle(.secondary) }
                if search.limited { Text("已显示前 200 个结果，请缩短搜索范围。").font(.caption).foregroundStyle(.secondary) }
                ForEach(Array(search.matches.enumerated()), id: \.offset) { index, match in
                    Button {
                        guard let page = match.pages.first, page.document === pane.document else { return }
                        pane.navigate(to: pane.document!.index(for: page)+1)
                        pane.pdfView?.setCurrentSelection(match, animate: true); pane.pdfView?.go(to: match); dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(localized: "原文第 \(match.pages.first.flatMap { pane.document?.index(for: $0) }.map { $0+1 } ?? 1) 页"))
                            Text(String((match.string ?? "").prefix(300))).foregroundStyle(.secondary).lineLimit(3)
                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }.accessibilityIdentifier("phonePDF.searchResult.\(index)")
                }
            }.navigationTitle(String(localized: "搜索 PDF 文字"))
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("phonePDF.searchDone") } }
        }.onDisappear { search.stop() }
    }
}

private struct PhonePDFMarksSheet: View {
    @Bindable var pane: PDFWorkspacePane
    @Environment(\.dismiss) private var dismiss
    @State private var deleting: PDFWorkspaceAnnotation?
    private var marks: [PDFWorkspaceAnnotation] {
        pane.projection.annotations.filter { $0.sourceSHA256 == pane.sourceSHA256 }.sorted {
            if $0.page != $1.page { return $0.page < $1.page }; if $0.rect.y != $1.rect.y { return $0.rect.y < $1.rect.y }; return $0.rect.x < $1.rect.x
        }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("批注独立保存。其他设备打开同一 PDF 与其批注目录后可读取。").font(.caption).foregroundStyle(.secondary)
                    if marks.isEmpty { Text("尚无高亮或批注").foregroundStyle(.secondary) }
                    ForEach(marks) { mark in
                        let layer = pane.projection.layers.first { $0.id == mark.layerID }
                        HStack(alignment: .top) {
                            Button { pane.navigate(to: mark.page); dismiss() } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(String(localized: "原文第 \(mark.page) 页"))
                                    Text(mark.text.isEmpty ? (mark.kind == .highlight ? String(localized: "区域高亮") : mark.kind == .ink ? String(localized: "笔迹图层") : String(localized: "文字批注")) : mark.text).font(.callout).foregroundStyle(.primary)
                                    if let layer { Text(layer.name == PDFReadingHighlight.layerName ? String(localized: "阅读标记") : layer.name).font(.caption).foregroundStyle(.secondary) }
                                    if layer?.visible == false { Text("该图层已隐藏").font(.caption).foregroundStyle(.secondary) }
                                    if layer?.locked == true { Text("该图层已锁定").font(.caption).foregroundStyle(.secondary) }
                                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("phonePDF.mark."+mark.id.uuidString.lowercased())
                            if PDFReadingHighlight.allows(mark.kind) {
                                Button(role: .destructive) { deleting = mark } label: { Image(systemName: "trash").frame(width:44,height:44).contentShape(Rectangle()) }
                                    .buttonStyle(.borderless).accessibilityLabel(String(localized: "删除批注")).accessibilityIdentifier("phonePDF.delete."+mark.id.uuidString.lowercased())
                                    .disabled(pane.isSaving || pane.hasPendingWrite || layer?.locked != false || layer?.visible != true)
                            }
                        }
                    }
                }
                if pane.mismatchedVersionCount > 0 { Text(String(localized: "另有 \(pane.mismatchedVersionCount) 条属于其他 PDF 版本的批注，当前不叠加显示。")).font(.caption).foregroundStyle(.secondary) }
                ForEach(pane.projection.warnings, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                if !pane.error.isEmpty { Text(pane.error).foregroundStyle(.red).font(.caption) }
            }.navigationTitle(String(localized: "高亮与批注"))
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("phonePDF.marksDone") } }
                .confirmationDialog(String(localized: "删除这条独立批注？"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                    Button(String(localized: "删除批注"), role: .destructive) { if let mark = deleting { Task { await pane.deleteAnnotation(mark) } }; deleting = nil }
                } message: { Text("删除会同步到其他设备，可在本次阅读工作区撤销；原 PDF 不受影响。") }
        }.interactiveDismissDisabled(pane.isSaving)
    }
}

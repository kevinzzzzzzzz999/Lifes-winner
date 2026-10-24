import SwiftUI

struct BoardTitleSheet: View {
    let store: BoardStore
    let onCreate: (String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var directoryPath: String
    @State private var showsDirectoryPicker = false

    init(store: BoardStore, initialDirectoryPath: String? = nil, initialTitle: String? = nil,
         onCreate: @escaping (String, String) -> Void) {
        self.store = store
        self.onCreate = onCreate
        _title = State(initialValue: initialTitle ?? "")
        let currentDirectory = store.boardURL.flatMap { store.relativePath(for: $0) }
            .map { ($0 as NSString).deletingLastPathComponent }
        _directoryPath = State(initialValue: initialDirectoryPath ?? currentDirectory ?? "InkSpace")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "白板名称")) {
                    TextField(String(localized: "例如：线性代数 · 第一章"), text: $title)
                        .accessibilityIdentifier("newBoard.title")
                }
                Section(String(localized: "保存位置")) {
                    Button { showsDirectoryPicker = true } label: {
                        HStack {
                            Label(directoryPath.isEmpty ? String(localized: "仓库根目录") : directoryPath, systemImage: "folder")
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }.frame(minHeight: 44)
                    }
                    .disabled(store.library == nil)
                    .accessibilityIdentifier("newBoard.saveLocation")
                    Text(String(localized: "白板和 Obsidian 入口会一起保存到此文件夹。可选择 COURSE101 等课程主目录，与 week 或类别文件夹并列；不受 PDF 所在位置限制。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(String(localized: "新建白板")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "创建")) { onCreate(title, directoryPath); dismiss() }.fontWeight(.semibold)
                        .disabled(store.isBusy || store.vaultURL == nil)
                        .accessibilityIdentifier("newBoard.create")
                }
            }
            .sheet(isPresented: $showsDirectoryPicker) {
                if let library = store.library {
                    BoardSaveDirectoryPicker(library: library, initialPath: directoryPath) { directoryPath = $0 }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct BoardFilesSheet: View {
    let store: BoardStore
    @Environment(\.dismiss) private var dismiss
    @State private var files: [URL] = []
    @State private var isLoading = true
    @State private var query = ""

    private var filteredFiles: [URL] {
        query.isEmpty ? files : files.filter {
            (store.relativePath(for: $0) ?? $0.lastPathComponent).localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if isLoading { ProgressView(String(localized: "正在查找各文件夹中的白板…")) }
                if let warning = store.boardFilesWarning {
                    Text(warning).font(.footnote).foregroundStyle(.secondary)
                }
                if !isLoading && files.isEmpty && store.boardFilesWarning == nil {
                    ContentUnavailableView(String(localized: "还没有白板"), systemImage: "rectangle.on.rectangle",
                                           description: Text(String(localized: "从“白板”菜单新建一个，开始书写。")))
                }
                ForEach(filteredFiles, id: \.self) { url in
                    Button {
                        guard let path = store.relativePath(for: url) else { return }
                        Task { await store.openBoard(relativePath: path) }
                        dismiss()
                    } label: {
                        HStack {
                            Image(systemName: "rectangle.and.pencil.and.ellipsis")
                            VStack(alignment: .leading, spacing: 4) {
                                Text(url.lastPathComponent.replacingOccurrences(of: ".inkspace.json", with: ""))
                                let parent = (store.relativePath(for: url) as NSString?)?.deletingLastPathComponent ?? ""
                                Text(parent.isEmpty ? String(localized: "仓库根目录") : parent).font(.caption).foregroundStyle(.secondary)
                            }
                        }.frame(minHeight: 44)
                    }
                }
            }
            .searchable(text: $query, prompt: String(localized: "搜索白板名称或课程目录"))
            .navigationTitle(String(localized: "打开白板")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button(String(localized: "刷新")) { Task { await reload() } }.disabled(isLoading) }
            }
            .task { await reload() }
        }
    }

    private func reload() async {
        isLoading = true
        let result = await store.boardFiles()
        guard !Task.isCancelled else { return }
        files = result
        isLoading = false
    }
}

struct BoardItemEditor: View {
    let store: BoardStore
    let existing: BoardItem?
    let kind: BoardItemKind
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var content = ""
    @State private var textHistory = DraftTextHistory()
    @State private var richEditor = BoardRichTextEditorModel()
    @State private var savingRichText = false
    @State private var editorCancelled = false
    @State private var link = ""
    @State private var errorMessage: String?
    @State private var editingBoardID: UUID?
    @State private var editingSessionID: UUID?
    @State private var baselineItem: BoardItem?
    @State private var imageScale = 1.0
    @State private var insertingWebLink = false
    @State private var insertedLinks: [BoardTextWebLinks.Link] = []
    @State private var linkedTextSnapshot = ""
    @FocusState private var focusedField: EditorField?
    private enum EditorField: Hashable { case title, content }

    private var isWebCard: Bool { (baselineItem ?? existing).map(BoardWebCardContent.isCard) ?? false }
    private var hasTextContent: Bool { kind == .text || kind == .formula }
    private var editsRichHTML: Bool { kind == .text && existing?.resolvedBoxTextFormat == "richText" && existing?.richTextHTML?.isEmpty == false }
    private var isImage: Bool { (baselineItem ?? existing).map(BoardImageResizing.isImage) ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "标题")) { TextField(String(localized: "节点标题"), text: $title).accessibilityIdentifier("boardItem.title").focused($focusedField, equals: .title) }
                if hasTextContent && !isWebCard {
                    Section(kind == .formula ? String(localized: "LaTeX 公式") : String(localized: "文字")) {
                        if !editsRichHTML { HStack {
                            Button(String(localized: "撤销"), systemImage: "arrow.uturn.backward") { if let value = textHistory.undo() { content = value } }
                                .disabled(!textHistory.canUndo).accessibilityIdentifier("boardItem.undo")
                            Button(String(localized: "重做"), systemImage: "arrow.uturn.forward") { if let value = textHistory.redo() { content = value } }
                                .disabled(!textHistory.canRedo).accessibilityIdentifier("boardItem.redo")
                        }.buttonStyle(.bordered) }
                        if kind == .text {
                            Button(String(localized: "插入网页链接"), systemImage: "link") { insertingWebLink = true }
                                .frame(minHeight: 44).accessibilityIdentifier("boardItem.insertLink")
                        }
                        if editsRichHTML, let existing { BoardRichTextEditor(model:richEditor,item:existing) }
                        else { TextEditor(text: $content)
                            .focused($focusedField, equals: .content)
                            .accessibilityIdentifier("boardItem.content")
                            .font(kind == .formula ? .system(.body, design: .monospaced) : .body)
                            .frame(minHeight: 180)
                            .autocorrectionDisabled(kind == .formula) }
                        if kind == .formula {
                            Text(String(localized: "例如：\\int_0^1 x^2 \\, dx = \\frac{1}{3}。输入公式本体即可，无需外层 $$。"))
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                if kind == .document || kind == .pdfPage {
                    Text(String(localized: "这里修改白板资料卡的标题和链接；文件正文请从“打开链接或原文”进入。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if isImage, let image = baselineItem ?? existing {
                    Section(String(localized: "图片比例")) {
                        HStack {
                            Text("\(Int((imageScale * 100).rounded()))%")
                                .monospacedDigit().accessibilityIdentifier("imageResize.percent")
                            Spacer()
                            Text("\(Int((image.width * imageScale).rounded())) × \(Int((image.height * imageScale).rounded()))")
                                .foregroundStyle(.secondary).monospacedDigit()
                        }
                        Slider(value: $imageScale, in: 0.25...2, step: 0.05)
                            .accessibilityLabel(String(localized: "图片比例"))
                            .accessibilityIdentifier("imageResize.scale")
                        Button(String(localized: "恢复 100%")) { imageScale = 1 }
                        Text(String(localized: "以当前尺寸为 100%，保持长宽比。图片内的完整笔迹会一起缩放；跨边界笔画或重叠页面会阻止调整。点保存才应用，取消会保留原尺寸。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section(isWebCard ? String(localized: "网页地址") : String(localized: "跳转链接（可选）")) {
                    TextField(String(localized: "https://… 或 obsidian://…"), text: $link)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Text(String(localized: "在整理模式选中节点，再点“打开链接或原文”。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle(existing == nil ? (kind == .formula ? String(localized: "添加公式") : String(localized: "添加文字")) : String(localized: "编辑节点"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { editorCancelled = true;richEditor.close();dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "保存")) { Task { await saveItem() } }.fontWeight(.semibold)
                        .disabled(savingRichText || (editsRichHTML && (!richEditor.ready || richEditor.busy)) || store.isBusy || (isImage && store.isSaving) || editingBoardID != store.document.id)
                        .accessibilityIdentifier("boardItem.save")
                }
            }
            .sheet(isPresented: $insertingWebLink) {
                BoardInlineLinkSheet { label, url in
                    if editsRichHTML { Task { await richEditor.appendLink(label:label,url:url) }; return }
                    // Append is explicit and preserves the existing text; no web request is made.
                    if existing?.resolvedBoxTextFormat == "markdown" {
                        let escapedLabel = label.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
                        content += (content.isEmpty || content.hasSuffix("\n") ? "" : "\n") + "[\(escapedLabel)](\(url.absoluteString))"
                        return
                    }
                    let oldText = content
                    var known = BoardTextWebLinks.links(text: oldText, html: existing?.richTextHTML)
                    if !insertedLinks.isEmpty { known.append(contentsOf: BoardTextWebLinks.links(text: oldText, html: BoardTextWebLinks.richHTML(text: linkedTextSnapshot, links: insertedLinks))) }
                    let prefix = oldText.isEmpty || oldText.hasSuffix("\n") ? "" : "\n"
                    content = oldText + prefix + label
                    let range = NSRange(location: (oldText + prefix).utf16.count, length: label.utf16.count)
                    insertedLinks = known + [BoardTextWebLinks.Link(range: range, url: url)]
                    linkedTextSnapshot = content
                }
            }
            .interactiveDismissDisabled()
            .onChange(of: content) { _, value in textHistory.track(value) }
            .onDisappear { richEditor.close() }
            .onAppear {
                guard editingBoardID == nil else { return }
                editingBoardID = store.document.id; editingSessionID = store.canvasSessionID; baselineItem = existing
                title = existing?.title ?? (kind == .formula ? String(localized: "公式") : String(localized: "想法"))
                content = existing?.text ?? ""; textHistory.reset(content)
                link = existing?.url ?? ""
                focusedField = hasTextContent ? .content : .title
            }
        }
    }

    private func saveItem() async {
        guard !savingRichText else { return }
        savingRichText = true; defer { savingRichText = false;Task { await richEditor.finishSaving() } }
        let richValue: BoardRichTextValue?
        do { richValue = editsRichHTML ? try await richEditor.snapshot() : nil }
        catch { errorMessage = error.localizedDescription; return }
        guard !editorCancelled, store.canEditBoardContents, editingBoardID == store.document.id, !store.isBusy, !(isImage && store.isSaving) else {
            errorMessage = String(localized: "白板正在处理或已切换，请稍后重新打开编辑。"); return
        }
        let normalizedLink = link.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedLink.isEmpty {
            guard let url = URL(string: normalizedLink),
                  ["https", "http", "obsidian", "inkspace"].contains(url.scheme?.lowercased() ?? "") else {
                errorMessage = String(localized: "请输入完整的网页、Obsidian 或人生赢家链接。")
                return
            }
        }
        if isWebCard && BoardWebCardContent.safeURL(normalizedLink) == nil {
            errorMessage = String(localized: "网页卡需要完整、不含账号密码的 http / https 地址。"); return
        }
        let linkHTMLSource = insertedLinks.isEmpty ? existing?.richTextHTML : BoardTextWebLinks.richHTML(text: linkedTextSnapshot, links: insertedLinks)
        let knownLinks = BoardTextWebLinks.links(text: content, html: linkHTMLSource)
        let preserveSourceFormat = ["markdown", "latex", "python"].contains(existing?.resolvedBoxTextFormat ?? "")
        let linkedHTML = knownLinks.isEmpty || preserveSourceFormat ? nil : BoardTextWebLinks.richHTML(text: content, links: knownLinks)
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if let existing = baselineItem ?? existing {
            guard let index = store.document.items.firstIndex(where: { $0.id == existing.id }) else {
                errorMessage = String(localized: "这个节点已不存在，请关闭编辑后重试。"); return
            }
            do {
                var nextDocument = store.document
                var nextDrawing = store.drawing
                if isImage && imageScale != 1 {
                    guard let baselineItem, nextDocument.items[index] == baselineItem else {
                        errorMessage = String(localized: "图片在编辑期间已发生变化，请关闭后重新打开。"); return
                    }
                    let resized = try BoardImageResizing.resize(document: nextDocument, drawing: nextDrawing, itemID: existing.id, scale: imageScale)
                    nextDocument = resized.document; nextDrawing = resized.drawing
                }
                if richValue != nil, let baselineItem, nextDocument.items[index] != baselineItem {
                    errorMessage = String(localized:"内容在编辑期间已变化，请关闭后重新打开。");return
                }
                nextDocument.items[index].title = cleanTitle.isEmpty ? existing.title : cleanTitle
                if isWebCard { nextDocument.items[index].text = normalizedLink; nextDocument.items[index].textFormat = "web" }
                else if let richValue {
                    nextDocument.items[index].text = richValue.text
                    nextDocument.items[index].richTextHTML = richValue.html
                }
                else if hasTextContent {
                    nextDocument.items[index].updatePlainText(content)
                    if let linkedHTML, kind == .text { nextDocument.items[index].richTextHTML = linkedHTML; nextDocument.items[index].textFormat = "richText" }
                }
                nextDocument.items[index].url = normalizedLink.isEmpty ? nil : normalizedLink
                if hasTextContent {
                    guard let editingBoardID, let editingSessionID,
                          store.commitExistingTextEdit(nextDocument.items[index], expected: existing,
                                                       boardID: editingBoardID, sessionID: editingSessionID) else {
                        errorMessage = store.status; return
                    }
                } else {
                    store.document = nextDocument
                    store.drawing = nextDrawing
                    store.changed()
                }
            } catch { DiagnosticsCenter.shared.record(code: .documentRenderFailed, operation: .renderDocument, error: error, severity: .warning); errorMessage = error.localizedDescription; return }
        } else {
            let width = kind == .formula ? 460.0 : 400.0
            let height = kind == .formula ? 180.0 : 260.0
            let item = BoardItem(kind: kind,
                                 x: min(max(0, store.usesPhoneInterface ? Double(store.insertionPoint?.x ?? store.viewportCenter.x) : Double(store.viewportCenter.x) - width / 2), store.document.canvasWidth - width),
                                 y: min(max(0, store.usesPhoneInterface ? Double(store.insertionPoint?.y ?? store.viewportCenter.y) : Double(store.viewportCenter.y) - height / 2), store.document.canvasHeight - height),
                                 width: width, height: height,
                                 title: cleanTitle.isEmpty ? String(localized: "想法") : cleanTitle,
                                 text: content, textFormat: linkedHTML == nil ? nil : "richText", richTextHTML: linkedHTML, url: normalizedLink.isEmpty ? nil : normalizedLink)
            store.addItem(item)
            if store.usesPhoneInterface { store.insertionPoint = nil; store.beginPhoneReading() }
            else { store.mode = .arrange }
        }
        dismiss()
    }
}

struct BoardPinsSheet: View {
    @Bindable var store: BoardStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var selecting = false
    @State private var selectedPins: Set<UUID> = []
    private var canChangePins: Bool { store.canEditBoardContents && !store.isBusy && !store.externalInteractionActive }

    var body: some View {
        NavigationStack {
            Form {
                if !store.isPadReading { Section(String(localized: "记住当前位置和缩放")) {
                    TextField(String(localized: "例如：重点公式"), text: $title)
                    Button(String(localized: "添加定位点"), systemImage: "mappin") {
                        let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
                        store.pin(title: value.isEmpty ? String(localized: "位置 \(store.document.pins.count + 1)") : value)
                        title = ""
                    }.frame(minHeight: 44).disabled(!canChangePins)
                }
                }
                Section(String(localized: "跳到定位点")) {
                    if store.document.pins.isEmpty { Text(String(localized: "尚无定位点")).foregroundStyle(.secondary) }
                    ForEach(store.document.pins) { pin in
                        HStack(spacing: 12) {
                            if selecting {
                                Button {
                                    if selectedPins.contains(pin.id) { selectedPins.remove(pin.id) }
                                    else { selectedPins.insert(pin.id) }
                                } label: { Image(systemName: selectedPins.contains(pin.id) ? "checkmark.circle.fill" : "circle") }
                                .buttonStyle(.borderless).accessibilityLabel(String(localized: "选择定位点") + " " + pin.title)
                            }
                            Button {
                                store.jump(to: pin)
                                dismiss()
                            } label: { HStack {
                                Label(pin.title, systemImage: "mappin.circle")
                                Spacer()
                                Text(pin.zoom.isFinite ? "\(Int(min(1_000_000, max(0, pin.zoom * 100))))%" : "—").foregroundStyle(.secondary)
                            }.frame(minHeight: 44) }.buttonStyle(.borderless)
                            Button(role: .destructive) {
                                if store.deletePin(pin.id) { selectedPins.remove(pin.id) }
                            } label: { Image(systemName: "trash").frame(minWidth: 44, minHeight: 44) }
                            .buttonStyle(.borderless).disabled(!canChangePins)
                            .accessibilityLabel(String(localized: "删除定位点") + " " + pin.title)
                            .accessibilityIdentifier("pin.delete.\(pin.id.uuidString)")
                        }
                    }
                }
                if selecting {
                    Section {
                        Button(String(localized: "全选")) { selectedPins = Set(store.document.pins.map(\.id)) }
                        Button(role: .destructive) {
                            if store.deletePins(selectedPins) { selectedPins.removeAll(); selecting = false }
                        } label: { Label(String(localized: "删除所选定位点") + " (\(selectedPins.count))", systemImage: "trash") }
                        .disabled(!canChangePins || selectedPins.isEmpty).accessibilityIdentifier("pins.deleteSelected")
                    }
                }
                if !store.canEditBoardContents { Text(String(localized: "切换到书写或整理模式后，可以添加和删除定位点。")).font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle(String(localized: "白板定位")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button(selecting ? String(localized: "完成选择") : String(localized: "多选")) { selecting.toggle(); selectedPins.removeAll() }
                        .disabled(!canChangePins || store.document.pins.isEmpty).accessibilityIdentifier("pins.select")
                }
            }
            .onChange(of: store.document.pins.map(\.id)) { _, ids in selectedPins.formIntersection(Set(ids)) }
        }
    }
}

struct SavedPenChip: View {
    let pen: SavedPen
    let isSelected: Bool
    let onSelect: () -> Void
    let onEdit: () -> Void

    private var label: some View {
        HStack(spacing: 7) {
            SavedPenSwatch(pen: pen)
            Text(pen.name).lineLimit(1)
            if isSelected { Image(systemName: "checkmark").font(.caption.weight(.semibold)) }
        }
        .font(.callout).foregroundStyle(.primary)
        .padding(.horizontal, 12).frame(minHeight: 44)
        .background(isSelected ? Color.teal.opacity(0.12) : Color.primary.opacity(0.045), in: Capsule())
        .overlay(Capsule().strokeBorder(isSelected ? Color.teal : Color.secondary.opacity(0.2), lineWidth: 1))
        .contentShape(Capsule())
    }
    private var tapGesture: some Gesture {
        TapGesture(count: 2).exclusively(before: TapGesture()).onEnded { result in
            switch result { case .first: onEdit(); case .second: onSelect() }
        }
    }
    private var traits: AccessibilityTraits { isSelected ? [.isButton, .isSelected] : .isButton }
    private var spokenValue: String {
        String(localized: "\(pen.kind.title)，粗细 \(pen.width.formatted(.number.precision(.fractionLength(1)))) 点")
    }
    var body: some View {
        label.gesture(tapGesture)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(pen.name)
            .accessibilityValue(spokenValue)
            .accessibilityAddTraits(traits)
            .accessibilityHint(String(localized: "单击使用，双击编辑；长按拖动排序或打开快捷菜单"))
            .accessibilityAction { onSelect() }
            .accessibilityIdentifier("savedPen.chip.\(pen.id.uuidString)")
    }
}

private struct SavedPenSwatch: View {
    let pen: SavedPen

    var body: some View {
        Circle().fill(.white)
            .overlay(Circle().fill(savedPenPreviewColor(pen)))
            .overlay(Circle().strokeBorder(.secondary.opacity(0.35), lineWidth: 1))
            .frame(width: 20, height: 20)
            .accessibilityHidden(true)
    }
}

struct SavedPensSheet: View {
    let store: BoardStore
    @Environment(\.dismiss) private var dismiss
    @State private var editor: PenEditorRoute?
    @State private var editMode: EditMode = .inactive
    @State private var lineSettings = BoardPencilLineSettings.load()
    @State private var shapeSettings = BoardPencilShapeSettings.load()
    @State private var underlaySettings = BoardHighlighterUnderlaySettings.load()

    private enum PenEditorRoute: Identifiable {
        case create, broadLine, edit(SavedPen), duplicate(SavedPen)
        var id: String {
            switch self {
            case .create: "new-pen"
            case .broadLine: "new-broad-line"
            case .edit(let pen): pen.id.uuidString
            case .duplicate(let pen): "duplicate-" + pen.id.uuidString
            }
        }
    }

    private var missingUtilities: [NativePaletteEntry] {
        NativePaletteEntry.utilities.filter { !store.nativePaletteEntries.contains($0) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if store.nativePaletteEntries.isEmpty {
                        ContentUnavailableView(String(localized: "原生笔栏中还没有工具"), systemImage: "pencil.tip.crop.circle.badge.plus",
                            description: Text(String(localized: "添加一支笔或下方的系统工具。展开原生笔栏后，点加号可以打开这里。")))
                    }
                    ForEach(store.nativePaletteEntries) { entry in
                        paletteRow(entry)
                            .contextMenu { entryActions(entry) }
                            .accessibilityAction(named: String(localized: "向前移动")) { move(entry, offset: -1) }
                            .accessibilityAction(named: String(localized: "向后移动")) { move(entry, offset: 1) }
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("nativePalette.row.\(entry.id)")
                    }
                    .onDelete(perform: deleteEntries)
                    .onMove { offsets, destination in
                        guard !store.isBusy else { return }
                        store.moveNativePaletteEntries(fromOffsets: offsets, toOffset: destination)
                    }
                } header: {
                    Text(String(localized: "原生笔栏中的工具"))
                } footer: {
                    Text(String(localized: "这里的顺序就是苹果浮动笔栏的顺序。笔、橡皮擦、圈选和直尺都可以排序或移除；移除系统工具后可在下方加回。设置保存在这台 iPad，已有笔迹不受影响。"))
                }
                if !missingUtilities.isEmpty {
                    Section(String(localized: "可添加的系统工具")) {
                        ForEach(missingUtilities) { entry in
                            Button { store.restoreNativePaletteUtility(entry) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: utilitySymbol(entry)).frame(width: 24)
                                    Text(utilityTitle(entry))
                                    Spacer(minLength: 8)
                                    Image(systemName: "plus.circle")
                                }.frame(minHeight: 44)
                            }
                            .accessibilityLabel(String(localized: "添加\(utilityTitle(entry))"))
                            .accessibilityIdentifier("nativePalette.restore.\(entry.id)")
                        }
                    }
                }
                Section(String(localized: "辅助笔")) {
                    NavigationLink {
                        BoardWritingAidSettingsView(controller: store.writingAids, canEdit: store.canEditBoardContents)
                    } label: {
                        Label(store.writingAids.mode == .off ? String(localized: "激光、波浪、填色、胶带与手写文字") : store.writingAids.mode.title, systemImage: "wand.and.stars")
                    }.accessibilityIdentifier("writingAid.settings")
                }
                Section {
                    Toggle(String(localized: "新画的荧光笔置于其他笔迹下方"), isOn: $underlaySettings.isEnabled)
                        .accessibilityIdentifier("pencil.marker.underlay")
                } header: { Text(String(localized: "荧光笔置底")) }
                footer: { Text(String(localized: "默认关闭，仅影响当前画布中新写的自由笔迹，不移动已有笔迹或资料。撤销可恢复原叠放顺序。")) }
                Section(String(localized: "粗线笔")) {
                    Button { editor = .broadLine } label: {
                        Label(String(localized: "添加粗线笔"), systemImage: "line.diagonal")
                    }.accessibilityIdentifier("savedPen.addBroadLine")
                    Text(String(localized: "单线笔可绘制最高 64 点的实线。已有常用笔及笔迹保持原样。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Toggle(String(localized: "停笔拉直"), isOn: $lineSettings.isEnabled)
                        .accessibilityIdentifier("pencil.holdLine.enabled")
                    if lineSettings.isEnabled || shapeSettings.shape != .off {
                        HStack {
                            Text(String(localized: "按住时间")); Spacer()
                            Text(String(localized: "\(lineSettings.holdDuration.formatted(.number.precision(.fractionLength(2)))) 秒"))
                                .monospacedDigit().foregroundStyle(.secondary)
                        }
                        Slider(value: $lineSettings.holdDuration, in: BoardPencilLineSettings.durationRange, step: 0.05,
                               onEditingChanged: { active in if !active { lineSettings.save() } })
                            .accessibilityLabel(String(localized: "停笔拉直的按住时间"))
                            .accessibilityIdentifier("pencil.holdLine.duration")
                    }
                } header: { Text(String(localized: "画线")) }
                footer: {
                    Text(String(localized: "画一段较直的线，笔尖停住会出现直线预览；抬笔确认，继续移动或取消保留原笔迹。撤销一次可恢复原来的线。"))
                }
                Section {
                    Picker(String(localized: "辅助形状"), selection: $shapeSettings.shape) {
                        ForEach(BoardPencilShapeSettings.Shape.allCases, id: \.self) { shape in
                            Text(shape.title).tag(shape)
                        }
                    }
                    .accessibilityIdentifier("pencil.geometry.shape")
                    if shapeSettings.shape != .off {
                        Button(String(localized: "关闭几何辅助")) { shapeSettings.shape = .off }
                            .accessibilityIdentifier("pencil.geometry.disable")
                    }
                } header: { Text(String(localized: "几何辅助")) }
                footer: {
                    Text(String(localized: "默认关闭。选择形状后，用笔画一个闭合轮廓并停住，抬笔确认预览；箭头只需画一段较直的线，坐标轴画一组相交的横纵线。继续移动可取消预览，撤销一次可恢复原笔迹。写字前请关闭几何辅助。"))
                }
            }
            .onChange(of: underlaySettings.isEnabled) { _, _ in underlaySettings.save() }
            .onChange(of: lineSettings.isEnabled) { _, _ in lineSettings.save() }
            .onChange(of: shapeSettings.shape) { _, _ in shapeSettings.save() }
            .environment(\.editMode, $editMode)
            .navigationTitle(String(localized: "编辑原生笔栏")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "关闭")) { dismiss() }
                        .accessibilityIdentifier("nativePalette.close")
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button(editMode.isEditing ? String(localized: "完成排序") : String(localized: "排序与删除")) {
                        withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                    }
                    .disabled(store.nativePaletteEntries.isEmpty)
                    .accessibilityIdentifier("savedPen.manageOrder")
                    Button(String(localized: "添加笔"), systemImage: "plus") { editor = .create }
                        .labelStyle(.titleAndIcon)
                        .accessibilityIdentifier("savedPen.add")
                }
            }
            .sheet(item: $editor) { route in
                switch route {
                case .create: SavedPenEditor(store: store, existing: nil)
                case .broadLine:
                    SavedPenEditor(store: store, existing: nil, creating:
                        SavedPen(name: String(localized: "粗线笔"), kind: .monoline, width: 24))
                case .edit(let pen): SavedPenEditor(store: store, existing: pen)
                case .duplicate(let pen): SavedPenEditor(store: store, existing: nil, copying: pen)
                }
            }
        }
        .disabled(store.isBusy)
    }

    @ViewBuilder private func paletteRow(_ entry: NativePaletteEntry) -> some View {
        if case .pen(let id) = entry, let pen = store.savedPens.first(where: { $0.id == id }) {
            HStack(spacing: 12) {
                Button {
                    guard !store.isBusy else { return }
                    store.selectSavedPen(pen.id)
                    dismiss()
                } label: {
                    HStack(spacing: 12) {
                        SavedPenSwatch(pen: pen)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pen.name).foregroundStyle(.primary)
                            Text(String(localized: "\(pen.kind.title) · \(pen.width.formatted(.number.precision(.fractionLength(1)))) 点"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        if store.selectedSavedPenID == pen.id {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.teal)
                        }
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .disabled(editMode.isEditing)
                .accessibilityHint(String(localized: "使用这支笔并返回白板"))
                .accessibilityAddTraits(store.selectedSavedPenID == pen.id ? .isSelected : [])
                .accessibilityIdentifier("nativePalette.select.\(entry.id)")
                Button(String(localized: "编辑")) { editor = .edit(pen) }
                    .buttonStyle(.borderless).frame(minHeight: 44)
                    .accessibilityLabel(String(localized: "编辑\(pen.name)"))
                    .accessibilityIdentifier("savedPen.edit.\(pen.id.uuidString)")
            }
        } else {
            HStack(spacing: 12) {
                Image(systemName: utilitySymbol(entry)).font(.title3).frame(width: 24)
                    .foregroundStyle(.teal).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(utilityTitle(entry))
                    Text(utilityDescription(entry)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
            }.frame(minHeight: 44).contentShape(Rectangle())
        }
    }

    @ViewBuilder private func entryActions(_ entry: NativePaletteEntry) -> some View {
        if case .pen(let id) = entry, let pen = store.savedPens.first(where: { $0.id == id }) {
            Button(String(localized: "编辑"), systemImage: "slider.horizontal.3") { editor = .edit(pen) }
            Button(String(localized: "复制为新笔"), systemImage: "doc.on.doc") { editor = .duplicate(pen) }
                .accessibilityIdentifier("nativePalette.duplicate.\(entry.id)")
        }
        Button(String(localized: "向前移动"), systemImage: "arrow.up") { move(entry, offset: -1) }
            .disabled(store.nativePaletteEntries.first == entry)
            .accessibilityIdentifier("nativePalette.moveUp.\(entry.id)")
        Button(String(localized: "向后移动"), systemImage: "arrow.down") { move(entry, offset: 1) }
            .disabled(store.nativePaletteEntries.last == entry)
            .accessibilityIdentifier("nativePalette.moveDown.\(entry.id)")
        Button(entry.isUtility ? String(localized: "从笔栏移除") : String(localized: "删除这支笔"), systemImage: "trash", role: .destructive) {
            store.removeNativePaletteEntry(entry)
        }
        .accessibilityIdentifier("nativePalette.delete.\(entry.id)")
    }

    private func move(_ entry: NativePaletteEntry, offset: Int) {
        guard !store.isBusy, let index = store.nativePaletteEntries.firstIndex(of: entry),
              store.nativePaletteEntries.indices.contains(index + offset) else { return }
        store.moveNativePaletteEntries(fromOffsets: IndexSet(integer: index), toOffset: index + offset + (offset > 0 ? 1 : 0))
    }

    private func deleteEntries(at offsets: IndexSet) {
        guard !store.isBusy else { return }
        let entries = offsets.compactMap { store.nativePaletteEntries.indices.contains($0) ? store.nativePaletteEntries[$0] : nil }
        for entry in entries { store.removeNativePaletteEntry(entry) }
    }

    private func utilityTitle(_ entry: NativePaletteEntry) -> String {
        switch entry {
        case .eraser: String(localized: "橡皮擦")
        case .lasso: String(localized: "圈选")
        case .ruler: String(localized: "直尺")
        case .pen: String(localized: "笔")
        }
    }

    private func utilitySymbol(_ entry: NativePaletteEntry) -> String {
        switch entry {
        case .eraser: "eraser"
        case .lasso: "lasso"
        case .ruler: "ruler"
        case .pen: "pencil.tip"
        }
    }

    private func utilityDescription(_ entry: NativePaletteEntry) -> String {
        switch entry {
        case .eraser: String(localized: "擦除白板上的手写笔迹。")
        case .lasso: String(localized: "圈选并移动手写笔迹。")
        case .ruler: String(localized: "辅助绘制直线。")
        case .pen: ""
        }
    }
}

struct SavedPenEditor: View {
    let store: BoardStore
    private let isEditing: Bool
    @State private var draft: SavedPen
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.self) private var environment

    init(store: BoardStore, existing: SavedPen?, copying: SavedPen? = nil, creating: SavedPen? = nil) {
        self.store = store
        isEditing = existing != nil
        var initial = existing ?? copying ?? creating ?? SavedPen()
        if copying != nil && existing == nil {
            initial.id = UUID()
            initial.name += String(localized: " 副本")
        }
        _draft = State(initialValue: initial)
    }

    private var selectedColor: Binding<Color> {
        Binding {
            savedPenPreviewColor(draft)
        } set: { color in
            let resolved = color.resolve(in: environment)
            draft.red = min(1, max(0, Double(resolved.red)))
            draft.green = min(1, max(0, Double(resolved.green)))
            draft.blue = min(1, max(0, Double(resolved.blue)))
            draft.alpha = min(1, max(0, Double(resolved.opacity)))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "名称")) {
                    TextField(String(localized: "例如：蓝色细钢笔"), text: $draft.name)
                        .accessibilityIdentifier("savedPen.name")
                }
                Section(String(localized: "笔型")) {
                    Picker(String(localized: "笔型"), selection: $draft.kind) {
                        ForEach(SavedPenKind.supportedCases) { kind in Text(kind.title).tag(kind) }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("savedPen.kind")
                }
                Section(String(localized: "颜色与透明度")) {
                    ColorPicker(String(localized: "自选颜色"), selection: selectedColor, supportsOpacity: true)
                        .accessibilityIdentifier("savedPen.color")
                    Text(String(localized: "不透明度 \(Int((draft.alpha * 100).rounded()))%"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section(String(localized: "粗细")) {
                    HStack {
                        Text(String(localized: "线宽"))
                        Spacer()
                        Text(String(localized: "\(draft.width.formatted(.number.precision(.fractionLength(1)))) 点"))
                            .monospacedDigit().foregroundStyle(.secondary)
                    }
                    Slider(value: $draft.width, in: draft.kind.minimumWidth...draft.kind.maximumWidth) {
                        Text(String(localized: "线宽"))
                    } minimumValueLabel: {
                        Image(systemName: "minus")
                    } maximumValueLabel: {
                        Image(systemName: "plus")
                    }
                    .accessibilityValue(String(localized: "\(draft.width.formatted(.number.precision(.fractionLength(1)))) 点"))
                    .accessibilityIdentifier("savedPen.width")
                    if draft.kind == .monoline {
                        HStack {
                            ForEach([12.0, 24, 48], id: \.self) { width in
                                Button { draft.width = width } label: { Text(String(localized: "\(Int(width)) 点")) }
                                    .buttonStyle(.bordered).frame(maxWidth: .infinity)
                                    .accessibilityIdentifier("savedPen.broadWidth.\(Int(width))")
                            }
                        }
                    } else {
                        Text(String(localized: "更宽的实线可选择单线笔，支持 12、24、48 点粗细。"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section {
                    SavedPenStrokePreview(pen: draft)
                } header: {
                    Text(String(localized: "预览"))
                } footer: {
                    Text(String(localized: "预览显示颜色与粗细；实际笔触随笔型和书写力度变化。常用笔保存在这台 iPad，切换白板或重开 App 后仍保留。"))
                }
                if isEditing {
                    Section {
                        Button(String(localized: "另存为新笔"), systemImage: "doc.on.doc") { savePen(asNew: true) }
                            .accessibilityIdentifier("savedPen.saveAsNew")
                    } footer: { Text(String(localized: "保留原来的笔，将当前参数另存为一支新笔。")) }
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle(isEditing ? String(localized: "编辑常用笔") : String(localized: "添加笔"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() }.accessibilityIdentifier("savedPen.cancel") }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? String(localized: "保存并使用") : String(localized: "添加并使用")) { savePen() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("savedPen.save")
                }
            }
            .onChange(of: draft.kind) { _, kind in
                draft.width = kind.defaultWidth
            }
        }
        .disabled(store.isBusy)
    }

    private func savePen(asNew: Bool = false) {
        guard !store.isBusy else { return }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        draft.name = name.isEmpty ? draft.kind.title : name
        draft.width = min(draft.kind.maximumWidth, max(draft.kind.minimumWidth, draft.width))
        var value = draft
        if asNew { value.id = UUID(); value.name += String(localized: " 副本") }
        guard store.saveSavedPen(value) else {
            errorMessage = store.status
            return
        }
        dismiss()
    }
}

private struct SavedPenStrokePreview: View {
    let pen: SavedPen

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.white
                Path { path in
                    for index in 1...3 {
                        let y = geometry.size.height * CGFloat(index) / 4
                        path.move(to: CGPoint(x: 0, y: y))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: y))
                    }
                }
                .stroke(Color.gray.opacity(0.15), lineWidth: 1)
                Path { path in
                    let width = geometry.size.width
                    let height = geometry.size.height
                    path.move(to: CGPoint(x: width * 0.1, y: height * 0.6))
                    path.addCurve(to: CGPoint(x: width * 0.9, y: height * 0.4),
                                  control1: CGPoint(x: width * 0.3, y: height * 0.05),
                                  control2: CGPoint(x: width * 0.65, y: height * 0.95))
                }
                .stroke(savedPenPreviewColor(pen), style: StrokeStyle(lineWidth: CGFloat(pen.width), lineCap: .round, lineJoin: .round))
            }
        }
        .frame(height: max(110, pen.width + 70))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(String(localized: "\(pen.kind.title)颜色与线宽预览"))
    }
}

private func savedPenPreviewColor(_ pen: SavedPen) -> Color {
    Color(.sRGB, red: pen.red, green: pen.green, blue: pen.blue, opacity: pen.alpha)
}

private struct BoardInlineLinkSheet: View {
    let onInsert: (String, URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var address = ""
    @State private var errorMessage: String?
    var body: some View {
        NavigationStack {
            Form {
                TextField(String(localized: "显示文字（可选）"), text: $label)
                TextField("https://…", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .accessibilityIdentifier("boardItem.linkURL")
                Text(String(localized: "链接会添加在正文末尾。阅读白板时轻点链接，可在应用内打开；内部浏览器也可将它放为网页卡。"))
                    .font(.footnote).foregroundStyle(.secondary)
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle(String(localized: "插入网页链接")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "插入")) {
                        guard let url = BoardWebCardContent.safeURL(address) else {
                            errorMessage = String(localized: "请输入完整、不含账号密码的 http / https 地址。"); return
                        }
                        let title = label.trimmingCharacters(in: .whitespacesAndNewlines)
                        onInsert(title.isEmpty ? url.absoluteString : String(title.prefix(1000)), url); dismiss()
                    }.accessibilityIdentifier("boardItem.linkInsert")
                }
            }
        }
    }
}

/// Small, tool-specific popovers. Every control commits to the same persistence
/// path as the full editor; opening the popover never changes another tool.
@MainActor enum BoardPaletteQuickSettingsController {
    private static func host<V: View>(_ view: V, height: CGFloat) -> UIHostingController<V> {
        let controller = UIHostingController(rootView: view)
        controller.preferredContentSize = CGSize(width: 300, height: height)
        controller.view.backgroundColor = UIColor(PadDesign.surface)
        return controller
    }
    static func pen(_ pen: SavedPen, onChange: @escaping (SavedPen) -> Bool) -> UIViewController {
        host(BoardPenQuickSettings(pen: pen, onChange: onChange), height: 320)
    }
    static func eraser(_ settings: BoardPaletteEraserSettings, onChange: @escaping (BoardPaletteEraserSettings) -> Void) -> UIViewController {
        let controller = host(BoardEraserQuickSettings(settings: settings, onChange: onChange), height: eraserHeight(settings.mode))
        controller.rootView.onModeChange = { [weak controller] mode in
            controller?.preferredContentSize = CGSize(width: 300, height: eraserHeight(mode))
        }
        return controller
    }
    private static func eraserHeight(_ mode: BoardPaletteEraserSettings.Mode) -> CGFloat { mode == .fixed ? 320 : 250 }
    static func lasso(_ types: Set<String>, onChange: @escaping (Set<String>) -> Void) -> UIViewController {
        host(BoardLassoQuickSettings(types: types, onChange: onChange), height: 340)
    }
    static func ruler(_ active: Bool, onChange: @escaping (Bool) -> Void) -> UIViewController {
        host(BoardRulerQuickSettings(active: active, onChange: onChange), height: 180)
    }
}

/// A steady header with one scrolling content area avoids Form's section gaps,
/// while keeping every control reachable at accessibility text sizes.
private struct BoardPaletteQuickPanel<Content: View>: View {
    let title: String
    let onDone: () -> Void
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(title).font(.headline).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                Button(action: onDone) {
                    Text(String(localized: "完成")).font(.subheadline.weight(.semibold))
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(PadDesign.accent)
                    .accessibilityIdentifier("nativePalette.quick.done")
            }.padding(.horizontal, 12).padding(.vertical, 2).background(PadDesign.paper)
            Rectangle().fill(PadDesign.hairline).frame(height: 0.5).accessibilityHidden(true)
            ScrollView {
                content.padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity)
            }.scrollBounceBehavior(.basedOnSize)
        }
        .font(.subheadline).foregroundStyle(PadDesign.ink).tint(PadDesign.accent)
        .background(PadDesign.surface)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(PadDesign.hairline, lineWidth: 0.7)
                .allowsHitTesting(false).accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct BoardPaletteQuickButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(PadDesign.accent)
            .background(configuration.isPressed ? PadDesign.accentWash : PadDesign.paper,
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(PadDesign.hairline, lineWidth: 0.7)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
    }
}

private struct BoardPenQuickSettings: View {
    @State var pen: SavedPen
    let onChange: (SavedPen) -> Bool
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.self) private var environment
    private var color: Binding<Color> {
        Binding(get: { savedPenPreviewColor(pen) }, set: { color in
            let c = color.resolve(in: environment)
            pen.red = Double(c.red); pen.green = Double(c.green); pen.blue = Double(c.blue); pen.alpha = Double(c.opacity)
            commit()
        })
    }
    var body: some View {
        BoardPaletteQuickPanel(title: pen.name, onDone: { if commit() { dismiss() } }) {
            VStack(spacing: 4) {
                ColorPicker(String(localized: "颜色与透明度"), selection: color, supportsOpacity: true)
                    .frame(minHeight: 44).accessibilityIdentifier("nativePalette.quick.colorPicker")
                HStack(spacing: 0) {
                    ForEach(["#203E35", "#000000", "#C53732", "#1F5DA8", "#F2C94C"], id: \.self) { hex in
                        Button {
                            let rgb = UInt64(hex.dropFirst(), radix: 16) ?? 0
                            pen.red = Double((rgb >> 16) & 255) / 255; pen.green = Double((rgb >> 8) & 255) / 255; pen.blue = Double(rgb & 255) / 255
                            commit()
                        } label: {
                            Circle().fill(Color(uiColor: PDFExtensionPaint.color(hex))).frame(width: 26, height: 26)
                                .overlay(Circle().strokeBorder(PadDesign.hairline, lineWidth: 0.7))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        .accessibilityLabel(hex).accessibilityIdentifier("nativePalette.quick.color." + hex)
                    }
                }
                HStack {
                    Text(String(localized: "粗细"))
                    Spacer()
                    Text(String(localized: "\(pen.width.formatted(.number.precision(.fractionLength(1)))) 点"))
                        .monospacedDigit().foregroundStyle(PadDesign.secondaryInk)
                }
                Slider(value: $pen.width, in: pen.kind.minimumWidth...pen.kind.maximumWidth, onEditingChanged: { active in if !active { commit() } })
                    .frame(minHeight: 44).accessibilityLabel(String(localized: "笔的粗细")).accessibilityIdentifier("nativePalette.quick.width")
                HStack(spacing: 6) {
                    ForEach([0.15, 0.35, 0.65, 0.9], id: \.self) { fraction in
                        let width = pen.kind.minimumWidth + (pen.kind.maximumWidth - pen.kind.minimumWidth) * fraction
                        Button { pen.width = width; commit() } label: {
                            Text(width.formatted(.number.precision(.fractionLength(1))))
                                .font(.caption.monospacedDigit()).frame(maxWidth: .infinity, minHeight: 44)
                        }.buttonStyle(BoardPaletteQuickButtonStyle())
                        .accessibilityIdentifier("nativePalette.quick.widthPreset.\(fraction)")
                    }
                }
                if pen.kind == .monoline {
                    HStack(spacing: 6) {
                        ForEach([12.0, 24, 48], id: \.self) { width in
                            Button { pen.width = width; commit() } label: {
                                Text(String(localized: "\(Int(width)) 点")).font(.caption.monospacedDigit())
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }.buttonStyle(BoardPaletteQuickButtonStyle())
                                .accessibilityIdentifier("nativePalette.quick.broadWidth.\(Int(width))")
                        }
                    }
                }
                BoardPaletteQuickStrokePreview(pen: pen)
                if failed { Text(String(localized: "设置未能保存，请重试。")).font(.caption).foregroundStyle(.red) }
            }
        }.accessibilityIdentifier("nativePalette.quick.pen")
    }
    @discardableResult private func commit() -> Bool { failed = !onChange(pen); return !failed }
}

private struct BoardPaletteQuickStrokePreview: View {
    let pen: SavedPen
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                PadDesign.paper
                Path { path in
                    path.move(to: CGPoint(x: 0, y: geometry.size.height / 2))
                    path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height / 2))
                }.stroke(PadDesign.hairline.opacity(0.55), lineWidth: 0.5)
                Path { path in
                    let width = geometry.size.width, height = geometry.size.height
                    path.move(to: CGPoint(x: width * 0.1, y: height * 0.6))
                    path.addCurve(to: CGPoint(x: width * 0.9, y: height * 0.4),
                                  control1: CGPoint(x: width * 0.3, y: height * 0.05),
                                  control2: CGPoint(x: width * 0.65, y: height * 0.95))
                }.stroke(savedPenPreviewColor(pen), style: StrokeStyle(lineWidth: CGFloat(pen.width), lineCap: .round, lineJoin: .round))
            }
        }.frame(height: max(36, pen.width + 8)).clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel(String(localized: "\(pen.kind.title)颜色与线宽预览"))
    }
}

private struct BoardEraserQuickSettings: View {
    @State var settings: BoardPaletteEraserSettings
    let onChange: (BoardPaletteEraserSettings) -> Void
    var onModeChange: (BoardPaletteEraserSettings.Mode) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        BoardPaletteQuickPanel(title: String(localized: "橡皮擦"), onDone: { onChange(settings); dismiss() }) {
            VStack(alignment: .leading, spacing: 6) {
                VStack(spacing: 0) {
                    ForEach(BoardPaletteEraserSettings.Mode.allCases, id: \.self) { mode in
                        Button { settings.mode = mode } label: {
                            HStack {
                                Text(mode.title).frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: settings.mode == mode ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(settings.mode == mode ? PadDesign.accent : PadDesign.secondaryInk)
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityAddTraits(settings.mode == mode ? .isSelected : [])
                            .accessibilityIdentifier("nativePalette.quick.eraserMode." + mode.rawValue)
                    }
                }.accessibilityElement(children: .contain).accessibilityIdentifier("nativePalette.quick.eraserMode")
                if settings.mode == .fixed {
                    HStack {
                        Text(String(localized: "擦除宽度")); Spacer()
                        Text(String(localized: "\(settings.width.formatted(.number.precision(.fractionLength(1)))) 点"))
                            .monospacedDigit().foregroundStyle(PadDesign.secondaryInk)
                    }
                    Slider(value: $settings.width, in: Double(settings.mode.type.validWidthRange.lowerBound)...Double(settings.mode.type.validWidthRange.upperBound), onEditingChanged: { active in if !active { onChange(settings) } })
                        .frame(minHeight: 44).accessibilityLabel(String(localized: "擦除宽度")).accessibilityIdentifier("nativePalette.quick.eraserWidth")
                }
                Text(settings.mode == .stroke ? String(localized: "碰到一笔时擦除整笔。") : String(localized: "只擦除笔尖经过的部分。固定宽度可调整擦除大小。"))
                    .font(.caption).foregroundStyle(PadDesign.secondaryInk).fixedSize(horizontal: false, vertical: true)
            }
        }
        .onChange(of: settings.mode) { _, mode in
            settings.width = Double(mode.type.defaultWidth); onChange(settings); onModeChange(mode)
        }
        .accessibilityIdentifier("nativePalette.quick.eraser")
    }
}

private struct BoardLassoQuickSettings: View {
    @State var types: Set<String>
    let onChange: (Set<String>) -> Void
    @Environment(\.dismiss) private var dismiss
    private let choices = [("ink", String(localized: "手写")), ("document", String(localized: "文档")), ("video", String(localized: "视频")), ("image", String(localized: "图片")), ("text", String(localized: "文字与公式"))]
    var body: some View {
        BoardPaletteQuickPanel(title: String(localized: "套索"), onDone: { dismiss() }) {
            VStack(spacing: 0) {
                ForEach(choices, id: \.0) { key, title in
                    Toggle(title, isOn: Binding(get: { types.contains(key) }, set: { selected in if selected { types.insert(key) } else { types.remove(key) }; onChange(types) }))
                        .frame(minHeight: 44).accessibilityIdentifier("nativePalette.quick.lasso." + key)
                }
                Button { types = Set(choices.map(\.0)); onChange(types) } label: {
                    Text(String(localized: "全部类型")).frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(BoardPaletteQuickButtonStyle()).padding(.top, 8)
                    .accessibilityIdentifier("nativePalette.quick.lasso.all")
            }
        }.accessibilityIdentifier("nativePalette.quick.lasso")
    }
}

private struct BoardRulerQuickSettings: View {
    @State var active: Bool
    let onChange: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        BoardPaletteQuickPanel(title: String(localized: "直尺"), onDone: { dismiss() }) {
            VStack(alignment: .leading, spacing: 8) {
                Toggle(String(localized: "显示直尺"), isOn: $active).frame(minHeight: 44)
                    .accessibilityIdentifier("nativePalette.quick.rulerVisible")
                Text(String(localized: "用手指移动，双指旋转；沿直尺边缘用 Apple Pencil 画直线。"))
                    .font(.caption).foregroundStyle(PadDesign.secondaryInk).fixedSize(horizontal: false, vertical: true)
            }
        }.onChange(of: active) { _, value in onChange(value) }
        .accessibilityIdentifier("nativePalette.quick.ruler")
    }
}

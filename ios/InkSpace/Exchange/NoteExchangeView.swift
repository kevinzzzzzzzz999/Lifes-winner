import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum NoteExchangeApp: String, CaseIterable, Identifiable {
    case boardNotes = "BoardNotes", goodnotes = "Goodnotes", notability = "Notability", oneNote = "OneNote"
    var id: String { rawValue }
    var importGuide: String {
        switch self {
        case .boardNotes: String(localized: "在 BoardNotes 导出 PDF 或图片；思维导图可导出 Markdown。私有 .boardNotes 文件只能存档，不能直接展开。")
        case .goodnotes: String(localized: "在 Goodnotes 分享或导出 PDF／图片，再存到“文件”。.goodnotes 保留为原生档案；导入的 PDF 文字与笔迹不再是 Goodnotes 可擦除笔迹。")
        case .notability: String(localized: "在 Notability 分享为 PDF 或图片。有录音的 ZIP 请先在“文件”解压，再多选 PDF 和音频；不恢复录音与笔迹的时间关联。.note／.nbn 仅保留档案。")
        case .oneNote: String(localized: "在 OneNote 导出或打印页面为 PDF。Mac／移动版与学校账号不一定提供整本导出；.one／.onepkg 仅保留档案，不能恢复整本或分区。")
        }
    }
    var exportGuide: String {
        switch self {
        case .boardNotes: String(localized: "分享 PDF／图片到 BoardNotes；“节点纲要.md”用于思维导图文本层级。布局、手写、资料与连线样式不会随 Markdown 迁移。")
        case .goodnotes: String(localized: "在分享菜单选 Goodnotes，或先存到“文件”再从 Goodnotes 导入 PDF／图片。可以继续标注，原笔迹会成为不可擦除的页面内容。")
        case .notability: String(localized: "在分享菜单选 Notability，或先存到“文件”再导入 PDF／图片。页面可继续标注；音频及笔迹时间关联不会包含在 PDF 中。")
        case .oneNote: String(localized: "在 OneNote 插入 PDF 附件或打印件，或插入图片；不同平台支持方式不同。这不是 OneNote 整本笔记恢复。")
        }
    }
}

/// A copy/share center, available in the reading-only phone role too. Board
/// mutation is a separate explicitly supplied iPad action.
struct NoteExchangeView: View {
    let library: DocumentLibrary
    let canExportBoard: Bool
    let canAddToBoard: Bool
    let onOpen: (URL) -> Void
    let onAdd: ([URL]) -> Void
    let onMindMap: (URL) async throws -> Void
    let onExport: () -> Void
    let onOutline: () throws -> Void
    let onChanged: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var app: NoteExchangeApp = .boardNotes
    @State private var directory: String
    @State private var picker = false
    @State private var folderPicker = false
    @State private var vaultPicker = false
    @State private var copyingExisting = false
    @State private var share: ExchangeShareRequest?
    @State private var result: NoteExchangeBatchResult?
    @State private var task: Task<Void, Never>?
    @State private var completed = 0
    @State private var total = 0
    @State private var error: String?
    init(library: DocumentLibrary, initialDirectory: String, canExportBoard: Bool, canAddToBoard: Bool,
         onOpen: @escaping (URL) -> Void, onAdd: @escaping ([URL]) -> Void,
         onMindMap: @escaping (URL) async throws -> Void, onExport: @escaping () -> Void,
         onOutline: @escaping () throws -> Void, onChanged: @escaping () -> Void) {
        self.library = library; self.canExportBoard = canExportBoard; self.canAddToBoard = canAddToBoard
        self.onOpen = onOpen; self.onAdd = onAdd; self.onMindMap = onMindMap; self.onExport = onExport
        self.onOutline = onOutline; self.onChanged = onChanged
        _directory = State(initialValue: initialDirectory)
    }
    private var busy: Bool { task != nil }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker(String(localized: "来源／目标应用"), selection: $app) { ForEach(NoteExchangeApp.allCases) { Text($0.rawValue).tag($0) } }
                        .accessibilityIdentifier("exchange.app")
                    Text(String(localized: "交换的是独立副本，不自动双向同步。原生笔记档案保留给来源应用；可读副本可在这里阅读与继续批注。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(busy)
                Section(String(localized: "导入到课程文件夹")) {
                    Text(app.importGuide).font(.callout)
                    Button { folderPicker = true } label: { Label(directory.isEmpty ? library.rootURL.lastPathComponent : directory, systemImage: "folder") }
                        .accessibilityIdentifier("exchange.folder").disabled(busy)
                    Button(String(localized: "从“文件”多选导入"), systemImage: "square.and.arrow.down") { picker = true }
                        .accessibilityIdentifier("exchange.import").disabled(busy)
                    Button(String(localized: "从当前资料库复制导入"), systemImage: "folder.badge.plus") { copyingExisting = true; vaultPicker = true }
                        .accessibilityIdentifier("exchange.importVault").disabled(busy)
                    Text(String(localized: "PDF、PNG／JPG、Markdown、TXT 和音频；同名自动编号，不覆盖原文件。一次最多 100 项，每项 256 MiB，总计 1 GiB。"))
                        .font(.caption).foregroundStyle(.secondary)
                    if busy {
                        ProgressView(value: Double(completed), total: Double(max(1, total)))
                        Text(String(localized: "已处理 \(completed) / \(total) 项"))
                        Button(String(localized: "取消，保留已导入文件")) { task?.cancel() }.accessibilityIdentifier("exchange.cancel")
                    }
                    if let error { Text(error).foregroundStyle(.red).accessibilityIdentifier("exchange.error") }
                }
                if let result {
                    Section {
                        if result.cancelled { Text(String(localized: "已停止；已成功的文件仍保留，其余未导入。")) }
                        ForEach(result.items) { item in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(item.destination?.lastPathComponent ?? item.sourceName).font(.headline).textSelection(.enabled)
                                if let failure = item.error { Text(failure).foregroundStyle(.red).font(.callout) }
                                if let url = item.destination {
                                    if item.kind == .archive {
                                        Text(String(localized: "已保留原生档案；不解析、不展开。使用原应用打开。")) .font(.caption).foregroundStyle(.secondary)
                                    } else {
                                        Button(String(localized: "打开阅读")) { onOpen(url) }.accessibilityIdentifier("exchange.open." + url.lastPathComponent)
                                        if canAddToBoard, DocumentLibrary.supportedExtensions.contains(url.pathExtension.lowercased()) {
                                            Button(String(localized: "放入当前白板")) { onAdd([url]) }.accessibilityIdentifier("exchange.add." + url.lastPathComponent)
                                        }
                                        if canAddToBoard, ["md", "markdown"].contains(url.pathExtension.lowercased()) {
                                            Button(String(localized: "作为思维导图导入")) { convertOutline(url) }.accessibilityIdentifier("exchange.mindmap")
                                        }
                                    }
                                    Button(String(localized: "分享此文件"), systemImage: "square.and.arrow.up") { share = ExchangeShareRequest(files: [url]) }
                                }
                            }
                            // Explicit style isolates actions inside one Form row;
                            // automatic style otherwise invokes every row button.
                            .buttonStyle(.borderless)
                            .padding(.vertical, 4)
                        }
                    } header: {
                        Text(String(localized: "本次导入结果")).accessibilityIdentifier("exchange.results")
                    }
                    .disabled(busy)
                }
                Section(String(localized: "导出与分享")) {
                    Text(app.exportGuide).font(.callout)
                    Text(String(localized: "节点纲要仅含节点标题与树层级，不含正文、文件、手写、布局和连线样式；环或多父关系需要 PDF 或原生备份。"))
                        .font(.caption).foregroundStyle(.secondary)
                    Button(String(localized: "导出当前白板为 PDF／图片"), systemImage: "doc.richtext") { onExport() }
                        .disabled(!canExportBoard).accessibilityIdentifier("exchange.exportBoard")
                    Button(String(localized: "导出节点纲要 Markdown"), systemImage: "list.bullet.indent") { do { try onOutline() } catch { self.error = error.localizedDescription } }
                        .disabled(!canExportBoard).accessibilityIdentifier("exchange.exportOutline")
                    Button(String(localized: "选择资料原件并分享"), systemImage: "doc.on.doc") { copyingExisting = false; vaultPicker = true }
                        .accessibilityIdentifier("exchange.shareOriginal")
                    Text(String(localized: "分享 PDF 原件不会合入本应用的独立阅读图层和便签。白板 PDF 只包含白板上可见内容；折叠资料仍是卡片，音视频不会嵌入。需要完整可编辑资料，请另保留原生白板备份。"))
                        .font(.caption).foregroundStyle(.secondary)
                }.disabled(busy)
            }
            .navigationTitle(String(localized: "笔记交换"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() }.disabled(busy).accessibilityIdentifier("exchange.close") } }
        }
        .interactiveDismissDisabled(busy)
        .onDisappear { task?.cancel() }
        .sheet(isPresented: $picker) { NoteExchangeFilesPicker { urls in picker = false; start(urls) } onCancel: { picker = false } }
        .sheet(isPresented: $folderPicker) { BoardSaveDirectoryPicker(library: library, initialPath: directory) { directory = $0 } }
        .sheet(isPresented: $vaultPicker) { NoteExchangeVaultPicker(library: library, initialPath: directory, forImport: copyingExisting) { urls in
            vaultPicker = false
            if copyingExisting { start(urls) }
            else { Task { try? await Task.sleep(for: .milliseconds(350)); share = ExchangeShareRequest(files: urls) } }
        } }
        .sheet(item: $share) { ExchangeShareView(files: $0.files) }
    }
    private func convertOutline(_ url: URL) {
        guard !busy else { return }
        task = Task { @MainActor in
            defer { task = nil }
            do { try await onMindMap(url) } catch { self.error = error.localizedDescription }
        }
    }
    private func start(_ urls: [URL]) {
        guard !busy, !urls.isEmpty else { return }
        completed = 0; total = urls.count; error = nil; result = nil
        let root = library.rootURL, target = directory
        task = Task { @MainActor in
            defer { task = nil }
            do {
                result = try await NoteExchange.importFiles(urls, root: root, directory: target) { count, _ in
                    await MainActor.run { completed = count }
                }
                onChanged()
            } catch { self.error = error.localizedDescription }
        }
    }
}
struct ExchangeShareRequest: Identifiable { let id = UUID(); let files: [URL] }
struct ExchangeShareView: UIViewControllerRepresentable {
    let files: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: files, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) { }
}
private struct NoteExchangeFilesPicker: UIViewControllerRepresentable {
    let onSelect: ([URL]) -> Void
    let onCancel: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onSelect: onSelect, onCancel: onCancel) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        // Generic data also lets opaque vendor extensions and ZIP be selected so
        // that we can give a precise per-file result rather than silently hiding them.
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
        picker.allowsMultipleSelection = true; picker.shouldShowFileExtensions = true; picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ view: UIDocumentPickerViewController, context: Context) { }
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onSelect: ([URL]) -> Void; let onCancel: () -> Void
        init(onSelect: @escaping ([URL]) -> Void, onCancel: @escaping () -> Void) { self.onSelect = onSelect; self.onCancel = onCancel }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { onSelect(urls) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onCancel() }
    }
}
private struct NoteExchangeVaultPicker: View {
    let library: DocumentLibrary
    let onSelect: ([URL]) -> Void
    let forImport: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var selected = Set<String>()
    @State private var path: String
    @State private var folders: [VaultFolder] = []
    @State private var files: [VaultDocument] = []
    @State private var warning: String?
    @State private var loading = true
    init(library: DocumentLibrary, initialPath: String, forImport: Bool, onSelect: @escaping ([URL]) -> Void) { self.library = library; self.onSelect = onSelect; self.forImport = forImport; _path = State(initialValue: initialPath) }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(path.isEmpty ? library.rootURL.lastPathComponent : path)
                    if !path.isEmpty { Button(String(localized: "上一级")) { path = (path as NSString).deletingLastPathComponent }.accessibilityIdentifier("exchangeVault.up") }
                    Text(forImport ? String(localized: "选中的资料会复制到目标课程文件夹，同名另编号。") : String(localized: "分享原文件，不合入独立阅读图层。")) .font(.caption).foregroundStyle(.secondary)
                }
                if loading { ProgressView() }
                if let warning { Text(warning).foregroundStyle(.red) }
                ForEach(folders) { folder in Button { path = folder.relativePath } label: { Label(folder.title, systemImage: "folder") } }
                ForEach(files) { file in Button {
                    if forImport {
                        if selected.contains(file.relativePath) { selected.remove(file.relativePath) }
                        else if selected.count < 100 { selected.insert(file.relativePath) }
                    } else if let url = library.resolve(relativePath: file.relativePath) { onSelect([url]) }
                } label: {
                    HStack { Label(file.title, systemImage: "doc"); Spacer(); if selected.contains(file.relativePath) { Image(systemName: "checkmark.circle.fill") } }
                }.accessibilityIdentifier("exchangeVault.file." + file.relativePath) }
            }
            .navigationTitle(forImport ? String(localized: "选择要复制的资料") : String(localized: "选择资料原件"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                if forImport { ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "导入所选（\(selected.count)）")) { onSelect(selected.sorted().compactMap { library.resolve(relativePath: $0) }) }
                        .disabled(selected.isEmpty || loading).accessibilityIdentifier("exchangeVault.confirm")
                } }
            }
            .task(id: path) {
                loading = true; let requested = path
                let listing = await library.listDirectory(relativePath: requested)
                guard !Task.isCancelled, path == requested else { return }
                folders = listing.folders; files = listing.documents.filter { NoteExchange.readableExtensions.contains(($0.relativePath as NSString).pathExtension.lowercased()) }
                warning = listing.warning; loading = false
            }
        }
    }
}

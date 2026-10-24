import SwiftUI
import UIKit

/// OCR is a reading operation. Only an explicit export creates a separate file.
struct LocalOCRView: View {
    let rootURL: URL?
    let sourceURL: URL
    @Environment(\.dismiss) private var dismiss
    @State private var firstPage: String
    @State private var lastPage: String
    @State private var result: LocalOCR.Result?
    @State private var progress: LocalOCR.Progress?
    @State private var recognitionTask: Task<Void, Never>?
    @State private var isRunning = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var notice: String?
    @State private var savedURL: URL?

    init(rootURL: URL?, sourceURL: URL, page: Int = 1) {
        self.rootURL = rootURL; self.sourceURL = sourceURL
        _firstPage = State(initialValue: String(max(1, page)))
        _lastPage = State(initialValue: String(max(1, page)))
    }
    private var isPDF: Bool { sourceURL.pathExtension.lowercased() == "pdf" }
    private var plainText: String { result?.pages.map(\.text).filter { !$0.isEmpty }.joined(separator: "\n\n") ?? "" }
    private var hasText: Bool { !plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            List {
                sourceSection
                if isRunning { progressSection }
                if let result { resultSection(result) }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("ocr.error") }
                if let notice { Text(notice).foregroundStyle(.secondary).textSelection(.enabled).accessibilityIdentifier("ocr.status") }
                if let savedURL { Label(savedURL.lastPathComponent, systemImage: "checkmark.circle").textSelection(.enabled).accessibilityElement(children: .ignore).accessibilityLabel(Text(verbatim: savedURL.lastPathComponent)).accessibilityIdentifier("ocr.saved") }
                if hasText { exportSection }
            }
            .navigationTitle(String(localized: "本机文字识别"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(String(localized: "关闭")) { dismiss() }.disabled(isRunning || isSaving).accessibilityIdentifier("ocr.close")
            } }
        }
        .interactiveDismissDisabled(isRunning || isSaving)
        .onDisappear { recognitionTask?.cancel() }
    }

    private var sourceSection: some View {
        Section {
            Label(sourceURL.lastPathComponent, systemImage: isPDF ? "doc.richtext" : "photo")
                .lineLimit(2).textSelection(.enabled)
            Text(String(localized: "文字在本机识别，原 PDF 和图片保持不变。识别结果请核对后使用。"))
                .font(.caption).foregroundStyle(.secondary)
            Text(LocalOCR.notice).font(.caption).foregroundStyle(.secondary)
            if isPDF {
                HStack {
                    TextField(String(localized: "起始页"), text: $firstPage).keyboardType(.numberPad).accessibilityIdentifier("ocr.firstPage")
                    Text("–").foregroundStyle(.secondary)
                    TextField(String(localized: "结束页"), text: $lastPage).keyboardType(.numberPad).accessibilityIdentifier("ocr.lastPage")
                }.frame(minHeight: 44)
                Text(String(localized: "填写要识别的页码范围，每次最多 50 页。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Button { recognize() } label: {
                Label(result == nil ? String(localized: "开始识别") : String(localized: "重新识别"), systemImage: "text.viewfinder")
                    .frame(minHeight: 44).contentShape(Rectangle())
            }.disabled(isRunning || isSaving).accessibilityIdentifier("ocr.start")
        } header: { Text(String(localized: "识别范围")) }
        .disabled(isRunning || isSaving)
    }

    private var progressSection: some View {
        Section {
            if let progress {
                ProgressView(value: Double(progress.completed), total: Double(max(1, progress.total)))
                Text(String(localized: "已完成 \(progress.completed) / \(progress.total) 页"))
            } else { ProgressView(String(localized: "正在读取并识别…")) }
            Button(String(localized: "停止识别，保留已完成页")) { recognitionTask?.cancel() }
                .frame(minHeight: 44).accessibilityIdentifier("ocr.cancel")
        }
    }

    @ViewBuilder private func resultSection(_ result: LocalOCR.Result) -> some View {
        Section {
            if result.cancelled { Text(String(localized: "识别已停止，已完成的页面仍可复制或保存。")) .foregroundStyle(.secondary) }
            if result.outputLimited { Text(String(localized: "本次结果已达到长度限制，请缩小页码范围继续识别。")) .foregroundStyle(.secondary) }
            ForEach(result.pages, id: \.page) { page in
                VStack(alignment: .leading, spacing: 8) {
                    Text(String(localized: "第 \(page.page) 页")).font(.headline)
                    if let error = page.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                    if page.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && page.error == nil {
                        Text(String(localized: "此页未识别到文字。")) .foregroundStyle(.secondary)
                    }
                    if !page.text.isEmpty {
                        Text(page.text).textSelection(.enabled).font(.body)
                            .accessibilityIdentifier("ocr.result.page.\(page.page)")
                    }
                }.padding(.vertical, 4)
            }
            if result.pages.isEmpty { Text(String(localized: "尚无已完成的页面，可调整范围后重试。")) .foregroundStyle(.secondary) }
        } header: { Text(String(localized: "识别结果")) }
    }

    private var exportSection: some View {
        Section {
            Button { UIPasteboard.general.string = plainText; notice = String(localized: "识别文字已复制。") } label: {
                Label(String(localized: "复制全部文字"), systemImage: "doc.on.doc").frame(minHeight: 44)
            }.accessibilityIdentifier("ocr.copy")
            Button { saveResult() } label: {
                if isSaving { ProgressView() }
                else { Label(String(localized: "保存独立 OCR 文稿"), systemImage: "doc.badge.plus").frame(minHeight: 44) }
            }.disabled(rootURL == nil || isSaving || isRunning).accessibilityIdentifier("ocr.save")
            Text(rootURL == nil ? String(localized: "授权资料文件夹后，才能保存独立 OCR 文稿。") : String(localized: "存入原资料所在文件夹，使用 .ocr.md；同名文件会另编号，不覆盖已有内容。"))
                .font(.caption).foregroundStyle(.secondary)
        } header: { Text(String(localized: "复制或独立保存")) }
          footer: { Text(String(localized: "长按识别结果可选取部分文字。")) }
    }

    private func recognize() {
        guard !isRunning, !isSaving else { return }
        let pages: ClosedRange<Int>?
        if isPDF {
            guard let first = Int(firstPage), let last = Int(lastPage), first > 0, last >= first, last - first < 50 else {
                errorMessage = String(localized: "请输入有效页码范围，每次最多 50 页。"); return
            }
            pages = first...last
        } else { pages = nil }
        errorMessage = nil; notice = nil; progress = nil; savedURL = nil; isRunning = true
        recognitionTask = Task { @MainActor in
            let access = rootURL?.startAccessingSecurityScopedResource() ?? false
            defer { if access { rootURL?.stopAccessingSecurityScopedResource() }; isRunning = false; recognitionTask = nil }
            do {
                let output = try await LocalOCR.recognize(url: sourceURL, pages: pages) { value in
                    Task { @MainActor in progress = value }
                }
                result = output
            } catch is CancellationError {
                notice = String(localized: "识别已停止。")
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func saveResult() {
        guard let rootURL, let result, hasText, !isSaving, !isRunning else { return }
        isSaving = true; errorMessage = nil
        let source = sourceURL
        var sections = ["# " + source.deletingPathExtension().lastPathComponent + " — OCR", "Source: " + source.lastPathComponent]
        if result.cancelled { sections.append("Status: cancelled; completed pages only.") }
        if result.outputLimited { sections.append("Status: output limit reached.") }
        for page in result.pages {
            sections.append("## Page \(page.page)")
            if let error = page.error { sections.append("[OCR notice] " + error) }
            if !page.text.isEmpty { sections.append(page.text) }
        }
        let text = sections.joined(separator: "\n\n") + "\n"
        Task { @MainActor in
            defer { isSaving = false }
            do {
                savedURL = try await Task.detached(priority: .userInitiated) {
                    try LocalOCRMarkdownExport.save(text: text, root: rootURL, source: source)
                }.value
                notice = String(localized: "独立 OCR 文稿已保存，原资料保持不变。")
            } catch { errorMessage = error.localizedDescription }
        }
    }
}

/// Same coordinated create-only publication used by scanned PDFs. A concurrent
/// filename collision causes a retry; no path ever replaces an existing file.
enum LocalOCRMarkdownExport {
    static func save(text: String, root: URL, source: URL) throws -> URL {
        let access = root.startAccessingSecurityScopedResource()
        defer { if access { root.stopAccessingSecurityScopedResource() } }
        let prefix = root.standardizedFileURL.path + "/"
        guard source.standardizedFileURL.path.hasPrefix(prefix) else { throw BoardStorageError.invalidDirectory }
        let relative = String(source.standardizedFileURL.path.dropFirst(prefix.count))
        guard VaultPath.isSafeRelative(relative) else { throw BoardStorageError.invalidDirectory }
        let folder = try BoardStorageLocations.directory(root: root, relativePath: (relative as NSString).deletingLastPathComponent)
        var name = source.deletingPathExtension().lastPathComponent
        while name.utf8.count > 150 { name.removeLast() }
        if name.isEmpty || name.hasPrefix(".") { name = "OCR" }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpace-OCR-" + UUID().uuidString)
        try Data(text.utf8).write(to: temporary, options: .atomic)
        defer { try? FileManager.default.removeItem(at: temporary) }
        for suffix in 1...1000 {
            let candidate = folder.appendingPathComponent(name + (suffix == 1 ? "" : " (\(suffix))") + ".ocr.md")
            if FileManager.default.fileExists(atPath: candidate.path) { continue }
            var coordinationError: NSError?
            var outcome: Result<Void, Error> = .failure(BoardStorageError.missingDirectory)
            NSFileCoordinator().coordinate(writingItemAt: candidate, options: [], error: &coordinationError) { destination in
                outcome = Result { try FileManager.default.copyItem(at: temporary, to: destination) }
            }
            if let coordinationError { throw coordinationError }
            do { try outcome.get(); return candidate }
            catch { if FileManager.default.fileExists(atPath: candidate.path) { continue }; throw error }
        }
        throw CocoaError(.fileWriteFileExists)
    }
}

struct LocalOCRSourcePicker: View {
    let library: DocumentLibrary
    let onSelect: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path: String
    @State private var folders: [VaultFolder] = []
    @State private var documents: [VaultDocument] = []
    @State private var warning: String?
    @State private var isLoading = true
    @State private var refreshID = UUID()
    init(library: DocumentLibrary, initialDirectory: String, onSelect: @escaping (URL) -> Void) {
        self.library = library; self.onSelect = onSelect; _path = State(initialValue: initialDirectory)
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(path.isEmpty ? library.rootURL.lastPathComponent : path).textSelection(.enabled)
                    if !path.isEmpty {
                        Button(String(localized: "上一级"), systemImage: "chevron.up") { path = (path as NSString).deletingLastPathComponent }
                            .accessibilityIdentifier("ocrPicker.up")
                        Button(String(localized: "返回仓库根目录"), systemImage: "house") { path = "" }.accessibilityIdentifier("ocrPicker.root")
                    }
                }
                if isLoading { ProgressView() }
                if let warning { Text(warning).foregroundStyle(.secondary) }
                ForEach(folders) { folder in
                    Button { path = folder.relativePath } label: { Label(folder.title, systemImage: "folder").frame(minHeight: 44) }
                        .accessibilityIdentifier("ocrPicker.folder." + folder.relativePath)
                }
                ForEach(documents) { document in
                    Button {
                        if let url = library.resolve(relativePath: document.relativePath) { onSelect(url) }
                    } label: { Label(document.title, systemImage: document.symbol).frame(minHeight: 44) }
                        .accessibilityIdentifier("ocrPicker.file." + document.relativePath)
                }
                if !isLoading && documents.isEmpty {
                    Text(String(localized: "此文件夹没有可识别的 PDF 或图片，可继续浏览子文件夹。")) .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(String(localized: "选择识别资料")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() }.accessibilityIdentifier("ocrPicker.close") }
                ToolbarItem(placement: .primaryAction) { Button(String(localized: "刷新"), systemImage: "arrow.clockwise") { refreshID = UUID() } }
            }
            .task(id: path + refreshID.uuidString) {
                isLoading = true; folders = []; documents = []; warning = nil
                let listing = await library.listDirectory(relativePath: path)
                guard !Task.isCancelled else { return }
                folders = listing.folders; documents = listing.documents.filter { $0.isPDF || $0.isImage }; warning = listing.warning
                isLoading = false
            }
        }
    }
}

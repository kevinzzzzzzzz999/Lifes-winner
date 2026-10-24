import SwiftUI
import PDFKit

struct PDFFileExportRequest: Identifiable {
    let id = UUID()
    let rootURL: URL?
    let sourceURL: URL
    let sourceSHA256: String
    let page: Int
    let pageCount: Int
    let marks: [PDFWorkspaceAnnotation]
    let layerWarnings: [String]
    @MainActor init(pane: PDFWorkspacePane) {
        rootURL = pane.rootURL; sourceURL = pane.sourceURL
        sourceSHA256 = pane.sourceSHA256; page = pane.page; pageCount = pane.pageCount
        layerWarnings = pane.projection.warnings
        let order = Dictionary(uniqueKeysWithValues: pane.projection.layers.enumerated().map { ($0.element.id, $0.offset) })
        marks = pane.displayedAnnotations.sorted { order[$0.layerID, default: 0] < order[$1.layerID, default: 0] }
    }
}

/// Frozen visible layers plus freshly verified extension records, over an
/// immutable private source copy. This never publishes an edit to the vault.
struct PDFFileExportView: View {
    let request: PDFFileExportRequest
    @Environment(\.dismiss) private var dismiss
    @State private var scope = 0
    @State private var task: Task<Void, Never>?
    @State private var progress: PDFExtensionExportProgress?
    @State private var result: URL?
    @State private var message = ""
    @State private var saveRequest: NativeFileSaveRequest?
    @State private var previewRequest: NativeFileSaveRequest?
    @State private var shareRequest: NativeFileSaveRequest?
    private var working: Bool { task != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "导出范围")) {
                    Picker(String(localized: "范围"), selection: $scope) {
                        Text(String(localized: "全部页面 · 含留白与笔记")).tag(0)
                        Text(String(localized: "当前页 · 含留白与笔记")).tag(1)
                        Text(String(localized: "原文件完整副本")).tag(2)
                    }.accessibilityIdentifier("pdfExport.scope")
                    Text(scope == 2
                         ? String(localized: "复制完整原 PDF，不合入独立图层与留白。")
                         : String(localized: "包含可见图层、高亮、批注及已保存留白。长留白自动续页，折叠留白也会完整展开；原 PDF 保持不变。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(String(localized: "原文共 \(request.pageCount) 页，当前第 \(request.page) 页。"))
                        .font(.footnote).monospacedDigit()
                }.disabled(working)
                if working {
                    Section {
                        if let progress {
                            ProgressView(value: Double(progress.completedPages), total: Double(max(1, progress.totalPages)))
                            Text(String(localized: "正在导出 \(progress.completedPages) / \(progress.totalPages) 页"))
                        } else { ProgressView(String(localized: "正在准备完整内容…")) }
                        Button(String(localized: "取消导出"), role: .destructive) { task?.cancel() }
                            .accessibilityIdentifier("pdfExport.cancel")
                    }.accessibilityIdentifier("pdfExport.progress")
                }
                if !message.isEmpty { Section { Text(message).accessibilityIdentifier("pdfExport.status") } }
                Section {
                    Button(String(localized: "生成导出文件"), systemImage: "square.and.arrow.up") { generate() }
                        .disabled(working).accessibilityIdentifier("pdfExport.generate")
                    if let result, !working {
                        Text(result.lastPathComponent).font(.footnote)
                        Button(String(localized: "预览"), systemImage: "doc.text.magnifyingglass") {
                            previewRequest = .init(files: [result])
                        }.accessibilityIdentifier("pdfExport.preview")
                        Button(String(localized: "存储到文件"), systemImage: "folder.badge.plus") {
                            saveRequest = .init(files: [result])
                        }.accessibilityIdentifier("pdfExport.saveFile")
                        Button(String(localized: "分享"), systemImage: "square.and.arrow.up") {
                            shareRequest = .init(files: [result])
                        }.accessibilityIdentifier("pdfExport.share")
                    }
                }
            }
            .navigationTitle(String(localized: "导出 PDF")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(String(localized: "关闭")) { clearResult(); dismiss() }.disabled(working)
                    .accessibilityIdentifier("pdfExport.close")
            } }
            .interactiveDismissDisabled(working || saveRequest != nil || previewRequest != nil || shareRequest != nil)
            .sheet(item: $saveRequest) { save in
                NativeFileSavePicker(files: save.files) { saved in
                    message = saved ? String(localized: "文件已存储到所选位置。iCloud 传输由系统继续完成。")
                                    : String(localized: "未保存文件。已生成的副本保留，可再次选择存储位置。")
                }
            }
            .sheet(item: $previewRequest) { NativeFilePreview(files: $0.files) }
            .sheet(item: $shareRequest) { NativeFileShare(files: $0.files) }
            .onDisappear {
                task?.cancel()
                // A child save/preview sheet still holds the generated file.
                if saveRequest == nil && previewRequest == nil && shareRequest == nil { clearResult() }
            }
        }
    }

    @MainActor private func generate() {
        guard task == nil else { return }
        let requestedScope = scope
        message = ""; progress = nil
        task = Task { @MainActor in
            defer { task = nil }
            do {
                let repository = PDFExtensionRepository(rootURL: request.rootURL, sourceURL: request.sourceURL)
                let output: URL
                if requestedScope == 2 {
                    output = try await originalCopy(repository: repository)
                } else {
                    guard request.layerWarnings.isEmpty else { throw PDFWorkspaceError.invalidRecord }
                    let snapshot = try await repository.load()
                    try Task.checkCancellation()
                    guard snapshot.sourceSHA256 == request.sourceSHA256 else { throw PDFWorkspaceError.staleSource }
                    guard snapshot.projection.warnings.isEmpty else { throw PDFWorkspaceError.invalidRecord }
                    let blocks = snapshot.projection.current(source: request.sourceSHA256).compactMap(\.block)
                    output = try await PDFExtensionExporter.export(sourceSHA256: request.sourceSHA256, blocks: blocks,
                        marks: request.marks, repository: repository,
                        pages: requestedScope == 1 ? request.page...request.page : nil, progress: { progress = $0 })
                }
                if Task.isCancelled { PDFExtensionExporter.removeTemporaryExport(output); throw CancellationError() }
                clearResult(); result = output
                let pages = PDFDocument(url: output)?.pageCount ?? 0
                message = String(localized: "已生成 \(pages) 页 PDF。请选择存储位置或分享。")
            } catch is CancellationError {
                message = String(localized: "已取消导出，未完成的文件已清理。")
            } catch {
                message = error.localizedDescription
                DiagnosticsCenter.shared.record(code: .exportFailed, operation: .exportBoard, error: error)
            }
        }
    }

    @MainActor private func originalCopy(repository: PDFExtensionRepository) async throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpace-PDF-Notes-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        var succeeded = false
        defer { if !succeeded { try? FileManager.default.removeItem(at: directory) } }
        let filename = request.sourceURL.deletingPathExtension().lastPathComponent
            .components(separatedBy: CharacterSet(charactersIn: "/\\:\0\n\r")).joined(separator: "-")
        let output = directory.appendingPathComponent(String(filename.prefix(80)) + "-原文件副本.pdf")
        try await repository.copyPDFSnapshot(to: output, expectedSHA256: request.sourceSHA256)
        try Task.checkCancellation()
        guard let verified = PDFDocument(url: output), verified.pageCount == request.pageCount else {
            throw PDFExtensionExportError.outputFailed
        }
        succeeded = true; return output
    }
    private func clearResult() {
        if let result { PDFExtensionExporter.removeTemporaryExport(result) }
        result = nil
    }
}

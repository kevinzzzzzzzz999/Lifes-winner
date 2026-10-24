import SwiftUI
import UIKit
import PDFKit
import QuickLook

/// The parent passes a frozen snapshot with its latest native drawing bytes.
/// No live BoardStore/viewport is consulted after the export starts.
struct BoardExportView: View {
    let snapshot: BoardDocument
    let rootURL: URL
    let selectionRect: CGRect?
    var onBackup: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var scope = 0
    @State private var targetApp: NoteExchangeApp = .goodnotes
    @State private var format = BoardExportFormat.pdf
    @State private var dpi = 216.0
    @State private var progress: BoardExportProgress?
    @State private var task: Task<Void, Never>?
    @State private var result: BoardExportResult?
    @State private var message: String?
    @State private var showShare = false
    @State private var showPreview = false
    @State private var shareFiles: [URL] = []
    @State private var saveRequest: NativeFileSaveRequest?

    init(snapshot: BoardDocument, rootURL: URL, selectionRect: CGRect?, onBackup: (() -> Void)? = nil) {
        self.snapshot = snapshot
        self.rootURL = rootURL
        self.selectionRect = selectionRect
        self.onBackup = onBackup
        // An explicit selection-export gesture wins even when saved print frames
        // also exist. Initial state is not reset after preview/share dismissal.
        _scope = State(initialValue: selectionRect != nil ? 1 : 2)
    }

    private var frames: [BoardPrintFrame] { snapshot.printFrames ?? [] }
    private var working: Bool { task != nil }
    private var useSelection: Bool { scope == 1 }
    private var available: Bool { scope == 2 || (useSelection ? selectionRect != nil : !frames.isEmpty) }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "导出范围")) {
                    Picker(String(localized: "范围"), selection: $scope) {
                        Text(String(localized: "打印框（\(frames.count) 页）")).tag(0)
                        Text(String(localized: "当前选择区")).tag(1)
                        Text(String(localized: "全部内容 · 自动分页")).tag(2)
                    }.accessibilityIdentifier("export.scope")
                    if scope == 2 {
                        Text(String(localized: "按全部内容边界逐页生成 Letter PDF／图片，保持比例，最多 200 页；远处内容不会静默省略。页面顺序从左到右、从上到下。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    } else if useSelection {
                        Text(selectionRect == nil ? String(localized: "请先回到白板框选要导出的区域。") : String(localized: "精确导出选区；PDF 和图片都不额外添加边距或页码。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text(String(localized: "Letter 纸张，四周留白半英寸，页脚居中连续页码。顺序与白板的打印框列表一致。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }.disabled(working)
                Section(String(localized: "发送到其他笔记应用")) {
                    Picker(String(localized: "目标应用"), selection: $targetApp) { ForEach(NoteExchangeApp.allCases) { Text($0.rawValue).tag($0) } }
                    Text(targetApp.exportGuide).font(.footnote).foregroundStyle(.secondary)
                    Text(String(localized: "导出可读副本：笔迹不再能单独擦除。折叠资料显示卡片；子白板请进入后分别导出，或收起后导出引用卡。音视频不嵌入，独立 PDF 阅读图层与留白请在 PDF 阅读中导出。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(working)
                Section(String(localized: "文件格式")) {
                    Picker(String(localized: "格式"), selection: $format) {
                        ForEach(BoardExportFormat.allCases) { Text($0.title).tag($0) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("export.format")
                    Picker(String(localized: "手写与图片清晰度"), selection: $dpi) {
                        Text(String(localized: "标准 · 144 dpi")).tag(144.0)
                        Text(String(localized: "清晰 · 216 dpi")).tag(216.0)
                        Text(String(localized: "打印 · 300 dpi")).tag(300.0)
                    }.accessibilityIdentifier("export.dpi")
                    Text(String(localized: "PDF 保留可用的文档与文字矢量内容；手写逐页生成清晰图片。多张图片按页编号，可一起分享或打包 ZIP。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(working)
                if let progress {
                    Section {
                        ProgressView(value: Double(progress.completedPages), total: Double(max(1, progress.totalPages)))
                        Text(progress.message).font(.callout).accessibilityIdentifier("export.progress")
                    }
                }
                if let message {
                    Section { Text(message).foregroundStyle(.secondary).accessibilityIdentifier("export.status") }
                }
                Section {
                    Button(working ? String(localized: "正在导出…") : String(localized: "生成导出文件"), systemImage: "square.and.arrow.up") { startExport() }
                        .disabled(working || !available).accessibilityIdentifier("export.generate")
                    if working {
                        Button(String(localized: "取消导出"), role: .destructive) { task?.cancel() }
                            .accessibilityIdentifier("export.cancel")
                    }
                    if let result, !working {
                        Text(String(localized: "已生成 \(result.pageCount) 页 · \(result.files.count) 个文件"))
                        Button(String(localized: "预览"), systemImage: "doc.text.magnifyingglass") { showPreview = true }
                            .accessibilityIdentifier("export.preview")
                        Button(String(localized: "存储到文件"), systemImage: "folder.badge.plus") {
                            saveRequest = .init(files: result.files)
                        }.accessibilityIdentifier("export.saveFile")
                        Button(String(localized: "分享或存储文件"), systemImage: "square.and.arrow.up") {
                            shareFiles = result.files; showShare = true
                        }.accessibilityIdentifier("export.share")
                        if result.files.count > 1 {
                            Button(String(localized: "打包 ZIP 并存储"), systemImage: "archivebox") { shareZIP(result, save: true) }
                                .accessibilityIdentifier("export.saveZIP")
                            Button(String(localized: "打包 ZIP 并分享"), systemImage: "archivebox") { shareZIP(result) }
                                .accessibilityIdentifier("export.zip")
                        }
                    }
                }
                if let onBackup {
                    Section {
                        Button(String(localized: "白板备份与恢复"), systemImage: "externaldrive.badge.timemachine") {
                            // The parent owns the queued next-sheet transition.
                            onBackup()
                        }.disabled(working).accessibilityIdentifier("export.backup")
                    } footer: { Text(String(localized: "备份保留当前白板及其引用附件，便于恢复后继续编辑，和打印导出分开。")) }
                }
            }
            .navigationTitle(String(localized: "导出白板"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "关闭")) { result?.removeTemporaryFiles(); dismiss() }.disabled(working).accessibilityIdentifier("export.close")
                }
            }
            .interactiveDismissDisabled(working)
            .onDisappear { task?.cancel() }
            .sheet(isPresented: $showShare) { BoardExportShare(files: shareFiles) }
            .sheet(isPresented: $showPreview) { BoardExportPreview(files: result?.files ?? []) }
            .sheet(item: $saveRequest) { save in
                NativeFileSavePicker(files: save.files) { saved in
                    message = saved ? String(localized: "文件已存储到所选位置。iCloud 传输由系统继续完成。")
                                    : String(localized: "未保存文件。已生成的副本保留，可再次选择存储位置。")
                }
            }
        }
    }

    @MainActor private func startExport() {
        guard task == nil else { return }
        let scope: BoardExportScope
        if self.scope == 2 { scope = .allContent }
        else if useSelection {
            guard let selectionRect else { return }
            scope = .selection(selectionRect)
        } else { scope = .printFrames(frames) }
        // Keep the last successful result until a replacement has succeeded.
        message = nil
        progress = .init(completedPages: 0, totalPages: self.scope == 2 ? 1 : useSelection ? 1 : frames.count, message: String(localized: "正在准备完整内容…"))
        let options = BoardExportOptions(scope: scope, format: format, dpi: dpi)
        task = Task { @MainActor in
            defer { task = nil }
            do {
                let exporter = BoardPrintExporter(rootURL: rootURL)
                let exported = try await exporter.export(snapshot: snapshot, options: options) { progress = $0 }
                result?.removeTemporaryFiles()
                result = exported
                message = String(localized: "导出完成。白板和原文件保持不变。")
            } catch is CancellationError { message = String(localized: "已取消导出，未完成的文件已清理。"); progress = nil }
            catch { DiagnosticsCenter.shared.record(code: .exportFailed, operation: .exportBoard, error: error); message = error.localizedDescription; progress = nil }
        }
    }

    @MainActor private func shareZIP(_ result: BoardExportResult, save: Bool = false) {
        guard task == nil else { return }
        let entries = result.files.map { (name: $0.lastPathComponent, url: $0) }
        let output = result.directory.appendingPathComponent(String(localized: "白板图片.zip"))
        task = Task { @MainActor in
            defer { task = nil }
            let worker = Task.detached(priority: .userInitiated) {
                // Only this export's generated ZIP may be replaced on a second tap.
                if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
                try BackupArchive.write(entries: entries, to: output)
            }
            do {
                try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
                try Task.checkCancellation()
                if save { saveRequest = .init(files: [output]) }
                else { shareFiles = [output]; showShare = true }
            } catch is CancellationError { message = String(localized: "已取消打包。") }
            catch { DiagnosticsCenter.shared.record(code: .exportFailed, operation: .exportBoard, error: error); message = error.localizedDescription }
        }
    }
}

private struct BoardExportShare: UIViewControllerRepresentable {
    let files: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: files, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) { }
}
private struct BoardExportPreview: UIViewControllerRepresentable {
    let files: [URL]
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator(files: files, onDismiss: { dismiss() }) }
    func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController()
        preview.dataSource = context.coordinator
        preview.navigationItem.title = String(localized: "导出预览")
        let done = UIBarButtonItem(title: String(localized: "完成"), style: .done,
            target: context.coordinator, action: #selector(Coordinator.finish))
        done.accessibilityIdentifier = "export.preview.done"
        preview.navigationItem.leftBarButtonItem = done
        let navigation = UINavigationController(rootViewController: preview)
        navigation.navigationBar.prefersLargeTitles = false
        navigation.setNavigationBarHidden(false, animated: false)
        return navigation
    }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {
        // Refresh the sheet's current environment action without retaining its UIKit host.
        context.coordinator.onDismiss = { dismiss() }
        if context.coordinator.files != files {
            context.coordinator.files = files
            (controller.viewControllers.first as? QLPreviewController)?.reloadData()
        }
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var files: [URL]
        var onDismiss: () -> Void
        init(files: [URL], onDismiss: @escaping () -> Void) {
            self.files = files; self.onDismiss = onDismiss
        }
        @objc func finish() { onDismiss() }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { files.count }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { files[index] as NSURL }
    }
}

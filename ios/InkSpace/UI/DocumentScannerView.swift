import Foundation
import PDFKit
#if canImport(UIKit)
import AVFoundation
import SwiftUI
import VisionKit

struct DocumentScannerView: UIViewControllerRepresentable {
    let onComplete: ([UIImage]) -> Void
    let onCancel: () -> Void
    let onFailure: (Error) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocumentScannerView
        init(parent: DocumentScannerView) { self.parent = parent }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            parent.onComplete((0..<scan.pageCount).map { scan.imageOfPage(at: $0) })
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { parent.onCancel() }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { parent.onFailure(error) }
    }
}

struct DocumentScanSheet: View {
    let library: DocumentLibrary?
    let canAddToBoard: Bool
    let onSaved: (URL, Bool, Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var pages: [ScannedDocumentPage] = []
    @State private var title = String(localized: "扫描文件") + " " + Date().formatted(.dateTime.year().month().day())
    @State private var directory: String
    @State private var addToBoard: Bool
    @State private var recognizeAfterSaving = false
    @State private var showsCamera = false
    @State private var showsFolderPicker = false
    @State private var showsExternalFolderPicker = false
    @State private var externalFolder: URL?
    @State private var editingPage: ScannedDocumentPage?
    @State private var confirmsDiscard = false
    @State private var cameraDenied = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var saveTask: Task<Void, Never>?

    init(library: DocumentLibrary?, initialDirectory: String, canAddToBoard: Bool, onSaved: @escaping (URL, Bool, Bool) -> Void) {
        self.library = library; self.canAddToBoard = canAddToBoard; self.onSaved = onSaved
        _directory = State(initialValue: initialDirectory)
        _addToBoard = State(initialValue: false)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField(String(localized: "PDF 文件名"), text: $title)
                        .accessibilityIdentifier("scanner.filename")
                    Button { if library != nil && externalFolder == nil { showsFolderPicker = true } else { showsExternalFolderPicker = true } } label: {
                        HStack {
                            Label(destinationLabel, systemImage: "folder")
                            Spacer(); Image(systemName: "chevron.right")
                        }
                    }.accessibilityIdentifier("scanner.folder")
                    Button(String(localized: "选择其他位置…")) { showsExternalFolderPicker = true }
                        .accessibilityIdentifier("scanner.folder.external")
                    if externalFolder != nil, library != nil {
                        Button(String(localized: "使用当前资料库")) { externalFolder = nil; showsFolderPicker = true }
                    }
                    if canAddToBoard { Toggle(String(localized: "保存后放入当前白板"), isOn: $addToBoard) }
                    Toggle(String(localized: "保存后识别文字"), isOn: $recognizeAfterSaving).accessibilityIdentifier("scanner.ocr")
                    if !canAddToBoard { Text(String(localized: "无需打开白板，扫描页面会一起保存为 PDF 到所选文件夹。")) .font(.caption).foregroundStyle(.secondary) }
                } header: { Text(String(localized: "保存设置")) }
                Section {
                    Button(pages.isEmpty ? String(localized: "开始扫描") : String(localized: "继续扫描"), systemImage: "doc.viewfinder") { requestCamera() }
                        .disabled(!VNDocumentCameraViewController.isSupported)
                        .accessibilityIdentifier("scanner.start")
                    if !VNDocumentCameraViewController.isSupported {
                        Text(String(localized: "这台设备暂不支持系统文档扫描，请使用带相机的 iPhone 或 iPad。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if cameraDenied {
                        Text(String(localized: "相机访问未获允许，请在系统设置中开启相机权限后重试。"))
                            .font(.footnote).foregroundStyle(.secondary)
                        Link(String(localized: "打开系统设置"), destination: URL(string: UIApplication.openSettingsURLString)!)
                    }
                    ForEach(Array(pages.enumerated()), id: \.element.id) { index, page in
                        Button { editingPage = page } label: {
                            HStack(spacing: 16) {
                                ScanPageThumbnail(page: page).frame(width: 64, height: 84)
                                VStack(alignment: .leading) {
                                    Text(String(localized: "第 \(index + 1) 页"))
                                    Text(page.appearance.title).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Label(String(localized: "裁剪与调整"), systemImage: "crop.rotate").font(.caption)
                            }
                        }.buttonStyle(.borderless).accessibilityIdentifier("scanner.page.\(index)")
                    }
                    .onDelete { pages.remove(atOffsets: $0) }
                    .onMove { pages.move(fromOffsets: $0, toOffset: $1) }
                } header: { Text(String(localized: "页面（\(pages.count)）")) }
                  footer: { Text(String(localized: "扫描保留纸张排版。点页面可裁剪、校正角度、旋转和选择彩色或黑白；编辑可排序和删除。默认仅保存 PDF，保存失败时保留页面。")) }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red).textSelection(.enabled) }
                if isSaving { ProgressView(String(localized: "正在生成并保存 PDF…")) }
            }
            .navigationTitle(String(localized: "扫描文件"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { if pages.isEmpty { dismiss() } else { confirmsDiscard = true } }.disabled(isSaving).accessibilityIdentifier("scanner.cancel") }
                ToolbarItemGroup(placement: .primaryAction) { EditButton().disabled(pages.isEmpty || isSaving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "保存 PDF")) { savePDF() }.disabled(pages.isEmpty || isSaving)
                        .accessibilityIdentifier("scanner.save")
                }
            }
            .disabled(isSaving)
            .interactiveDismissDisabled(!pages.isEmpty || isSaving)
            .sheet(isPresented: $showsFolderPicker) {
                if let library { BoardSaveDirectoryPicker(library: library, initialPath: directory) { directory = $0 } }
            }
            .sheet(isPresented: $showsExternalFolderPicker) {
                ScanDestinationPicker { url in externalFolder = url; showsExternalFolderPicker = false }
            }
            .sheet(item: $editingPage) { page in
                ScannedPageEditor(page: page) { edited in
                    if let index = pages.firstIndex(where: { $0.id == edited.id }) { pages[index] = edited }
                }
            }
            .confirmationDialog(String(localized: "放弃尚未保存的扫描？"), isPresented: $confirmsDiscard, titleVisibility: .visible) {
                Button(String(localized: "放弃扫描"), role: .destructive) { dismiss() }
                Button(String(localized: "继续编辑"), role: .cancel) {}
            }
            .fullScreenCover(isPresented: $showsCamera) {
                DocumentScannerView(onComplete: { images in
                    pages.append(contentsOf: images.map { ScannedDocumentPage(image: $0) })
                    showsCamera = false; errorMessage = nil
                }, onCancel: { showsCamera = false }, onFailure: { error in
                    showsCamera = false; errorMessage = String(localized: "扫描失败：\(error.localizedDescription)。已扫描的页面仍保留。")
                }).ignoresSafeArea()
            }
        }
    }

    private var destinationLabel: String {
        if let externalFolder { return externalFolder.lastPathComponent }
        guard let library else { return String(localized: "选择保存文件夹") }
        return directory.isEmpty ? library.rootURL.lastPathComponent : directory
    }
    private func requestCamera() {
        errorMessage = nil
        guard VNDocumentCameraViewController.isSupported else { return }
        Task { @MainActor in
            let granted: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: granted = true
            case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .video)
            default: granted = false
            }
            cameraDenied = !granted
            if granted { showsCamera = true }
        }
    }
    private func savePDF() {
        guard !isSaving, !pages.isEmpty else { return }
        guard let root = externalFolder ?? library?.rootURL else { showsExternalFolderPicker = true; return }
        isSaving = true; errorMessage = nil
        let values = pages, path = externalFolder == nil ? directory : ""
        let requestedName = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldAdd = addToBoard && canAddToBoard
        let shouldRecognize = recognizeAfterSaving
        saveTask = Task { @MainActor in
            defer { isSaving = false; saveTask = nil }
            do {
                let task = Task.detached(priority: .userInitiated) { () throws -> URL in
                    let pdfPages = try values.map { value -> PDFPage in
                        try autoreleasepool {
                            guard let page = PDFPage(image: try ScanPageRenderer.render(value)) else { throw ScanSaveError.invalidPDF }
                            return page
                        }
                    }
                    return try ScannedPDFExport.save(pages: pdfPages, root: root, relativeDirectory: path, title: requestedName)
                }
                let url = try await task.value
                onSaved(url, shouldAdd, shouldRecognize)
                dismiss()
            } catch {
                errorMessage = String(localized: "PDF 尚未保存：\(error.localizedDescription)。页面仍保留，请检查保存位置后重试。")
            }
        }
    }
}

private struct ScanPageThumbnail: View {
    let page: ScannedDocumentPage
    @State private var image: UIImage?
    private var key: String { "\(page.id)-\(page.quarterTurns)-\(page.angle)-\(page.crop)-\(page.appearance.rawValue)" }
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { ProgressView() }
        }.task(id: key) {
            let value = page
            let rendered = try? await Task.detached(priority: .utility) { try ScanPageRenderer.render(value, maxDimension: 200) }.value
            if !Task.isCancelled { image = rendered }
        }
    }
}

private struct ScanDestinationPicker: UIViewControllerRepresentable {
    let onSelect: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.allowsMultipleSelection = false; picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let parent: ScanDestinationPicker
        init(parent: ScanDestinationPicker) { self.parent = parent }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if let url = urls.first { parent.onSelect(url) }
            parent.dismiss()
        }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { parent.dismiss() }
    }
}
#endif

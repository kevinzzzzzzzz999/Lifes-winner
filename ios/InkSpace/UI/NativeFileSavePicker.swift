import SwiftUI
import UIKit
import QuickLook

struct NativeFileSaveRequest: Identifiable {
    let id = UUID()
    let files: [URL]
}

/// Export copies, never moves the vault source. The system owns destination
/// selection and overwrite confirmation; cancellation does not imply a save.
struct NativeFileSavePicker: UIViewControllerRepresentable {
    let files: [URL]
    let onCompletion: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(onCompletion: onCompletion, dismiss: { dismiss() }) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: files, asCopy: true)
        picker.delegate = context.coordinator
        picker.shouldShowFileExtensions = true
        picker.view.accessibilityIdentifier = "files.savePicker"
        return picker
    }
    func updateUIViewController(_ picker: UIDocumentPickerViewController, context: Context) {
        context.coordinator.onCompletion = onCompletion
        context.coordinator.dismiss = { dismiss() }
    }
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        var onCompletion: (Bool) -> Void
        var dismiss: () -> Void
        private var replied = false
        init(onCompletion: @escaping (Bool) -> Void, dismiss: @escaping () -> Void) {
            self.onCompletion = onCompletion; self.dismiss = dismiss
        }
        private func finish(_ saved: Bool) {
            guard !replied else { return }; replied = true
            onCompletion(saved); dismiss()
        }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            finish(!urls.isEmpty)
        }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(false) }
    }
}

struct NativeFileShare: UIViewControllerRepresentable {
    let files: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: files, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) { }
}

struct NativeFilePreview: UIViewControllerRepresentable {
    let files: [URL]
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator(files: files, onDismiss: { dismiss() }) }
    func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController(); preview.dataSource = context.coordinator
        preview.navigationItem.title = String(localized: "导出预览")
        let done = UIBarButtonItem(title: String(localized: "完成"), style: .done,
                                  target: context.coordinator, action: #selector(Coordinator.finish))
        done.accessibilityIdentifier = "files.preview.done"
        preview.navigationItem.leftBarButtonItem = done
        return UINavigationController(rootViewController: preview)
    }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {
        context.coordinator.onDismiss = { dismiss() }
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let files: [URL]
        var onDismiss: () -> Void
        init(files: [URL], onDismiss: @escaping () -> Void) { self.files = files; self.onDismiss = onDismiss }
        @objc func finish() { onDismiss() }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { files.count }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { files[index] as NSURL }
    }
}

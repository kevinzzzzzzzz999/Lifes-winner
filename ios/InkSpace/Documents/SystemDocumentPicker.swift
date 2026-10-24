import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// Opens original URLs. DocumentLibrary decides whether a vault reference or an
/// explicitly disclosed external-file copy is needed; the picker never imports copies.
struct SystemDocumentPicker: UIViewControllerRepresentable {
    var directoryURL: URL? = nil
    let onSelect: ([URL]) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onSelect: onSelect, onCancel: onCancel) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let types = DocumentLibrary.supportedExtensions.sorted().compactMap { UTType(filenameExtension: $0) }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
        picker.allowsMultipleSelection = true
        picker.shouldShowFileExtensions = true
        picker.directoryURL = directoryURL
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIDocumentPickerViewController, context: Context) {
        context.coordinator.onSelect = onSelect
        context.coordinator.onCancel = onCancel
    }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        var onSelect: ([URL]) -> Void
        var onCancel: () -> Void
        init(onSelect: @escaping ([URL]) -> Void, onCancel: @escaping () -> Void) {
            self.onSelect = onSelect
            self.onCancel = onCancel
        }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if urls.isEmpty { onCancel() } else { onSelect(urls) }
        }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onCancel() }
    }
}

import SwiftUI

/// Original Office bytes stay in the offline reader until the reader explicitly asks
/// for a versioned PDF rendition. This route never inserts or saves board items.
struct OfficeReadingTranslationView: View {
    let library: DocumentLibrary
    let sourceURL: URL
    let onOpenWeb: (URL) -> Void
    let onOpenPDF: (URL) -> Void
    @State private var operation: Task<Void, Never>?
    @State private var status = ""
    @State private var error = ""
    @State private var warnings: [String] = []
    @State private var previewURL: URL?
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button(String(localized: "阅读与翻译"), systemImage: "character.book.closed") { prepare() }
                        .accessibilityIdentifier("office.readTranslate").disabled(operation != nil)
                    if operation != nil {
                        ProgressView().controlSize(.small)
                        Button(String(localized: "取消")) { operation?.cancel() }
                    }
                    Spacer()
                }.buttonStyle(.bordered)
                Text("按当前原件生成独立 PDF 阅读版，可圈选翻译或范围翻译；不会改写原文件或白板。排版可能与 Office 原版不同。")
                    .font(.caption).foregroundStyle(.secondary)
                if !status.isEmpty { Text(status).font(.caption).accessibilityIdentifier("office.readingStatus") }
                if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red).accessibilityIdentifier("office.readingError") }
                if !warnings.isEmpty {
                    ScrollView { Text(warnings.joined(separator: "\n")).font(.caption).foregroundStyle(.orange) }.frame(maxHeight: 110)
                    if let previewURL {
                        Button(String(localized: "打开阅读版")) { onOpenPDF(previewURL) }.accessibilityIdentifier("office.openPreview")
                    }
                }
            }.padding(10)
            InlineOfficeReadingView(url: sourceURL, onOpenWeb: onOpenWeb)
        }
        .onDisappear { operation?.cancel(); operation = nil }
    }
    private func prepare() {
        guard operation == nil else { return }
        error = ""; warnings = []; previewURL = nil
        status = String(localized: "正在生成阅读版…")
        operation = Task { @MainActor in
            defer { operation = nil }
            do {
                let result = try await library.prepareOfficeReadingPreview(sourceURL: sourceURL) { status = $0 }
                try Task.checkCancellation()
                previewURL = result.url; warnings = result.warnings; status = ""
                if warnings.isEmpty { onOpenPDF(result.url) }
            } catch is CancellationError { status = String(localized: "已取消生成阅读版，原文件保持不变。") }
            catch { status = ""; self.error = error.localizedDescription }
        }
    }
}

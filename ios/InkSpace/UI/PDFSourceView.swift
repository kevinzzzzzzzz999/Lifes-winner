import PDFKit
import SwiftUI
import UIKit

/// Opens the original PDF in place and navigates to the board's one-based page.
/// The surrounding document library retains the folder's security scope.
struct PDFSourceView: View {
    let url: URL
    let page: Int
    @State private var translation: PDFTranslationSession
    @State private var source = PDFReaderTranslationSource()
    init(url: URL, page: Int, translation: PDFTranslationSession? = nil) {
        self.url = url; self.page = page; _translation = State(initialValue: translation ?? PDFTranslationSession())
    }
    var body: some View {
        PDFSourceContentView(url: url, page: page, translationSource: source)
            .overlay { if UIDevice.current.userInterfaceIdiom == .pad { PDFTranslationOverlay(session: translation) } }
            .safeAreaInset(edge: .top) {
                if UIDevice.current.userInterfaceIdiom == .pad {
                    HStack {
                        Button(String(localized: "圈选翻译"), systemImage: "character.bubble") { translation.begin(source: source) }
                            .accessibilityIdentifier("translation.begin.pdf")
                        Button(String(localized: "翻译设置"), systemImage: "gearshape") { translation.showsSettings = true }
                            .accessibilityIdentifier("translation.settings.pdf")
                        Spacer()
                        Text(String(localized: "框选范围，松手翻译")).font(.caption).foregroundStyle(.secondary)
                    }.buttonStyle(.bordered).padding(8).background(.regularMaterial)
                }
            }
            .onChange(of: url) { _, _ in translation.close() }
            .onChange(of: page) { _, _ in translation.close() }
            .onDisappear { translation.close() }
            .opensExternalLinksInApp()
    }
}

private struct PDFSourceContentView: UIViewRepresentable {
    let url: URL
    let page: Int
    let translationSource: PDFReaderTranslationSource
    @Environment(\.openURL) private var openURL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.delegate = context.coordinator
        context.coordinator.openURL = { openURL($0) }
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.accessibilityLabel = String(localized: "PDF 原文，第 \(page) 页")
        view.accessibilityIdentifier = "translation.pdfReader"
        translationSource.view = view
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        let coordinator = context.coordinator
        coordinator.openURL = { openURL($0) }
        guard coordinator.url != url || coordinator.page != page else { return }
        coordinator.url = url
        coordinator.page = page
        translationSource.snapshotSessionID = UUID()
        view.viewWithTag(Coordinator.messageTag)?.removeFromSuperview()
        guard let document = PDFDocument(url: url), !document.isLocked else {
            view.document = nil
            showMessage(String(localized: "无法打开 PDF。请确认原文件已完整下载且未加密。"), in: view)
            return
        }
        view.document = document
        guard page >= 1, let target = document.page(at: page - 1) else {
            showMessage(String(localized: "原文件目前没有第 \(page) 页，请检查文档是否已被替换。"), in: view)
            return
        }
        view.go(to: target)
        // The first update may precede the sheet's final layout. Reapply once after
        // layout, without pulling the reader back on unrelated SwiftUI updates.
        DispatchQueue.main.async { [weak view, weak coordinator] in
            guard let view, let coordinator, coordinator.url == url,
                  coordinator.page == page, view.document === document else { return }
            view.layoutDocumentView()
            view.go(to: target)
        }
    }

    private func showMessage(_ message: String, in view: PDFView) {
        let label = UILabel()
        label.tag = Coordinator.messageTag
        label.text = message
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.backgroundColor = .secondarySystemBackground
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])
    }

    final class Coordinator: NSObject, PDFViewDelegate {
        var openURL: ((URL) -> Void)?
        func pdfViewWillClick(onLink sender: PDFView, with url: URL) {
            guard ["https", "http", "mailto", "obsidian", "inkspace"].contains(url.scheme?.lowercased() ?? "") else { return }
            openURL?(url)
        }
        static let messageTag = 740_131
        var url: URL?
        var page: Int?
    }
}

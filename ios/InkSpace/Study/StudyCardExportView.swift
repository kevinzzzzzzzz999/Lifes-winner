import SwiftUI
import PDFKit

/// Creates a separate PDF copy. Hidden masks are flattened into the exported
/// image, so the PDF never embeds an uncovered source below a covering shape.
struct StudyCardExportView: View {
    let rootURL: URL?
    let card: StudyCardPayload
    let item: BoardItem?
    @Environment(\.dismiss) private var dismiss
    @State private var includesAnswers = false
    @State private var url: URL?
    @State private var error: String?
    @State private var working = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                Toggle(String(localized: "导出包含答案"), isOn: $includesAnswers)
                    .padding(.horizontal).accessibilityIdentifier("study.export.answers")
                Text(includesAnswers ? String(localized: "此副本显示所有遮盖区域和答案。") : String(localized: "此副本遮住图片区域，并省略答案面。"))
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                if working { ProgressView(String(localized: "正在生成卡片预览…")) }
                if let error { Text(error).foregroundStyle(.orange).padding() }
                if let url, !working {
                    StudyExportPDFPreview(url: url).accessibilityIdentifier("study.export.preview")
                    ShareLink(String(localized: "分享 PDF 副本"), item: url)
                        .buttonStyle(.borderedProminent).padding().accessibilityIdentifier("study.export.share")
                } else { Spacer() }
            }
            .navigationTitle(String(localized: "图文卡片导出预览")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(String(localized: "关闭")) { dismiss() }.accessibilityIdentifier("study.export.close")
            } }
            .task(id: includesAnswers) {
                working = true; error = nil; url = nil
                do {
                    let result = try await StudyCardPDFExport.make(root: rootURL, card: card, item: item, includesAnswers: includesAnswers)
                    try Task.checkCancellation(); url = result; working = false
                } catch is CancellationError {} catch { self.error = error.localizedDescription; working = false }
            }
        }
    }
}
private struct StudyExportPDFPreview: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous; return view }
    func updateUIView(_ view: PDFView, context: Context) { if view.document?.documentURL != url { view.document = PDFDocument(url: url) } }
}

@MainActor enum StudyCardPDFExport {
    static func make(root: URL?, card: StudyCardPayload, item: BoardItem?, includesAnswers: Bool) async throws -> URL {
        try card.validate()
        var images: [String: UIImage] = [:]
        var paths = (card.questionBlocks ?? []).compactMap(\.sourcePath)
        if includesAnswers {
            paths += (card.answerBlocks ?? []).compactMap(\.sourcePath)
            if card.answerMode == "node", StudyNodes.isImage(item), let path = item?.sourcePath { paths.append(path) }
        }
        for path in Set(paths) {
            guard let root else { throw VisualNoteAssetError.missing }
            images[path] = try await VisualNoteAssets.image(root: root, path: path, maximumPixelSize: 1536)
            try Task.checkCancellation()
        }
        let page = CGRect(x: 0, y: 0, width: 612, height: 792)
        let renderer = UIGraphicsPDFRenderer(bounds: page)
        let data = renderer.pdfData { context in
            var y: CGFloat = 44
            func newPage() { context.beginPage(); y = 44 }
            func ensure(_ height: CGFloat) { if y + height > 748 { newPage() } }
            func text(_ text: String, font: UIFont = .systemFont(ofSize: 16)) {
                for paragraph in text.components(separatedBy: "\n") {
                    let chars = Array(paragraph)
                    if chars.isEmpty { y += 12; continue }
                    for index in stride(from: 0, to: chars.count, by: 250) {
                        let value = String(chars[index..<min(index + 250, chars.count)]) as NSString
                        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.black]
                        let height = ceil(value.boundingRect(with: CGSize(width: 524, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes, context: nil).height)
                        ensure(height + 8); value.draw(in: CGRect(x: 44, y: y, width: 524, height: height + 2), withAttributes: attributes); y += height + 8
                    }
                }
            }
            func image(_ original: UIImage, masks: [StudyOcclusionRegion]) {
                let flattened: UIImage
                if masks.isEmpty { flattened = original }
                else {
                    let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
                    flattened = UIGraphicsImageRenderer(size: original.size, format: format).image { output in
                        original.draw(in: CGRect(origin: .zero, size: original.size))
                        UIColor(red: 0.17, green: 0.32, blue: 0.27, alpha: 1).setFill()
                        for region in masks {
                            output.cgContext.fill(CGRect(x: region.x * original.size.width, y: region.y * original.size.height,
                                width: region.width * original.size.width, height: region.height * original.size.height))
                        }
                    }
                }
                let scale = min(524 / max(1, flattened.size.width), 460 / max(1, flattened.size.height))
                let size = CGSize(width: flattened.size.width * scale, height: flattened.size.height * scale)
                ensure(size.height + 16); flattened.draw(in: CGRect(x: 44, y: y, width: size.width, height: size.height)); y += size.height + 16
            }
            func blocks(_ blocks: [StudyContentBlock]) {
                for block in blocks {
                    if block.kind == "text" { text(block.text ?? "") }
                    else if let path = block.sourcePath, let value = images[path] { image(value, masks: includesAnswers ? [] : block.regions ?? []) }
                }
            }
            newPage()
            text(card.mode == "cloze" && !includesAnswers ? ((try? StudyCloze.front(card.question)) ?? card.question) : card.question, font: .boldSystemFont(ofSize: 20))
            blocks(card.questionBlocks ?? [])
            if includesAnswers {
                text(String(localized: "答案"), font: .boldSystemFont(ofSize: 20))
                if card.mode == "cloze" { text(StudyCloze.revealed(card.question)) }
                if card.answerMode == "node", StudyNodes.isImage(item), let path = item?.sourcePath, let value = images[path] { image(value, masks: []) }
                else { text(card.answerMode == "node" ? StudyNodes.answer(item) : card.answer) }
                blocks(card.answerBlocks ?? [])
            }
        }
        try Task.checkCancellation()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Study65-Exports", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("Study-" + UUID().uuidString + ".pdf")
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        return url
    }
}

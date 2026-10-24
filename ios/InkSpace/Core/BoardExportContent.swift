import UIKit
import PDFKit
import WebKit

/// Export uses fresh bounded content, never a viewport thumbnail or a source write.
@MainActor enum BoardExportContent {
    static func richTextPDF(item: BoardItem, body: CGRect) async throws -> (document: PDFDocument, bytes: Int) {
        guard body.width > 0, body.height > 0 else { throw BoardExportContentError.doesNotFit(item.title) }
        let page = BoardRichTextPage()
        defer { page.close() }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let value = try await page.load(item: item, editable: false, width: Double(body.width))
            guard let width = value["width"] as? Double, let height = value["height"] as? Double,
                  width.isFinite, height.isFinite, width > 0, height > 0,
                  width <= 4096, height <= 8192, width * height <= 8_000_000 else {
                throw BoardExportContentError.unavailable(item.title)
            }
            let size = CGSize(width: width, height: height)
            _ = try fittedContent(size: size, in: body, title: item.title)
            page.webView.frame.size = size
            let configuration = WKPDFConfiguration(); configuration.rect = CGRect(origin: .zero, size: size)
            let data = try await page.pdf(configuration: configuration)
            try Task.checkCancellation()
            guard !data.isEmpty, data.count <= 64 * 1024 * 1024,
                  let document = PDFDocument(data: data), document.pageCount == 1,
                  !document.isLocked, let first = document.page(at: 0),
                  first.bounds(for: .mediaBox).width > 0, first.bounds(for: .mediaBox).height > 0 else {
                throw BoardExportContentError.unavailable(item.title)
            }
            return (document, data.count)
        } onCancel: { Task { @MainActor in page.close() } }
    }

    /// Keep the requested font size; narrow cards may reduce width, but height
    /// never silently shrinks or clips a long table/text block to make it fit.
    static func fittedContent(size: CGSize, in body: CGRect, title: String) throws -> CGRect {
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              body.width.isFinite, body.height.isFinite, body.width > 0, body.height > 0 else {
            throw BoardExportContentError.doesNotFit(title)
        }
        let scale = min(1, body.width / size.width)
        let height = size.height * scale
        guard height <= body.height + 0.5 else { throw BoardExportContentError.doesNotFit(title) }
        return CGRect(x: body.minX, y: body.minY, width: size.width * scale, height: height)
    }

    static func validateText(_ item: BoardItem, layout: BoardExportCardLayout) throws {
        let text = item.kind == .document ? item.sourcePath ?? "" : item.text ?? ""
        guard !text.isEmpty else { return }
        guard layout.body.width > 0, layout.body.height > 0 else { throw BoardExportContentError.doesNotFit(item.title) }
        let bounds = (text as NSString).boundingRect(with: CGSize(width: layout.body.width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: layout.bodyAttributes, context: nil)
        guard bounds.width.isFinite, bounds.height.isFinite,
              ceil(bounds.width) <= layout.body.width + 0.5,
              ceil(bounds.height) <= layout.body.height + 0.5 else { throw BoardExportContentError.doesNotFit(item.title) }
    }
}

/// The same title/body geometry and fonts as the canvas at world scale 1.
@MainActor struct BoardExportCardLayout {
    let title: CGRect
    let body: CGRect
    let titleFont: UIFont
    let bodyFont: UIFont
    let textColor: UIColor
    let fillColor: UIColor
    let strokeColor: UIColor
    let strokeWidth: CGFloat
    let shape: BoardNodeShape?
    let styled: Bool

    init(_ item: BoardItem) {
        styled = item.style != nil && (item.kind == .text || item.kind == .formula)
        let style = styled ? item.style : nil
        shape = style.map { $0.shape ?? .rounded }
        let content = shape == .ellipse ? item.rect.insetBy(dx: item.width * 0.15, dy: item.height * 0.15) : item.rect
        let titleSize = CGFloat(style?.fontSize ?? 13)
        titleFont = .systemFont(ofSize: max(1, titleSize), weight: .semibold)
        let fontSize = CGFloat(style?.fontSize ?? 16)
        bodyFont = item.usesMonospacedText ? .monospacedSystemFont(ofSize: max(1, fontSize), weight: .regular) : .systemFont(ofSize: max(1, fontSize))
        textColor = BoardStyledDrawing.color(style?.textColor) ?? .darkGray
        fillColor = BoardStyledDrawing.color(style?.fillColor) ?? .white
        strokeColor = BoardStyledDrawing.color(style?.strokeColor) ?? (styled ? UIColor.black.withAlphaComponent(0.13) : UIColor(white: 0.83, alpha: 1))
        strokeWidth = CGFloat(style?.strokeWidth ?? 1)
        if styled {
            let height = max(12, titleSize * 1.4)
            title = CGRect(x: content.minX + 12, y: content.minY + 6,
                           width: max(0, content.width - 24), height: height)
            body = CGRect(x: title.minX, y: title.maxY + 6, width: title.width,
                          height: max(0, content.maxY - title.maxY - 12))
        } else {
            title = CGRect(x: item.x + 12, y: item.y + 3, width: max(0, item.width - 24), height: max(0, min(28, item.height) - 6))
            body = CGRect(x: item.x + 12, y: item.y + 40, width: max(0, item.width - 24), height: max(0, item.height - 52))
        }
    }
    var bodyAttributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byWordWrapping
        return [.font: bodyFont, .foregroundColor: textColor, .paragraphStyle: paragraph]
    }
    var titleAttributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
        return [.font: titleFont, .foregroundColor: textColor, .paragraphStyle: paragraph]
    }
}

enum BoardExportContentError: LocalizedError {
    case doesNotFit(String), unavailable(String), expandedChild(String)
    var errorDescription: String? {
        switch self {
        case .doesNotFit(let title): String(localized: "内容超出文本框：\(title)。请调大文本框或拆分内容后再导出，避免文字或表格被裁掉。")
        case .unavailable(let title): String(localized: "无法完整排版：\(title)。请修正内容后重试；未生成不完整的导出文件。")
        case .expandedChild(let title): String(localized: "展开的子白板尚不支持合并导出：\(title)。请进入子白板单独导出，或收起后导出引用卡片。")
        }
    }
}

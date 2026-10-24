import UIKit

/// Shared native drawing for optional schema-1 graph styles. Source PDF pages
/// and unstyled cards continue through their original rendering paths.
@MainActor enum BoardStyledDrawing {
    static func color(_ hex: String?) -> UIColor? {
        guard let hex, hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                       green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }

    static func card(_ item: BoardItem, frame: CGRect, scale: CGFloat, selected: Bool,
                     formula: UIImage?, richTextFailed: Bool = false, context: CGContext) {
        guard let style = item.style else { return }
        context.saveGState()
        defer { context.restoreGState() }
        let path: UIBezierPath
        switch style.shape ?? .rounded {
        case .ellipse: path = UIBezierPath(ovalIn: frame)
        case .rectangle: path = UIBezierPath(rect: frame)
        case .rounded: path = UIBezierPath(roundedRect: frame, cornerRadius: min(12, 8 * scale))
        }
        (color(style.fillColor) ?? .white).setFill(); path.fill()
        (selected ? UIColor.systemTeal : color(style.strokeColor) ?? UIColor.black.withAlphaComponent(0.13)).setStroke()
        path.lineWidth = selected ? 2.5 : style.strokeWidth.map { max(0.25, $0 * scale) } ?? 1
        path.stroke(); path.addClip()
        guard frame.width >= 24, frame.height >= 18 else { return }
        let inset = max(3, 12 * scale)
        // An ellipse uses its inscribed central rectangle for readable text.
        let contentFrame = style.shape == .ellipse ? frame.insetBy(dx: frame.width * 0.15, dy: frame.height * 0.15) : frame
        let fontSize = CGFloat(style.fontSize ?? 16) * scale
        let titleSize = style.fontSize.map { CGFloat($0) * scale } ?? min(18, max(7, 13 * scale))
        let titleHeight = max(12, titleSize * 1.4)
        let textColor = color(style.textColor) ?? .darkGray
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
        let title = CGRect(x: contentFrame.minX + inset, y: contentFrame.minY + inset / 2,
                           width: max(0, contentFrame.width - 2 * inset), height: titleHeight)
        (item.title as NSString).draw(in: title, withAttributes: [.font: UIFont.systemFont(ofSize: max(1, titleSize), weight: .semibold), .foregroundColor: textColor, .paragraphStyle: paragraph])
        let body = CGRect(x: title.minX, y: title.maxY + inset / 2,
                          width: title.width, height: max(0, contentFrame.maxY - title.maxY - inset))
        guard body.width > 0, body.height > 0 else { return }
        if item.usesRichTextRendering, let formula {
            let factor = min(body.width / max(1,formula.size.width),body.height / max(1,formula.size.height))
            formula.draw(in:CGRect(x:body.minX,y:body.minY,width:formula.size.width*factor,height:formula.size.height*factor))
        } else if item.usesFormulaRendering, let formula {
            // Formula thumbnails are captured at 2x. Retain the requested point
            // size, reducing only if the content cannot fit its existing node.
            let factor = min(scale / 2, body.width / max(1, formula.size.width), body.height / max(1, formula.size.height))
            let size = CGSize(width: formula.size.width * factor, height: formula.size.height * factor)
            formula.draw(in: CGRect(x: body.minX, y: body.minY, width: size.width, height: size.height))
        } else {
            let bodyFont = item.usesMonospacedText ? UIFont.monospacedSystemFont(ofSize: max(1, fontSize), weight: .regular) : UIFont.systemFont(ofSize: max(1, fontSize))
            ((richTextFailed ? String(localized:"表格预览暂不可用，原内容已保留。") + "\n" : "") + (item.text ?? "") as NSString).draw(in: body, withAttributes: [.font: bodyFont, .foregroundColor: textColor])
        }
    }

    static func edgeStyle(_ edge: BoardEdge, scale: CGFloat, context: CGContext) {
        context.setStrokeColor((color(edge.style?.strokeColor) ?? UIColor.systemTeal.withAlphaComponent(0.72)).cgColor)
        context.setLineWidth(edge.style?.strokeWidth.map { max(0.25, $0 * scale) } ?? max(1, min(3, 2 * scale)))
        context.setAlpha(edge.style?.opacity ?? 1)
        let pattern: [CGFloat]
        switch edge.style?.dash ?? .solid {
        case .solid: pattern = []
        case .dashed: pattern = [8, 5]
        case .dotted: pattern = [2, 4]
        case .dashDot: pattern = [9, 4, 2, 4]
        }
        context.setLineDash(phase: 0, lengths: pattern.map { max(0.25, $0 * scale) })
    }

    static func relation(_ text: String?, at point: CGPoint, scale: CGFloat) {
        guard let text, !text.isEmpty, scale >= 0.2 else { return }
        let font = UIFont.systemFont(ofSize: max(6, min(20, 12 * scale)))
        let rect = CGRect(x: point.x - 100 * scale, y: point.y - 9 * scale, width: 200 * scale, height: 22 * scale)
        let style = NSMutableParagraphStyle(); style.alignment = .center; style.lineBreakMode = .byTruncatingTail
        (text as NSString).draw(in: rect, withAttributes: [.font: font, .foregroundColor: UIColor.label, .backgroundColor: UIColor.systemBackground.withAlphaComponent(0.9), .paragraphStyle: style])
    }

    static func arrow(at tip: CGPoint, from control: CGPoint, scale: CGFloat, context: CGContext) {
        let dx = tip.x - control.x, dy = tip.y - control.y
        let length = hypot(dx, dy)
        guard length > 0.001 else { return }
        let ux = dx / length, uy = dy / length, size = min(24, max(3, 10 * scale))
        context.move(to: CGPoint(x: tip.x - ux * size - uy * size * 0.5, y: tip.y - uy * size + ux * size * 0.5))
        context.addLine(to: tip)
        context.addLine(to: CGPoint(x: tip.x - ux * size + uy * size * 0.5, y: tip.y - uy * size - ux * size * 0.5))
        context.strokePath()
    }
}

import Foundation
import CoreGraphics
import PencilKit

/// Resizes an image presentation and only unambiguously owned whole strokes.
/// Pure value transformation: callers commit document + drawing together only
/// after this succeeds. This never reads or writes original/derived files.
enum BoardImageResizing {
    struct Result {
        var document: BoardDocument
        var drawing: PKDrawing
        var movedStrokeCount: Int
        var movedGroupCount: Int
    }
    enum Failure: LocalizedError {
        case notImage, invalidScale, outsideCanvas, crossingStroke, overlappingPage, incompleteGroup, invalidInk, occupiedDestination
        var errorDescription: String? {
            switch self {
            case .notImage: String(localized: "这个节点不是可调整比例的图片。")
            case .invalidScale: String(localized: "请选择 25%–200% 的图片比例。")
            case .outsideCanvas: String(localized: "调整后的图片或笔迹超出白板范围，请先把图片移到更宽敞的位置。")
            case .crossingStroke: String(localized: "有笔画跨过图片边界。请先整理这些笔画，再调整图片比例；本次没有改变任何内容。")
            case .overlappingPage: String(localized: "图片与其他 PDF 页面重叠，无法确定笔迹归属。请先分开页面；本次没有改变任何内容。")
            case .incompleteGroup: String(localized: "有手写节点跨过图片边界，或节点笔迹不完整。请先移开或完整纳入图片；本次没有改变任何内容。")
            case .invalidInk: String(localized: "无法完整核对图片附近的笔迹，本次没有改变任何内容。")
            case .occupiedDestination: String(localized: "放大后的图片会覆盖外部笔迹或手写节点。请先腾出空间；本次没有改变任何内容。")
            }
        }
    }
    static func isImage(_ item: BoardItem) -> Bool {
        item.kind == .pdfPage && item.originalSourcePath.map {
            ["png", "jpg", "jpeg"].contains(($0 as NSString).pathExtension.lowercased())
        } == true
    }
    static func resize(document: BoardDocument, drawing: PKDrawing, itemID: UUID, scale: Double) throws -> Result {
        try document.validate()
        guard scale.isFinite, (0.25...2).contains(scale) else { throw Failure.invalidScale }
        guard let index = document.items.firstIndex(where: { $0.id == itemID }), isImage(document.items[index]) else { throw Failure.notImage }
        let image = document.items[index], old = image.rect
        guard valid(old) else { throw Failure.outsideCanvas }
        if scale == 1 { return Result(document: document, drawing: drawing, movedStrokeCount: 0, movedGroupCount: 0) }
        let next = CGRect(x: old.minX, y: old.minY, width: old.width * scale, height: old.height * scale)
        let world = CGRect(x: 0, y: 0, width: document.canvasWidth, height: document.canvasHeight)
        guard valid(next), world.contains(next) else { throw Failure.outsideCanvas }
        for item in document.items where item.kind == .pdfPage && item.id != itemID {
            if overlaps(old, item.rect) || overlaps(next, item.rect) { throw Failure.overlappingPage }
        }
        let transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                         tx: old.minX * (1-scale), ty: old.minY * (1-scale))
        var nextStrokes: [PKStroke] = []; nextStrokes.reserveCapacity(drawing.strokes.count)
        var moved = 0, count = 0
        for stroke in drawing.strokes {
            try Task.checkCancellation(); count += stroke.path.count
            guard count <= 2_000_000, stroke.path.count > 0, valid(stroke.renderBounds) else { throw Failure.invalidInk }
            let bounds = stroke.renderBounds
            if old.contains(bounds) {
                let transformed = PKDrawing(strokes: [stroke]).transformed(using: transform).strokes
                guard transformed.count == 1, valid(transformed[0].renderBounds), world.contains(transformed[0].renderBounds),
                      next.contains(transformed[0].renderBounds) else { throw Failure.outsideCanvas }
                nextStrokes.append(transformed[0]); moved += 1
            } else {
                if overlaps(old, bounds) { throw Failure.crossingStroke }
                if overlaps(next, bounds) { throw Failure.occupiedDestination }
                nextStrokes.append(stroke)
            }
        }
        var result = document, movedGroups = 0
        for groupIndex in result.items.indices where result.items[groupIndex].kind == .inkGroup {
            try Task.checkCancellation()
            let group = result.items[groupIndex]
            // A group whose metadata is far away may still contain large local
            // strokes. Decode all groups before claiming spatial independence.
            guard let bytes = group.inkData, let ink = try? PKDrawing(data: bytes), !ink.strokes.isEmpty else { throw Failure.incompleteGroup }
            count += ink.strokes.reduce(0) { $0 + $1.path.count }
            guard count <= 2_000_000, valid(group.rect), ink.strokes.allSatisfy({ valid($0.renderBounds) && !$0.path.isEmpty }) else { throw Failure.invalidInk }
            let worldInk = ink.transformed(using: CGAffineTransform(translationX: group.x, y: group.y))
            let inkBounds = worldInk.bounds
            guard valid(inkBounds) else { throw Failure.invalidInk }
            let touchesOld = overlaps(old, group.rect) || overlaps(old, inkBounds)
            if touchesOld {
                guard old.contains(group.rect), old.contains(inkBounds),
                      CGRect(x: 0,y: 0,width: group.width,height: group.height).contains(ink.bounds) else { throw Failure.incompleteGroup }
                let scaled = ink.transformed(using: CGAffineTransform(scaleX: scale, y: scale))
                result.items[groupIndex].x = old.minX + (group.x-old.minX) * scale
                result.items[groupIndex].y = old.minY + (group.y-old.minY) * scale
                result.items[groupIndex].width = group.width * scale
                result.items[groupIndex].height = group.height * scale
                result.items[groupIndex].inkData = scaled.dataRepresentation()
                let bounds = scaled.transformed(using: CGAffineTransform(translationX: result.items[groupIndex].x, y: result.items[groupIndex].y)).bounds
                guard world.contains(bounds), next.contains(bounds), next.contains(result.items[groupIndex].rect) else { throw Failure.outsideCanvas }
                movedGroups += 1
            } else if overlaps(next, group.rect) || overlaps(next, inkBounds) { throw Failure.occupiedDestination }
        }
        result.items[index].width = next.width; result.items[index].height = next.height
        let transformedDrawing = PKDrawing(strokes: nextStrokes)
        result.drawing = transformedDrawing.dataRepresentation()
        // These are derived representations; normal save regenerates them from
        // editable ink and writes only this board's owned PDF annotations.
        result.webInk = nil; result.previewPNG = nil
        try result.validate()
        return Result(document: result, drawing: transformedDrawing, movedStrokeCount: moved, movedGroupCount: movedGroups)
    }
    private static func valid(_ rect: CGRect) -> Bool {
        !rect.isNull && !rect.isInfinite && [rect.minX,rect.minY,rect.width,rect.height].allSatisfy(\.isFinite) && rect.width > 0 && rect.height > 0
    }
    private static func overlaps(_ a: CGRect, _ b: CGRect) -> Bool {
        let intersection = a.intersection(b)
        return !intersection.isNull && intersection.width > 0 && intersection.height > 0
    }
}

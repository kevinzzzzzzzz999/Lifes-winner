import Foundation
import PencilKit

enum BoardInkLocator {
    /// PencilKit keeps creation time through grouping and transforms. Array order
    /// alone is not chronology: grouped ink is stored separately from free ink.
    static func location(drawing: PKDrawing, items: [BoardItem], canvasSize: Double) -> BoardInkLocation? {
        var newest: Date?
        var result: BoardInkLocation?
        func consider(_ ink: PKDrawing, offset: CGPoint = .zero) {
            for stroke in ink.strokes {
                guard !stroke.path.isEmpty,
                      stroke.path.creationDate.timeIntervalSince1970.isFinite,
                      stroke.mask == nil || !stroke.maskedPathRanges.isEmpty,
                      stroke.ink.color.cgColor.alpha > 0,
                      stroke.path.contains(where: { $0.opacity > 0 }) else { continue }
                let date = stroke.path.creationDate
                guard newest.map({ date >= $0 }) ?? true else { continue }
                let bounds = stroke.renderBounds.offsetBy(dx: offset.x, dy: offset.y)
                guard let candidate = clipped(bounds, canvasSize: canvasSize) else { continue }
                newest = date
                result = candidate
            }
        }
        consider(drawing)
        for item in items where item.kind == .inkGroup {
            guard let bytes = item.inkData, let ink = try? PKDrawing(data: bytes) else { continue }
            consider(ink, offset: CGPoint(x: item.x, y: item.y))
        }
        return result
    }

    /// Used only for legacy boards that have browser ink and no native drawing.
    /// Such previews have no stroke timestamps, so their saved order is the fallback.
    static func webLocation(_ ink: BoardWebInk?, canvasSize: Double) -> BoardInkLocation? {
        for stroke in (ink?.strokes ?? []).reversed() where stroke.opacity > 0 {
            var bounds = CGRect.null
            for point in stroke.points where point.count >= 2 && point[0].isFinite && point[1].isFinite {
                let width = point.count > 2 && point[2].isFinite ? max(1, min(10_000, point[2])) : 1
                bounds = bounds.union(CGRect(x: point[0] - width / 2, y: point[1] - width / 2, width: width, height: width))
            }
            if let result = clipped(bounds, canvasSize: canvasSize) { return result }
        }
        return nil
    }

    private static func clipped(_ rect: CGRect, canvasSize: Double) -> BoardInkLocation? {
        guard !rect.isNull, !rect.isInfinite,
              [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite),
              rect.width >= 0, rect.height >= 0 else { return nil }
        let expanded = CGRect(x: rect.midX - max(1, rect.width) / 2,
                              y: rect.midY - max(1, rect.height) / 2,
                              width: max(1, rect.width), height: max(1, rect.height))
        let value = expanded.intersection(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))
        guard !value.isNull, value.width > 0, value.height > 0 else { return nil }
        return BoardInkLocation(x: value.minX, y: value.minY, width: value.width, height: value.height)
    }
}

import Foundation
import PencilKit
import UIKit

/// A read-only projection of the strokes that still exist. It never restores
/// erased ink or writes to a board, and does not invent missing timestamps.
struct InkReplaySnapshot {
    let strokes: [PKStroke]
    let revealTimes: [Double]
    let bounds: CGRect
    let hasRecordedTimes: Bool
    var sourceIndices: [Int]? = nil
    var duration: Double { max(1, revealTimes.last ?? 1) }
    func visibleCount(at time: Double) -> Int {
        var low = 0, high = revealTimes.count
        while low < high {
            let mid = (low + high) / 2
            if revealTimes[mid] <= time { low = mid + 1 } else { high = mid }
        }
        return low
    }
}

enum InkReplay {
    enum Failure: LocalizedError {
        case tooLarge
        var errorDescription: String? { String(localized: "当前笔迹量过大，请先在较小的子白板中回放。原笔迹没有修改。") }
    }
    private static let worker = DispatchQueue(label: "InkSpace.ink-replay", qos: .userInitiated)
    static func load(drawingData: Data, items: [BoardItem], webInk: BoardWebInk?) async throws -> InkReplaySnapshot {
        try await withCheckedThrowingContinuation { continuation in
            worker.async { continuation.resume(with: Result { try make(drawingData: drawingData, items: items, webInk: webInk) }) }
        }
    }
    static func make(drawingData: Data, items: [BoardItem], webInk: BoardWebInk?) throws -> InkReplaySnapshot {
        var bytes = drawingData.count
        guard bytes <= 64 * 1024 * 1024 else { throw Failure.tooLarge }
        var strokes: [PKStroke] = [], nativePoints = 0
        func append(_ ink: PKDrawing, offset: CGPoint = .zero) throws {
            guard strokes.count + ink.strokes.count <= 50_000 else { throw Failure.tooLarge }
            for stroke in ink.strokes {
                nativePoints += stroke.path.count
                guard nativePoints <= 1_000_000 else { throw Failure.tooLarge }
            }
            strokes += offset == .zero ? ink.strokes : ink.transformed(using:.init(translationX:offset.x,y:offset.y)).strokes
        }
        try append(PKDrawing(data:drawingData))
        for item in items where item.kind == .inkGroup {
            guard let data = item.inkData else { continue }
            bytes += data.count
            guard bytes <= 64 * 1024 * 1024 else { throw Failure.tooLarge }
            try append(PKDrawing(data:data),offset:CGPoint(x:item.x,y:item.y))
        }
        var dates: [Double?] = []
        if strokes.isEmpty, let webInk {
            guard webInk.strokes.count <= 50_000 else { throw Failure.tooLarge }
            var count = 0, clipCount = 0
            for source in webInk.strokes {
                count += source.points.count
                guard count <= 1_000_000 else { throw Failure.tooLarge }
                var mask: UIBezierPath?
                if let commands = source.clipPath {
                    clipCount += commands.count
                    guard clipCount <= BoardWebClipPath.maximumTotalCommands else { throw Failure.tooLarge }
                    mask = UIBezierPath(cgPath: try BoardWebClipPath.path(from: commands))
                }
                let color = color(source.color, opacity: source.opacity)
                let points: [PKStrokePoint] = source.points.enumerated().compactMap { index, p in
                    guard p.count == 3, p.allSatisfy(\.isFinite), abs(p[0]) <= 8_000_000, abs(p[1]) <= 8_000_000, p[2] > 0, p[2] <= 10_000 else { return nil }
                    return PKStrokePoint(location: CGPoint(x:p[0],y:p[1]), timeOffset: Double(index)*0.01,
                        size: CGSize(width:p[2],height:p[2]), opacity:1, force:1, azimuth:0, altitude:.pi/2)
                }
                guard !points.isEmpty else { continue }
                let time = validDate(source.startedAt)
                // This date exists only in this temporary preview; dates[] keeps
                // missing chronology explicit and prevents fabricated history.
                let path = PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: time ?? 0))
                strokes.append(PKStroke(ink: PKInk(.pen, color:color), path:path, transform: .identity, mask: mask))
                dates.append(time)
            }
        } else {
            dates = strokes.map { validDate($0.path.creationDate.timeIntervalSince1970) }
        }
        guard strokes.count <= 50_000 else { throw Failure.tooLarge }
        let visible = strokes.indices.filter { !strokes[$0].path.isEmpty && (strokes[$0].mask == nil || !strokes[$0].maskedPathRanges.isEmpty) }
        let chronological = !visible.isEmpty && visible.allSatisfy { dates[$0] != nil }
        let order = chronological ? visible.sorted { dates[$0]! == dates[$1]! ? $0 < $1 : dates[$0]! < dates[$1]! } : visible
        let sorted = order.map { strokes[$0] }
        var times: [Double] = [], elapsed = 0.0
        for (index, original) in order.enumerated() {
            let gap = chronological && index > 0 ? max(0, dates[original]! - dates[order[index-1]]!) : 0.4
            // Keep order and short pauses; long breaks never force a long wait.
            elapsed += min(2, max(0.08, gap)); times.append(elapsed)
        }
        let bounds = PKDrawing(strokes:sorted).bounds
        return InkReplaySnapshot(strokes:sorted, revealTimes:times,
            bounds: bounds.isNull || bounds.isInfinite ? CGRect(x:0,y:0,width:1,height:1) : bounds,
            hasRecordedTimes:chronological, sourceIndices:order)
    }
    private static func validDate(_ date: Double?) -> Double? {
        guard let date, date.isFinite, date > 0, date < 32_503_680_000 else { return nil }; return date
    }
    private static func color(_ hex: String, opacity: Double) -> UIColor {
        let raw = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = UInt32(raw,radix:16) ?? 0
        return UIColor(red:CGFloat((value>>16)&255)/255,green:CGFloat((value>>8)&255)/255,
                       blue:CGFloat(value&255)/255,alpha:opacity.isFinite ? min(1,max(0,opacity)) : 1)
    }
}

/// Pure presentation geometry. Nothing here changes a board, its viewport, or
/// its files. Camera fitting is deliberately local; Overview is an explicit action.
enum InkReplayFraming {
    struct Focus {
        let rect: CGRect
        let strokeRect: CGRect
        let itemID: UUID?
        let label: String
    }
    static func valid(_ rect: CGRect) -> Bool {
        [rect.minX, rect.minY, rect.maxX, rect.maxY, rect.width, rect.height].allSatisfy(\.isFinite)
            && !rect.isNull && rect.width > 0 && rect.height > 0
            && max(abs(rect.minX), abs(rect.minY), abs(rect.maxX), abs(rect.maxY)) <= 16_000_000
    }
    static func extent(ink: CGRect, items: [BoardItem]) -> CGRect {
        var result = valid(ink) ? ink : CGRect.null
        for item in items where valid(item.rect) { result = result.union(item.rect) }
        if result.isNull { return CGRect(x: 0, y: 0, width: 900, height: 650) }
        return result.insetBy(dx: -500, dy: -500)
    }
    static func focus(stroke: CGRect, items: [BoardItem]) -> Focus {
        let ink = valid(stroke) ? stroke : CGRect(x: 0, y: 0, width: 1, height: 1)
        let center = CGPoint(x: ink.midX, y: ink.midY)
        let candidates = items.filter { $0.kind != .inkGroup && valid($0.rect) && $0.rect.contains(center) }
        let selected = candidates.min {
            if ($0.kind == .pdfPage) != ($1.kind == .pdfPage) { return $0.kind == .pdfPage }
            return $0.width * $0.height < $1.width * $1.height
        }
        if let item = selected {
            let pageLabel = item.page.map { String(localized: "第 \($0) 页") } ?? ""
            return Focus(rect: item.rect.insetBy(dx: -24, dy: -24), strokeRect: ink, itemID: item.id,
                         label: pageLabel.isEmpty ? item.title : "\(item.title) · \(pageLabel)")
        }
        // A short mark still receives surrounding context, rather than 8× zoom;
        // very long strokes don't force all 66 pages into one unreadable view.
        let width = max(700, min(1_200, ink.width + 160))
        let height = max(480, min(900, ink.height + 160))
        return Focus(rect: CGRect(x: ink.midX - width / 2, y: ink.midY - height / 2, width: width, height: height),
                     strokeRect: ink, itemID: nil, label: String(localized: "笔记局部"))
    }
    static func camera(focus: Focus, viewport: CGSize) -> (center: CGPoint, zoom: CGFloat) {
        let available = CGSize(width: max(1, viewport.width - 24), height: max(1, viewport.height - 24))
        let fit = min(available.width / focus.rect.width, available.height / focus.rect.height)
        // The floor is deliberately readable on narrow phones as well. Oversized
        // pages are cropped around the active ink instead of shrinking to a speck.
        let zoom = max(0.45, min(2, fit))
        let center = fit >= 0.45 ? CGPoint(x: focus.rect.midX, y: focus.rect.midY)
            : CGPoint(x: focus.strokeRect.midX, y: focus.strokeRect.midY)
        return (center, zoom)
    }
    static func visible(_ items: [BoardItem], viewport: CGRect, limit: Int = 48) -> [BoardItem] {
        let center = CGPoint(x: viewport.midX, y: viewport.midY)
        return Array(items.filter { $0.kind != .inkGroup && valid($0.rect) && $0.rect.intersects(viewport) }
            .sorted {
                let a = hypot($0.rect.midX - center.x, $0.rect.midY - center.y)
                let b = hypot($1.rect.midX - center.x, $1.rect.midY - center.y)
                return a == b ? $0.id.uuidString < $1.id.uuidString : a < b
            }.prefix(max(0, limit)))
    }
}

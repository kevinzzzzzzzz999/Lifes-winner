import Foundation
import CoreGraphics
import PencilKit
#if canImport(UIKit)
import UIKit
private typealias WritingAidBezierPath = UIBezierPath
#else
import AppKit
private typealias WritingAidBezierPath = NSBezierPath
#endif

/// Value-only factories. The host owns insertion, undo, saving and source-PDF policy.
enum BoardWritingAidStrokes {
    static let maximumInputPoints = 4096
    static let maximumOutputPoints = 65_536
    static let maximumFillSide: CGFloat = 4096
    /// Public native stroke metadata, retained on save/reopen. It identifies
    /// only our flat fill when deciding whether source-PDF projection is safe.
    static let fillRandomSeed: UInt32 = 0x494E4B46

    static func isTaggedFill(_ stroke: PKStroke) -> Bool {
        guard stroke.randomSeed == fillRandomSeed, stroke.mask != nil, stroke.path.count == 3 else { return false }
        let points = Array(stroke.path), a = points[0].location, b = points[2].location
        let dx = b.x - a.x, dy = b.y - a.y, length = hypot(dx, dy)
        let widths = points.map { ($0.size.width + $0.size.height) / 2 }
        guard length.isFinite, length > 0, widths.allSatisfy({ $0.isFinite && $0 > 0 }),
              let low = widths.min(), let high = widths.max() else { return false }
        let middle = points[1].location
        return abs((middle.x-a.x)*dy-(middle.y-a.y)*dx)/length <= 0.5 && high-low <= max(0.5,high*0.001)
    }

    static func wavy(points: [CGPoint], ink: PKInk, width: CGFloat, wavelength: CGFloat,
                     amplitude: CGFloat, worldSize: CGSize) throws -> PKDrawing {
        let input = try validated(points, worldSize: worldSize)
        guard input.count >= 2, width.isFinite, (0.1...4096).contains(width),
              wavelength.isFinite, wavelength >= 2, amplitude.isFinite,
              amplitude > 0, amplitude <= wavelength / 2 else { throw BoardWritingAidFailure.invalidGeometry }
        var cumulative: [CGFloat] = [0]
        for pair in zip(input, input.dropFirst()) { cumulative.append(cumulative.last! + hypot(pair.1.x - pair.0.x, pair.1.y - pair.0.y)) }
        let length = cumulative.last!
        guard length >= max(2, width / 2), length.isFinite else { throw BoardWritingAidFailure.invalidGeometry }
        let cycles = max(1, (length / wavelength).rounded())
        let count = max(25, Int(ceil(cycles * 24)))
        guard count <= maximumOutputPoints else { throw BoardWritingAidFailure.tooComplex }
        var index = 1, output: [CGPoint] = []; output.reserveCapacity(count + 1)
        for step in 0...count {
            let distance = length * CGFloat(step) / CGFloat(count)
            while index < cumulative.count - 1 && cumulative[index] < distance { index += 1 }
            let a = input[index - 1], b = input[index], segment = cumulative[index] - cumulative[index - 1]
            guard segment > 0 else { continue }
            let progress = (distance - cumulative[index - 1]) / segment
            let base = CGPoint(x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress)
            let offset = sin(CGFloat.pi * 2 * cycles * distance / length) * amplitude
            output.append(CGPoint(x: base.x - (b.y - a.y) / segment * offset,
                                  y: base.y + (b.x - a.x) / segment * offset))
        }
        try requireInside(output, margin: width / 2, worldSize: worldSize)
        let stroke = PKStroke(ink: ink, path: path(output, size: width))
        return PKDrawing(strokes: [stroke])
    }

    /// A native monoline paint strip clipped to the *closed polygon*, not a wide
    /// outline. The mask and strip are both part of native PKDrawing persistence.
    /// The explicit area/complexity bounds prevent an accidental huge allocation.
    /// `autoClose` is reserved for the explicitly selected fill mode: lifting
    /// closes the selected region. Other callers retain the strict closure gate.
    static func fill(points: [CGPoint], color: PKInk, closureTolerance: CGFloat,
                     worldSize: CGSize, autoClose: Bool = false) throws -> PKDrawing {
        var polygon = try validated(points, worldSize: worldSize)
        guard polygon.count >= (autoClose ? 3 : 4), closureTolerance.isFinite, closureTolerance > 0 else { throw BoardWritingAidFailure.notClosed }
        if !autoClose {
            guard let first = polygon.first, let last = polygon.last,
                  hypot(first.x - last.x, first.y - last.y) <= closureTolerance else { throw BoardWritingAidFailure.notClosed }
        }
        if polygon.last == polygon.first { polygon.removeLast() }
        guard polygon.count >= 3, let first = polygon.first,
              let second = polygon.first(where: { $0 != first }),
              polygon.contains(where: { $0 != first && $0 != second }) else { throw BoardWritingAidFailure.invalidGeometry }
        let box = polygon.reduce(CGRect.null) { $0.union(CGRect(x: $1.x, y: $1.y, width: 0.001, height: 0.001)) }
        guard box.width > 1, box.height > 1, box.width <= maximumFillSide,
              box.height <= maximumFillSide else { throw BoardWritingAidFailure.tooComplex }
        var twiceArea: CGFloat = 0
        for (a, b) in zip(polygon, polygon.dropFirst() + [polygon[0]]) {
            // Relative coordinates keep precision on the eight-million-point board.
            twiceArea += (a.x - box.minX) * (b.y - box.minY) - (b.x - box.minX) * (a.y - box.minY)
        }
        guard abs(twiceArea) >= 2 else { throw BoardWritingAidFailure.invalidGeometry }
        // PencilKit clips/tiles a native stroke in float coordinates internally.
        // Keep its mask and samples near zero even on a four-million-point board;
        // the public stroke transform supplies the world translation once.
        let origin = box.origin
        let local = polygon.map { CGPoint(x: $0.x-origin.x, y: $0.y-origin.y) }
        let mask = WritingAidBezierPath()
        mask.move(to: local[0])
        for point in local.dropFirst() {
            #if canImport(UIKit)
            mask.addLine(to: point)
            #else
            mask.line(to: point)
            #endif
        }
        mask.close()
        // A circular-capped horizontal strip covers the bounding rectangle. The
        // polygon mask supplies every actual edge, including concave cut-outs.
        let diameter = box.height * 2 + 4
        let samples = [CGPoint(x: 0, y: box.height/2), CGPoint(x: box.width/2, y: box.height/2), CGPoint(x: box.width, y: box.height/2)]
        let stroke = PKStroke(ink: PKInk(.monoline, color: color.color), path: path(samples, size: diameter),
                              transform: CGAffineTransform(translationX: origin.x, y: origin.y),
                              mask: mask, randomSeed: fillRandomSeed)
        let drawing = PKDrawing(strokes: [stroke])
        guard !drawing.bounds.isNull, drawing.bounds.width.isFinite, drawing.bounds.height.isFinite else { throw BoardWritingAidFailure.invalidGeometry }
        return drawing
    }

    private static func path(_ points: [CGPoint], size: CGFloat) -> PKStrokePath {
        PKStrokePath(controlPoints: points.enumerated().map { index, point in
            PKStrokePoint(location: point, timeOffset: Double(index) / 120,
                          size: CGSize(width: size, height: size), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }, creationDate: Date())
    }
    private static func validated(_ points: [CGPoint], worldSize: CGSize) throws -> [CGPoint] {
        guard points.count <= maximumInputPoints else { throw BoardWritingAidFailure.tooComplex }
        try requireInside(points, margin: 0, worldSize: worldSize)
        var result: [CGPoint] = []
        for point in points where result.last != point { result.append(point) }
        return result
    }
    private static func requireInside(_ points: [CGPoint], margin: CGFloat, worldSize: CGSize) throws {
        guard worldSize.width.isFinite, worldSize.height.isFinite,
              worldSize.width > 0, worldSize.height > 0,
              worldSize.width <= 8_000_000, worldSize.height <= 8_000_000,
              points.allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.x >= margin && $0.y >= margin
                && $0.x + margin <= worldSize.width && $0.y + margin <= worldSize.height }) else { throw BoardWritingAidFailure.invalidGeometry }
    }
}

/// A queued auxiliary edit owns an exact baseline and session. In particular a
/// native run-loop undo group is a temporary wait, never a lost Pencil contour.
struct BoardWritingAidDrawingCommit {
    enum Readiness: String { case ready, waitingForNativeUndo, cancelled, expired }
    static let maximumAttempts = 80
    let id = UUID()
    let baseline: PKDrawing
    let addition: PKDrawing
    let token: BoardWritingAidSessionToken
    let mode: BoardWritingAidMode
    private(set) var attempts = 0

    mutating func readiness(current: PKDrawing, token currentToken: BoardWritingAidSessionToken,
                            mode currentMode: BoardWritingAidMode, canEdit: Bool,
                            nativeInkActive: Bool, undoGroupingLevel: Int?, undoEnabled: Bool) -> Readiness {
        guard token == currentToken, mode == currentMode, canEdit else { return .cancelled }
        guard attempts < Self.maximumAttempts else { return .expired }
        attempts += 1
        // Wait without enumerating ordinary ink while PencilKit owns its group.
        guard !nativeInkActive, let undoGroupingLevel, undoGroupingLevel == 0, undoEnabled else { return .waitingForNativeUndo }
        return Self.sameStrokes(current, baseline) ? .ready : .cancelled
    }

    func replacementForRendering() -> PKDrawing {
        let strokes = addition.strokes.map { value -> PKStroke in
            var value = value
            if #available(iOS 27.0, macOS 27.0, *) { value.id = UUID(); return value }
            return PKStroke(ink: value.ink, path: value.path, transform: value.transform,
                            mask: value.mask, randomSeed: value.randomSeed)
        }
        return PKDrawing(strokes: baseline.strokes + strokes)
    }

    private static func sameStrokes(_ lhs: PKDrawing, _ rhs: PKDrawing) -> Bool {
        let left=lhs.strokes,right=rhs.strokes
        guard left.count==right.count else { return false }
        return zip(left,right).allSatisfy { a,b in
            guard a.transform==b.transform,a.randomSeed==b.randomSeed,a.ink.inkType==b.ink.inkType,
                  a.ink.color==b.ink.color,a.path.count==b.path.count,a.path.creationDate==b.path.creationDate,
                  (a as PKStrokeReference).isEqual(b as PKStrokeReference) else { return false }
            switch (a.mask,b.mask) {
            case (nil,nil): return true
            case (let x?,let y?): return x.cgPath==y.cgPath
            default: return false
            }
        }
    }
}

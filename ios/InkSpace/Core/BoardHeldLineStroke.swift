import CoreGraphics
import Foundation
import PencilKit

enum BoardHeldLineStroke {
    private static func sameStroke(_ lhs: PKStroke, _ rhs: PKStroke) -> Bool {
        // Native equality omits transforms; compare externally editable fields
        // as well so a concurrent lasso/color/mask edit can never be overwritten.
        guard lhs.transform == rhs.transform, lhs.randomSeed == rhs.randomSeed,
              lhs.ink.inkType == rhs.ink.inkType, lhs.ink.color == rhs.ink.color,
              lhs.path.count == rhs.path.count, lhs.path.creationDate == rhs.path.creationDate,
              (lhs as PKStrokeReference).isEqual(rhs as PKStrokeReference) else { return false }
        switch (lhs.mask, rhs.mask) {
        case (nil, nil): return true
        case (let left?, let right?): return left.cgPath == right.cgPath
        default: return false
        }
    }

    /// PKDrawing equality includes drawing identity; rebuilding the same prefix
    /// produces a different drawing. Compare native stroke content instead.
    static func hasSameStrokes(_ lhs: PKDrawing, _ rhs: PKDrawing) -> Bool {
        let left = lhs.strokes, right = rhs.strokes
        return left.count == right.count && zip(left, right).allSatisfy { sameStroke($0.0, $0.1) }
    }

    static func appendedStroke(in drawing: PKDrawing, after baseline: PKDrawing) -> PKStroke? {
        let strokes = drawing.strokes, previous = baseline.strokes
        guard strokes.count == previous.count + 1,
              zip(strokes.dropLast(), previous).allSatisfy({ sameStroke($0.0, $0.1) }) else { return nil }
        return strokes.last
    }

    /// Copy the native stroke and change only its positions, retaining pressure,
    /// timing, pigment, texture seed, transforms and other native stroke metadata.
    static func straightened(_ original: PKStroke, screenZoom: CGFloat,
                             screenOffset: CGPoint = .zero,
                             matching heldLine: BoardPencilLineTracker.Line? = nil) -> PKStroke? {
        guard original.mask == nil, screenZoom.isFinite, screenZoom > 0,
              screenOffset.x.isFinite, screenOffset.y.isFinite,
              original.path.count >= 3, original.path.count <= BoardPencilLineTracker.maximumSamples else { return nil }
        let transform = original.transform
        let determinant = transform.a * transform.d - transform.b * transform.c
        guard [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy(\.isFinite),
              determinant.isFinite, abs(determinant) > 0.00000001 else { return nil }
        let points = Array(original.path)
        let screenPoints = points.map { point in
            let world = point.location.applying(transform)
            return CGPoint(x: world.x * screenZoom - screenOffset.x,
                           y: world.y * screenZoom - screenOffset.y)
        }
        guard let line = BoardPencilLineTracker.line(through: screenPoints) else { return nil }
        if let heldLine {
            // Only the native stroke that the passive observer actually watched
            // may be changed. Final pressure estimates can shift endpoints a few pixels.
            guard hypot(line.start.x - heldLine.start.x, line.start.y - heldLine.start.y) <= 8,
                  hypot(line.end.x - heldLine.end.x, line.end.y - heldLine.end.y) <= 8 else { return nil }
        }
        let start = line.start, dx = line.end.x - start.x, dy = line.end.y - start.y
        let squaredLength = dx * dx + dy * dy, inverse = transform.inverted()
        let projected = zip(points, screenPoints).map { point, screen -> PKStrokePoint in
            let progress = min(1, max(0, ((screen.x - start.x) * dx + (screen.y - start.y) * dy) / squaredLength))
            let world = CGPoint(x: (start.x + progress * dx + screenOffset.x) / screenZoom,
                                y: (start.y + progress * dy + screenOffset.y) / screenZoom)
            let location = world.applying(inverse)
            if #available(iOS 27.0, macOS 27.0, *) {
                return PKStrokePoint(location: location, timeOffset: point.timeOffset, size: point.size,
                    opacity: point.opacity, force: point.force, azimuth: point.azimuth, altitude: point.altitude,
                    secondaryScale: point.secondaryScale, threshold: point.threshold, lateralJitter: point.lateralJitter)
            } else if #available(iOS 26.0, macOS 26.0, *) {
                return PKStrokePoint(location: location, timeOffset: point.timeOffset, size: point.size,
                    opacity: point.opacity, force: point.force, azimuth: point.azimuth, altitude: point.altitude,
                    secondaryScale: point.secondaryScale, threshold: point.threshold)
            } else {
                return PKStrokePoint(location: location, timeOffset: point.timeOffset, size: point.size,
                    opacity: point.opacity, force: point.force, azimuth: point.azimuth, altitude: point.altitude,
                    secondaryScale: point.secondaryScale)
            }
        }
        var result = original
        result.path = PKStrokePath(controlPoints: projected, creationDate: original.path.creationDate)
        return result
    }

    /// Replace one observed outline with one native vector stroke. Existing
    /// pressure samples stay in order; exact shape vertices add interpolated
    /// samples so corners and arrowheads do not depend on sampling frequency.
    static func shaped(_ original: PKStroke, screenZoom: CGFloat,
                       screenOffset: CGPoint = .zero,
                       matching held: BoardPencilShapeTracker.ShapeResult) -> PKStroke? {
        guard original.mask == nil, screenZoom.isFinite, screenZoom > 0,
              screenOffset.x.isFinite, screenOffset.y.isFinite,
              original.path.count >= 3, original.path.count <= BoardPencilShapeTracker.maximumSamples,
              held.shape != .off, held.points.count >= 3, held.points.count <= 104,
              held.points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
        let transform = original.transform
        let determinant = transform.a * transform.d - transform.b * transform.c
        guard [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy(\.isFinite),
              determinant.isFinite, abs(determinant) > 0.00000001 else { return nil }
        let originalPoints = Array(original.path)
        let screen = originalPoints.map { point -> CGPoint in
            let world = point.location.applying(transform)
            return CGPoint(x: world.x * screenZoom - screenOffset.x, y: world.y * screenZoom - screenOffset.y)
        }
        guard let actual = BoardPencilShapeTracker.shape(through: screen, kind: held.shape),
              hypot(actual.sourceStart.x - held.sourceStart.x, actual.sourceStart.y - held.sourceStart.y) <= 8,
              hypot(actual.sourceEnd.x - held.sourceEnd.x, actual.sourceEnd.y - held.sourceEnd.y) <= 8,
              abs(actual.sourceBounds.minX - held.sourceBounds.minX) <= 12,
              abs(actual.sourceBounds.minY - held.sourceBounds.minY) <= 12,
              abs(actual.sourceBounds.maxX - held.sourceBounds.maxX) <= 12,
              abs(actual.sourceBounds.maxY - held.sourceBounds.maxY) <= 12 else { return nil }
        func distances(_ points: [CGPoint]) -> [CGFloat] {
            var values: [CGFloat] = [0]
            for index in 1..<points.count {
                values.append(values.last! + hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y))
            }
            return values
        }
        let sourceDistance = distances(screen), targetDistance = distances(held.points)
        guard let sourceLength = sourceDistance.last, let targetLength = targetDistance.last,
              sourceLength.isFinite, targetLength.isFinite, sourceLength > 0, targetLength > 0 else { return nil }
        let sourceProgress = sourceDistance.map { $0 / sourceLength }
        let targetProgress = targetDistance.map { $0 / targetLength }
        let inverse = transform.inverted()
        func location(at progress: CGFloat) -> CGPoint {
            var index = 1
            while index < targetProgress.count - 1 && targetProgress[index] < progress { index += 1 }
            let delta = targetProgress[index] - targetProgress[index - 1]
            let t = delta > 0 ? min(1, max(0, (progress - targetProgress[index - 1]) / delta)) : 0
            let a = held.points[index - 1], b = held.points[index]
            let point = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            return CGPoint(x: (point.x + screenOffset.x) / screenZoom,
                           y: (point.y + screenOffset.y) / screenZoom).applying(inverse)
        }
        var samples: [(progress: CGFloat, point: PKStrokePoint)] = zip(sourceProgress, originalPoints).map { progress, point in
            (progress, copying(point, at: location(at: progress)))
        }
        for progress in targetProgress where !sourceProgress.contains(where: { abs($0 - progress) < 0.000000001 }) {
            var index = 1
            while index < sourceProgress.count - 1 && sourceProgress[index] < progress { index += 1 }
            let delta = sourceProgress[index] - sourceProgress[index - 1]
            let amount = delta > 0 ? min(1, max(0, (progress - sourceProgress[index - 1]) / delta)) : 0
            samples.append((progress, interpolating(originalPoints[index - 1], originalPoints[index], amount: amount,
                at: location(at: progress))))
        }
        samples.sort { $0.progress == $1.progress ? $0.point.timeOffset < $1.point.timeOffset : $0.progress < $1.progress }
        var result = original
        result.path = PKStrokePath(controlPoints: samples.map(\.point), creationDate: original.path.creationDate)
        return result
    }

    private static func copying(_ point: PKStrokePoint, at location: CGPoint) -> PKStrokePoint {
        interpolating(point, point, amount: 0, at: location)
    }

    private static func interpolating(_ a: PKStrokePoint, _ b: PKStrokePoint,
                                      amount t: CGFloat, at location: CGPoint) -> PKStrokePoint {
        func value(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * t }
        let time = a.timeOffset + (b.timeOffset - a.timeOffset) * Double(t)
        let size = CGSize(width: value(a.size.width, b.size.width), height: value(a.size.height, b.size.height))
        if #available(iOS 27.0, macOS 27.0, *) {
            return PKStrokePoint(location: location, timeOffset: time, size: size,
                opacity: value(a.opacity, b.opacity), force: value(a.force, b.force),
                azimuth: value(a.azimuth, b.azimuth), altitude: value(a.altitude, b.altitude),
                secondaryScale: value(a.secondaryScale, b.secondaryScale), threshold: value(a.threshold, b.threshold),
                lateralJitter: value(a.lateralJitter, b.lateralJitter))
        } else if #available(iOS 26.0, macOS 26.0, *) {
            return PKStrokePoint(location: location, timeOffset: time, size: size,
                opacity: value(a.opacity, b.opacity), force: value(a.force, b.force),
                azimuth: value(a.azimuth, b.azimuth), altitude: value(a.altitude, b.altitude),
                secondaryScale: value(a.secondaryScale, b.secondaryScale), threshold: value(a.threshold, b.threshold))
        } else {
            return PKStrokePoint(location: location, timeOffset: time, size: size,
                opacity: value(a.opacity, b.opacity), force: value(a.force, b.force),
                azimuth: value(a.azimuth, b.azimuth), altitude: value(a.altitude, b.altitude),
                secondaryScale: value(a.secondaryScale, b.secondaryScale))
        }
    }
}


import Foundation
import CoreGraphics

enum ReviewStrokeGeometry {
    static func width(_ review: BoardReview, world: CGRect, zoom: CGFloat) -> CGFloat {
        if let width = review.strokeWidth { return CGFloat(width) * world.width / max(CGFloat(review.rect.width), 0.00005) * zoom }
        return review.isHighlight ? 16 * zoom : 3
    }
    static func screenRect(_ world: CGRect, zoom: CGFloat, offset: CGPoint) -> CGRect {
        CGRect(x: world.minX * zoom - offset.x, y: world.minY * zoom - offset.y, width: world.width * zoom, height: world.height * zoom)
    }
    /// Match the actual visible stroke and optional comment badge, never the
    /// bounding rectangle interior. Sparse eraser paths test whole segments.
    static func hit(eraser: [CGPoint], review: BoardReview, world: CGRect, zoom: CGFloat, offset: CGPoint, radius: CGFloat = 10) -> Bool {
        guard !eraser.isEmpty, zoom.isFinite, zoom > 0 else { return false }
        let box = screenRect(world, zoom: zoom, offset: offset)
        let tolerance = radius + width(review, world: world, zoom: zoom) / 2
        func hits(_ line: [CGPoint], margin: CGFloat) -> Bool {
            guard let first = line.first else { return false }
            let target = line.count == 1 ? [first, first] : line
            let sweep = eraser.count == 1 ? [eraser[0], eraser[0]] : eraser
            let targetBounds = target.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: CGSize(width: 0.01, height: 0.01))) }.insetBy(dx: -margin, dy: -margin)
            for a in 1..<sweep.count {
                let swept = CGRect(x: min(sweep[a-1].x, sweep[a].x), y: min(sweep[a-1].y, sweep[a].y), width: abs(sweep[a-1].x-sweep[a].x)+0.01, height: abs(sweep[a-1].y-sweep[a].y)+0.01)
                guard targetBounds.intersects(swept) else { continue }
                for b in 1..<target.count where segmentDistance(sweep[a-1], sweep[a], target[b-1], target[b]) <= margin { return true }
            }
            return false
        }
        if review.points.isEmpty {
            // Comment pins are visible rings of radius 7 points.
            let ring = (0...24).map { index in CGPoint(x: box.midX + 7 * cos(CGFloat(index) * .pi / 12), y: box.midY + 7 * sin(CGFloat(index) * .pi / 12)) }
            if hits(ring, margin: tolerance) { return true }
        } else if hits(review.points.map { CGPoint(x: box.minX + $0[0] * box.width, y: box.minY + $0[1] * box.height) }, margin: tolerance) { return true }
        return !review.comment.isEmpty && hits([CGPoint(x: box.maxX, y: box.minY)], margin: radius + 7)
    }
    private static func pointDistance(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x-a.x, dy = b.y-a.y, length = dx*dx+dy*dy
        guard length > 0 else { return hypot(p.x-a.x, p.y-a.y) }
        let t = min(1, max(0, ((p.x-a.x)*dx + (p.y-a.y)*dy)/length))
        return hypot(p.x-a.x-t*dx, p.y-a.y-t*dy)
    }
    private static func segmentDistance(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint) -> CGFloat {
        func cross(_ p: CGPoint, _ q: CGPoint, _ r: CGPoint) -> CGFloat { (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x) }
        let abC = cross(a,b,c), abD = cross(a,b,d), cdA = cross(c,d,a), cdB = cross(c,d,b)
        if ((abC < 0 && abD > 0) || (abC > 0 && abD < 0)) && ((cdA < 0 && cdB > 0) || (cdA > 0 && cdB < 0)) { return 0 }
        return min(pointDistance(a,c,d),pointDistance(b,c,d),pointDistance(c,a,b),pointDistance(d,a,b))
    }
}

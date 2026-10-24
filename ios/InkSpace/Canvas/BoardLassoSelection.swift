import Foundation
import CoreGraphics
import PencilKit

/// Value-only mixed lasso geometry. The host owns gesture state, undo and saving.
/// Stroke indices always refer to the initial snapshot, never to iOS 27 IDs.
enum BoardLassoSelection {
    enum Kind: String, CaseIterable, Hashable { case ink, document, video, image, text }
    struct Selection {
        var strokeIndices: Set<Int> = []
        var itemIDs: Set<UUID> = []
        var bounds: CGRect = .null
        /// Original normalized freehand query in world coordinates. Presentation
        /// only: never changes selected IDs, native hit testing or board schema.
        var outline: [CGPoint]? = nil
        var isEmpty: Bool { strokeIndices.isEmpty && itemIDs.isEmpty }
    }
    struct Snapshot {
        var drawing: PKDrawing
        var items: [BoardItem]
        var selection: Selection
        var canvasSize: CGSize
    }
    struct Result {
        var drawing: PKDrawing
        var items: [BoardItem]
        var selection: Selection
    }
    enum Failure: Error, LocalizedError {
        case invalidPolygon, invalidSelection, invalidGeometry, invalidInk, invalidScale, outsideCanvas, tooComplex
        var errorDescription: String? {
            switch self {
            case .invalidPolygon: return String(localized: "圈选区域无效，请重新圈选。")
            case .invalidSelection: return String(localized: "圈选内容已改变，请重新圈选。")
            case .invalidGeometry: return String(localized: "圈选内容的边界无效，本次没有改变任何内容。")
            case .invalidInk: return String(localized: "无法完整读取圈选笔迹，本次没有改变任何内容。")
            case .invalidScale: return String(localized: "缩放比例需在 5%–2000% 之间，内容边长需大于 1。")
            case .outsideCanvas: return String(localized: "移动或缩放会超出白板范围，本次没有改变任何内容。")
            case .tooComplex: return String(localized: "圈选区域过于复杂，请缩小范围后重试。")
            }
        }
    }
    static let minimumScale: CGFloat = 0.05
    static let maximumScale: CGFloat = 20
    static let minimumItemSide: CGFloat = 1
    private static let maximumWorldSide: CGFloat = 8_000_000
    private static let maximumVisitedSamples = 2_000_000

    /// Geometry-only failure facts; never retain stroke contents or the path.
    static func polygonDiagnostics(_ input: [CGPoint], canvasSize: CGSize) -> String {
        let world = try? worldRect(canvasSize)
        let queryWorld = world.map { $0.insetBy(dx: -maximumWorldSide, dy: -maximumWorldSide) }
        let finitePoints = input.filter { finite($0) }
        let outside = queryWorld.map { query in finitePoints.filter { !closedContains(query, $0) }.count } ?? 0
        var unique: [CGPoint] = []
        for point in input where unique.last != point { unique.append(point) }
        if unique.count > 1, unique.first == unique.last { unique.removeLast() }
        let bounds = finitePoints.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
        let crossMax = unique.count >= 3 ? unique.dropFirst(2).reduce(CGFloat.zero) { max($0, abs(cross(unique[0], unique[1], $1))) } : 0
        let reason: String
        if world == nil { reason = "invalidWorld" }
        else if !(3...8192).contains(input.count) { reason = "pointCount" }
        else if finitePoints.count != input.count { reason = "nonFinite" }
        else if outside > 0 { reason = "outsideWorld" }
        else if unique.count < 3 { reason = "uniqueCount" }
        else if !valid(bounds) { reason = "degenerateBounds" }
        else if crossMax <= 0.000001 { reason = "collinear" }
        else { reason = "valid" }
        return "reason:\(reason),count:\(input.count),unique:\(unique.count),outside:\(outside),bounds:\(bounds.minX)|\(bounds.minY)|\(bounds.maxX)|\(bounds.maxY),crossMax:\(crossMax),world:\(canvasSize.width)|\(canvasSize.height),queryMargin:\(maximumWorldSide)"
    }

    static func kind(of item: BoardItem) -> Kind {
        if item.kind == .inkGroup { return .ink }
        if BoardVideo.isVideo(item) { return .video }
        if (item.kind == .document || item.kind == .pdfPage),
           [item.originalSourcePath, item.sourcePath].compactMap({ $0 }).contains(where: {
               ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "tif", "bmp"].contains(($0 as NSString).pathExtension.lowercased())
           }) { return .image }
        if item.kind == .text || item.kind == .formula { return .text }
        return .document
    }

    static func select(polygon points: [CGPoint], drawing: PKDrawing, items: [BoardItem],
                       kinds: Set<Kind> = Set(Kind.allCases), canvasSize: CGSize) throws -> Selection {
        let world = try worldRect(canvasSize)
        var work = 10_000_000
        let polygon = try Polygon(points, world: world, work: &work)
        // PKDrawing.strokes bridges a native array. Borrow it once per operation,
        // never once per selected index on a large board.
        let strokes = drawing.strokes
        var result = Selection(outline: polygon.points), visitedSamples = 0
        if kinds.contains(.ink) {
            for (index, stroke) in strokes.enumerated() {
                try Task.checkCancellation()
                guard valid(stroke.renderBounds), stroke.renderBounds.intersects(polygon.bounds) else { continue }
                // Most strokes of a large enclosing lasso need no interpolation.
                // This proves the whole render bounds are inside, including for
                // concave polygons; a center-only hit would lose that guarantee.
                if try polygon.fullyContains(stroke.renderBounds, work: &work) {
                    result.strokeIndices.insert(index); continue
                }
                // A native render bound encloses the complete visible stroke.
                // Prove a disjoint bound before walking any control points in
                // the empty corners of a concave or curved lasso's bounding box.
                guard try polygon.intersects(stroke.renderBounds, work: &work) else { continue }
                if try hits(stroke, polygon: polygon, work: &work, visitedSamples: &visitedSamples) { result.strokeIndices.insert(index) }
            }
        }
        for item in items where kinds.contains(kind(of: item)) {
            try Task.checkCancellation()
            guard valid(item.rect) else { throw Failure.invalidGeometry }
            // A solid card is selectable even when a small lasso is wholly inside it.
            var rects = [item.rect]
            rects += (item.childBoards ?? []).compactMap { $0.presentation }.filter(\.expanded).map(\.rect)
            if item.kind == .inkGroup, let data = item.inkData, let ink = try? PKDrawing(data: data), valid(ink.bounds) {
                rects.append(ink.bounds.offsetBy(dx: item.x, dy: item.y))
            }
            if try rects.contains(where: { try polygon.intersects($0, work: &work) }) { result.itemIDs.insert(item.id) }
        }
        result.bounds = try selectionBounds(result, strokes: strokes, items: items)
        return result
    }

    /// Recompute from the initial value snapshot on every call; callers must not
    /// feed the previous result back as the next gesture's initial snapshot.
    static func transform(snapshot: Snapshot, translation: CGSize = .zero, scale: CGFloat = 1,
                          anchor: CGPoint? = nil) throws -> Result {
        let world = try worldRect(snapshot.canvasSize)
        guard scale.isFinite, (minimumScale...maximumScale).contains(scale),
              translation.width.isFinite, translation.height.isFinite else { throw Failure.invalidScale }
        let originalStrokes = snapshot.drawing.strokes
        let originalBounds = try selectionBounds(snapshot.selection, strokes: originalStrokes, items: snapshot.items)
        guard !snapshot.selection.isEmpty, valid(originalBounds) else { throw Failure.invalidSelection }
        let origin = anchor ?? originalBounds.origin
        guard finite(origin), originalBounds.insetBy(dx: -0.0001, dy: -0.0001).contains(origin) else { throw Failure.invalidGeometry }
        let matrix = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                      tx: origin.x * (1-scale) + translation.width,
                                      ty: origin.y * (1-scale) + translation.height)
        guard [matrix.a, matrix.d, matrix.tx, matrix.ty].allSatisfy(\.isFinite) else { throw Failure.invalidGeometry }
        let outline = transformedOutline(snapshot.selection.outline, using: matrix)
        if matrix.isIdentity {
            // Undo bounds refresh needs no native rewrite, path duplication or
            // temporary render identities for thousands of unchanged strokes.
            guard world.contains(originalBounds) else { throw Failure.outsideCanvas }
            var selection = snapshot.selection
            selection.bounds = originalBounds
            selection.outline = outline
            return Result(drawing: snapshot.drawing, items: snapshot.items, selection: selection)
        }
        var strokes = originalStrokes, items = snapshot.items
        let indices = snapshot.selection.strokeIndices.sorted()
        // Transform bounded native batches, draining temporary PencilKit objects
        // between them. Paths/pressure/timing are preserved by PencilKit, without
        // raster snapshots or rebuilding millions of control points in Swift.
        for start in stride(from: 0, to: indices.count, by: 128) {
            try Task.checkCancellation()
            let batch = indices[start..<min(start + 128, indices.count)]
            let updated = autoreleasepool {
                PKDrawing(strokes: batch.map { originalStrokes[$0] }).transformed(using: matrix).strokes
            }
            guard updated.count == batch.count else { throw Failure.invalidInk }
            for (index, nativeStroke) in zip(batch, updated) {
            guard valid(nativeStroke.renderBounds) else { throw Failure.invalidInk }
            guard world.contains(nativeStroke.renderBounds) else { throw Failure.outsideCanvas }
            // Preserve PencilKit's stable stroke identity so moving existing
            // ink does not present the entire selection as newly created ink.
            strokes[index] = nativeStroke
            }
        }
        for index in items.indices where snapshot.selection.itemIDs.contains(items[index].id) {
            try Task.checkCancellation()
            let old = items[index]
            let rect = try transformedRect(old.rect, using: matrix, world: world)
            items[index].x = rect.minX; items[index].y = rect.minY
            items[index].width = rect.width; items[index].height = rect.height
            if scale != 1, old.kind == .text || old.kind == .formula {
                var style = old.style ?? BoardItemStyle()
                let font = style.fontSize ?? (old.usesFormulaRendering ? 28 : 16)
                guard font.isFinite else { throw Failure.invalidGeometry }
                style.fontSize = min(72, max(8, font * scale))
                items[index].style = style
            }
            if old.kind == .inkGroup {
                guard let data = old.inkData, let drawing = try? PKDrawing(data: data) else { throw Failure.invalidInk }
                let scaled = scale == 1 ? drawing : drawing.transformed(using: CGAffineTransform(scaleX: scale, y: scale))
                for stroke in scaled.strokes {
                    guard valid(stroke.renderBounds), !stroke.path.isEmpty else { throw Failure.invalidInk }
                    guard world.contains(stroke.renderBounds.offsetBy(dx: rect.minX, dy: rect.minY)) else { throw Failure.outsideCanvas }
                }
                // Translation must not reserialize local ink or change its origin.
                if scale != 1 { items[index].inkData = scaled.dataRepresentation() }
            }
            if var children = old.childBoards {
                for childIndex in children.indices {
                    guard var presentation = children[childIndex].presentation else { continue }
                    let childRect = try transformedRect(presentation.rect, using: matrix, world: world)
                    presentation.x = childRect.minX; presentation.y = childRect.minY
                    presentation.width = childRect.width; presentation.height = childRect.height
                    if var viewport = presentation.viewport {
                        viewport.zoom *= scale
                        guard viewport.zoom.isFinite, viewport.zoom > 0 else { throw Failure.invalidScale }
                        presentation.viewport = viewport
                    }
                    children[childIndex].presentation = presentation
                }
                items[index].childBoards = children
            }
        }
        // The original PKStroke values for every unselected index are reused.
        let drawing = PKDrawing(strokes: strokes)
        var selection = snapshot.selection
        selection.outline = outline
        selection.bounds = try selectionBounds(selection, strokes: strokes, items: items)
        guard world.contains(selection.bounds) else { throw Failure.outsideCanvas }
        return Result(drawing: drawing, items: items, selection: selection)
    }

    /// A bounded, nondegenerate presentation path. Clipboard input must pass
    /// this check before it becomes selection state. No vertices are clamped or
    /// resampled; only adjacent duplicates and an explicit closing point go away.
    static func validatedOutline(_ input: [CGPoint]) throws -> [CGPoint] {
        guard (3...8192).contains(input.count) else { throw Failure.invalidPolygon }
        var points: [CGPoint] = []
        points.reserveCapacity(input.count)
        for (index, point) in input.enumerated() {
            if index.isMultiple(of: 128) { try Task.checkCancellation() }
            guard finite(point), abs(point.x) <= 512_000_000, abs(point.y) <= 512_000_000 else { throw Failure.invalidPolygon }
            if points.last != point { points.append(point) }
        }
        if points.count > 1, points.first == points.last { points.removeLast() }
        guard points.count >= 3 else { throw Failure.invalidPolygon }
        let bounds = points.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
        guard valid(bounds), points.dropFirst(2).contains(where: { abs(cross(points[0], points[1], $0)) > 0.000001 }) else { throw Failure.invalidPolygon }
        return points
    }

    /// Screen previews and committed content use exactly the same affine map.
    /// An unrepresentable *display* path falls back to bounds, never blocks a
    /// content transform that has independently passed the strict world checks.
    static func transformedOutline(_ outline: [CGPoint]?, using matrix: CGAffineTransform) -> [CGPoint]? {
        guard let outline, [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty].allSatisfy(\.isFinite),
              let points = try? validatedOutline(outline) else { return nil }
        return try? validatedOutline(points.map { $0.applying(matrix) })
    }

    /// Fill every bounded lobe, independently of traversal direction or how
    /// often a segment was retraced. The original outline remains untouched.
    /// This same vector coverage is used for querying and presentation.
    static func coveragePath(for outline: [CGPoint]) throws -> CGPath {
        var work = 10_000_000
        let points = try validatedOutline(outline)
        let coverage = try PolygonCoverage(points: points, work: &work)
        let path = CGMutablePath()
        for contour in coverage.contours {
            try spend(&work, contour.count)
            path.move(to: contour[0])
            for point in contour.dropFirst() { path.addLine(to: point) }
            path.closeSubpath()
        }
        return path
    }

    private static func selectionBounds(_ selection: Selection, strokes: [PKStroke], items: [BoardItem]) throws -> CGRect {
        guard selection.strokeIndices.allSatisfy({ strokes.indices.contains($0) }),
              Set(items.map(\.id)).count == items.count,
              selection.itemIDs.isSubset(of: Set(items.map(\.id))) else { throw Failure.invalidSelection }
        var bounds = CGRect.null
        for index in selection.strokeIndices {
            let stroke = strokes[index], rect = stroke.renderBounds
            guard valid(rect), !stroke.path.isEmpty else { throw Failure.invalidInk }
            bounds = bounds.union(rect)
        }
        for item in items where selection.itemIDs.contains(item.id) {
            guard valid(item.rect) else { throw Failure.invalidGeometry }; bounds = bounds.union(item.rect)
            for child in item.childBoards ?? [] {
                if let presentation = child.presentation, presentation.expanded {
                    guard valid(presentation.rect) else { throw Failure.invalidGeometry }; bounds = bounds.union(presentation.rect)
                }
            }
            if item.kind == .inkGroup {
                guard let data = item.inkData, let ink = try? PKDrawing(data: data) else { throw Failure.invalidInk }
                if !ink.strokes.isEmpty {
                    guard valid(ink.bounds) else { throw Failure.invalidInk }
                    bounds = bounds.union(ink.bounds.offsetBy(dx: item.x, dy: item.y))
                }
            }
        }
        return bounds
    }
    private static func transformedRect(_ rect: CGRect, using matrix: CGAffineTransform, world: CGRect) throws -> CGRect {
        guard valid(rect) else { throw Failure.invalidGeometry }
        let result = rect.applying(matrix)
        guard valid(result), result.width > minimumItemSide, result.height > minimumItemSide else { throw Failure.invalidScale }
        guard world.contains(result) else { throw Failure.outsideCanvas }
        return result
    }
    private static func worldRect(_ size: CGSize) throws -> CGRect {
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              size.width <= maximumWorldSide, size.height <= maximumWorldSide else { throw Failure.invalidGeometry }
        return CGRect(origin: .zero, size: size)
    }
    private static func valid(_ rect: CGRect) -> Bool {
        !rect.isNull && !rect.isInfinite && [rect.minX, rect.minY, rect.maxX, rect.maxY, rect.width, rect.height].allSatisfy(\.isFinite) && rect.width > 0 && rect.height > 0
    }
    private static func finite(_ p: CGPoint) -> Bool { p.x.isFinite && p.y.isFinite }
    private static func closedContains(_ rect: CGRect, _ point: CGPoint) -> Bool {
        point.x >= rect.minX && point.y >= rect.minY && point.x <= rect.maxX && point.y <= rect.maxY
    }
    private static func spend(_ work: inout Int, _ count: Int = 1) throws {
        work -= count; if work < 0 { throw Failure.tooComplex }
        if work.isMultiple(of: 1024) { try Task.checkCancellation() }
    }
    private static func hits(_ stroke: PKStroke, polygon: Polygon, work: inout Int, visitedSamples: inout Int) throws -> Bool {
        guard !stroke.path.isEmpty else { return false }
        let end = CGFloat(stroke.path.count-1)
        let ranges = stroke.mask == nil ? [CGFloat(0)...end] : stroke.maskedPathRanges
        let widthScale = max(hypot(stroke.transform.a, stroke.transform.b), hypot(stroke.transform.c, stroke.transform.d))
        guard widthScale.isFinite else { throw Failure.invalidInk }
        for range in ranges {
            guard range.lowerBound.isFinite, range.upperBound.isFinite,
                  range.lowerBound >= 0, range.upperBound <= end else { throw Failure.invalidInk }
            var previous: CGPoint?, previousRadius: CGFloat = 0
            // Quarter control-point steps follow curved paths. Connecting adjacent
            // samples detects even a narrow lasso crossing a long straight stroke.
            func visit(_ sample: PKStrokePoint) throws -> Bool {
                // Charge actual work, not every original control point up front:
                // a long native path may be decided by its very first sample.
                visitedSamples += 1
                guard visitedSamples <= maximumVisitedSamples else { throw Failure.tooComplex }
                if visitedSamples.isMultiple(of: 128) { try Task.checkCancellation() }
                try spend(&work)
                let point = sample.location.applying(stroke.transform)
                let radius = max(sample.size.width, sample.size.height) * widthScale * 0.5
                guard finite(point), radius.isFinite, radius >= 0 else { throw Failure.invalidInk }
                if try polygon.contains(point, work: &work) { return true }
                if try polygon.touchesSegment(previous ?? point, point, radius: max(radius, previousRadius), work: &work) { return true }
                previous = point; previousRadius = radius
                return false
            }
            for sample in stroke.path.interpolatedPoints(in: range, by: .parametricStep(0.25)) {
                if try visit(sample) { return true }
            }
            if try visit(stroke.path.interpolatedPoint(at: range.upperBound)) { return true }
        }
        return false
    }
    /// An exact broad phase over the original polygon edges. The flattened
    /// pre-order tree needs no per-point stack or candidate array allocations.
    /// Candidate predicates below retain the bounded segment/boundary rules.
    private struct PolygonEdgeIndex {
        struct Edge {
            let a: CGPoint
            let b: CGPoint
            let bounds: CGRect
            let id: Int
        }
        struct Query {
            let minX: CGFloat
            let minY: CGFloat
            let maxX: CGFloat
            let maxY: CGFloat

            init(rect: CGRect, padding: CGFloat = 0.000002) {
                minX = rect.minX - padding; minY = rect.minY - padding
                maxX = rect.maxX + padding; maxY = rect.maxY + padding
            }
            init(a: CGPoint, b: CGPoint, padding: CGFloat) {
                minX = min(a.x, b.x) - padding; minY = min(a.y, b.y) - padding
                maxX = max(a.x, b.x) + padding; maxY = max(a.y, b.y) + padding
            }
            func intersects(_ rect: CGRect) -> Bool {
                rect.minX <= maxX && rect.maxX >= minX && rect.minY <= maxY && rect.maxY >= minY
            }
        }
        private struct Node {
            let bounds: CGRect
            var range: Range<Int>
            var next: Int
        }
        private let edges: [Edge]
        private let nodes: [Node]

        init(points: [CGPoint], work: inout Int) throws {
            try self.init(contours: [points], work: &work)
        }

        init(contours: [[CGPoint]], work: inout Int) throws {
            var segments: [(a: CGPoint, b: CGPoint)] = []
            segments.reserveCapacity(contours.reduce(0) { $0 + $1.count })
            for points in contours { for index in points.indices {
                try spend(&work)
                segments.append((points[index], points[(index + 1) % points.count]))
            } }
            try self.init(segments: segments, work: &work)
        }

        init(segments: [(a: CGPoint, b: CGPoint)], work: inout Int) throws {
            var input: [Edge] = []
            input.reserveCapacity(segments.count)
            for (a, b) in segments {
                try spend(&work)
                // Match the existing fullyContains edge bounding box, including
                // its small positive extent for horizontal/vertical edges.
                let bounds = CGRect(x: min(a.x, b.x), y: min(a.y, b.y),
                    width: max(abs(a.x - b.x), 0.000001), height: max(abs(a.y - b.y), 0.000001))
                input.append(Edge(a: a, b: b, bounds: bounds, id: input.count))
            }
            var ordered: [Edge] = [], built: [Node] = []
            ordered.reserveCapacity(input.count)
            built.reserveCapacity(input.count / 4 + 1)
            _ = try Self.build(input, ordered: &ordered, nodes: &built, work: &work)
            edges = ordered; nodes = built
        }

        private static func build(_ input: [Edge], ordered: inout [Edge], nodes: inout [Node], work: inout Int) throws -> Int {
            try Task.checkCancellation()
            var bounds = CGRect.null
            for edge in input { try spend(&work); bounds = bounds.union(edge.bounds) }
            let index = nodes.count
            nodes.append(Node(bounds: bounds, range: 0..<0, next: 0))
            if input.count <= 8 {
                let start = ordered.count
                for edge in input { try spend(&work); ordered.append(edge) }
                nodes[index].range = start..<ordered.count
            } else {
                let horizontal = bounds.width >= bounds.height
                let sorted = try input.sorted { lhs, rhs in
                    try spend(&work)
                    let a = horizontal ? lhs.bounds.midX : lhs.bounds.midY
                    let b = horizontal ? rhs.bounds.midX : rhs.bounds.midY
                    return a == b ? lhs.id < rhs.id : a < b
                }
                let middle = sorted.count / 2
                _ = try build(Array(sorted[..<middle]), ordered: &ordered, nodes: &nodes, work: &work)
                _ = try build(Array(sorted[middle...]), ordered: &ordered, nodes: &nodes, work: &work)
            }
            nodes[index].next = nodes.count
            return index
        }

        func anyEdge(in query: Query, work: inout Int, matching predicate: (Edge) -> Bool) throws -> Bool {
            var index = 0
            while index < nodes.count {
                try spend(&work)
                let node = nodes[index]
                guard query.intersects(node.bounds) else { index = node.next; continue }
                if node.range.isEmpty { index += 1; continue }
                for edgeIndex in node.range {
                    try spend(&work)
                    let edge = edges[edgeIndex]
                    if query.intersects(edge.bounds), predicate(edge) { return true }
                }
                index = node.next
            }
            return false
        }

        func visitEdges(in query: Query, work: inout Int, _ visit: (Edge, inout Int) throws -> Void) throws {
            var index = 0
            while index < nodes.count {
                try spend(&work)
                let node = nodes[index]
                guard query.intersects(node.bounds) else { index = node.next; continue }
                if node.range.isEmpty { index += 1; continue }
                for edgeIndex in node.range {
                    try spend(&work)
                    let edge = edges[edgeIndex]
                    if query.intersects(edge.bounds) { try visit(edge, &work) }
                }
                index = node.next
            }
        }
    }

    /// Planar edge arrangement, not a winding-rule shortcut: opposite-winding
    /// loops may overlap with winding zero, yet their bounded faces are covered.
    /// Deduplicating undirected subedges also makes exact retracing idempotent.
    private struct PolygonCoverage {
        let contours: [[CGPoint]]
        private static let nodeTolerance: CGFloat = 0.0000001 // below the existing 0.000001 boundary tolerance
        private static let maximumNodes = 32_768
        private static let maximumCuts = 65_536
        private static let maximumEdges = 32_768
        private struct Bucket: Hashable { let x: Int64; let y: Int64 }
        private struct Cut { let t: CGFloat; let node: Int }
        private struct EdgeKey: Hashable { let a: Int; let b: Int }
        private struct HalfEdge { let from: Int; let to: Int; let reverse: Int; var next: Int = -1 }

        init(points: [CGPoint], work: inout Int) throws {
            var nodes: [CGPoint] = [], buckets: [Bucket: [Int]] = [:]
            func node(_ point: CGPoint, work: inout Int) throws -> Int {
                try spend(&work)
                let bx = Int64((point.x / Self.nodeTolerance).rounded())
                let by = Int64((point.y / Self.nodeTolerance).rounded())
                for x in (bx - 1)...(bx + 1) { for y in (by - 1)...(by + 1) {
                    for id in buckets[Bucket(x: x, y: y)] ?? [] {
                        try spend(&work)
                        let old = nodes[id]
                        if hypot(old.x - point.x, old.y - point.y) <= Self.nodeTolerance { return id }
                    }
                } }
                guard nodes.count < Self.maximumNodes else { throw Failure.tooComplex }
                let id = nodes.count
                nodes.append(point); buckets[Bucket(x: bx, y: by), default: []].append(id)
                return id
            }
            var originalNodes: [Int] = []
            originalNodes.reserveCapacity(points.count)
            for point in points { originalNodes.append(try node(point, work: &work)) }
            var originalEdges = Set<EdgeKey>()
            for i in originalNodes.indices {
                try spend(&work)
                let a = originalNodes[i], b = originalNodes[(i + 1) % originalNodes.count]
                if a != b { originalEdges.insert(EdgeKey(a: min(a, b), b: max(a, b))) }
            }
            // A repeated forward/backward traversal is the same query boundary,
            // not thousands of coincident edges to intersect with each other.
            let initialEdges = try originalEdges.sorted {
                try spend(&work)
                return $0.a == $1.a ? $0.b < $1.b : $0.a < $1.a
            }
            let segments = initialEdges.map { (a: nodes[$0.a], b: nodes[$0.b]) }
            let index = try PolygonEdgeIndex(segments: segments, work: &work)
            var cuts = initialEdges.map { [Cut(t: 0, node: $0.a), Cut(t: 1, node: $0.b)] }
            var cutCount = cuts.count * 2
            func add(_ point: CGPoint, to edge: Int, work: inout Int) throws {
                try spend(&work)
                let a = segments[edge].a, b = segments[edge].b
                let dx = b.x - a.x, dy = b.y - a.y
                let length = dx * dx + dy * dy
                guard length > 0 else { return }
                let t = min(1, max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
                let id = try node(point, work: &work)
                if id == cuts[edge][0].node || id == cuts[edge][1].node { return }
                guard cutCount < Self.maximumCuts else { throw Failure.tooComplex }
                cuts[edge].append(Cut(t: t, node: id))
                cutCount += 1
            }
            for i in segments.indices {
                try Task.checkCancellation()
                let a = segments[i].a, b = segments[i].b
                try index.visitEdges(in: .init(a: a, b: b, padding: 0.000001), work: &work) { edge, budget in
                    guard edge.id > i else { return }
                    try spend(&budget)
                    let c = edge.a, d = edge.b
                    let rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y
                    let denominator = rx * sy - ry * sx
                    if denominator != 0 {
                        let qx = c.x - a.x, qy = c.y - a.y
                        let t = (qx * sy - qy * sx) / denominator
                        let u = (qx * ry - qy * rx) / denominator
                        guard t >= 0, t <= 1, u >= 0, u <= 1 else { return }
                        let point = CGPoint(x: a.x + t * rx, y: a.y + t * ry)
                        try add(point, to: i, work: &budget); try add(point, to: edge.id, work: &budget)
                    } else {
                        // Parallel overlaps split at every shared endpoint;
                        // this handles partial/complete forward or backtracking.
                        for point in [a, b, c, d] {
                            try spend(&budget)
                            if segmentDistanceSquared(point, a, b) < 1e-14,
                               segmentDistanceSquared(point, c, d) < 1e-14 {
                                try add(point, to: i, work: &budget); try add(point, to: edge.id, work: &budget)
                            }
                        }
                    }
                }
            }
            var uniqueEdges = Set<EdgeKey>()
            for edgeCuts in cuts {
                let ordered = try edgeCuts.sorted {
                    try spend(&work)
                    return $0.t == $1.t ? $0.node < $1.node : $0.t < $1.t
                }
                var previous: Int?
                for cut in ordered {
                    try spend(&work)
                    if let old = previous, old != cut.node {
                        uniqueEdges.insert(EdgeKey(a: min(old, cut.node), b: max(old, cut.node)))
                        guard uniqueEdges.count <= Self.maximumEdges else { throw Failure.tooComplex }
                    }
                    previous = cut.node
                }
            }
            let orderedEdges = try uniqueEdges.sorted {
                try spend(&work)
                return $0.a == $1.a ? $0.b < $1.b : $0.a < $1.a
            }
            var halfEdges: [HalfEdge] = [], adjacency = Array(repeating: [Int](), count: nodes.count)
            halfEdges.reserveCapacity(orderedEdges.count * 2)
            for edge in orderedEdges {
                try spend(&work)
                let a = halfEdges.count, b = a + 1
                halfEdges.append(HalfEdge(from: edge.a, to: edge.b, reverse: b))
                halfEdges.append(HalfEdge(from: edge.b, to: edge.a, reverse: a))
                adjacency[edge.a].append(a); adjacency[edge.b].append(b)
            }
            for id in nodes.indices {
                try Task.checkCancellation()
                let origin = nodes[id]
                let angles = adjacency[id].map { edge -> (Int, CGFloat) in
                    let point = nodes[halfEdges[edge].to]
                    return (edge, atan2(point.y - origin.y, point.x - origin.x))
                }
                let sorted = try angles.sorted {
                    try spend(&work)
                    return $0.1 == $1.1 ? $0.0 < $1.0 : $0.1 < $1.1
                }.map(\.0)
                for i in sorted.indices {
                    try spend(&work)
                    halfEdges[halfEdges[sorted[i]].reverse].next = sorted[(i + sorted.count - 1) % sorted.count]
                }
            }
            var visited = Array(repeating: false, count: halfEdges.count), faces: [[CGPoint]] = []
            for start in halfEdges.indices where !visited[start] {
                var current = start, face: [CGPoint] = []
                repeat {
                    try spend(&work)
                    guard halfEdges.indices.contains(current), !visited[current] else { throw Failure.invalidPolygon }
                    visited[current] = true; face.append(nodes[halfEdges[current].from])
                    current = halfEdges[current].next
                } while current != start
                guard face.count >= 3 else { continue }
                let origin = face[0]
                var area: CGFloat = 0
                for i in face.indices {
                    try spend(&work)
                    area += cross(origin, face[i], face[(i + 1) % face.count])
                }
                // Left-hand faces have positive signed area. The unbounded
                // exterior walks clockwise and is the only region excluded.
                if area > 1e-12 { faces.append(face) }
            }
            guard !faces.isEmpty else { throw Failure.invalidPolygon }
            contours = faces
        }
    }

    private struct Polygon {
        let points: [CGPoint]
        let bounds: CGRect
        let isRectangle: Bool
        private let edgeIndex: PolygonEdgeIndex
        init(_ input: [CGPoint], world: CGRect, work: inout Int) throws {
            // A lasso is a bounded query, not new board geometry. Retain its
            // original outside vertices so crossing an edge never changes its
            // shape. All actual content transformations still require world.
            let queryWorld = world.insetBy(dx: -maximumWorldSide, dy: -maximumWorldSide)
            guard (3...8192).contains(input.count), input.allSatisfy({ finite($0) && closedContains(queryWorld, $0) }) else { throw Failure.invalidPolygon }
            var unique: [CGPoint] = []
            for point in input { try spend(&work); if unique.last != point { unique.append(point) } }
            if unique.count > 1, unique.first == unique.last { unique.removeLast() }
            guard unique.count >= 3 else { throw Failure.invalidPolygon }
            points = unique
            bounds = unique.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
            guard valid(bounds), unique.dropFirst(2).contains(where: { abs(cross(unique[0], unique[1], $0)) > 0.000001 }) else { throw Failure.invalidPolygon }
            let corners = [bounds.origin, CGPoint(x: bounds.maxX, y: bounds.minY),
                           CGPoint(x: bounds.maxX, y: bounds.maxY), CGPoint(x: bounds.minX, y: bounds.maxY)]
            isRectangle = unique.count == 4 && corners.allSatisfy { unique.contains($0) }
                && zip(unique, Array(unique.dropFirst()) + [unique[0]]).allSatisfy { $0.x == $1.x || $0.y == $1.y }
            let contours = isRectangle ? [unique] : try PolygonCoverage(points: unique, work: &work).contours
            edgeIndex = try PolygonEdgeIndex(contours: contours, work: &work)
        }
        func fullyContains(_ rect: CGRect, work: inout Int) throws -> Bool {
            guard bounds.contains(rect) else { return false }
            if isRectangle { return true }
            guard try contains(CGPoint(x: rect.midX, y: rect.midY), work: &work) else { return false }
            let corners = [rect.origin, CGPoint(x: rect.maxX,y: rect.minY), CGPoint(x: rect.maxX,y: rect.maxY), CGPoint(x: rect.minX,y: rect.maxY)]
            return try !edgeIndex.anyEdge(in: .init(rect: rect), work: &work) { edge in
                if rect.contains(edge.a) || rect.contains(edge.b) { return true }
                guard edge.bounds.intersects(rect) else { return false }
                return corners.indices.contains { segmentsIntersect(edge.a, edge.b, corners[$0], corners[($0 + 1) % 4]) }
            }
        }
        func contains(_ p: CGPoint, work: inout Int) throws -> Bool {
            guard bounds.insetBy(dx: -0.000001, dy: -0.000001).contains(p) else { return false }
            var winding = 0
            // Include the original boundary tolerance, then keep only edges
            // that can meet the horizontal ray to the polygon's right edge.
            let ray = CGRect(x: p.x, y: p.y, width: max(0, bounds.maxX - p.x), height: 0)
            let boundary = try edgeIndex.anyEdge(in: .init(rect: ray), work: &work) { edge in
                let a = edge.a, b = edge.b
                if segmentDistanceSquared(p, a, b) < 1e-12 { return true }
                if (a.y > p.y) != (b.y > p.y), p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x {
                    winding += b.y > a.y ? 1 : -1
                }
                return false
            }
            return boundary || winding != 0
        }
        func intersects(_ rect: CGRect, work: inout Int) throws -> Bool {
            guard valid(rect), bounds.intersects(rect) else { return false }
            if try contains(CGPoint(x: rect.midX, y: rect.midY), work: &work) { return true }
            let corners = [rect.origin, CGPoint(x: rect.maxX,y: rect.minY), CGPoint(x: rect.maxX,y: rect.maxY), CGPoint(x: rect.minX,y: rect.maxY)]
            if try edgeIndex.anyEdge(in: .init(rect: rect), work: &work, matching: { rect.contains($0.a) || rect.contains($0.b) }) { return true }
            for i in corners.indices {
                if try contains(corners[i], work: &work) { return true }
                if try touchesSegment(corners[i], corners[(i+1)%4], radius: 0, work: &work) { return true }
            }
            return false
        }
        func touchesSegment(_ a: CGPoint, _ b: CGPoint, radius: CGFloat, work: inout Int) throws -> Bool {
            return try edgeIndex.anyEdge(in: .init(a: a, b: b, padding: radius + 0.000002), work: &work) { edge in
                let c = edge.a, d = edge.b
                if segmentsIntersect(a,b,c,d) { return true }
                if radius > 0 && min(segmentDistanceSquared(a,c,d), segmentDistanceSquared(b,c,d), segmentDistanceSquared(c,a,b), segmentDistanceSquared(d,a,b)) <= radius*radius { return true }
                return false
            }
        }
    }
    private static func cross(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) -> CGFloat { (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x) }
    private static func segmentDistanceSquared(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x-a.x, dy = b.y-a.y, length = dx*dx+dy*dy
        let t = length == 0 ? 0 : max(0,min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length))
        let x = p.x-a.x-t*dx, y = p.y-a.y-t*dy
        return x*x+y*y
    }
    private static func segmentsIntersect(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint) -> Bool {
        let first = cross(a,b,c), second = cross(a,b,d), third = cross(c,d,a), fourth = cross(c,d,b)
        if ((first > 0 && second < 0) || (first < 0 && second > 0)) && ((third > 0 && fourth < 0) || (third < 0 && fourth > 0)) { return true }
        return segmentDistanceSquared(a,c,d) < 1e-12 || segmentDistanceSquared(b,c,d) < 1e-12 || segmentDistanceSquared(c,a,b) < 1e-12 || segmentDistanceSquared(d,a,b) < 1e-12
    }
}

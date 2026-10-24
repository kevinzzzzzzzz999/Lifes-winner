import Foundation
import CoreGraphics
import PencilKit
#if os(iOS)
import os
#endif

/// Pure value preparation only. The host owns the system clipboard, session/CAS,
/// one undo group and saving. No files, child boards or source PDFs are written.
enum BoardLassoClipboard {
    static let typeIdentifier = "org.inkspace.lasso-selection"

    struct ReferenceContext: Codable, Equatable, Sendable {
        /// Stable hash/identifier of the authorized vault; never an absolute URL.
        var vaultID: String
        var boardID: UUID
        var boardPath: String
    }
    struct Envelope: Codable {
        var version: Int = 1
        var context: ReferenceContext
        var bounds: CGRect
        var canvasSize: CGSize
        /// Authoritative selected PKDrawing, not a bitmap or web approximation.
        var drawingData: Data
        var nativeStrokeCount: Int
        var items: [BoardItem]
        /// Only edges whose two owners are selected belong to the copied group.
        var edges: [BoardEdge]
        /// Optional schema-1 extension; older clipboard payloads omit it.
        var outline: [CGPoint]? = nil

        private enum CodingKeys: String, CodingKey {
            case version, context, bounds, canvasSize, drawingData, nativeStrokeCount, items, edges, outline
        }
        init(version: Int = 1, context: ReferenceContext, bounds: CGRect, canvasSize: CGSize,
             drawingData: Data, nativeStrokeCount: Int, items: [BoardItem], edges: [BoardEdge], outline: [CGPoint]? = nil) {
            self.version = version; self.context = context; self.bounds = bounds; self.canvasSize = canvasSize
            self.drawingData = drawingData; self.nativeStrokeCount = nativeStrokeCount
            self.items = items; self.edges = edges; self.outline = outline
        }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            version = try values.decode(Int.self, forKey: .version)
            context = try values.decode(ReferenceContext.self, forKey: .context)
            bounds = try values.decode(CGRect.self, forKey: .bounds)
            canvasSize = try values.decode(CGSize.self, forKey: .canvasSize)
            drawingData = try values.decode(Data.self, forKey: .drawingData)
            nativeStrokeCount = try values.decode(Int.self, forKey: .nativeStrokeCount)
            items = try values.decode([BoardItem].self, forKey: .items)
            edges = try values.decode([BoardEdge].self, forKey: .edges)
            if values.contains(.outline), try !values.decodeNil(forKey: .outline) {
                var path = try values.nestedUnkeyedContainer(forKey: .outline)
                guard path.count.map({ (3...8192).contains($0) }) ?? true else { throw Failure.invalid }
                var points: [CGPoint] = []
                while !path.isAtEnd {
                    guard points.count < 8192 else { throw Failure.invalid }
                    if points.count.isMultiple(of: 128) { try Task.checkCancellation() }
                    points.append(try path.decode(CGPoint.self))
                }
                outline = try BoardLassoSelection.validatedOutline(points)
            } else { outline = nil }
        }
    }
    struct Result {
        var drawing: PKDrawing
        var items: [BoardItem]
        var edges: [BoardEdge]
        /// Refers exclusively to added strokes and new owner IDs, ready to drag.
        var selection: BoardLassoSelection.Selection
        var itemIDMap: [UUID: UUID]
    }
    struct Limits: Sendable {
        var maximumStrokes = 100_000
        var maximumItems = 10_000
        var maximumEdges = 100_000
        var maximumControlPoints = 10_000_000
        var maximumNativeBytes = 96 * 1024 * 1024
        var maximumEnvelopeBytes = 128 * 1024 * 1024
        /// Testable override. Production iOS otherwise reads current headroom.
        var availableMemoryBytes: UInt64? = nil
    }
    enum Failure: Error, LocalizedError, Equatable {
        case empty, invalid, unsupportedVersion, tooLarge, memoryPressure, differentVault, recursiveChild
        var errorDescription: String? {
            switch self {
            case .empty: return String(localized: "请先圈选要复制的笔迹或模块。")
            case .invalid: return String(localized: "圈选内容或剪贴板格式无效，没有改变白板。")
            case .unsupportedVersion: return String(localized: "这份圈选剪贴板的版本暂不支持，没有改变白板。")
            case .tooLarge: return String(localized: "圈选内容超过安全复制容量；没有截断笔迹，也没有改变白板。")
            case .memoryPressure: return String(localized: "当前可用内存不足，尚未复制。请暂时关闭大型文档后重试；原内容保留。")
            case .differentVault: return String(localized: "圈选内容引用原资料库文件，暂不能跨资料库粘贴。请在原资料库中粘贴，避免资料链接失效。")
            case .recursiveChild: return String(localized: "不能把子白板链接粘贴回它自身，没有改变白板。")
            }
        }
    }
    private struct Content {
        var drawing: PKDrawing
        var items: [BoardItem]
        var edges: [BoardEdge]
        var bounds: CGRect
        var context: ReferenceContext
        var outline: [CGPoint]? = nil
    }

    static func makeEnvelope(snapshot: BoardLassoSelection.Snapshot, edges: [BoardEdge] = [],
                             context: ReferenceContext, limits: Limits = .init()) throws -> Envelope {
        let content = try selected(snapshot: snapshot, edges: edges, context: context, limits: limits)
        try Task.checkCancellation()
        let bytes = content.drawing.dataRepresentation()
        guard bytes.count <= limits.maximumNativeBytes else { throw Failure.tooLarge }
        let envelope = Envelope(context: context, bounds: content.bounds, canvasSize: snapshot.canvasSize,
            drawingData: bytes, nativeStrokeCount: content.drawing.strokes.count,
            items: content.items, edges: content.edges, outline: content.outline)
        try checkMemory(bytes: bytes.count, points: 0, limits: limits)
        try Task.checkCancellation()
        return envelope
    }

    static func encode(_ envelope: Envelope, limits: Limits = .init()) throws -> Data {
        _ = try read(envelope, limits: limits)
        try Task.checkCancellation()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(envelope)
        guard bytes.count <= limits.maximumEnvelopeBytes else { throw Failure.tooLarge }
        try Task.checkCancellation()
        return bytes
    }

    static func decode(_ bytes: Data, limits: Limits = .init()) throws -> Envelope {
        try validateLimits(limits)
        guard bytes.count <= limits.maximumEnvelopeBytes else { throw Failure.tooLarge }
        try checkMemory(bytes: bytes.count, points: 0, limits: limits)
        try Task.checkCancellation()
        let value: Envelope
        do { value = try JSONDecoder().decode(Envelope.self, from: bytes) }
        catch is CancellationError { throw CancellationError() }
        catch { throw Failure.invalid }
        _ = try read(value, limits: limits)
        try Task.checkCancellation()
        return value
    }

    /// The immediate duplicate does not serialize a large selected drawing first.
    static func duplicate(snapshot: BoardLassoSelection.Snapshot, edges: [BoardEdge] = [],
                          context: ReferenceContext, translation: CGSize = CGSize(width: 24, height: 24),
                          limits: Limits = .init()) throws -> Result {
        let content = try selected(snapshot: snapshot, edges: edges, context: context, limits: limits)
        return try adding(content, drawing: snapshot.drawing, items: snapshot.items, edges: edges,
            context: context, canvasSize: snapshot.canvasSize, at: nil, translation: translation, limits: limits)
    }

    static func insert(_ envelope: Envelope, drawing: PKDrawing, items: [BoardItem], edges: [BoardEdge] = [],
                       context: ReferenceContext, canvasSize: CGSize, at: CGPoint? = nil,
                       translation: CGSize = .zero, limits: Limits = .init()) throws -> Result {
        let content = try read(envelope, limits: limits)
        return try adding(content, drawing: drawing, items: items, edges: edges, context: context,
            canvasSize: canvasSize, at: at, translation: translation, limits: limits)
    }

    private static func selected(snapshot: BoardLassoSelection.Snapshot, edges: [BoardEdge],
                                 context: ReferenceContext, limits: Limits) throws -> Content {
        try validateLimits(limits)
        try validateContext(context)
        guard !snapshot.selection.isEmpty else { throw Failure.empty }
        let allStrokes = snapshot.drawing.strokes
        guard snapshot.selection.strokeIndices.allSatisfy({ allStrokes.indices.contains($0) }),
              Set(snapshot.items.map(\.id)).count == snapshot.items.count,
              snapshot.selection.itemIDs.isSubset(of: Set(snapshot.items.map(\.id))) else { throw Failure.invalid }
        let strokes = snapshot.selection.strokeIndices.sorted().map { allStrokes[$0] }
        let items = snapshot.items.filter { snapshot.selection.itemIDs.contains($0.id) }
        let copiedEdges = edges.filter { snapshot.selection.itemIDs.contains($0.from) && snapshot.selection.itemIDs.contains($0.to) }
        try inspect(strokes: strokes, items: items, edges: copiedEdges, limits: limits)
        // The existing transform owns all native/item/child bounds validation.
        let checked = try BoardLassoSelection.transform(snapshot: snapshot)
        try validateItems(items, edges: copiedEdges, canvasSize: snapshot.canvasSize)
        return Content(drawing: PKDrawing(strokes: strokes), items: items, edges: copiedEdges,
                       bounds: checked.selection.bounds, context: context, outline: checked.selection.outline)
    }

    private static func read(_ envelope: Envelope, limits: Limits) throws -> Content {
        try validateLimits(limits)
        guard envelope.version == 1 else { throw Failure.unsupportedVersion }
        try validateContext(envelope.context)
        guard envelope.nativeStrokeCount >= 0, envelope.nativeStrokeCount <= limits.maximumStrokes,
              envelope.drawingData.count <= limits.maximumNativeBytes else { throw Failure.tooLarge }
        try checkMemory(bytes: envelope.drawingData.count, points: 0, limits: limits)
        try Task.checkCancellation()
        let drawing: PKDrawing
        do { drawing = try PKDrawing(data: envelope.drawingData) } catch { throw Failure.invalid }
        let strokes = drawing.strokes
        guard strokes.count == envelope.nativeStrokeCount else { throw Failure.invalid }
        guard !strokes.isEmpty || !envelope.items.isEmpty else { throw Failure.empty }
        try inspect(strokes: strokes, items: envelope.items, edges: envelope.edges, limits: limits)
        try validateItems(envelope.items, edges: envelope.edges, canvasSize: envelope.canvasSize)
        let outline: [CGPoint]?
        do { outline = try envelope.outline.map { try BoardLassoSelection.validatedOutline($0) } }
        catch is CancellationError { throw CancellationError() }
        catch { throw Failure.invalid }
        let selection = BoardLassoSelection.Selection(strokeIndices: Set(strokes.indices), itemIDs: Set(envelope.items.map(\.id)), outline: outline)
        let checked = try BoardLassoSelection.transform(snapshot: .init(drawing: drawing, items: envelope.items,
            selection: selection, canvasSize: envelope.canvasSize))
        guard sameBounds(envelope.bounds, checked.selection.bounds) else { throw Failure.invalid }
        return Content(drawing: drawing, items: envelope.items, edges: envelope.edges,
                       bounds: checked.selection.bounds, context: envelope.context, outline: checked.selection.outline)
    }

    private static func adding(_ content: Content, drawing: PKDrawing, items: [BoardItem], edges: [BoardEdge],
                               context: ReferenceContext, canvasSize: CGSize, at: CGPoint?, translation: CGSize,
                               limits: Limits) throws -> Result {
        try validateContext(context)
        guard content.context.vaultID == context.vaultID || !hasFileReferences(content.items) else { throw Failure.differentVault }
        guard !content.items.contains(where: { ($0.childBoards ?? []).contains(where: { $0.id == context.boardID }) }) else { throw Failure.recursiveChild }
        let oldStrokes = drawing.strokes, selectedStrokes = content.drawing.strokes
        guard oldStrokes.count <= limits.maximumStrokes - selectedStrokes.count,
              items.count <= limits.maximumItems - content.items.count,
              edges.count <= limits.maximumEdges - content.edges.count else { throw Failure.tooLarge }
        try inspect(strokes: oldStrokes + selectedStrokes, items: items + content.items,
                    edges: edges + content.edges, limits: limits)
        try validateItems(items, edges: edges, canvasSize: canvasSize)
        var offset = translation
        if let at {
            guard at.x.isFinite, at.y.isFinite else { throw Failure.invalid }
            offset.width += at.x - content.bounds.minX
            offset.height += at.y - content.bounds.minY
        }
        let selection = BoardLassoSelection.Selection(strokeIndices: Set(selectedStrokes.indices), itemIDs: Set(content.items.map(\.id)), outline: content.outline)
        let moved = try BoardLassoSelection.transform(snapshot: .init(drawing: content.drawing, items: content.items,
            selection: selection, canvasSize: canvasSize), translation: offset)
        try Task.checkCancellation()
        var reserved = Set(items.map(\.id) + edges.map(\.id) + content.items.map(\.id) + content.edges.map(\.id))
        reserved.formUnion((items + content.items).compactMap(\.sourceCardID))
        reserved.formUnion(content.items.flatMap { ($0.childBoards ?? []).map(\.id) })
        var map: [UUID: UUID] = [:]
        for item in moved.items { map[item.id] = freshID(&reserved) }
        var copies = moved.items
        var sourceGroups = map
        for i in copies.indices {
            try Task.checkCancellation()
            let old = copies[i].id
            guard let id = map[old] else { throw Failure.invalid }
            copies[i].id = id
            if let owner = copies[i].sourceCardID {
                if sourceGroups[owner] == nil { sourceGroups[owner] = freshID(&reserved) }
                copies[i].sourceCardID = sourceGroups[owner]
            }
            // BoardChildLink.id is the actual child file ID. Keep id/path as the
            // shared source reference; the new ownerID gives an independent view
            // key (owner.id + child.id). Transform already translated presentation.
            if copies[i].kind == .inkGroup {
                guard let bytes = copies[i].inkData else { throw Failure.invalid }
                let group: PKDrawing
                do { group = try PKDrawing(data: bytes) } catch { throw Failure.invalid }
                copies[i].inkData = try freshDrawing(group).dataRepresentation()
            }
        }
        var copiedEdges = movedEdges(content.edges, map: map)
        for i in copiedEdges.indices { copiedEdges[i].id = freshID(&reserved) }
        let fresh = try freshDrawing(moved.drawing)
        let addedStrokes = fresh.strokes
        var combinedStrokes = oldStrokes
        combinedStrokes.append(contentsOf: addedStrokes)
        let allItems = items + copies, allEdges = edges + copiedEdges
        try validateItems(allItems, edges: allEdges, canvasSize: canvasSize)
        try Task.checkCancellation()
        return Result(drawing: PKDrawing(strokes: combinedStrokes), items: allItems, edges: allEdges,
            selection: .init(strokeIndices: Set(oldStrokes.count..<(oldStrokes.count + addedStrokes.count)),
                             itemIDs: Set(copies.map(\.id)), bounds: moved.selection.bounds, outline: moved.selection.outline), itemIDMap: map)
    }

    private static func movedEdges(_ edges: [BoardEdge], map: [UUID: UUID]) -> [BoardEdge] {
        edges.map { old in
            var copy = old
            // Validated internal edges have both endpoints in map.
            copy.from = map[old.from] ?? old.from; copy.to = map[old.to] ?? old.to
            return copy
        }
    }
    private static func freshDrawing(_ drawing: PKDrawing) throws -> PKDrawing {
        var output: [PKStroke] = []
        let strokes = drawing.strokes
        output.reserveCapacity(strokes.count)
        for (index, original) in strokes.enumerated() {
            if index % 128 == 0 { try Task.checkCancellation() }
            var copy = original
            if #available(iOS 27.0, macOS 27.0, *) { copy.id = UUID() }
            else { copy = PKStroke(ink: original.ink, path: original.path, transform: original.transform,
                                   mask: original.mask, randomSeed: original.randomSeed) }
            output.append(copy)
        }
        return PKDrawing(strokes: output)
    }
    private static func freshID(_ reserved: inout Set<UUID>) -> UUID {
        var id = UUID()
        while !reserved.insert(id).inserted { id = UUID() }
        return id
    }
    private static func validateContext(_ context: ReferenceContext) throws {
        guard !context.vaultID.isEmpty, context.vaultID.utf8.count <= 512,
              !context.vaultID.contains("/"), !context.vaultID.contains("\\"),
              context.vaultID.rangeOfCharacter(from: .controlCharacters) == nil,
              VaultPath.isSafeRelative(context.boardPath), context.boardPath.lowercased().hasSuffix(".inkspace.json") else { throw Failure.invalid }
    }
    private static func validateItems(_ items: [BoardItem], edges: [BoardEdge], canvasSize: CGSize) throws {
        guard [1_000_000.0, 8_000_000.0].contains(Double(canvasSize.width)), canvasSize.height == canvasSize.width,
              Set(items.map(\.id)).count == items.count, Set(edges.map(\.id)).count == edges.count else { throw Failure.invalid }
        var board = BoardDocument()
        board.canvasWidth = Double(canvasSize.width); board.canvasHeight = Double(canvasSize.height)
        board.items = items; board.edges = edges
        try board.validate()
        guard items.allSatisfy({ $0.sourceReference.map { VaultPath.isSafeRelative($0.path) } ?? true }) else { throw Failure.invalid }
    }
    private static func hasFileReferences(_ items: [BoardItem]) -> Bool {
        items.contains { item in
            if item.sourcePath != nil || item.originalSourcePath != nil || item.sourceReference != nil || !(item.childBoards ?? []).isEmpty { return true }
            // External HTTPS/HTTP links are self-contained. Local/file/app URLs
            // may resolve inside the source vault and cannot be rebased safely.
            if let url = item.url, !url.isEmpty {
                return !["https", "http", "mailto", "tel"].contains(URL(string: url)?.scheme?.lowercased() ?? "")
            }
            return false
        }
    }
    private static func sameBounds(_ a: CGRect, _ b: CGRect) -> Bool {
        !a.isNull && !a.isInfinite && [a.minX, a.minY, a.width, a.height].allSatisfy(\.isFinite) &&
        abs(a.minX-b.minX) <= 0.0001 && abs(a.minY-b.minY) <= 0.0001 &&
        abs(a.width-b.width) <= 0.0001 && abs(a.height-b.height) <= 0.0001
    }
    private static func validateLimits(_ limits: Limits) throws {
        guard (1...100_000).contains(limits.maximumStrokes), (1...10_000).contains(limits.maximumItems),
              (1...100_000).contains(limits.maximumEdges), (1...10_000_000).contains(limits.maximumControlPoints),
              (1...(96 * 1024 * 1024)).contains(limits.maximumNativeBytes),
              (1...(128 * 1024 * 1024)).contains(limits.maximumEnvelopeBytes) else { throw Failure.tooLarge }
    }
    private static func inspect(strokes: [PKStroke], items: [BoardItem], edges: [BoardEdge], limits: Limits) throws {
        guard strokes.count <= limits.maximumStrokes, items.count <= limits.maximumItems,
              edges.count <= limits.maximumEdges else { throw Failure.tooLarge }
        var points = 0, bytes = 0
        for (i, stroke) in strokes.enumerated() {
            if i % 128 == 0 { try Task.checkCancellation() }
            guard stroke.path.count > 0, points <= limits.maximumControlPoints - stroke.path.count else { throw Failure.tooLarge }
            points += stroke.path.count
        }
        for item in items {
            try Task.checkCancellation()
            for string in [item.title, item.text, item.richTextHTML, item.url, item.sourcePath, item.originalSourcePath].compactMap({ $0 }) {
                guard string.utf8.count <= limits.maximumEnvelopeBytes - bytes else { throw Failure.tooLarge }
                bytes += string.utf8.count
            }
            for child in item.childBoards ?? [] {
                try addBytes(child.title.utf8.count, to: &bytes, limit: limits.maximumEnvelopeBytes)
                try addBytes(child.path.utf8.count, to: &bytes, limit: limits.maximumEnvelopeBytes)
            }
            if let reference = item.sourceReference {
                try addBytes(reference.quote.utf8.count, to: &bytes, limit: limits.maximumEnvelopeBytes)
                try addBytes(reference.path.utf8.count, to: &bytes, limit: limits.maximumEnvelopeBytes)
            }
            if let metadata = item.boardNotesObject {
                var nodes = 0
                for (key, value) in metadata {
                    try addBytes(key.utf8.count, to: &bytes, limit: limits.maximumEnvelopeBytes)
                    try metadataBytes(value, depth: 1, nodes: &nodes, bytes: &bytes, limit: limits.maximumEnvelopeBytes)
                }
            }
            if let ink = item.inkData {
                guard ink.count <= limits.maximumNativeBytes, ink.count <= limits.maximumEnvelopeBytes - bytes else { throw Failure.tooLarge }
                bytes += ink.count
                try checkMemory(bytes: bytes, points: points, limits: limits)
                let group: PKDrawing
                do { group = try PKDrawing(data: ink) } catch { throw Failure.invalid }
                for stroke in group.strokes {
                    try Task.checkCancellation()
                    guard stroke.path.count > 0, points <= limits.maximumControlPoints - stroke.path.count else { throw Failure.tooLarge }
                    points += stroke.path.count
                }
            }
        }
        for edge in edges {
            try Task.checkCancellation()
            try addBytes(edge.relation?.utf8.count ?? 0, to: &bytes, limit: limits.maximumEnvelopeBytes)
        }
        try checkMemory(bytes: bytes, points: points, limits: limits)
    }
    private static func addBytes(_ count: Int, to bytes: inout Int, limit: Int) throws {
        guard count >= 0, bytes <= limit - count else { throw Failure.tooLarge }
        bytes += count
    }
    private static func metadataBytes(_ value: BoardSourceJSONValue, depth: Int, nodes: inout Int,
                                      bytes: inout Int, limit: Int) throws {
        guard depth <= 4, nodes < 100_000 else { throw Failure.tooLarge }
        nodes += 1
        if nodes % 128 == 0 { try Task.checkCancellation() }
        switch value {
        case .string(let text): try addBytes(text.utf8.count, to: &bytes, limit: limit)
        case .array(let values):
            for item in values { try metadataBytes(item, depth: depth + 1, nodes: &nodes, bytes: &bytes, limit: limit) }
        case .object(let values):
            for (key, item) in values {
                try addBytes(key.utf8.count, to: &bytes, limit: limit)
                try metadataBytes(item, depth: depth + 1, nodes: &nodes, bytes: &bytes, limit: limit)
            }
        default: try addBytes(32, to: &bytes, limit: limit)
        }
    }
    private static func checkMemory(bytes: Int, points: Int, limits: Limits) throws {
        guard bytes >= 0, points >= 0 else { throw Failure.tooLarge }
        let (byteCost, a) = UInt64(bytes).multipliedReportingOverflow(by: 10)
        let (pointCost, b) = UInt64(points).multipliedReportingOverflow(by: 192)
        let (cost, c) = byteCost.addingReportingOverflow(pointCost)
        let (required, d) = cost.addingReportingOverflow(128 * 1024 * 1024)
        guard !a, !b, !c, !d else { throw Failure.tooLarge }
        var available = limits.availableMemoryBytes
#if os(iOS)
        if available == nil { available = UInt64(os_proc_available_memory()) }
#endif
        if let available, available < required { throw Failure.memoryPressure }
        try Task.checkCancellation()
    }
}

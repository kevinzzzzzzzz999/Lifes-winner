import Foundation
import CoreGraphics

enum SavedPenKind: String, Codable, CaseIterable, Identifiable {
    case pen, fountainPen, monoline, pencil, marker, watercolor, crayon, reed
    var id: String { rawValue }
    static var supportedCases: [Self] {
        if #available(iOS 26.0, macOS 26.0, *) { return allCases }
        return allCases.filter { $0 != .reed }
    }
    var title: String {
        switch self {
        case .pen: String(localized: "圆珠笔")
        case .fountainPen: String(localized: "钢笔")
        case .monoline: String(localized: "单线笔")
        case .pencil: String(localized: "铅笔")
        case .marker: String(localized: "荧光笔")
        case .watercolor: String(localized: "水彩笔")
        case .crayon: String(localized: "蜡笔")
        case .reed: String(localized: "书法笔")
        }
    }
}

struct SavedPen: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var name: String = String(localized: "新笔")
    var kind: SavedPenKind = .pen
    var red: Double = 0
    var green: Double = 0
    var blue: Double = 0
    var alpha: Double = 1
    var width: Double = 2

    var toolIdentifier: String { "inkspace.savedPen.\(id.uuidString)" }
}

/// Local app preferences, independent of the current vault or whiteboard.
struct SavedPenSettings: Codable, Equatable {
    static let defaultsKey = "InkSpace.savedPens.v2"
    static let legacyDefaultsKey = "InkSpace.savedPens.v1"
    static let legacyPickerKey = "InkSpace.nativePickerState.v1"
    var pens: [SavedPen] = []
    var selectedID: UUID?

    func validate() throws {
        var ids = Set<UUID>()
        for pen in pens {
            guard ids.insert(pen.id).inserted,
                  !pen.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  pen.width.isFinite, pen.width > 0,
                  [pen.red, pen.green, pen.blue, pen.alpha].allSatisfy({ $0.isFinite && (0...1).contains($0) })
            else { throw SavedPenSettingsError.invalidSettings }
        }
        if let selectedID, !ids.contains(selectedID) { throw SavedPenSettingsError.invalidSettings }
    }

    static func load(from defaults: UserDefaults = .standard) throws -> SavedPenSettings {
        if let data = defaults.data(forKey: defaultsKey) {
            let value = try JSONDecoder().decode(SavedPenSettings.self, from: data)
            try value.validate()
            return value
        }
        // Version 1 managed only additional pens; seven native ink tools were
        // always prepended and could never be deleted or reordered. Import those
        // tools once, preserving both legacy preference blobs for recovery.
        var legacy = SavedPenSettings()
        if let data = defaults.data(forKey: legacyDefaultsKey) {
            legacy = try JSONDecoder().decode(SavedPenSettings.self, from: data)
            try legacy.validate()
        }
        let native = defaults.data(forKey: legacyPickerKey).flatMap {
            try? JSONDecoder().decode(LegacyPickerState.self, from: $0)
        }
        let imported = initialPalette.map { pen in
            var pen = pen
            if let ink = native?.ink["inkspace.builtIn." + pen.kind.rawValue] {
                func component(_ value: Double, fallback: Double) -> Double {
                    value.isFinite ? min(1, max(0, value)) : fallback
                }
                pen.red = component(ink.red, fallback: pen.red)
                pen.green = component(ink.green, fallback: pen.green)
                pen.blue = component(ink.blue, fallback: pen.blue)
                pen.alpha = component(ink.alpha, fallback: pen.alpha)
                if ink.width.isFinite, ink.width > 0 { pen.width = ink.width }
            }
            return pen
        }
        let nativeSelection = imported.first {
            "inkspace.builtIn." + $0.kind.rawValue == native?.selectedIdentifier
        }?.id
        let value = SavedPenSettings(pens: imported + legacy.pens,
                                    selectedID: legacy.selectedID ?? nativeSelection)
        try value.save(to: defaults)
        return value
    }

    /// A deleted selected pen falls back to its neighbour, preserving list order.
    /// Empty palettes stay empty after relaunch; the native eraser remains usable.
    func removingPen(_ id: UUID) -> SavedPenSettings {
        guard let index = pens.firstIndex(where: { $0.id == id }) else { return self }
        var result = self
        result.pens.remove(at: index)
        if selectedID == id {
            result.selectedID = result.pens.isEmpty ? nil : result.pens[min(index, result.pens.count - 1)].id
        }
        return result
    }

    private static var initialPalette: [SavedPen] {
        [SavedPen(name: SavedPenKind.pen.title, kind: .pen, width: 2),
         SavedPen(name: SavedPenKind.fountainPen.title, kind: .fountainPen, width: 4),
         SavedPen(name: SavedPenKind.monoline.title, kind: .monoline, width: 2),
         SavedPen(name: SavedPenKind.pencil.title, kind: .pencil, red: 1 / 3, green: 1 / 3, blue: 1 / 3, width: 3),
         SavedPen(name: SavedPenKind.marker.title, kind: .marker, red: 1, green: 0.8, width: 18),
         SavedPen(name: SavedPenKind.watercolor.title, kind: .watercolor, green: 0.478, blue: 1, width: 12),
         SavedPen(name: SavedPenKind.crayon.title, kind: .crayon, red: 1, green: 0.584, width: 8)]
    }

    private struct LegacyPickerState: Decodable {
        var ink: [String: LegacyInk]
        var selectedIdentifier: String
    }
    private struct LegacyInk: Decodable {
        var red: Double
        var green: Double
        var blue: Double
        var alpha: Double
        var width: Double
    }

    func save(to defaults: UserDefaults = .standard) throws {
        try validate()
        let bytes = try JSONEncoder().encode(self)
        defaults.set(bytes, forKey: Self.defaultsKey)
    }
}

enum SavedPenSettingsError: LocalizedError {
    case invalidSettings
    var errorDescription: String? { String(localized: "自定义笔设置无效，请检查颜色和粗细。") }
}

enum BoardItemKind: String, Codable, CaseIterable {
    case text, formula, document, pdfPage, inkGroup
}

enum BoardNodeShape: String, Codable { case rectangle, rounded, ellipse }
enum BoardEdgeArrow: String, Codable { case none, end, both }
enum BoardEdgeDash: String, Codable { case solid, dashed, dotted, dashDot }

struct BoardChildLink: Codable, Equatable, Identifiable {
    var id: UUID
    var path: String
    var title: String
    var presentation: BoardChildPresentation? = nil
}

/// Parent layout only. The child file remains the owner of every object and stroke.
struct BoardChildPresentation: Codable, Equatable {
    /// A clipped giant portal can have an off-canvas canonical camera center
    /// while the visible child region is inside the actual eight-million-point world.
    static let maximumCameraMagnitude: Double = 1_000_000_000_000
    var expanded: Bool
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    /// Child world center, with zoom measured in parent world points per child point.
    var viewport: BoardViewport? = nil
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

    func validate(canvasSize: Double) throws {
        guard [x, y, width, height].allSatisfy(\.isFinite), x >= 0, y >= 0,
              width > 0, height > 0, x + width <= canvasSize, y + height <= canvasSize else {
            throw BoardFormatError.invalidGeometry
        }
        if let viewport {
            guard [viewport.x, viewport.y, viewport.zoom].allSatisfy(\.isFinite),
                  abs(viewport.x) <= Self.maximumCameraMagnitude,
                  abs(viewport.y) <= Self.maximumCameraMagnitude, viewport.zoom > 0 else { throw BoardFormatError.invalidGeometry }
        }
    }
}

enum BoardChildLayout {
    static let headerHeight: Double = 44
    static func collapsedRect(owner: BoardItem, index: Int) -> CGRect {
        if owner.kind == .document, owner.sourcePath == nil, owner.childBoards?.count == 1 { return owner.rect }
        return CGRect(x: owner.x, y: owner.y + owner.height + 16 + Double(index) * 132, width: 360, height: 120)
    }
    static func visibleChildCenter(viewport: BoardViewport, fullBody: CGRect, visibleBody: CGRect, parentZoom: Double) -> CGPoint {
        let scale = viewport.zoom * parentZoom
        return CGPoint(x: viewport.x + (visibleBody.midX - fullBody.midX) / scale,
                       y: viewport.y + (visibleBody.midY - fullBody.midY) / scale)
    }
    static func viewport(visibleCenter: CGPoint, childScreenZoom: Double, fullBody: CGRect,
                         visibleBody: CGRect, parentZoom: Double) -> BoardViewport {
        BoardViewport(x: visibleCenter.x - (visibleBody.midX - fullBody.midX) / childScreenZoom,
                      y: visibleCenter.y - (visibleBody.midY - fullBody.midY) / childScreenZoom,
                      zoom: childScreenZoom / parentZoom)
    }
    static func expandedPresentation(childBounds: CGRect, childViewport: BoardViewport,
                                     origin: CGPoint, canvasSize: Double) -> BoardChildPresentation {
        let hasContent = !childBounds.isNull && !childBounds.isInfinite && !childBounds.isEmpty
        let center = hasContent ? CGPoint(x: childBounds.midX, y: childBounds.midY)
            : CGPoint(x: childViewport.x, y: childViewport.y)
        // Whole contents retain their actual writing size; the surrounding margin
        // is writable space, and the parent scroll view handles large regions.
        let width = min(canvasSize, max(720, hasContent ? childBounds.width + 160 : 960))
        let height = min(canvasSize, max(520, hasContent ? childBounds.height + 160 : 680) + headerHeight)
        let x = min(max(0, origin.x), max(0, canvasSize - width))
        let y = min(max(0, origin.y), max(0, canvasSize - height))
        return BoardChildPresentation(expanded: true, x: x, y: y, width: width, height: height,
            viewport: BoardViewport(x: min(8_000_000, max(0, center.x)), y: min(8_000_000, max(0, center.y)), zoom: 1))
    }
}

/// Optional schema-1 visual attributes shared with desktop. Absence keeps the
/// existing native appearance. Invalid values fail validation before any save.
struct BoardItemStyle: Codable, Equatable {
    var fillColor: String? = nil
    var strokeColor: String? = nil
    var textColor: String? = nil
    var fontSize: Double? = nil
    var shape: BoardNodeShape? = nil
    var strokeWidth: Double? = nil

    func validate() throws {
        guard [fillColor, strokeColor, textColor].allSatisfy(BoardStyleValidation.color),
              BoardStyleValidation.number(fontSize, in: 8...72),
              BoardStyleValidation.number(strokeWidth, in: 1...8)
        else { throw BoardFormatError.invalidGeometry }
    }
}

struct BoardEdgeStyle: Codable, Equatable {
    var strokeColor: String? = nil
    var strokeWidth: Double? = nil
    var arrow: BoardEdgeArrow? = nil
    var dash: BoardEdgeDash? = nil
    var opacity: Double? = nil

    func validate() throws {
        guard BoardStyleValidation.color(strokeColor),
              BoardStyleValidation.number(strokeWidth, in: 1...12),
              BoardStyleValidation.number(opacity, in: 0.1...1)
        else { throw BoardFormatError.invalidGeometry }
    }
}

private enum BoardStyleValidation {
    static func color(_ value: String?) -> Bool {
        guard let value else { return true }
        return value.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil
    }
    static func number(_ value: Double?, in range: ClosedRange<Double>) -> Bool {
        guard let value else { return true }
        return value.isFinite && range.contains(value)
    }
}

/// Inert source metadata. Preserve JSON values, including 64-bit integer IDs,
/// without interpreting paths, links, styles, or scripts from the original app.
enum BoardSourceJSONValue: Codable, Equatable {
    case null, bool(Bool), integer(Int64), unsigned(UInt64), number(Double), string(String)
    case array([Self]), object([String: Self])
    init(from decoder: Decoder) throws {
        let field = decoder.codingPath.lastIndex { $0.stringValue == "boardNotesObject" || $0.stringValue == "boardNotesImport" } ?? -1
        guard decoder.codingPath.count - field <= 6 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Source metadata is too deeply nested"))
        }
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Int64.self) { self = .integer(v) }
        else if let v = try? value.decode(UInt64.self) { self = .unsigned(v) }
        else if let v = try? value.decode(Double.self), v.isFinite { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([Self].self) { self = .array(v) }
        else { self = .object(try value.decode([String: Self].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let v): try value.encode(v)
        case .integer(let v): try value.encode(v)
        case .unsigned(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .string(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .object(let v): try value.encode(v)
        }
    }
    func isBounded(depth: Int = 1) -> Bool {
        guard depth <= 4 else { return false }
        switch self {
        case .null, .bool, .integer, .unsigned: return true
        case .number(let value): return value.isFinite
        case .string(let value): return value.utf16.count <= 300_000
        case .array(let values): return values.count <= 10_000 && values.allSatisfy { $0.isBounded(depth: depth + 1) }
        case .object(let values): return values.count <= 10_000 && values.allSatisfy { $0.key.utf16.count <= 300_000 && $0.value.isBounded(depth: depth + 1) }
        }
    }
}

struct BoardItem: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var kind: BoardItemKind
    var x: Double
    var y: Double
    var width: Double = 360
    var height: Double = 220
    var title: String
    var text: String? = nil
    /// Per-node display format; unknown future values remain readable as text.
    var textFormat: String? = nil
    /// Preserved as metadata. Native rendering never executes this HTML.
    var richTextHTML: String? = nil
    var sourcePath: String? = nil
    /// Optional desktop expansion ownership. Preserves card/page grouping across devices.
    var sourceCardID: UUID? = nil
    /// A rendered Office/Markdown page retains its original separately. Only
    /// sourcePath (the actual PDF) participates in PDF annotation writeback.
    var originalSourcePath: String? = nil
    var originalSourceSHA256: String? = nil
    /// One-based page number. Source documents stay in the vault.
    var page: Int? = nil
    var sourceReference: PDFSourceReference? = nil
    var inkData: Data? = nil
    var url: String? = nil
    var style: BoardItemStyle? = nil
    var childBoards: [BoardChildLink]? = nil
    /// Mac importer source record/content. Inert, bounded, and round-tripped.
    var boardNotesObject: [String: BoardSourceJSONValue]? = nil

    var usesBoardNotesImageBounds: Bool {
        guard kind == .document, let metadata = boardNotesObject, !metadata.isEmpty,
              let sourcePath else { return false }
        return ["png", "jpg", "jpeg"].contains((sourcePath as NSString).pathExtension.lowercased())
    }

    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

    var resolvedBoxTextFormat: String {
        if let textFormat { return ["richText", "markdown", "latex", "python"].contains(textFormat) ? textFormat : "plain" }
        return kind == .formula ? "latex" : "richText"
    }
    var usesFormulaRendering: Bool { (kind == .text || kind == .formula) && resolvedBoxTextFormat == "latex" }
    var usesMonospacedText: Bool { ["latex", "python"].contains(resolvedBoxTextFormat) }
    mutating func updatePlainText(_ value: String) {
        if text != value && resolvedBoxTextFormat == "richText" { richTextHTML = nil }
        text = value
    }
}

struct BoardEdge: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var from: UUID
    var to: UUID
    var style: BoardEdgeStyle? = nil
    var relation: String? = nil
}

struct BoardPin: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var title: String
    var x: Double
    var y: Double
    var zoom: Double
}

struct BoardViewport: Codable, Equatable {
    var x: Double = 500_000
    var y: Double = 500_000
    var zoom: Double = 1
}

/// Derived world bounds of the most recently created surviving stroke.
/// Kept separately from the viewport so browsing never changes the writing location.
struct BoardInkLocation: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

    func validate(canvasSize: Double) throws {
        guard [x, y, width, height].allSatisfy(\.isFinite), x >= 0, y >= 0,
              width > 0, height > 0, x + width <= canvasSize, y + height <= canvasSize
        else { throw BoardFormatError.invalidGeometry }
    }
}

/// Readable vector ink for the Obsidian companion; PencilKit data remains authoritative.
struct BoardWebInk: Codable {
    var version = 1
    var strokes: [BoardWebStroke] = []
}
struct BoardWebStroke: Codable {
    var points: [[Double]]
    var color: String
    var opacity: Double
    /// Optional Unix seconds: old schema-1 previews remain readable.
    var startedAt: Double? = nil
    var duration: Double? = nil
    /// Optional world-space clipping commands. Absent in older schema-1 previews.
    var clipPath: [[Double]]? = nil
}
struct PDFAnnotationSource: Codable {
    var sourcePath: String
    var sha256: String
    var pages: [Int]
}

struct BoardDocument: Codable, Identifiable {
    var schemaVersion: Int = 1
    var id: UUID = UUID()
    var title: String = String(localized: "未命名白板")
    var createdAt: Date = Date()
    var updatedAt: Date = Date()
    var revision: Int = 0
    var writerID: UUID = UUID()
    var canvasWidth: Double = 8_000_000
    var canvasHeight: Double = 8_000_000
    var drawing: Data? = nil
    /// Inert import provenance; never interpreted as a path or executable content.
    var boardNotesImport: [String: BoardSourceJSONValue]? = nil
    var webInk: BoardWebInk? = nil
    var lastInkLocation: BoardInkLocation? = nil
    var pdfAnnotationSources: [PDFAnnotationSource]? = nil
    var pdfOwnedSourcePaths: [String]? = nil
    /// A conflict copy must not compete with its original for PDF annotations.
    var pdfWritebackSuspended: Bool? = nil
    /// Read-only lineage of native ink already embedded in source PDFs. A merged
    /// board displays its editable drawing, so these inherited PDF copies must
    /// be hidden in private preview/export documents, never removed from source.
    var pdfMergedOwnerIDs: [UUID]? = nil
    var pdfDisplayOwnerIDs: Set<UUID> { Set([id] + (pdfMergedOwnerIDs ?? [])) }
    /// Optional bounded viewport preview. It is not an export of the whole board.
    var previewPNG: Data? = nil
    var items: [BoardItem] = []
    var edges: [BoardEdge] = []
    var pins: [BoardPin] = []
    /// Optional for schema-1 compatibility; these are output regions, never source pages.
    var printFrames: [BoardPrintFrame]? = nil
    var viewport = BoardViewport()

    static func decode(_ data: Data) throws -> BoardDocument {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let value = try decoder.decode(BoardDocument.self, from: data)
        try value.validate()
        return value
    }

    func encode() throws -> Data {
        try validate()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        guard let webInk else { return try encoder.encode(self) }
        // The companion may contain a million nested point arrays. Encoding that
        // whole graph with the native data creates a second, very large encoder
        // object tree. Keep the same schema and sorted-key bytes, but drain each
        // derived stroke before encoding the next one. Authoritative ink stays
        // untouched; no points, masks, timing or imported fields are dropped.
        var native = self
        native.webInk = nil
        var data = try encoder.encode(native)
        let writerKey = Data(",\"writerID\":".utf8)
        guard let writerRange = data.range(of: writerKey, options: .backwards) else {
            throw BoardFormatError.invalidTextFormat
        }
        // writerID is the last sorted root key. Its short suffix is detached so
        // the main buffer can grow in place instead of retaining a full copy.
        let suffix = data.subdata(in: writerRange.lowerBound..<data.endIndex)
        data.removeSubrange(writerRange.lowerBound..<data.endIndex)
        data.append(contentsOf: ",\"webInk\":{\"strokes\":[".utf8)
        for (index, stroke) in webInk.strokes.enumerated() {
            if index > 0 { data.append(44) }
            try autoreleasepool { data.append(try encoder.encode(stroke)) }
        }
        data.append(contentsOf: "],\"version\":".utf8)
        data.append(try encoder.encode(webInk.version))
        data.append(125)
        data.append(suffix)
        return data
    }

    private static func validateSourceMetadata(_ metadata: [String: BoardSourceJSONValue]) throws {
        guard !metadata.isEmpty, metadata.count <= 10_000,
              metadata.allSatisfy({ $0.key.utf16.count <= 300_000 && $0.value.isBounded() }),
              (try? JSONEncoder().encode(metadata).count) ?? Int.max <= 512 * 1_024
        else { throw BoardFormatError.invalidTextFormat }
    }

    func validate() throws {
        guard schemaVersion == 1 else { throw BoardFormatError.unsupportedVersion }
        if let owners = pdfMergedOwnerIDs {
            guard owners.count <= 128, Set(owners).count == owners.count else { throw BoardFormatError.invalidGeometry }
        }
        guard [1_000_000.0, 8_000_000.0].contains(canvasWidth), canvasHeight == canvasWidth,
              viewport.x.isFinite, viewport.y.isFinite, viewport.zoom.isFinite,
              viewport.zoom > 0 else { throw BoardFormatError.invalidGeometry }
        try PrintPageGeometry.validate(frames: printFrames ?? [], canvasSize: canvasWidth)
        try lastInkLocation?.validate(canvasSize: canvasWidth)
        if let metadata = boardNotesImport { try Self.validateSourceMetadata(metadata) }
        var ids = Set<UUID>()
        for item in items {
            try item.style?.validate()
            if let metadata = item.boardNotesObject {
                try Self.validateSourceMetadata(metadata)
            }
            if let children = item.childBoards {
                guard children.count <= 100, Set(children.map(\.id)).count == children.count else { throw BoardFormatError.invalidEdge }
                for child in children {
                    try child.presentation?.validate(canvasSize: canvasWidth)
                    guard VaultPath.isSafeRelative(child.path), child.path.lowercased().hasSuffix(".inkspace.json") else { throw BoardFormatError.unsafePath }
                    guard child.title.utf16.count <= 1000, !child.title.contains("\0") else { throw BoardFormatError.invalidTextFormat }
                }
            }
            guard item.textFormat.map({ $0.utf16.count <= 64 && !$0.contains("\0") }) ?? true,
                  item.richTextHTML.map({ $0.utf16.count <= 300_000 && !$0.contains("\0") }) ?? true
            else { throw BoardFormatError.invalidTextFormat }
            guard ids.insert(item.id).inserted else { throw BoardFormatError.duplicateIdentifier }
            guard item.x.isFinite, item.y.isFinite, item.width.isFinite, item.height.isFinite,
                  item.width > 0, item.height > 0, item.x >= 0, item.y >= 0,
                  item.x + item.width <= canvasWidth, item.y + item.height <= canvasHeight
            else { throw BoardFormatError.invalidGeometry }
            if let reference=item.sourceReference,!reference.isValid {throw BoardFormatError.unsafePath}
            if let path = item.sourcePath, !VaultPath.isSafeRelative(path) {
                throw BoardFormatError.unsafePath
            }
            if let path = item.originalSourcePath, !VaultPath.isSafeRelative(path) {
                throw BoardFormatError.unsafePath
            }
            if let digest = item.originalSourceSHA256,
               (item.originalSourcePath == nil || digest.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) == nil) {
                throw BoardFormatError.unsafePath
            }
            if item.kind == .pdfPage, item.originalSourcePath != nil,
               item.sourcePath?.lowercased().hasSuffix(".pdf") != true {
                throw BoardFormatError.invalidPageSource
            }
            if item.kind == .pdfPage, (item.page ?? 0) < 1 { throw BoardFormatError.invalidPage }
        }
        for edge in edges {
            try edge.style?.validate()
            guard edge.relation.map({ $0.utf16.count <= 120 && !$0.contains("\0") }) ?? true else { throw BoardFormatError.invalidEdge }
            guard edge.from != edge.to, ids.contains(edge.from), ids.contains(edge.to)
            else { throw BoardFormatError.invalidEdge }
        }
        for pin in pins {
            guard pin.x.isFinite, pin.y.isFinite, pin.zoom.isFinite, pin.zoom > 0,
                  pin.x >= 0, pin.y >= 0, pin.x <= canvasWidth, pin.y <= canvasHeight
            else { throw BoardFormatError.invalidGeometry }
        }
    }
}

enum BoardFormatError: LocalizedError {
    case unsupportedVersion, invalidGeometry, duplicateIdentifier, unsafePath, invalidPage, invalidPageSource, invalidEdge, invalidTextFormat
    var errorDescription: String? {
        switch self {
        case .invalidTextFormat: String(localized: "文本框格式无效或内容过长，未覆盖原文件。")
        case .unsupportedVersion: String(localized: "白板格式版本不受支持，未覆盖原文件。")
        case .invalidGeometry: String(localized: "白板中存在无效或超出画布范围的位置。")
        case .duplicateIdentifier: String(localized: "白板中存在重复对象标识。")
        case .unsafePath: String(localized: "文档引用必须位于已授权的仓库内。")
        case .invalidPage: String(localized: "PDF 页码必须从 1 开始。")
        case .invalidPageSource: String(localized: "展开的页面必须关联 PDF 批注版，不能直接把 Word、PPT 或 Markdown 当作 PDF 写入。")
        case .invalidEdge: String(localized: "导图连线指向了不存在的节点。")
        }
    }
}

enum VaultPath {
    static func isSafeRelative(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"),
              !path.contains(":"), path.rangeOfCharacter(from: .controlCharacters) == nil
        else { return false }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
}

/// Cross-platform source anchor. Geometry is normalized against the rotated,
/// visible CropBox. A source hash mismatch is never silently relocated.
struct PDFSourceReference: Codable, Equatable, Sendable {
    struct Rect:Codable,Equatable,Sendable {
        var x:Double;var y:Double;var width:Double;var height:Double
        var isValid:Bool { [x,y,width,height].allSatisfy(\.isFinite) && x>=0 && y>=0 && width>0 && height>0 && x+width<=1.000000001 && y+height<=1.000000001 }
    }
    var schemaVersion=1
    var path:String
    var sourceSHA256:String
    var page:Int
    var rect:Rect
    var quote:String
    var extendBlockID:String?=nil
    var isValid:Bool {
        schemaVersion==1 && !path.isEmpty && !path.hasPrefix("/") && !path.contains("\\") && !path.split(separator:"/",omittingEmptySubsequences:false).contains(where:{$0.isEmpty || $0=="." || $0==".."}) && (sourceSHA256.count==64 && sourceSHA256.allSatisfy{"0123456789abcdef".contains($0)}) && page>0 && rect.isValid && quote.utf8.count<=256*1024
    }
}

import Foundation

struct PDFWorkspaceLayer: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var name: String
    var visible: Bool
    var locked: Bool
    var order: Int
}
struct PDFWorkspaceRect: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var isValid: Bool {
        [x,y,width,height].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 && x <= 1 && y <= 1 && width <= 1 && height <= 1 && x + width <= 1.000000001 && y + height <= 1.000000001
    }
}
struct PDFWorkspaceAnnotation: Codable, Equatable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable { case ink, highlight, text }
    var id: UUID
    var layerID: UUID
    var sourceSHA256: String
    var page: Int
    var kind: Kind
    var color: String
    var width: Double
    var points: [[Double]]
    var rect: PDFWorkspaceRect
    var text: String
    var nativeInk: PDFNativeInkArchive? = nil
}
struct PDFWorkspaceEvent: Codable, Equatable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable { case layer, deleteLayer, annotation, deleteAnnotation }
    var schemaVersion = 1
    var id: UUID
    var createdAt: String
    var kind: Kind
    var layer: PDFWorkspaceLayer?
    var annotation: PDFWorkspaceAnnotation?
    var targetID: UUID?
    private(set) var instant = Date.distantPast
    enum CodingKeys: String, CodingKey { case schemaVersion, id, createdAt, kind, layer, annotation, targetID }
    static let maximumBytes = 256 * 1024

    /// Strict Foundation-only validator shared by the workspace and file manager.
    /// Future/malformed records remain untouched; no lossy repair/re-encoding.
    static func decodeValidated(_ data: Data) throws -> PDFWorkspaceEvent {
        guard data.count <= maximumBytes,
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kindName = raw["kind"] as? String, let kind = Kind(rawValue: kindName) else { throw PDFWorkspaceError.invalidRecord }
        let payload: String = kind == .layer ? "layer" : kind == .annotation ? "annotation" : "targetID"
        guard Set(raw.keys) == Set(["schemaVersion","id","createdAt","kind",payload]) else { throw PDFWorkspaceError.invalidRecord }
        if kind == .layer {
            guard let value = raw["layer"] as? [String: Any], Set(value.keys) == Set(["id","name","visible","locked","order"]) else { throw PDFWorkspaceError.invalidRecord }
        } else if kind == .annotation {
            let base=Set(["id","layerID","sourceSHA256","page","kind","color","width","points","rect","text"])
            guard let value = raw["annotation"] as? [String: Any],
                  Set(value.keys) == base || (Set(value.keys) == base.union(["nativeInk"]) && PDFNativeInkArchive.hasValidKeys(value["nativeInk"])),
                  let rect = value["rect"] as? [String: Any], Set(rect.keys) == Set(["x","y","width","height"]) else { throw PDFWorkspaceError.invalidRecord }
        }
        var event: PDFWorkspaceEvent
        do { event = try JSONDecoder().decode(Self.self, from: data) } catch { throw PDFWorkspaceError.invalidRecord }
        guard event.schemaVersion == 1, event.createdAt.hasSuffix("Z"), let date = parseDate(event.createdAt) else { throw PDFWorkspaceError.invalidRecord }
        event.instant = date
        if let layer = event.layer {
            guard !layer.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, layer.name.unicodeScalars.count <= 120, !layer.name.contains("\0"),
                  (-9_007_199_254_740_991...9_007_199_254_740_991).contains(layer.order) else { throw PDFWorkspaceError.invalidRecord }
        }
        if let mark = event.annotation {
            guard mark.sourceSHA256.count == 64, mark.sourceSHA256.allSatisfy({ "0123456789abcdef".contains($0) }),
                  (1...100000).contains(mark.page), mark.rect.isValid, mark.width.isFinite, (0.0001...0.05).contains(mark.width),
                  mark.color.count == 7, mark.color.first == "#", mark.color.dropFirst().allSatisfy({ $0.isASCII && $0.isHexDigit }),
                  mark.points.count <= 4096, (mark.kind != .ink || !mark.points.isEmpty), mark.points.allSatisfy({ $0.count == 2 && $0.allSatisfy { $0.isFinite && (0...1).contains($0) } }),
                  mark.text.unicodeScalars.count <= 10000, !mark.text.contains("\0"),
                  mark.nativeInk == nil || (mark.kind == .ink && mark.nativeInk!.isValid) else { throw PDFWorkspaceError.invalidRecord }
        }
        if var mark = event.annotation { mark.color = mark.color.uppercased(); event.annotation = mark }
        return event
    }
    static func make(layer: PDFWorkspaceLayer) throws -> Self { try create(kind: .layer, layer: layer) }
    static func make(annotation: PDFWorkspaceAnnotation) throws -> Self { try create(kind: .annotation, annotation: annotation) }
    static func deleteLayer(_ id: UUID) throws -> Self { try create(kind: .deleteLayer, targetID: id) }
    static func deleteAnnotation(_ id: UUID) throws -> Self { try create(kind: .deleteAnnotation, targetID: id) }
    private static func create(kind: Kind, layer: PDFWorkspaceLayer? = nil, annotation: PDFWorkspaceAnnotation? = nil, targetID: UUID? = nil) throws -> Self {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let event = Self(id: UUID(), createdAt: formatter.string(from: Date()), kind: kind, layer: layer, annotation: annotation, targetID: targetID)
        return try decodeValidated(event.encoded())
    }
    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(_ value: String) { stringValue = value }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(schemaVersion,forKey:Key("schemaVersion"));try c.encode(id.uuidString.lowercased(),forKey:Key("id"))
        try c.encode(createdAt,forKey:Key("createdAt"));try c.encode(kind,forKey:Key("kind"))
        if let targetID { try c.encode(targetID.uuidString.lowercased(),forKey:Key("targetID")) }
        if let layer {
            var v = c.nestedContainer(keyedBy:Key.self,forKey:Key("layer"))
            try v.encode(layer.id.uuidString.lowercased(),forKey:Key("id"));try v.encode(layer.name,forKey:Key("name"))
            try v.encode(layer.visible,forKey:Key("visible"));try v.encode(layer.locked,forKey:Key("locked"));try v.encode(layer.order,forKey:Key("order"))
        }
        if let mark = annotation {
            var v = c.nestedContainer(keyedBy:Key.self,forKey:Key("annotation"))
            try v.encode(mark.id.uuidString.lowercased(),forKey:Key("id"));try v.encode(mark.layerID.uuidString.lowercased(),forKey:Key("layerID"))
            try v.encode(mark.sourceSHA256,forKey:Key("sourceSHA256"));try v.encode(mark.page,forKey:Key("page"));try v.encode(mark.kind,forKey:Key("kind"))
            try v.encode(mark.color,forKey:Key("color"));try v.encode(mark.width,forKey:Key("width"));try v.encode(mark.points,forKey:Key("points"))
            try v.encode(mark.rect,forKey:Key("rect"));try v.encode(mark.text,forKey:Key("text"))
            try v.encodeIfPresent(mark.nativeInk,forKey:Key("nativeInk"))
        }
    }
    func encoded() throws -> Data {
        // Encode user strings directly. JSONSerialization roundtripping can
        // consume a leading U+FEFF inside NSString on some Foundation versions.
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys,.withoutEscapingSlashes]
        return try encoder.encode(self)
    }
    static func parseDate(_ value: String) -> Date? {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$"#, options: .regularExpression) != nil else { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var result = formatter.date(from: value)
        formatter.formatOptions = [.withInternetDateTime]
        if result == nil { result = formatter.date(from: value) }
        guard let result, formatter.string(from: result).prefix(19) == value.prefix(19) else { return nil }
        return result
    }
}
struct PDFWorkspaceProjection: Sendable {
    var layers: [PDFWorkspaceLayer]
    var annotations: [PDFWorkspaceAnnotation]
    var warnings: [String]
    static func project(_ records: [PDFWorkspaceEvent], warnings: [String] = []) -> Self {
        var deletedLayers = Set<UUID>(), deletedMarks = Set<UUID>(), layers: [UUID: PDFWorkspaceEvent] = [:], marks: [UUID: PDFWorkspaceEvent] = [:]
        func newer(_ a: PDFWorkspaceEvent, than b: PDFWorkspaceEvent?) -> Bool {
            guard let b else { return true }
            return a.instant > b.instant || (a.instant == b.instant && a.id.uuidString.lowercased() > b.id.uuidString.lowercased())
        }
        var unique: [UUID: PDFWorkspaceEvent] = [:], conflicts = Set<UUID>()
        for event in records {
            if let previous = unique[event.id], previous != event { conflicts.insert(event.id) }
            else { unique[event.id] = event }
        }
        for event in unique.values where !conflicts.contains(event.id) {
            switch event.kind {
            case .layer: if let layer = event.layer, newer(event, than: layers[layer.id]) { layers[layer.id] = event }
            case .annotation: if let mark = event.annotation, newer(event, than: marks[mark.id]) { marks[mark.id] = event }
            case .deleteLayer: if let id = event.targetID { deletedLayers.insert(id) }
            case .deleteAnnotation: if let id = event.targetID { deletedMarks.insert(id) }
            }
        }
        let resultLayers = layers.values.compactMap(\.layer).filter { !deletedLayers.contains($0.id) }.sorted { $0.order == $1.order ? $0.id.uuidString < $1.id.uuidString : $0.order < $1.order }
        let present = Set(resultLayers.map(\.id))
        let resultMarks = marks.values.compactMap(\.annotation).filter { !deletedMarks.contains($0.id) && present.contains($0.layerID) }.sorted { $0.id.uuidString < $1.id.uuidString }
        return Self(layers: resultLayers, annotations: resultMarks, warnings: warnings + (conflicts.isEmpty ? [] : [String(localized: "有重复标识的冲突图层记录，已跳过冲突记录；原文件保持不变。")]))
    }
}
enum PDFWorkspaceError: LocalizedError {
    case invalidRecord, unsafePath, unavailable, readUnavailable, tooLarge, staleSource, lockedLayer, backupFailed
    /// The repository shares low-level I/O errors between reads and writes.
    /// Only a read's generic unavailable error loses the save-specific wording.
    static func readingErrorDescription(_ error: Error) -> String {
        if let workspaceError = error as? PDFWorkspaceError, case .unavailable = workspaceError {
            return PDFWorkspaceError.readUnavailable.localizedDescription
        }
        return error.localizedDescription
    }
    var errorDescription: String? {
        switch self {
        case .invalidRecord: String(localized: "PDF 图层记录格式无效或来自较新版本，原记录保持不变。")
        case .unsafePath: String(localized: "请授权 PDF 所在的资料文件夹后保存图层；不支持符号链接或硬链接。")
        case .unavailable: String(localized: "PDF 图层暂不可访问，本次更改已保留，可重试保存。")
        case .readUnavailable: String(localized: "无法读取 PDF 或其图层，请确认文件完整且已下载，然后刷新重试。")
        case .tooLarge: String(localized: "PDF 或图层记录超过本机处理预算，请缩小范围后重试。")
        case .staleSource: String(localized: "原 PDF 已更新，请刷新阅读内容后再批注；已有图层不会贴到不同版本。")
        case .lockedLayer: String(localized: "该图层已隐藏、锁定或删除，请选择可编辑图层。")
        case .backupFailed: String(localized: "图层恢复副本未能保存，本次发布已停止，请检查本机空间。")
        }
    }
}

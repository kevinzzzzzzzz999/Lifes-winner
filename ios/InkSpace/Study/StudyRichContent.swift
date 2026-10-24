import Foundation

struct StudyOcclusionRegion: Codable, Equatable, Identifiable, Sendable {
    var id = UUID().uuidString.lowercased()
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    func validate() throws {
        guard (try? StudyEvent.uuid(id)) == id, [x, y, width, height].allSatisfy(\.isFinite),
              x >= 0, y >= 0, width > 0, height > 0, x + width <= 1.000000001, y + height <= 1.000000001 else { throw StudyError.invalidCard }
    }
}
struct StudyContentBlock: Codable, Equatable, Identifiable, Sendable {
    var id = UUID().uuidString.lowercased()
    var kind: String
    var text: String? = nil
    var sourcePath: String? = nil
    var regions: [StudyOcclusionRegion]? = nil
    static func text(_ text: String = "") -> Self { .init(kind: "text", text: text) }
    static func image(_ path: String) -> Self { .init(kind: "image", sourcePath: path) }
    func validate(allowRegions: Bool) throws {
        guard (try? StudyEvent.uuid(id)) == id else { throw StudyError.invalidCard }
        switch kind {
        case "text":
            guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.unicodeScalars.count <= 4000, !text.contains("\0"), sourcePath == nil, regions == nil else { throw StudyError.invalidCard }
        case "image":
            guard text == nil, let sourcePath, VaultPath.isSafeRelative(sourcePath),
                  ["png", "jpg", "jpeg"].contains((sourcePath as NSString).pathExtension.lowercased()) else { throw StudyError.invalidCard }
            if let regions {
                guard allowRegions, regions.count <= 32, Set(regions.map(\.id)).count == regions.count else { throw StudyError.invalidCard }
                try regions.forEach { try $0.validate() }
            }
        default: throw StudyError.invalidCard
        }
    }
    static func decode(_ raw: Any) throws -> [Self] {
        guard let values = raw as? [[String: Any]], values.count <= 16 else { throw StudyError.invalidCard }
        for value in values {
            guard Set(value.keys).isSubset(of: ["id", "kind", "text", "sourcePath", "regions"]) else { throw StudyError.invalidCard }
            if let rawRegions = value["regions"] {
                guard let regions = rawRegions as? [[String: Any]], regions.count <= 32,
                      regions.allSatisfy({ Set($0.keys) == Set(["id", "x", "y", "width", "height"]) }) else { throw StudyError.invalidCard }
            }
        }
        return try JSONDecoder().decode([Self].self, from: JSONSerialization.data(withJSONObject: values))
    }
}

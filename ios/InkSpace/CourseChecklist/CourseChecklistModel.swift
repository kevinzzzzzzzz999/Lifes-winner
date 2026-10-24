import Foundation
import CryptoKit
import CoreFoundation

struct CoursePoem: Codable, Identifiable, Sendable {
    let id: String
    let text: String
    let author: String
    let title: String
    let note: String
    let sourceURL: String
    static func bundled() throws -> [CoursePoem] {
        guard let url = Bundle.main.url(forResource: "poetry-rewards", withExtension: "json", subdirectory: "CourseChecklist") else { throw CourseChecklistError.catalog }
        let poems = try JSONDecoder().decode([CoursePoem].self, from: Data(contentsOf: url))
        guard !poems.isEmpty, Set(poems.map(\.id)).count == poems.count else { throw CourseChecklistError.catalog }
        return poems
    }
}

enum CourseChecklistError: LocalizedError {
    case invalid, tooLarge, path, conflict, catalog, missing, backup, rootOnly
    var errorDescription: String? {
        switch self {
        case .rootOnly: String(localized: "新清单只能保存在资料库主文件夹；旧清单仍可在原位置编辑。")
        case .invalid: String(localized: "课程清单格式不受支持或内容无效，未修改文件。")
        case .tooLarge: String(localized: "清单最多包含 1000 项，文件不能超过 1 MB。")
        case .path: String(localized: "无法访问此课程文件夹，请重新选择资料库或文件夹。")
        case .conflict: String(localized: "清单已被另一台设备修改。你的草稿仍保留，请刷新后再保存。")
        case .catalog: String(localized: "诗词资源暂时不可用，未更改完成状态。")
        case .missing: String(localized: "找不到课程清单，请刷新文件夹。")
        case .backup: String(localized: "无法保存本地备份，原清单未修改。")
        }
    }
}

struct CourseChecklistTask: Decodable, Identifiable, Sendable {
    let id: String
    let text: String
    let section: String
    let done: Bool
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
    let rewardId: String?
    let archivedAt: String?
}

struct CourseChecklistDocument: Sendable {
    static let maximumBytes = 1_048_576
    let data: Data
    let id: String
    let title: String
    let tasks: [CourseChecklistTask]
    let updatedAt: String
    private struct Header: Decodable {
        let schemaVersion: Int
        let kind: String
        let id: String
        let title: String
        let tasks: [CourseChecklistTask]
        let updatedAt: String
    }
    static func decode(_ data: Data) throws -> Self {
        guard data.count <= maximumBytes else { throw CourseChecklistError.tooLarge }
        guard let raw = try? JSONSerialization.jsonObject(with: data), validJSONNumbers(raw),
              let object = raw as? [String: Any], let rows = object["tasks"] as? [[String: Any]],
              rows.allSatisfy({ row in ["completedAt", "rewardId", "archivedAt"].allSatisfy { row[$0] == nil || row[$0] is String } }) else { throw CourseChecklistError.invalid }
        let value: Header
        do { value = try JSONDecoder().decode(Header.self, from: data) } catch { throw CourseChecklistError.invalid }
        guard value.schemaVersion == 1, value.kind == "course-checklist", UUID(uuidString: value.id) != nil,
              validText(value.title, limit: 200), validDate(value.updatedAt), value.tasks.count <= 1000,
              Set(value.tasks.map { $0.id.lowercased() }).count == value.tasks.count else { throw CourseChecklistError.invalid }
        for task in value.tasks {
            guard UUID(uuidString: task.id) != nil, validText(task.text, limit: 1000), validText(task.section, limit: 200, empty: true),
                  validDate(task.createdAt), validDate(task.updatedAt), task.completedAt.map(validDate) ?? true,
                  task.archivedAt.map(validDate) ?? true, task.rewardId.map({ validText($0, limit: 200) }) ?? true,
                  task.done || task.completedAt == nil else { throw CourseChecklistError.invalid }
        }
        return Self(data: data, id: value.id, title: value.title, tasks: value.tasks, updatedAt: value.updatedAt)
    }
    static func validText(_ text: String, limit: Int, empty: Bool = false) -> Bool {
        text.utf16.count <= limit && !text.contains("\0") && (empty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    static func validDate(_ value: String) -> Bool {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$"#, options: .regularExpression) != nil else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return formatter.string(from: date).prefix(19) == value.prefix(19) }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: value) else { return false }
        return formatter.string(from: date).prefix(19) == value.prefix(19)
    }
    private static func validJSONNumbers(_ value: Any) -> Bool {
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return true }
            let value = number.doubleValue
            return value.isFinite && (value.rounded() != value || abs(value) <= 9_007_199_254_740_991)
        }
        if let rows = value as? [Any] { return rows.allSatisfy(validJSONNumbers) }
        if let object = value as? [String: Any] { return object.values.allSatisfy(validJSONNumbers) }
        return true
    }
    static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    static func create(title: String) throws -> Self {
        try serialize(["schemaVersion": 1, "kind": "course-checklist", "id": UUID().uuidString,
                       "title": title, "tasks": [], "updatedAt": timestamp()])
    }
    private static func serialize(_ object: [String: Any]) throws -> Self {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        return try decode(data)
    }
    enum Change: Sendable {
        case add(text: String, section: String)
        case edit(id: String, text: String, section: String)
        case toggle(String), archive(String), restore(String)
    }
    func applying(_ change: Change, poems: [CoursePoem]) throws -> Self {
        guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any], var rows = object["tasks"] as? [[String: Any]] else { throw CourseChecklistError.invalid }
        let now = Self.timestamp()
        switch change {
        case .add(let text, let section):
            guard rows.count < 1000 else { throw CourseChecklistError.tooLarge }
            rows.append(["id": UUID().uuidString, "text": text, "section": section, "done": false, "createdAt": now, "updatedAt": now])
        default:
            let id: String
            switch change {
            case .edit(let target, _, _), .toggle(let target), .archive(let target), .restore(let target): id = target
            default: throw CourseChecklistError.invalid
            }
            guard let index = rows.firstIndex(where: { $0["id"] as? String == id }) else { throw CourseChecklistError.invalid }
            var row = rows[index]
            switch change {
            case .edit(_, let text, let section): row["text"] = text; row["section"] = section
            case .toggle:
                guard row["archivedAt"] == nil else { throw CourseChecklistError.invalid }
                let done = !(row["done"] as? Bool ?? false)
                row["done"] = done
                if done {
                    row["completedAt"] = now
                    if row["rewardId"] == nil {
                        guard !poems.isEmpty else { throw CourseChecklistError.catalog }
                        let seed = SHA256.hash(data: Data(id.utf8)).prefix(4).reduce(UInt64(0)) { $0 * 256 + UInt64($1) }
                        row["rewardId"] = poems[Int(seed % UInt64(poems.count))].id
                    }
                } else { row.removeValue(forKey: "completedAt") }
            case .archive: row["archivedAt"] = now
            case .restore: row.removeValue(forKey: "archivedAt")
            default: break
            }
            row["updatedAt"] = now; rows[index] = row
        }
        object["tasks"] = rows; object["updatedAt"] = now
        return try Self.serialize(object)
    }
}

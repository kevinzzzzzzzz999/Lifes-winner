import Foundation
import CoreFoundation

enum StudyError: LocalizedError {
    case invalidEvent, invalidCard, unsafePath, conflict, limit, incomplete, unavailable
    var errorDescription: String? {
        switch self {
        case .invalidEvent: String(localized: "复习记录格式无效，未写入。")
        case .invalidCard: String(localized: "请检查问题、答案和 {{挖空}} 格式。")
        case .unsafePath: String(localized: "复习文件夹不可用或路径不安全。")
        case .conflict: String(localized: "复习记录正在变化，请刷新后重试。")
        case .limit: String(localized: "复习记录超出支持的大小或数量，请分开管理。")
        case .incomplete: String(localized: "部分复习记录未能读取，已暂停保存。请恢复文件后刷新；草稿仍保留。")
        case .unavailable: String(localized: "请先打开已保存的白板。")
        }
    }
}
enum StudyGrade: String, Codable, CaseIterable, Sendable { case again, hard, good, easy }
struct StudyCardPayload: Codable, Equatable, Sendable {
    var question: String
    var answer: String
    var mode: String
    var answerMode: String = "custom"
    var questionBlocks: [StudyContentBlock]? = nil
    var answerBlocks: [StudyContentBlock]? = nil
    var hasRichContent: Bool { !(questionBlocks?.isEmpty ?? true) || !(answerBlocks?.isEmpty ?? true) || mode == "occlusion" }
    var imagePaths: [String] { Array(Set(((questionBlocks ?? []) + (answerBlocks ?? [])).compactMap(\.sourcePath))).sorted() }
    func validate() throws {
        guard ["qa", "cloze", "occlusion"].contains(mode), ["node", "custom"].contains(answerMode),
              question.unicodeScalars.count <= 4000, answer.unicodeScalars.count <= 20000,
              !question.contains("\0"), !answer.contains("\0"), !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StudyError.invalidCard }
        let front = questionBlocks ?? [], back = answerBlocks ?? []
        guard front.count <= 16, back.count <= 16,
              Set(front.map(\.id)).count == front.count, Set(back.map(\.id)).count == back.count else { throw StudyError.invalidCard }
        try front.forEach { try $0.validate(allowRegions: mode == "occlusion") }
        try back.forEach { try $0.validate(allowRegions: false) }
        if mode == "cloze" {
            guard answerMode == "custom", questionBlocks == nil, answerBlocks == nil else { throw StudyError.invalidCard }
            _ = try StudyCloze.front(question)
        } else if mode == "occlusion" {
            guard answerMode == "custom", front.contains(where: { $0.kind == "image" && !($0.regions?.isEmpty ?? true) }),
                  !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !back.isEmpty else { throw StudyError.invalidCard }
        } else if answerMode == "custom", answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, back.isEmpty { throw StudyError.invalidCard }
    }
}
enum StudyCloze {
    static func front(_ text: String) throws -> String {
        var rest = text[...], output = "", found = false
        while let opening = rest.range(of: "{{") {
            let prefix = rest[..<opening.lowerBound]
            guard !prefix.contains("}}") else { throw StudyError.invalidCard }
            let tail = rest[opening.upperBound...]
            guard let closing = tail.range(of: "}}") else { throw StudyError.invalidCard }
            let hidden = tail[..<closing.lowerBound]
            guard !hidden.contains("{{"), !hidden.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StudyError.invalidCard }
            output += prefix + "[…]"; rest = tail[closing.upperBound...]; found = true
        }
        guard found, !rest.contains("}}") else { throw StudyError.invalidCard }
        return output + rest
    }
    static func revealed(_ text: String) -> String { text.replacingOccurrences(of: "{{", with: "").replacingOccurrences(of: "}}", with: "") }
}
enum StudyTime {
    static func parse(_ value: String) throws -> Date {
        let pattern = #"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(Z|[+-][0-9]{2}:[0-9]{2})$"#
        let regex = try NSRegularExpression(pattern: pattern)
        guard let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { throw StudyError.invalidEvent }
        func part(_ n: Int) -> String { Range(match.range(at: n), in: value).map { String(value[$0]) } ?? "" }
        let year = Int(part(1))!, month = Int(part(2))!, day = Int(part(3))!, hour = Int(part(4))!, minute = Int(part(5))!, second = Int(part(6))!
        guard (1...9998).contains(year), (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 60 else { throw StudyError.invalidEvent }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
        guard let date = calendar.date(from: c) else { throw StudyError.invalidEvent }
        let actual = calendar.dateComponents([.year,.month,.day,.hour,.minute,.second], from: date)
        guard actual == c else { throw StudyError.invalidEvent }
        let fraction = part(7), ms = Int(fraction.padding(toLength: 3, withPad: "0", startingAt: 0)) ?? 0
        let zone = part(8)
        var offset = 0
        if zone != "Z" {
            let pieces = zone.dropFirst().split(separator: ":"); let hours = Int(pieces[0])!, minutes = Int(pieces[1])!
            guard hours <= 23, minutes <= 59 else { throw StudyError.invalidEvent }
            offset = (hours * 3600 + minutes * 60) * (zone.hasPrefix("-") ? -1 : 1)
        }
        return date.addingTimeInterval(Double(ms) / 1000 - Double(offset))
    }
    static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
struct StudyEvent: Codable, Equatable, Sendable {
    var schemaVersion = 1
    var id: String
    var deviceID: String
    var createdAt: String
    var boardID: String
    var itemID: String
    var kind: String
    var card: StudyCardPayload?
    var grade: StudyGrade?
    var date: Date { try! StudyTime.parse(createdAt) }
    static func uuid(_ value: String) throws -> String {
        guard value.count == 36, UUID(uuidString: value) != nil else { throw StudyError.invalidEvent }
        return value.lowercased()
    }
    func normalized() throws -> StudyEvent {
        var event = self
        guard schemaVersion == 1, ["card", "grade", "delete"].contains(kind) else { throw StudyError.invalidEvent }
        event.id = try Self.uuid(id); event.deviceID = try Self.uuid(deviceID); event.boardID = try Self.uuid(boardID); event.itemID = try Self.uuid(itemID)
        event.createdAt = StudyTime.string(try StudyTime.parse(createdAt))
        switch kind {
        case "card": guard let card, grade == nil else { throw StudyError.invalidEvent }; try card.validate()
        case "grade": guard card == nil, grade != nil else { throw StudyError.invalidEvent }
        default: guard card == nil, grade == nil else { throw StudyError.invalidEvent }
        }
        return event
    }
    static func decode(_ data: Data) throws -> StudyEvent {
        guard data.count <= 65536, String(data: data, encoding: .utf8) != nil else { throw StudyError.limit }
        try rejectUnpairedSurrogates(data)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys).isSubset(of: ["schemaVersion","id","deviceID","createdAt","boardID","itemID","kind","card","grade"]),
              let version = object["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let id = object["id"] as? String, let device = object["deviceID"] as? String, let board = object["boardID"] as? String,
              let item = object["itemID"] as? String, let time = object["createdAt"] as? String, let kind = object["kind"] as? String else { throw StudyError.invalidEvent }
        var card: StudyCardPayload?, grade: StudyGrade?
        if let value = object["card"] {
            guard let c = value as? [String: Any], Set(c.keys).isSubset(of: ["question","answer","mode","answerMode","questionBlocks","answerBlocks"]),
                  let question = c["question"] as? String, let answer = c["answer"] as? String, let mode = c["mode"] as? String,
                  c["answerMode"] == nil || c["answerMode"] is String else { throw StudyError.invalidCard }
            card = StudyCardPayload(question: question, answer: answer, mode: mode, answerMode: c["answerMode"] as? String ?? "custom",
                questionBlocks: try c["questionBlocks"].map { try StudyContentBlock.decode($0) },
                answerBlocks: try c["answerBlocks"].map { try StudyContentBlock.decode($0) })
        }
        if let value = object["grade"] { guard let s = value as? String, let g = StudyGrade(rawValue: s) else { throw StudyError.invalidEvent }; grade = g }
        return try StudyEvent(id: id, deviceID: device, createdAt: time, boardID: board, itemID: item, kind: kind, card: card, grade: grade).normalized()
    }
    func data() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let bytes = try encoder.encode(normalized()); guard bytes.count <= 65536 else { throw StudyError.limit }; return bytes
    }
    private static func rejectUnpairedSurrogates(_ data: Data) throws {
        let bytes = Array(data); var i = 0
        while i < bytes.count {
            if bytes[i] != 92 { i += 1; continue }
            guard i + 1 < bytes.count else { throw StudyError.invalidEvent }
            if bytes[i+1] != 117 { i += 2; continue }
            guard i+6 <= bytes.count, let n = Int(String(bytes: bytes[(i+2)..<(i+6)], encoding: .ascii) ?? "", radix: 16) else { throw StudyError.invalidEvent }
            if (0xD800...0xDBFF).contains(n) {
                guard i+12 <= bytes.count, bytes[i+6] == 92, bytes[i+7] == 117,
                      let low = Int(String(bytes: bytes[(i+8)..<(i+12)], encoding: .ascii) ?? "", radix: 16), (0xDC00...0xDFFF).contains(low) else { throw StudyError.invalidEvent }
                i += 12
            } else { guard !(0xDC00...0xDFFF).contains(n) else { throw StudyError.invalidEvent }; i += 6 }
        }
    }
}
struct StudyCardState: Codable, Equatable, Identifiable, Sendable {
    var itemID: String
    var eventID: String
    var card: StudyCardPayload
    var dueAt: String
    var intervalDays: Int
    var reviewCount: Int
    var lastGrade: StudyGrade?
    var id: String { itemID }
}
enum StudyProjection {
    static func cards(_ input: [StudyEvent]) throws -> [StudyCardState] {
        let normalized: [StudyEvent] = try input.map { try $0.normalized() }
        let dated: [(StudyEvent, Date)] = normalized.map { ($0, $0.date) }
        let events: [StudyEvent] = dated.sorted { a, b in
            if a.1 == b.1 { return a.0.id < b.0.id }; return a.1 < b.1
        }.map { $0.0 }
        var seen: [String: StudyEvent] = [:], cards: [String: StudyCardState] = [:]
        for event in events {
            if let old = seen[event.id] { guard old == event else { throw StudyError.conflict }; continue }
            seen[event.id] = event
            switch event.kind {
            case "delete": cards.removeValue(forKey: event.itemID)
            case "card":
                var state = cards[event.itemID] ?? StudyCardState(itemID: event.itemID, eventID: event.id, card: event.card!, dueAt: event.createdAt, intervalDays: 0, reviewCount: 0, lastGrade: nil)
                state.card = event.card!; state.eventID = event.id; cards[event.itemID] = state
            case "grade":
                guard var state = cards[event.itemID], let grade = event.grade else { continue }
                let days: Int
                switch grade {
                case .again: days = 0
                case .hard: days = max(1, Int((Double(state.intervalDays) * 1.2).rounded()))
                case .good: days = state.intervalDays == 0 ? 1 : max(1, Int((Double(state.intervalDays) * 2.5).rounded()))
                case .easy: days = state.intervalDays == 0 ? 4 : max(4, Int((Double(state.intervalDays) * 3.5).rounded()))
                }
                state.intervalDays = min(365, days); state.reviewCount += 1; state.lastGrade = grade; state.eventID = event.id
                state.dueAt = StudyTime.string(event.date.addingTimeInterval(grade == .again ? 600 : Double(state.intervalDays) * 86400))
                cards[event.itemID] = state
            default: break
            }
        }
        return cards.values.sorted { $0.itemID < $1.itemID }
    }
}

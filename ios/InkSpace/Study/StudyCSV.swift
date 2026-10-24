import Foundation
import CryptoKit

enum StudyCSVError: LocalizedError {
    case encoding, syntax, limit, target, collision, save
    var errorDescription: String? { switch self {
    case .encoding: String(localized: "请选择 UTF-8 编码的 CSV 或 TSV 文件。")
    case .syntax: String(localized: "引号格式不完整，文件未导入。请修正后重新选择。")
    case .limit: String(localized: "每次最多 500 条、2 MiB；问题最多 4000 字符，答案最多 20000 字符。")
    case .target: String(localized: "接收白板已改变或尚未保存，已暂停导入。已完成的内容保留。")
    case .collision: String(localized: "对应节点内容已改变，已暂停导入以保护现有笔记。")
    case .save: String(localized: "节点或卡片未全部保存，已完成的内容保留；可重试剩余条目。")
    } }
}
struct StudyCSVPair: Hashable, Codable, Sendable { var question: String; var answer: String }
struct StudyCSVRow: Identifiable, Sendable {
    let id: Int
    let line: Int
    let cells: [String]
    let pair: StudyCSVPair?
    let error: String?
}
struct StudyCSVExport: Sendable { let data: Data; let escapedCells: Int }
enum StudyCSV {
    static let maximumBytes = 2 * 1024 * 1024
    static let spaces = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").trimmingCharacters(in: spaces).precomposedStringWithCanonicalMapping
    }
    static func pair(_ question: String, _ answer: String) -> StudyCSVPair { .init(question: normalized(question), answer: normalized(answer)) }
    static func key(_ pair: StudyCSVPair) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: [pair.question, pair.answer], options: [.withoutEscapingSlashes]), encoding: .utf8)!
    }
    static func stableID(boardID: UUID, pair: StudyCSVPair, role: String, generation: Int = 0) -> UUID {
        let input = "inkspace.study.csv.v1\n" + boardID.uuidString.lowercased() + "\n" + role + "\n" + key(pair) + (generation > 0 ? "\ngeneration:" + String(generation) : "")
        var bytes = Array(SHA256.hash(data: Data(input.utf8)).prefix(16)); bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80
        return UUID(uuid: (bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
    }
    static func parse(_ data: Data, delimiter: String, header: Bool) throws -> [StudyCSVRow] {
        guard data.count <= maximumBytes else { throw StudyCSVError.limit }
        guard var text = String(data: data, encoding: .utf8) else { throw StudyCSVError.encoding }
        guard delimiter == "," || delimiter == "\t" else { throw StudyCSVError.syntax }
        if text.first == "\u{FEFF}" { text.removeFirst() }
        text = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let chars = Array(text.unicodeScalars), separator = delimiter.unicodeScalars.first!
        var records: [(Int,[String])] = [], fields: [String] = [], cell = "", state = 0, touched = false, line = 1, startLine = 1, index = 0
        func endRecord() throws {
            if touched || !fields.isEmpty || !cell.isEmpty { fields.append(cell); records.append((startLine, fields)) }
            fields = []; cell = ""; touched = false; state = 0
            guard records.count <= 500 + (header ? 1 : 0) else { throw StudyCSVError.limit }
        }
        while index < chars.count {
            let c = chars[index]
            if state == 1 {
                if c == "\"" { if index+1 < chars.count, chars[index+1] == "\"" { cell.append("\""); index += 1 } else { state = 2 } }
                else { cell.unicodeScalars.append(c); if c == "\n" { line += 1 } }
            } else if c == separator {
                fields.append(cell); cell = ""; state = 0; touched = true
            } else if c == "\n" {
                try endRecord(); line += 1; startLine = line
            } else if state == 2 { throw StudyCSVError.syntax }
            else if c == "\"" { guard cell.isEmpty else { throw StudyCSVError.syntax }; state = 1; touched = true }
            else { cell.unicodeScalars.append(c); touched = true }
            index += 1
        }
        guard state != 1 else { throw StudyCSVError.syntax }; try endRecord()
        if header, !records.isEmpty { records.removeFirst() }
        return records.enumerated().map { index, record in
            let cells = record.1
            guard cells.count == 2 else { return .init(id:index,line:record.0,cells:cells,pair:nil,error:String(localized:"每条必须恰好包含问题和答案两列。")) }
            let pair = pair(cells[0],cells[1])
            guard !pair.question.isEmpty, !pair.answer.isEmpty, !pair.question.contains("\0"), !pair.answer.contains("\0"), pair.question.unicodeScalars.count <= 4000, pair.answer.unicodeScalars.count <= 20000 else {
                return .init(id:index,line:record.0,cells:cells,pair:nil,error:String(localized:"问题和答案不能为空，且不能超过字符上限。"))
            }
            let uuid = "00000000-0000-4000-8000-000000000000"
            let event: [String:Any] = ["schemaVersion":1,"id":uuid,"deviceID":uuid,"boardID":uuid,"itemID":uuid,"createdAt":"2026-01-01T00:00:00.000Z","kind":"card","card":["question":pair.question,"answer":pair.answer,"mode":"qa","answerMode":"custom"]]
            if (try? JSONSerialization.data(withJSONObject:event,options:[.withoutEscapingSlashes]).count) ?? Int.max > 65536 {
                return .init(id:index,line:record.0,cells:cells,pair:nil,error:String(localized:"单张卡片编码超过 64 KiB，请缩短内容。"))
            }
            return .init(id:index,line:record.0,cells:cells,pair:pair,error:nil)
        }
    }
    static func export(_ pairs: [StudyCSVPair], delimiter: String, formulaProtection: Bool = false) throws -> StudyCSVExport {
        guard pairs.count <= 500, delimiter == "," || delimiter == "\t" else { throw StudyCSVError.limit }
        var escaped = 0
        func cell(_ original: String) -> String {
            let first = original.unicodeScalars.first
            let trimmed = original.trimmingCharacters(in: spaces)
            let dangerous = first == "\t" || first == "\r" || first == "\n" || trimmed.first.map { "=+-@".contains($0) } == true
            let text: String
            if dangerous && formulaProtection { escaped += 1; text = "'" + original } else { text = original }
            return "\"" + text.replacingOccurrences(of:"\"",with:"\"\"").replacingOccurrences(of:"\r\n",with:"\n").replacingOccurrences(of:"\r",with:"\n").replacingOccurrences(of:"\n",with:"\r\n") + "\""
        }
        let text = "\u{FEFF}" + pairs.map { cell($0.question) + delimiter + cell($0.answer) }.joined(separator:"\r\n") + (pairs.isEmpty ? "" : "\r\n")
        let data = Data(text.utf8); guard data.count <= maximumBytes else { throw StudyCSVError.limit }
        return .init(data:data,escapedCells:escaped)
    }
}

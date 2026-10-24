import Foundation

struct NoteOutlineNode: Equatable { var title: String; var parent: Int? }
enum NoteOutlineError: LocalizedError {
    case format(Int), capacity, empty, graph, title
    var errorDescription: String? {
        switch self {
        case .format(let line): String(localized: "第 \(line) 行不是支持的标题／列表层级。仅支持 # 标题、- 列表（每层 2 空格），不支持正文或代码块；原文仍保留。")
        case .capacity: String(localized: "节点纲要限 UTF-8 1 MiB、500 个节点和 12 层；请拆分后再导入。")
        case .empty: String(localized: "没有可转换的标题或列表节点。")
        case .graph: String(localized: "此图包含环、多父节点或无效连线，不能无损表示为树形纲要。请使用 PDF 或原生备份。")
        case .title: String(localized: "节点标题为空、超过 2000 字符或含换行，不能直接转为 Markdown 纲要。请调整标题或使用 PDF。")
        }
    }
}
enum NoteOutline {
    static func parse(_ data: Data) throws -> [NoteOutlineNode] {
        guard data.count <= 1_048_576, let raw = String(data: data, encoding: .utf8), !raw.contains("\0") else { throw NoteOutlineError.capacity }
        let text = raw.hasPrefix("\u{feff}") ? String(raw.dropFirst()) : raw
        var nodes: [NoteOutlineNode] = [], headings: [(level: Int, index: Int)] = [], lists: [(indent: Int, index: Int)] = []
        var depths: [Int] = []
        for (lineNumber, rawLine) in text.components(separatedBy: .newlines).enumerated() {
            if rawLine.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            let spaces = rawLine.prefix { $0 == " " }.count
            let line = String(rawLine.dropFirst(spaces))
            var title: String; var parent: Int?
            let hashes = line.prefix { $0 == "#" }.count
            if spaces == 0, (1...6).contains(hashes), line.dropFirst(hashes).first == " " {
                title = String(line.dropFirst(hashes + 1)).replacingOccurrences(of: "[ \t]+#+[ \t]*$", with: "", options: .regularExpression); lists = []
                while let last = headings.last, last.level >= hashes { headings.removeLast() }
                parent = headings.last?.index
                headings.append((hashes, nodes.count))
            } else if let marker = line.range(of: "^(?:[-+*]|[0-9]+[.)]) +", options: .regularExpression), spaces % 2 == 0 {
                let indent = spaces / 2
                while let last = lists.last, last.indent >= indent { lists.removeLast() }
                if indent > 0, lists.last?.indent != indent - 1 { throw NoteOutlineError.format(lineNumber + 1) }
                parent = lists.last?.index ?? headings.last?.index
                title = String(line[marker.upperBound...]); lists.append((indent, nodes.count))
            } else { throw NoteOutlineError.format(lineNumber + 1) }
            title = unescape(title.trimmingCharacters(in: .whitespaces))
            try validateTitle(title)
            let depth = parent.map { depths[$0] + 1 } ?? 1
            guard depth <= 12, nodes.count < 500 else { throw NoteOutlineError.capacity }
            nodes.append(.init(title: title, parent: parent)); depths.append(depth)
        }
        guard !nodes.isEmpty else { throw NoteOutlineError.empty }
        return nodes
    }
    static func encode(titles: [String], edges: [(Int, Int)]) throws -> Data {
        guard !titles.isEmpty else { throw NoteOutlineError.empty }
        guard titles.count <= 500 else { throw NoteOutlineError.capacity }
        var children = Array(repeating: [Int](), count: titles.count), parents = Array(repeating: 0, count: titles.count)
        for title in titles { try validateTitle(title) }
        var unique = Set<String>()
        for (from, to) in edges {
            guard titles.indices.contains(from), titles.indices.contains(to), from != to,
                  unique.insert("\(from)-\(to)").inserted else { throw NoteOutlineError.graph }
            parents[to] += 1; guard parents[to] <= 1 else { throw NoteOutlineError.graph }; children[from].append(to)
        }
        var seen = Set<Int>(), lines: [String] = []
        func visit(_ index: Int, depth: Int) throws {
            guard depth < 12, seen.insert(index).inserted else { throw NoteOutlineError.graph }
            lines.append(String(repeating: "  ", count: depth) + "- " + escape(titles[index]))
            for child in children[index] { try visit(child, depth: depth + 1) }
        }
        for index in titles.indices where parents[index] == 0 { try visit(index, depth: 0) }
        guard seen.count == titles.count else { throw NoteOutlineError.graph }
        let data = Data((lines.joined(separator: "\n") + "\n").utf8)
        guard data.count <= 1_048_576 else { throw NoteOutlineError.capacity }
        return data
    }
    private static func validateTitle(_ title: String) throws {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty, title.unicodeScalars.count <= 2000, title.utf8.count <= 8000,
              !title.contains("\n"), !title.contains("\r"), !title.contains("\0"), !title.contains("\t") else { throw NoteOutlineError.title }
    }
    private static let punctuation = CharacterSet(charactersIn: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
    private static func escape(_ text: String) -> String { text.unicodeScalars.map { punctuation.contains($0) ? "\\" + String($0) : String($0) }.joined() }
    private static func unescape(_ text: String) -> String {
        let chars = Array(text); var result = "", index = 0
        while index < chars.count {
            if chars[index] == "\\", index + 1 < chars.count, chars[index + 1].unicodeScalars.allSatisfy({ punctuation.contains($0) }) { index += 1 }
            result.append(chars[index]); index += 1
        }
        return result
    }
}

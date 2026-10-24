import Foundation

/// Mirrors the app's local-image policy. URLs are never fetched. Code samples
/// do not become dependencies; both reference-style and wiki images are kept.
enum BackupMarkdownReferences {
    private struct Reference { let range: NSRange; let href: String; let wiki: Bool }
    static func images(in text: String, sourcePath: String) throws -> [String] {
        let refs = try references(text)
        guard refs.count <= 128 else { throw BoardBackupError.limit }
        return Array(Set(refs.compactMap { normalize($0.href, sourcePath: sourcePath, wiki: $0.wiki) })).sorted()
    }
    static func relocateRootImages(in text: String, sourcePath: String, prefix: String) throws -> String {
        let result = NSMutableString(string: text)
        for ref in try references(text).sorted(by: { $0.range.location > $1.range.location }) {
            guard ref.wiki || ref.href.hasPrefix("/"), let path = normalize(ref.href, sourcePath: sourcePath, wiki: ref.wiki) else { continue }
            let new = prefix + path
            result.replaceCharacters(in: ref.range, with: ref.wiki ? new : "/" + new.replacingOccurrences(of: " ", with: "%20"))
        }
        return result as String
    }
    private static func references(_ text: String) throws -> [Reference] {
        guard text.utf8.count <= 2 * 1024 * 1024 else { throw BoardBackupError.limit }
        let masked = NSMutableString(string: text)
        func hide(_ pattern: String) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else { return }
            for match in regex.matches(in: masked as String, range: NSRange(location: 0, length: masked.length)).reversed() {
                masked.replaceCharacters(in: match.range, with: String(repeating: " ", count: match.range.length))
            }
        }
        hide("(?ms)^ {0,3}(`{3,}|~{3,})[^\\n]*\\n.*?^ {0,3}\\1[^\\n]*$")
        hide("(`+)[^`\\n]*\\1")
        let raw = masked as String, ns = raw as NSString
        var refs: [Reference] = [], imageLabels = Set<String>()
        let wiki = try NSRegularExpression(pattern: "!\\[\\[([^\\]\\n|]+)(?:\\|[^\\]\\n]*)?\\]\\]")
        for m in wiki.matches(in: raw, range: NSRange(location: 0, length: ns.length)) {
            refs.append(.init(range: m.range(at: 1), href: ns.substring(with: m.range(at: 1)), wiki: true))
        }
        // Balanced delimiters permit local names such as chart (draft).png.
        func escaped(_ position: Int) -> Bool {
            var at = position - 1, count = 0
            while at >= 0 && ns.character(at: at) == 92 { count += 1; at -= 1 }; return count % 2 == 1
        }
        func closing(from start: Int, open: unichar, close: unichar) -> Int? {
            var depth = 1, at = start + 1
            while at < ns.length {
                let c = ns.character(at: at)
                if c == 10 { return nil }
                if !escaped(at) { if c == open { depth += 1 }; if c == close { depth -= 1; if depth == 0 { return at } } }
                at += 1
            }; return nil
        }
        var at = 0
        while at + 2 < ns.length {
            defer { at += 1 }
            guard ns.character(at: at) == 33, ns.character(at: at+1) == 91, ns.character(at: at+2) != 91,
                  !escaped(at), let end = closing(from: at+1, open: 91, close: 93) else { continue }
            let label = ns.substring(with: NSRange(location: at+2, length: end-at-2)).lowercased()
            let next = end + 1
            if next < ns.length, ns.character(at: next) == 40, let last = closing(from: next, open: 40, close: 41) {
                var begin = next + 1; while begin < last && [9, 32].contains(ns.character(at: begin)) { begin += 1 }
                var finish = last
                if begin < last && ns.character(at: begin) == 60 {
                    begin += 1; let tail = ns.range(of: ">", options: [], range: NSRange(location: begin, length: last-begin)); finish = tail.location == NSNotFound ? begin : tail.location
                } else {
                    // A whitespace + quote starts an optional Markdown title.
                    let part = ns.substring(with: NSRange(location: begin, length: last-begin))
                    if let title = part.range(of: #"\s+["']"#, options: .regularExpression) { finish = begin + (part as NSString).range(of: String(part[title])).location }
                    while finish > begin && [9, 32].contains(ns.character(at: finish-1)) { finish -= 1 }
                }
                if finish > begin { refs.append(.init(range: NSRange(location: begin, length: finish-begin), href: ns.substring(with: NSRange(location: begin, length: finish-begin)), wiki: false)) }
                at = last
            } else if next < ns.length, ns.character(at: next) == 91, let last = closing(from: next, open: 91, close: 93) {
                let name = ns.substring(with: NSRange(location: next+1, length: last-next-1)); imageLabels.insert(name.isEmpty ? label : name.lowercased()); at = last
            } else { imageLabels.insert(label); at = end }
        }
        let definitions = try NSRegularExpression(pattern: #"(?m)^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s]+))"#)
        for match in definitions.matches(in: raw, range: NSRange(location: 0, length: ns.length)) {
            if imageLabels.contains(ns.substring(with: match.range(at: 1)).lowercased()) {
                let range = match.range(at: 2).location == NSNotFound ? match.range(at: 3) : match.range(at: 2)
                refs.append(.init(range: range, href: ns.substring(with: range), wiki: false))
            }
        }
        return refs
    }
    private static func normalize(_ raw: String, sourcePath: String, wiki: Bool) -> String? {
        let href = raw.replacingOccurrences(of: "\\(", with: "(").replacingOccurrences(of: "\\)", with: ")")
        guard let decoded = href.removingPercentEncoding, !decoded.contains(":"), !decoded.contains("\\"),
              !decoded.contains("?"), decoded.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        let path = String(decoded.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0])
        var parts = wiki || path.hasPrefix("/") ? [] : sourcePath.split(separator: "/").dropLast().map(String.init)
        for part in path.split(separator: "/") {
            if part == "." { continue }; if part == ".." { guard !parts.isEmpty else { return nil }; parts.removeLast() }
            else { parts.append(String(part)) }
        }
        let result = parts.joined(separator: "/")
        return VaultPath.isSafeRelative(result) ? result : nil
    }
}

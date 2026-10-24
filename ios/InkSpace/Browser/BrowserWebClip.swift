import Foundation

/// Schema-1 browser cards remain ordinary text items with a future-safe format.
/// No page HTML, cookies or browsing history enter the board document.
enum BoardWebCardContent {
    static func safeURL(_ raw: String?) -> URL? {
        guard let raw else { return nil }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count <= 8192, !text.contains("\\"),
              !text.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              text.range(of: "%[01][0-9a-f]|%7f", options: .regularExpression.union(.caseInsensitive)) == nil,
              let components = URLComponents(string: text), ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.user == nil, components.password == nil, !(components.host ?? "").isEmpty,
              let url = components.url else { return nil }
        return url
    }
    static func isCard(_ item: BoardItem) -> Bool { item.kind == .text && item.textFormat == "web" }
    static func makeItem(url: URL, title: String, center: CGPoint, canvasSize: CGSize) -> BoardItem? {
        guard let safe = safeURL(url.absoluteString) else { return nil }
        let width = min(720.0, canvasSize.width), height = min(560.0, canvasSize.height)
        return BoardItem(kind: .text, x: max(0, min(center.x - width / 2, canvasSize.width - width)),
                         y: max(0, min(center.y - height / 2, canvasSize.height - height)), width: width, height: height,
                         title: title.isEmpty ? safe.host ?? String(localized: "网页") : String(title.prefix(512)),
                         text: safe.absoluteString, textFormat: "web", url: safe.absoluteString)
    }
    static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
    }
    static func frameHTML(_ url: URL) -> String {
        // A subframe deliberately preserves X-Frame-Options / frame-ancestors.
        // Never replace this wrapper with a top-level remote navigation.
        """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:white}iframe{display:block}</style></head><body><iframe title="Web page" src="\(escape(url.absoluteString))" sandbox="allow-scripts allow-forms allow-same-origin" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe></body></html>
        """
    }
}

/// Inert text parsing only: no HTML renderer or resource loading is used.
@MainActor enum BoardTextWebLinks {
    struct Link { let range: NSRange; let url: URL }
    static func links(text: String, html: String?) -> [Link] {
        let source = text as NSString, full = NSRange(location: 0, length: source.length)
        guard full.length <= 100_000 else { return [] }
        var result: [Link] = []
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            for match in detector.matches(in: text, range: full) {
                if let url = BoardWebCardContent.safeURL(match.url?.absoluteString) { result.append(Link(range: match.range, url: url)) }
            }
        }
        if let html, html.utf8.count <= 300_000,
           let expression = try? NSRegularExpression(pattern: #"<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)</a>"#, options: .caseInsensitive) {
            let htmlSource = html as NSString
            for match in expression.matches(in: html, range: NSRange(location: 0, length: htmlSource.length)).prefix(128) {
                let address = entities(htmlSource.substring(with: match.range(at: 1)))
                let label = entities(htmlSource.substring(with: match.range(at: 2)).replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression))
                guard !label.isEmpty, let url = BoardWebCardContent.safeURL(address) else { continue }
                // Repeated labels map in source order and never overwrite an earlier link.
                var search = full
                while search.length > 0 {
                    let range = source.range(of: label, options: [], range: search)
                    if range.location == NSNotFound { break }
                    if !result.contains(where: { NSIntersectionRange($0.range, range).length > 0 }) { result.append(Link(range: range, url: url)); break }
                    let next = NSMaxRange(range); search = NSRange(location: next, length: source.length - next)
                }
            }
        }
        return result.sorted { $0.range.location < $1.range.location }
    }
    static func richHTML(text: String, links: [Link]) -> String {
        let source = text as NSString; var cursor = 0; var html = ""
        for link in links.sorted(by: { $0.range.location < $1.range.location }) where link.range.location >= cursor && NSMaxRange(link.range) <= source.length {
            html += BoardWebCardContent.escape(source.substring(with: NSRange(location: cursor, length: link.range.location - cursor)))
            html += "<a href=\"\(BoardWebCardContent.escape(link.url.absoluteString))\">\(BoardWebCardContent.escape(source.substring(with: link.range)))</a>"
            cursor = NSMaxRange(link.range)
        }
        html += BoardWebCardContent.escape(source.substring(from: cursor))
        return "<p>" + html.replacingOccurrences(of: "\n", with: "<br>") + "</p>"
    }
    private static func entities(_ value: String) -> String {
        value.replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&nbsp;", with: " ").replacingOccurrences(of: "&amp;", with: "&")
    }
}

/// Shared, versioned interchange format. It contains only the user-selected
/// quotation, page title, and source URL; never cookies, credentials, or HTML.
struct BrowserWebClip: Codable {
    let format: String
    let version: Int
    let title: String
    let url: URL
    let text: String?

    static func read(from file: URL) throws -> BrowserWebClip {
        let accessing = file.startAccessingSecurityScopedResource()
        defer { if accessing { file.stopAccessingSecurityScopedResource() } }
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= 512_000 else {
            throw BrowserExtensionFailure.invalid(String(localized: "剪藏文件过大或不是普通文件。"))
        }
        let clip = try JSONDecoder().decode(BrowserWebClip.self, from: Data(contentsOf: file))
        guard clip.format == "inkspace.webclip", clip.version == 1,
              EmbeddedBrowserTab.isWebURL(clip.url), clip.title.count <= 500, (clip.text?.count ?? 0) <= 50_000 else {
            throw BrowserExtensionFailure.invalid(String(localized: "不是有效的人生赢家剪藏文件。"))
        }
        return clip
    }
}

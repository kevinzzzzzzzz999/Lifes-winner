import Foundation

/// Strict timings prevent accidentally changing a transcript into invented subtitles.
enum MediaCaptionImporter {
    static func load(_ url: URL, fallback: ClosedRange<Double>, duration: Double) async throws -> [MediaCaption] {
        guard ["srt", "vtt", "txt"].contains(url.pathExtension.lowercased()) else { throw MediaEditError.unsupported }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let bytes = try await Task.detached(priority: .userInitiated) {
            var coordination: NSError?, failure: Error?, result: Data?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordination) { readable in
                do {
                    let size = try readable.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 4 * 1024 * 1024 else { throw MediaEditError.invalidProject }
                    result = try Data(contentsOf: readable)
                } catch { failure = error }
            }
            if let coordination { throw coordination }; if let failure { throw failure }
            guard let result, result.count <= 4 * 1024 * 1024 else { throw MediaEditError.invalidProject }
            return result
        }.value
        try Task.checkCancellation()
        guard let text = String(data: bytes, encoding: .utf8) else { throw MediaEditError.exportFailed("Subtitles must use UTF-8 text.") }
        return try parse(text, fileExtension: url.pathExtension.lowercased(), fallback: fallback, duration: duration)
    }
    static func parse(_ text: String, fileExtension: String, fallback: ClosedRange<Double>, duration: Double) throws -> [MediaCaption] {
        let normalized = text.replacingOccurrences(of: "\u{FEFF}", with: "").replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        if !normalized.contains("-->") {
            let value = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
            guard fileExtension == "txt", !value.isEmpty, value.count <= 1000,
                  fallback.lowerBound >= 0, fallback.upperBound > fallback.lowerBound, fallback.upperBound <= duration else { throw MediaEditError.invalidProject }
            return [MediaCaption(start: fallback.lowerBound, end: fallback.upperBound, text: value)]
        }
        var cues: [MediaCaption] = [], index = 0
        while index < lines.count {
            let line = lines[index].trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("WEBVTT") { index += 1; continue }
            if line.hasPrefix("NOTE") || line == "STYLE" || line == "REGION" {
                while index < lines.count && !lines[index].isEmpty { index += 1 }; continue
            }
            if !line.contains("-->") {
                // Cue identifiers (including SRT sequence numbers) occupy one line.
                guard index + 1 < lines.count, lines[index + 1].contains("-->") else { throw MediaEditError.invalidProject }
                index += 1; continue
            }
            let pieces = line.components(separatedBy: "-->")
            guard pieces.count == 2, let start = timestamp(pieces[0].trimmingCharacters(in: .whitespaces)) else { throw MediaEditError.invalidProject }
            let tail = pieces[1].trimmingCharacters(in: .whitespaces).split(maxSplits: 1, whereSeparator: \.isWhitespace)
            guard let rawEnd = tail.first, let end = timestamp(String(rawEnd)) else { throw MediaEditError.invalidProject }
            var body: [String] = []
            if fileExtension == "txt", tail.count > 1 { body.append(String(tail[1])) }
            index += 1
            while index < lines.count && !lines[index].trimmingCharacters(in: .whitespaces).isEmpty && !lines[index].contains("-->") {
                body.append(lines[index]); index += 1
            }
            // VTT/SRT inline markup is presentation syntax, not visible text.
            let value = body.joined(separator: "\n").replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard start >= 0, end > start, end <= duration + 0.000001, !value.isEmpty, value.count <= 1000, !value.contains("\0") else { throw MediaEditError.invalidProject }
            cues.append(MediaCaption(start: start, end: end, text: value))
            guard cues.count <= 1000 else { throw MediaEditError.invalidProject }
        }
        cues.sort { $0.start < $1.start }
        guard !cues.isEmpty else { throw MediaEditError.invalidProject }
        for index in 1..<cues.count where cues[index].start < cues[index - 1].end { throw MediaEditError.invalidProject }
        return cues
    }
    private static func timestamp(_ value: String) -> Double? {
        let parts = value.replacingOccurrences(of: ",", with: ".").split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 || parts.count == 3,
              let seconds = Double(parts.last!), seconds.isFinite, (0..<60).contains(seconds),
              let minutes = Double(parts[parts.count - 2]), minutes.rounded() == minutes, (0..<60).contains(minutes) else { return nil }
        let hours = parts.count == 3 ? Double(parts[0]) : 0
        guard let hours, hours.isFinite, hours >= 0, hours.rounded() == hours else { return nil }
        return hours * 3600 + minutes * 60 + seconds
    }
}

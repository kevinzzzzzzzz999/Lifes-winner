import Foundation
import CoreGraphics

struct BoardReadAloudWord: Sendable {
    let range: NSRange
    /// Top-left normalized coordinates in the immutable viewport snapshot.
    let rect: CGRect
}

struct BoardReadAloudLine: Sendable {
    let text: String
    let rect: CGRect
    let words: [BoardReadAloudWord]
    let confidence: Float
    /// When set, rects are in this PDF page's native coordinates, not normalized.
    var pageIndex: Int? = nil
    func highlight(for range: NSRange) -> CGRect {
        let matching = words.filter { NSIntersectionRange($0.range, range).length > 0 }
        return matching.map(\.rect).reduce(CGRect.null) { $0.union($1) }.isNull
            ? rect : matching.map(\.rect).reduce(CGRect.null) { $0.union($1) }
    }
}

struct BoardReadAloudRun: Equatable, Sendable {
    let text: String
    let language: String
    /// UTF-16 range in the original OCR line; speech callbacks also use UTF-16.
    let range: NSRange
}

enum BoardReadAloudText {
    static func languageRuns(_ text: String) -> [BoardReadAloudRun] {
        var result: [BoardReadAloudRun] = []
        var start = text.startIndex, current: String?, offset = 0, runOffset = 0
        for index in text.indices {
            let character = text[index]
            let language = scriptLanguage(character)
            if let language, let previous = current, language != previous {
                let part = String(text[start..<index])
                if !part.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    result.append(BoardReadAloudRun(text: part, language: previous,
                        range: NSRange(location: runOffset, length: offset - runOffset)))
                }
                start = index; runOffset = offset
            }
            if let language { current = language }
            offset += String(character).utf16.count
        }
        let tail = String(text[start...])
        if !tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append(BoardReadAloudRun(text: tail, language: current ?? "zh-CN",
                range: NSRange(location: runOffset, length: offset - runOffset)))
        }
        return result
    }

    private static func scriptLanguage(_ character: Character) -> String? {
        for scalar in character.unicodeScalars {
            switch scalar.value {
            case 0x3400...0x9FFF, 0xF900...0xFAFF, 0x20000...0x3134F: return "zh-CN"
            case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F: return "en-US"
            default: continue
            }
        }
        return nil
    }

    static func topLeftRect(_ visionRect: CGRect) -> CGRect {
        CGRect(x: visionRect.minX, y: 1 - visionRect.maxY, width: visionRect.width, height: visionRect.height)
    }

    static func vocabulary(_ text: String) -> [String] {
        var seen = Set<String>()
        return Array(text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.utf16.count <= 64 && seen.insert($0).inserted }.prefix(200))
    }
}

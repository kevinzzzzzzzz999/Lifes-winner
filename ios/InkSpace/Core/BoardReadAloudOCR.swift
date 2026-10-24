import Foundation
import Vision
import CoreGraphics

/// Word locations are requested only for read-aloud. VisionKit does not expose
/// boxes publicly; both engines consume the same bounded immutable pixels.
enum BoardReadAloudOCR {
    private static let queue = DispatchQueue(label: "InkSpace.BoardReadAloudOCR", qos: .userInitiated)
    static func recognize(_ image: CGImage, customWords: [String]) async throws -> [BoardReadAloudLine] {
        let cancellation = BoardReadAloudCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    do {
                        let request = VNRecognizeTextRequest()
                        request.revision = VNRecognizeTextRequestRevision3
                        request.recognitionLevel = .accurate
                        request.recognitionLanguages = ["zh-Hans", "en-US"]
                        request.usesLanguageCorrection = true
                        request.customWords = customWords
                        request.minimumTextHeight = 0.003
                        try cancellation.install(request)
                        defer { cancellation.clear() }
                        try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
                        try cancellation.check()
                        let observations = (request.results ?? []).sorted {
                            if abs($0.boundingBox.midY - $1.boundingBox.midY) > min($0.boundingBox.height, $1.boundingBox.height) * 0.5 {
                                return $0.boundingBox.midY > $1.boundingBox.midY
                            }
                            return $0.boundingBox.minX < $1.boundingBox.minX
                        }
                        var lines: [BoardReadAloudLine] = [], characters = 0
                        for observation in observations.prefix(500) {
                            try cancellation.check()
                            guard let candidate = observation.topCandidates(1).first,
                                  !candidate.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                  characters + candidate.string.utf16.count <= 30_000 else { continue }
                            let text = candidate.string
                            var words: [BoardReadAloudWord] = []
                            text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: [.byWords, .substringNotRequired]) { _, range, _, _ in
                                let box = (try? candidate.boundingBox(for: range))?.boundingBox ?? observation.boundingBox
                                words.append(BoardReadAloudWord(range: NSRange(range, in: text), rect: BoardReadAloudText.topLeftRect(box)))
                            }
                            characters += text.utf16.count
                            lines.append(BoardReadAloudLine(text: text, rect: BoardReadAloudText.topLeftRect(observation.boundingBox),
                                words: words, confidence: candidate.confidence))
                        }
                        continuation.resume(returning: lines)
                    } catch { continuation.resume(throwing: error) }
                }
            }
        } onCancel: { cancellation.cancel() }
    }
}

private final class BoardReadAloudCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var request: VNRequest?
    func check() throws { lock.lock(); defer { lock.unlock() }; if cancelled { throw CancellationError() } }
    func install(_ request: VNRequest) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
        self.request = request
    }
    func clear() { lock.lock(); request = nil; lock.unlock() }
    func cancel() { lock.lock(); cancelled = true; let active = request; lock.unlock(); active?.cancel() }
}

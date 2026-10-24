import Foundation

/// Optional v1 native payload alongside the original normalized interchange
/// points. Old records need no migration and are never rewritten on read.
struct PDFNativeInkArchive: Codable, Equatable, Sendable {
    static let maximumDataBytes = 128 * 1024
    var version: Int = 1
    var referenceWidth: Double
    var data: Data
    var isValid: Bool {
        version == 1 && referenceWidth.isFinite && (1...100_000).contains(referenceWidth)
            && !data.isEmpty && data.count <= Self.maximumDataBytes
    }
    static func hasValidKeys(_ value: Any?) -> Bool {
        guard let raw = value as? [String: Any] else { return false }
        return Set(raw.keys) == Set(["version", "referenceWidth", "data"])
    }
}

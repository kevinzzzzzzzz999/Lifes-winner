import Foundation
import CryptoKit

enum VaultWriteError: LocalizedError {
    case externalChange
    case unavailable
    var errorDescription: String? {
        switch self {
        case .externalChange: String(localized: "文件已被其他设备或应用修改。将保留两个版本。")
        case .unavailable: String(localized: "无法访问仓库文件，请检查文件夹授权及 iCloud 下载状态。")
        }
    }
}

/// Serializes local writes. iCloud transport and cross-device merging are not transactions.
actor VaultFileIO {
    static func fingerprint(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func read(_ url: URL) throws -> (Data, String) {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<Data, Error> = .failure(VaultWriteError.unavailable)
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { target in
            result = Result { try Data(contentsOf: target) }
        }
        if let coordinationError { throw coordinationError }
        let data = try result.get()
        return (data, Self.fingerprint(data))
    }

    func write(_ data: Data, to url: URL, expectedFingerprint: String?) throws -> String {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<Void, Error> = .failure(VaultWriteError.unavailable)
        coordinator.coordinate(writingItemAt: url, options: expectedFingerprint == nil ? [] : .forReplacing,
                               error: &coordinationError) { target in
            result = Result {
                let exists = FileManager.default.fileExists(atPath: target.path)
                if exists {
                    let current = try Data(contentsOf: target)
                    guard let expectedFingerprint,
                          Self.fingerprint(current) == expectedFingerprint
                    else { throw VaultWriteError.externalChange }
                } else if expectedFingerprint != nil {
                    throw VaultWriteError.externalChange
                }
                try data.write(to: target, options: .atomic)
            }
        }
        if let coordinationError { throw coordinationError }
        try result.get()
        return Self.fingerprint(data)
    }
    /// The wrapper is an ordinary Obsidian note; it references, rather than copies,
    /// the whiteboard and original PDFs. Existing user-authored notes are untouched.
    func ensureObsidianNote(boardURL: URL, relativePath: String, boardID: UUID) throws -> URL {
        let stem = String(boardURL.lastPathComponent.dropLast(".inkspace.json".count))
        let marker = "%% InkSpace board: \(boardID.uuidString) %%"
        let legacyMarker = "<!-- InkSpace board: \(boardID.uuidString) -->"
        let reference = String(data: try JSONSerialization.data(withJSONObject: ["file": relativePath], options: [.sortedKeys]), encoding: .utf8)!
        let content = marker + "\n\n```inkspace\n" + reference + "\n```\n"
        for suffix in ["", "-InkSpace", "-InkSpace-" + boardID.uuidString] {
            let url = boardURL.deletingLastPathComponent().appendingPathComponent(stem + suffix + ".md")
            if FileManager.default.fileExists(atPath: url.path) {
                let (existing, fingerprint) = try read(url)
                let text = String(data: existing, encoding: .utf8) ?? ""
                if text.hasPrefix(marker) { return url }
                if text.hasPrefix(legacyMarker) {
                    // Migrate only the exact earlier generated note, retaining any
                    // user additions verbatim if the wrapper has been edited.
                    let oldContent = legacyMarker + "\n\n```inkspace\n" + reference + "\n```\n"
                    if text == oldContent { _ = try write(Data(content.utf8), to: url, expectedFingerprint: fingerprint) }
                    return url
                }
                continue
            }
            do {
                _ = try write(Data(content.utf8), to: url, expectedFingerprint: nil)
                return url
            } catch VaultWriteError.externalChange { continue }
        }
        throw VaultWriteError.externalChange
    }

}

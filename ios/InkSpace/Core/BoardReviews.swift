import Foundation
import CryptoKit
import Darwin

struct ReviewRect: Codable, Equatable, Sendable {
    var x: Double; var y: Double; var width: Double; var height: Double
    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    init(_ rect: CGRect) { x = rect.minX; y = rect.minY; width = rect.width; height = rect.height }
    func valid(limit: Double) -> Bool {
        [x,y,width,height].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= limit + 1e-9 && y + height <= limit + 1e-9
    }
}
struct ReviewAnchor: Codable, Equatable, Sendable {
    var itemID: UUID
    var sourcePath: String?
    var originalSourcePath: String?
    var page: Int?
    var rect: ReviewRect
}
enum BoardReviewStyle: String, Codable, Sendable { case comment, highlight }

struct BoardReview: Codable, Identifiable, Equatable, Sendable {
    var schemaVersion = 1
    var id = UUID()
    var boardPath: String
    var boardID: UUID
    var createdAt: String
    var comment: String
    var color: String
    var rect: ReviewRect
    var points: [[Double]]
    var anchor: ReviewAnchor?
    var sourceSHA256: String?
    // Optional fields preserve decoding of existing immutable review records.
    var style: BoardReviewStyle? = nil
    var strokeWidth: Double? = nil
    var isHighlight: Bool { style == .highlight }
    func validate() throws {
        guard schemaVersion == 1, ReviewRepository.safePath(boardPath), boardPath.lowercased().hasSuffix(".inkspace.json"),
              ReviewRepository.isDate(createdAt), comment.utf16.count <= 10_000,
              color.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil,
              rect.valid(limit: 8_000_000), points.count <= 2048,
              points.allSatisfy({ $0.count == 2 && $0.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 } }) else { throw ReviewError.invalid }
        if let strokeWidth {
            guard strokeWidth.isFinite, strokeWidth > 0, strokeWidth <= 1_000_000 else { throw ReviewError.invalid }
        }
        if let anchor {
            guard anchor.rect.valid(limit: 1), anchor.sourcePath.map(ReviewRepository.safePath) ?? true,
                  anchor.originalSourcePath.map(ReviewRepository.safePath) ?? true,
                  anchor.page.map({ (1...100_000).contains($0) }) ?? true else { throw ReviewError.invalid }
        }
        if let sourceSHA256, sourceSHA256.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) == nil { throw ReviewError.invalid }
    }
}
struct ReviewDeletion: Codable, Sendable {
    var schemaVersion = 1
    var id: UUID
    var deletedAt: String
}
struct ReviewListing: Sendable {
    var records: [BoardReview]
    var warnings: Int
}
enum ReviewError: LocalizedError {
    case invalid, unavailable, exists, tooMany
    var errorDescription: String? {
        switch self {
        case .invalid: String(localized: "临时批注格式无效，未写入任何原文件")
        case .unavailable: String(localized: "临时批注无法保存，请检查资料文件夹授权和下载状态")
        case .exists: String(localized: "这条临时批注已经存在或已删除，请刷新列表")
        case .tooMany: String(localized: "临时批注文件过多，暂未读取；已有文件保持不变")
        }
    }
}

/// Immutable per-review files plus permanent deletion markers. No board, PDF, or
/// source-document URL is ever opened for writing by this repository.
actor ReviewRepository {
    static let folderName = ".inkspace-reviews"
    static let recordLimit = 128 * 1024
    private let backupDirectory: URL
    init(backupDirectory: URL? = nil) {
        self.backupDirectory = backupDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("InkSpace/ReviewRecovery", isDirectory: true)
    }
    private func writeNewAtomically(_ data: Data, to target: URL) throws {
        let temporary = target.deletingLastPathComponent().appendingPathComponent(".pending-" + UUID().uuidString.lowercased())
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        // Public since iOS 10. Atomic publication that explicitly refuses to
        // replace another writer's existing immutable record or tombstone.
        if renamex_np(temporary.path, target.path, UInt32(RENAME_EXCL)) != 0 {
            let code = errno
            if code == EEXIST { throw ReviewError.exists }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
    }
    private func backup(_ data: Data, root: URL, filename: String) throws {
        let identity = SHA256.hash(data: Data(root.standardizedFileURL.resolvingSymlinksInPath().path.utf8)).map { String(format: "%02x",$0) }.joined()
        let dir = backupDirectory.appendingPathComponent(identity, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent(filename)
        if FileManager.default.fileExists(atPath: target.path) {
            guard try Data(contentsOf: target) == data else { throw ReviewError.exists }
        } else { try writeNewAtomically(data, to: target) }
    }
    nonisolated static func safePath(_ path: String) -> Bool {
        VaultPath.isSafeRelative(path) && !path.split(separator: "/").contains { $0.lowercased() == folderName }
    }
    nonisolated static func isDate(_ value: String) -> Bool {
        let f = ISO8601DateFormatter()
        if f.date(from: value) != nil { return true }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: value) != nil
    }
    nonisolated static func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
    private func directory(root: URL, create: Bool) throws -> URL? {
        let normalized = root.standardizedFileURL.resolvingSymlinksInPath()
        let target = normalized.appendingPathComponent(Self.folderName, isDirectory: true)
        if FileManager.default.fileExists(atPath: target.path) {
            let values = try target.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true,
                  target.resolvingSymlinksInPath().path == target.path else { throw ReviewError.unavailable }
        } else if create {
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        } else { return nil }
        return target
    }
    private func readFile(_ url: URL) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              (values.fileSize ?? Int.max) <= Self.recordLimit else { throw ReviewError.invalid }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.recordLimit else { throw ReviewError.invalid }
        return data
    }
    func list(root: URL) throws -> ReviewListing {
        var failure: NSError?
        var result: Result<ReviewListing, Error> = .failure(ReviewError.unavailable)
        NSFileCoordinator().coordinate(readingItemAt: root, options: [], error: &failure) { root in
            result = Result {
                guard let dir = try directory(root: root, create: false) else { return ReviewListing(records: [], warnings: 0) }
                let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
                guard files.count <= 20_000 else { throw ReviewError.tooMany }
                let deadline = Date().addingTimeInterval(20)
                var total = 0
                for file in files {
                    guard Date() < deadline else { throw ReviewError.tooMany }
                    let size = (try file.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
                    guard size >= 0, size <= 32*1024*1024-total else { throw ReviewError.tooMany }; total += size
                }
                var bytesRead = 0
                func boundedData(_ file: URL) throws -> Data {
                    let data = try readFile(file)
                    guard data.count <= 32*1024*1024-bytesRead else { throw ReviewError.tooMany }
                    bytesRead += data.count
                    return data
                }
                var hidden = Set<UUID>(); var warnings = 0; var records: [UUID:BoardReview] = [:]
                for file in files where file.lastPathComponent.lowercased().hasSuffix(".deleted.json") {
                    guard Date() < deadline else { throw ReviewError.tooMany }
                    let stem = String(file.lastPathComponent.dropLast(".deleted.json".count))
                    guard let id = UUID(uuidString: stem) else { warnings += 1; continue }
                    // Presence wins even when malformed, unavailable, or a future schema.
                    hidden.insert(id)
                    do {
                        let marker = try JSONDecoder().decode(ReviewDeletion.self, from: boundedData(file))
                        guard marker.schemaVersion == 1, marker.id == id, Self.isDate(marker.deletedAt) else { throw ReviewError.invalid }
                    } catch { if case ReviewError.tooMany = error { throw error }; warnings += 1 }
                }
                for file in files where file.pathExtension.lowercased() == "json" && !file.lastPathComponent.lowercased().hasSuffix(".deleted.json") {
                    guard Date() < deadline else { throw ReviewError.tooMany }
                    guard let id = UUID(uuidString: String(file.lastPathComponent.dropLast(5))) else { warnings += 1; continue }
                    guard !hidden.contains(id) else { continue }
                    do {
                        let record = try JSONDecoder().decode(BoardReview.self, from: boundedData(file)); try record.validate()
                        guard record.id == id, records[id] == nil else { throw ReviewError.invalid }
                        records[id] = record
                    } catch { if case ReviewError.tooMany = error { throw error }; warnings += 1 }
                }
                return ReviewListing(records: records.values.sorted { $0.createdAt == $1.createdAt ? $0.id.uuidString < $1.id.uuidString : $0.createdAt < $1.createdAt }, warnings: warnings)
            }
        }
        if let failure { throw failure }; return try result.get()
    }
    private func publish(data: Data, id: UUID, root: URL, deleted: Bool) throws {
        guard data.count <= Self.recordLimit else { throw ReviewError.invalid }
        var failure: NSError?; var result: Result<Void, Error> = .failure(ReviewError.unavailable)
        NSFileCoordinator().coordinate(writingItemAt: root, options: .forMerging, error: &failure) { root in
            result = Result {
                guard let dir = try directory(root: root, create: true) else { throw ReviewError.unavailable }
                let base = id.uuidString.lowercased()
                let record = dir.appendingPathComponent(base + ".json")
                let marker = dir.appendingPathComponent(base + ".deleted.json")
                if deleted, FileManager.default.fileExists(atPath: marker.path) { return }
                if !deleted, FileManager.default.fileExists(atPath: record.path), !FileManager.default.fileExists(atPath: marker.path),
                   try readFile(record) == data {
                    try backup(data, root: root, filename: record.lastPathComponent)
                    return // Same immutable bytes are an idempotent retry, never an edit.
                }
                guard !FileManager.default.fileExists(atPath: deleted ? marker.path : record.path),
                      deleted || !FileManager.default.fileExists(atPath: marker.path) else { throw ReviewError.exists }
                let existing = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
                let count = existing.filter { $0.pathExtension.lowercased() == "json" && !$0.lastPathComponent.lowercased().hasSuffix(".deleted.json") }.count
                guard existing.count < 20_000, deleted || count < 10_000 else { throw ReviewError.tooMany }
                let budget = (deleted ? 32 : 28)*1024*1024
                var total = data.count
                for file in existing {
                    let size = (try file.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? 0
                    guard size >= 0, size <= budget-total else { throw ReviewError.tooMany }; total += size
                }
                // Keep an independent local copy before shared-folder publication.
                try backup(data, root: root, filename: (deleted ? marker : record).lastPathComponent)
                // A new immutable name only. Never replace an existing file.
                try writeNewAtomically(data, to: deleted ? marker : record)
            }
        }
        if let failure { throw failure }; try result.get()
    }
    func add(_ record: BoardReview, root: URL) throws {
        try record.validate()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try publish(data: encoder.encode(record), id: record.id, root: root, deleted: false)
    }
    func delete(_ id: UUID, root: URL) throws {
        let marker = ReviewDeletion(id: id, deletedAt: Self.timestamp())
        try publish(data: JSONEncoder().encode(marker), id: id, root: root, deleted: true)
    }
}

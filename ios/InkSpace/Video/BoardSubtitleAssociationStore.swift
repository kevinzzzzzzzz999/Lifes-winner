import Foundation
import CryptoKit
import Darwin

struct BoardSubtitleSource: Codable, Equatable, Sendable {
    let name: String
    let text: String
    let enabled: Bool

    func validated() throws -> BoardSubtitleDocument {
        guard !name.isEmpty, name.unicodeScalars.count <= 255, !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              ["srt", "vtt", "txt"].contains((name as NSString).pathExtension.lowercased()) else {
            throw BoardSubtitleError.unsupported
        }
        guard text.utf8.count <= BoardSubtitleParser.maximumBytes, text.unicodeScalars.count <= 200_000 else {
            throw BoardSubtitleError.tooLarge
        }
        return try BoardSubtitleParser.parse(data: Data(text.utf8), fileExtension: (name as NSString).pathExtension)
    }
}

struct BoardSubtitleAssociationSnapshot: Sendable {
    let subtitle: BoardSubtitleSource?
    /// nil means the association file did not exist, not an explicit null tombstone.
    let sha256: String?
}

enum BoardSubtitleAssociationError: LocalizedError {
    case malformed, conflict, unavailable, readUnavailable, timedOut, pendingLimit
    var errorDescription: String? {
        switch self {
        case .malformed: String(localized: "已保存的字幕关联无法读取；原文件保持不变。")
        case .conflict: String(localized: "字幕关联已被其他操作修改。请重新读取已保存的字幕，再决定是否重新导入。")
        case .unavailable: String(localized: "字幕关联未能保存。已保留本次字幕，可重试；原关联保持不变。")
        case .readUnavailable: String(localized: "字幕关联暂不可读，请等待云端下载完成后重新读取；原关联保持不变。")
        case .timedOut: String(localized: "字幕关联读取超时，请检查下载状态后重新读取；原关联保持不变。")
        case .pendingLimit: String(localized: "尚有多份字幕等待保存，请先重试或放弃待保存的更改。")
        }
    }
}

/// Completion is independent of a provider's worker, which may finish late.
private final class SubtitleAssociationCompletion<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var resolved = false
    private var deadline: DispatchWorkItem?
    private let resolve: (Result<Value, Error>) -> Void
    init(_ resolve: @escaping (Result<Value, Error>) -> Void) { self.resolve = resolve }
    func install(_ item: DispatchWorkItem) {
        lock.lock(); let done = resolved; if !done { deadline = item }; lock.unlock()
        if done { item.cancel() }
    }
    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard !resolved else { lock.unlock(); return }
        resolved = true; let deadline = deadline; self.deadline = nil
        lock.unlock(); deadline?.cancel(); resolve(result)
    }
}

private final class SubtitleAssociationControl: @unchecked Sendable {
    private let lock = NSLock()
    private var failure: Error?
    private var coordinator: NSFileCoordinator?
    private var stopped: ((Error) -> Void)?
    func onStop(_ handler: @escaping (Error) -> Void) {
        lock.lock(); stopped = handler; let error = failure; lock.unlock()
        if let error { handler(error) }
    }
    func stop(_ error: Error) {
        lock.lock(); if failure == nil { failure = error }; let coordinator = coordinator, stopped = stopped, reason = failure!; lock.unlock()
        stopped?(reason); coordinator?.cancel()
    }
    func use(_ value: NSFileCoordinator) throws {
        lock.lock(); coordinator = value; let error = failure; lock.unlock()
        if let error { value.cancel(); throw error }
    }
    func check() throws { lock.lock(); let error = failure; lock.unlock(); if let error { throw error } }
}

/// A placeholder is not a missing association. Ask iCloud to materialize before
/// taking a POSIX snapshot; other providers materialize during target coordination.
enum BoardSubtitleCloudPreparation {
    static func waitUntilReadable(_ url: URL, check: () throws -> Void,
                                  needsDownload: (URL) throws -> Bool = needsDownload,
                                  requestDownload: (URL) throws -> Void = { try FileManager.default.startDownloadingUbiquitousItem(at: $0) },
                                  now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                                  wait: () -> Void = { Thread.sleep(forTimeInterval: 0.1) },
                                  timeout: TimeInterval = 20) throws {
        try check()
        guard try needsDownload(url) else { return }
        let deadline = now() + timeout
        try check(); try requestDownload(url)
        while true {
            try check()
            if try !needsDownload(url) { try check(); return }
            guard now() < deadline else { throw BoardSubtitleAssociationError.timedOut }
            wait()
        }
    }
    private static func needsDownload(_ url: URL) throws -> Bool {
        var fresh = url; fresh.removeAllCachedResourceValues()
        let values = try fresh.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
        guard values.isUbiquitousItem == true else { return false }
        var value = stat()
        let dataless = url.path.withCString { lstat($0, &value) } == 0 && (value.st_flags & UInt32(SF_DATALESS)) != 0
        return dataless || (values.ubiquitousItemDownloadingStatus != .current && values.ubiquitousItemDownloadingStatus != .downloaded)
    }
}

/// Shared Mac/iOS v1 association. No video or board bytes are written. The
/// original authorized root lease remains live for the full coordinated operation.
final class BoardSubtitleAssociationStore: @unchecked Sendable {
    private static let readQueue = DispatchQueue(label: "InkSpace.subtitle-association-reads", qos: .userInitiated, attributes: .concurrent)
    private static let queue = DispatchQueue(label: "InkSpace.subtitle-associations", qos: .userInitiated)
    private let rootURL: URL
    private let videoPath: String
    static let maximumJSONBytes = 4 * 1_024 * 1_024

    init(rootURL: URL, videoPath: String) { self.rootURL = rootURL; self.videoPath = videoPath }

    /// Exact basename, including extension/case/Unicode spelling; no normalization.
    static func sidecarURL(for videoURL: URL) -> URL {
        videoURL.deletingLastPathComponent().appendingPathComponent("." + videoURL.lastPathComponent + ".inkspace-subtitles.json")
    }

    func identity() async throws -> String {
        try await perform { lease, control in try control.check(); return Self.sidecarURL(for: lease.url).path }
    }
    func load() async throws -> BoardSubtitleAssociationSnapshot {
        try await perform { lease, control in
            try self.coordinated(lease: lease, writing: false, control: control) { target, exists in
                try control.check()
                let data = try Self.readBytes(target)
                guard !exists || data != nil else { throw BoardSubtitleAssociationError.readUnavailable }
                try control.check()
                return BoardSubtitleAssociationSnapshot(subtitle: try data.map(Self.decode) ?? nil, sha256: data.map(Self.digest))
            }
        }
    }

    func save(_ subtitle: BoardSubtitleSource?, expectedSHA256: String?) async throws -> BoardSubtitleAssociationSnapshot {
        if let subtitle { _ = try subtitle.validated() }
        let data = try Self.encode(subtitle)
        return try await perform(readOnly: false) { lease, control in
            try self.coordinated(lease: lease, writing: true, control: control) { target, exists in
                try control.check()
                let previous = try Self.readBytes(target)
                guard !exists || previous != nil else { throw BoardSubtitleAssociationError.unavailable }
                guard previous.map(Self.digest) == expectedSHA256 else { throw BoardSubtitleAssociationError.conflict }
                // Malformed existing metadata is never replaced as a repair side effect.
                if let previous { _ = try Self.decode(previous) }
                try control.check()
                // Once the atomic write starts, report its actual outcome even if a
                // cancellation/deadline arrives. No early completion for writes.
                try data.write(to: target, options: .atomic)
                let saved = try Self.readBytes(target)
                guard saved == data else { throw BoardSubtitleAssociationError.conflict }
                return BoardSubtitleAssociationSnapshot(subtitle: subtitle, sha256: Self.digest(data))
            }
        }
    }

    private func perform<T>(readOnly: Bool = true, _ operation: @escaping (BoardVideoLease, SubtitleAssociationControl) throws -> T) async throws -> T {
        let control = SubtitleAssociationControl()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let completion = SubtitleAssociationCompletion<T> { continuation.resume(with: $0) }
                if readOnly { control.onStop { completion.finish(.failure($0)) } }
                let deadline = DispatchWorkItem {
                    control.stop(BoardSubtitleAssociationError.timedOut)
                    if readOnly { completion.finish(.failure(BoardSubtitleAssociationError.timedOut)) }
                }
                completion.install(deadline)
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 25, execute: deadline)
                // The deadline starts before enqueueing: a previous provider may
                // still be unwinding after its caller has already timed out.
                let worker = readOnly ? Self.readQueue : Self.queue
                worker.async {
                    completion.finish(Result {
                        try control.check()
                        let lease = try BoardVideoLease(rootURL: self.rootURL, relativePath: self.videoPath)
                        return try operation(lease, control)
                    })
                }
            }
        } onCancel: { control.stop(CancellationError()) }
    }

    private func coordinated<T>(lease: BoardVideoLease, writing: Bool, control: SubtitleAssociationControl,
                                body: (URL, Bool) throws -> T) throws -> T {
        let target = Self.sidecarURL(for: lease.url), parent = target.deletingLastPathComponent()
        // Inspect only metadata while holding the parent. Do not hold its lock
        // while downloading, as the provider may need it to publish the bytes.
        let inspector = NSFileCoordinator(); try control.use(inspector)
        var inspectError: NSError?, existence: Result<Bool, Error>?
        inspector.coordinate(readingItemAt: parent, options: [], error: &inspectError) { accessed in
            existence = Result {
                try control.check(); try self.validateLocation(lease: lease, parent: accessed)
                return try Self.targetExists(target)
            }
        }
        try control.check()
        if let inspectError { throw inspectError }
        guard let existence else { throw BoardSubtitleAssociationError.readUnavailable }
        let exists = try existence.get()
        if exists { try BoardSubtitleCloudPreparation.waitUntilReadable(target, check: control.check) }
        try control.check()
        let coordinator = NSFileCoordinator(); try control.use(coordinator)
        var error: NSError?, result: Result<T, Error>?
        func access(_ readable: URL, _ accessedParent: URL) {
            result = Result {
                try control.check(); try self.validateLocation(lease: lease, parent: accessedParent)
                guard readable.standardizedFileURL == target.standardizedFileURL else { throw BoardVideoError.outsideVault }
                // An association appearing/disappearing during preparation requires
                // a reload, never an empty snapshot or implicit overwrite.
                guard try Self.targetExists(target) == exists else { throw BoardSubtitleAssociationError.conflict }
                return try body(target, exists)
            }
        }
        if exists {
            if writing {
                coordinator.coordinate(readingItemAt: target, options: [], writingItemAt: parent, options: .forMerging, error: &error) {
                    access($0, $1)
                }
            } else {
                coordinator.coordinate(readingItemAt: target, options: [], error: &error) { access($0, parent) }
            }
        } else if writing {
            coordinator.coordinate(writingItemAt: parent, options: .forMerging, error: &error) { access(target, $0) }
        } else {
            coordinator.coordinate(readingItemAt: parent, options: [], error: &error) { access(target, $0) }
        }
        // A completed save wins over a deadline racing after its atomic write.
        if let result { return try result.get() }
        try control.check()
        if let error { throw error }
        throw BoardSubtitleAssociationError.readUnavailable
    }

    private static func targetExists(_ target: URL) throws -> Bool {
        var value = stat()
        if target.path.withCString({ lstat($0, &value) }) == 0 {
            guard allowed(value) else { throw BoardSubtitleAssociationError.readUnavailable }
            return true
        }
        guard errno == ENOENT else { throw BoardSubtitleAssociationError.readUnavailable }
        // Older iCloud providers can expose a .name.icloud placeholder before
        // the logical URL has a POSIX entry. Never treat that as no subtitles.
        let placeholder = target.deletingLastPathComponent().appendingPathComponent("." + target.lastPathComponent + ".icloud")
        if placeholder.path.withCString({ lstat($0, &value) }) == 0 {
            guard allowed(value) else { throw BoardSubtitleAssociationError.readUnavailable }
            return true
        }
        guard errno == ENOENT else { throw BoardSubtitleAssociationError.readUnavailable }
        return false
    }
    private static func allowed(_ value: stat) -> Bool {
        (value.st_mode & S_IFMT) == S_IFREG && value.st_nlink == 1 && value.st_size >= 0 && value.st_size <= maximumJSONBytes
    }
    private func validateLocation(lease: BoardVideoLease, parent: URL) throws {
        let fresh = try BoardVideoLease.resolve(rootURL: rootURL, relativePath: videoPath)
        guard fresh == lease.url, parent.standardizedFileURL == fresh.deletingLastPathComponent().standardizedFileURL else {
            throw BoardVideoError.outsideVault
        }
    }
    private static func readBytes(_ target: URL) throws -> Data? {
        var before = stat()
        if target.path.withCString({ lstat($0, &before) }) != 0 {
            if errno == ENOENT { return nil }
            throw BoardSubtitleAssociationError.unavailable
        }
        func same(_ a: stat, _ b: stat) -> Bool {
            a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size && a.st_nlink == b.st_nlink
                && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
                && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
        }
        guard allowed(before), (before.st_flags & UInt32(SF_DATALESS)) == 0 else { throw BoardSubtitleAssociationError.unavailable }
        let descriptor = target.path.withCString { open($0, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK) }
        guard descriptor >= 0 else { throw BoardSubtitleAssociationError.unavailable }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? input.close() }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0, allowed(opened), same(before, opened) else { throw BoardSubtitleAssociationError.unavailable }
        let data = try input.read(upToCount: maximumJSONBytes + 1) ?? Data()
        var after = stat(), current = stat()
        guard fstat(descriptor, &after) == 0, target.path.withCString({ lstat($0, &current) }) == 0,
              same(opened, after), same(after, current), data.count == after.st_size else { throw BoardSubtitleAssociationError.unavailable }
        return data
    }
    private struct Envelope: Codable {
        let schemaVersion: Int
        let subtitle: BoardSubtitleSource?
        enum CodingKeys: String, CodingKey { case schemaVersion, subtitle }
        init(_ subtitle: BoardSubtitleSource?) { schemaVersion = 1; self.subtitle = subtitle }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
            guard values.contains(.subtitle) else { throw BoardSubtitleAssociationError.malformed }
            subtitle = try values.decodeIfPresent(BoardSubtitleSource.self, forKey: .subtitle)
        }
        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(schemaVersion, forKey: .schemaVersion)
            if let subtitle { try values.encode(subtitle, forKey: .subtitle) } else { try values.encodeNil(forKey: .subtitle) }
        }
    }
    static func decode(_ data: Data) throws -> BoardSubtitleSource? {
        guard data.count <= maximumJSONBytes, String(data: data, encoding: .utf8) != nil else { throw BoardSubtitleAssociationError.malformed }
        do {
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == Set(["schemaVersion", "subtitle"]) else { throw BoardSubtitleAssociationError.malformed }
            if let child = object["subtitle"] as? [String: Any] {
                guard Set(child.keys) == Set(["name", "text", "enabled"]) else { throw BoardSubtitleAssociationError.malformed }
            } else if !(object["subtitle"] is NSNull) { throw BoardSubtitleAssociationError.malformed }
            let value = try JSONDecoder().decode(Envelope.self, from: data)
            guard value.schemaVersion == 1 else { throw BoardSubtitleAssociationError.malformed }
            if let subtitle = value.subtitle { _ = try subtitle.validated() }
            return value.subtitle
        } catch { throw BoardSubtitleAssociationError.malformed }
    }
    static func encode(_ subtitle: BoardSubtitleSource?) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(Envelope(subtitle))
        guard data.count <= maximumJSONBytes else { throw BoardSubtitleError.tooLarge }
        return data
    }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

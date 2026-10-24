import Foundation
import Darwin
import ImageIO

struct StudySnapshot: Sendable {
    var events: [StudyEvent]
    var cards: [StudyCardState]
    var warnings: [String]
    var bytes: Int
}
private final class StudyIOControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var coordinator: NSFileCoordinator?
    func cancel() { lock.lock(); cancelled = true; let c = coordinator; lock.unlock(); c?.cancel() }
    func check() throws { lock.lock(); let stop = cancelled; lock.unlock(); if stop { throw CancellationError() } }
    func use(_ c: NSFileCoordinator) throws { lock.lock(); coordinator = c; let stop = cancelled; lock.unlock(); if stop { c.cancel(); throw CancellationError() } }
}
/// A separate immutable event log. Board/PDF bytes are never written by this service.
enum StudyRepository {
    private static let queue = DispatchQueue(label: "InkSpace.study.events", qos: .userInitiated)
    static let maximumEvents = 10_000, maximumBytes = 32 * 1024 * 1024
    static func load(root: URL, boardID: UUID) async throws -> StudySnapshot {
        try await perform(root: root, writing: false) { root, control in
            try scan(root: root, boardID: boardID, control: control)
        }
    }
    static func append(_ input: StudyEvent, root: URL) async throws -> StudySnapshot {
        let event = try input.normalized(), data = try input.data()
        return try await perform(root: root, writing: true) { root, control in
            let boardID = UUID(uuidString: event.boardID)!
            let before = try scan(root: root, boardID: boardID, control: control)
            if let existing = before.events.first(where: { $0.id == event.id }) {
                guard existing == event else { throw StudyError.conflict }
                return before
            }
            guard before.warnings.isEmpty else { throw StudyError.incomplete }
            guard before.events.count < maximumEvents, before.bytes + data.count <= maximumBytes else { throw StudyError.limit }
            if event.kind == "grade" {
                guard let card = before.cards.first(where: { $0.itemID == event.itemID }) else { throw StudyError.conflict }
                try validateImages(card.card.imagePaths, root: root, control: control)
            }
            let (fd, path) = try openEvents(root: root, boardID: boardID, create: true)
            defer { close(fd) }
            let temporary = ".pending-" + UUID().uuidString.lowercased()
            let temporaryFD = openat(fd, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
            guard temporaryFD >= 0 else { throw StudyError.unsafePath }
            defer { close(temporaryFD); unlinkat(fd, temporary, 0) }
            try data.withUnsafeBytes { buffer in
                var offset = 0
                while offset < data.count {
                    try control.check()
                    let count = Darwin.write(temporaryFD, buffer.baseAddress!.advanced(by: offset), data.count - offset)
                    guard count > 0 else { throw StudyError.unavailable }; offset += count
                }
            }
            guard fsync(temporaryFD) == 0 else { throw StudyError.unavailable }
            try control.check()
            try verifyDirectory(fd, path: path)
            let target = event.id + ".json"
            guard renameatx_np(fd, temporary, fd, target, UInt32(RENAME_EXCL)) == 0 else {
                if errno == EEXIST, let prior = try? readFile(fd: fd, name: target), (try? StudyEvent.decode(prior)) == event {
                    return try scan(root: root, boardID: boardID, control: control)
                }
                throw StudyError.conflict
            }
            _ = fsync(fd)
            // If the response is lost, the UI retries this exact event identity.
            return try scan(root: root, boardID: boardID, control: control)
        }
    }
    private static func validateImages(_ paths: [String], root: URL, control: StudyIOControl) throws {
        for path in paths {
            try control.check()
            guard VaultPath.isSafeRelative(path) else { throw StudyError.unsafePath }
            var fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard fd >= 0 else { throw StudyError.unavailable }
            defer { close(fd) }
            let parts = path.split(separator: "/")
            for (index, part) in parts.enumerated() {
                let next = openat(fd, String(part), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (index < parts.count - 1 ? O_DIRECTORY : 0))
                guard next >= 0 else { throw StudyError.unavailable }; close(fd); fd = next
            }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= 8 * 1024 * 1024 else { throw StudyError.unavailable }
            var bytes = Data(count: Int(info.st_size))
            try bytes.withUnsafeMutableBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    try control.check()
                    let read = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    guard read > 0 else { throw StudyError.unavailable }; offset += read
                }
            }
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width <= 8192, height <= 8192, Double(width) * Double(height) <= 16 * 1024 * 1024,
                  CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 256] as CFDictionary) != nil else { throw StudyError.unavailable }
        }
    }
    private static func perform<T: Sendable>(root: URL, writing: Bool, body: @escaping @Sendable (URL, StudyIOControl) throws -> T) async throws -> T {
        let control = StudyIOControl()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    let timeout = DispatchWorkItem { control.cancel() }
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30, execute: timeout)
                    defer { timeout.cancel() }
                    let scope = root.startAccessingSecurityScopedResource(); defer { if scope { root.stopAccessingSecurityScopedResource() } }
                    continuation.resume(with: Result {
                        try control.check()
                        guard root.isFileURL else { throw StudyError.unsafePath }
                        let resolved = root.standardizedFileURL.resolvingSymlinksInPath()
                        let coordinator = NSFileCoordinator(); try control.use(coordinator)
                        var error: NSError?, result: Result<T, Error>?
                        func access(_ url: URL) { result = Result {
                            try control.check()
                            guard url.standardizedFileURL.resolvingSymlinksInPath().path == resolved.path else { throw StudyError.conflict }
                            return try body(resolved, control)
                        } }
                        if writing { coordinator.coordinate(writingItemAt: resolved, options: .forMerging, error: &error, byAccessor: access) }
                        else { coordinator.coordinate(readingItemAt: resolved, options: [], error: &error, byAccessor: access) }
                        if let error { throw error }
                        guard let result else { throw StudyError.unavailable }; return try result.get()
                    })
                }
            }
        }, onCancel: { control.cancel() })
    }
    private static func openEvents(root: URL, boardID: UUID, create: Bool) throws -> (Int32, URL) {
        var path = root, fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw StudyError.unsafePath }
        do {
            for part in [".inkspace-study", boardID.uuidString.lowercased(), "events"] {
                if create, mkdirat(fd, part, 0o700) != 0, errno != EEXIST { throw StudyError.unsafePath }
                let next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                if next < 0 {
                    if !create, errno == ENOENT { close(fd); return (-1, path.appendingPathComponent(part)) }
                    throw StudyError.unsafePath
                }
                close(fd); fd = next; path.appendPathComponent(part, isDirectory: true)
            }
            try verifyDirectory(fd, path: path); return (fd, path)
        } catch { close(fd); throw error }
    }
    private static func verifyDirectory(_ fd: Int32, path: URL) throws {
        var descriptor = stat(), namespace = stat()
        guard fstat(fd, &descriptor) == 0, lstat(path.path, &namespace) == 0,
              descriptor.st_dev == namespace.st_dev, descriptor.st_ino == namespace.st_ino,
              (namespace.st_mode & S_IFMT) == S_IFDIR,
              path.resolvingSymlinksInPath().path == path.path else { throw StudyError.conflict }
    }
    private static func readFile(fd: Int32, name: String) throws -> Data {
        let file = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard file >= 0 else { throw StudyError.conflict }; defer { close(file) }
        var first = stat(), last = stat(), named = stat()
        guard fstat(file, &first) == 0, first.st_mode & S_IFMT == S_IFREG, first.st_nlink == 1 else { throw StudyError.unsafePath }
        guard first.st_size >= 0, first.st_size <= 65536 else { throw StudyError.limit }
        var result = Data(count: Int(first.st_size))
        try result.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw StudyError.conflict }; offset += count
            }
        }
        guard fstat(file, &last) == 0, fstatat(fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
              first.st_dev == last.st_dev, first.st_ino == last.st_ino, first.st_size == last.st_size,
              first.st_mtimespec.tv_sec == last.st_mtimespec.tv_sec, first.st_mtimespec.tv_nsec == last.st_mtimespec.tv_nsec,
              named.st_dev == last.st_dev, named.st_ino == last.st_ino else { throw StudyError.conflict }
        return result
    }
    private static func scan(root: URL, boardID: UUID, control: StudyIOControl) throws -> StudySnapshot {
        let (fd, path) = try openEvents(root: root, boardID: boardID, create: false)
        if fd < 0 { return .init(events: [], cards: [], warnings: [], bytes: 0) }
        defer { close(fd) }
        let names = try FileManager.default.contentsOfDirectory(atPath: path.path).filter { !$0.hasPrefix(".pending-") }.sorted()
        guard names.count <= maximumEvents else { throw StudyError.limit }
        var events: [StudyEvent] = [], warnings: [String] = [], bytes = 0
        for name in names {
            try control.check()
            guard name.lowercased().hasSuffix(".json"), let fileID = try? StudyEvent.uuid(String(name.dropLast(5))) else {
                warnings.append(String(localized: "发现无法识别的复习记录，原文件已保留。")); continue
            }
            let data = try readFile(fd: fd, name: name); bytes += data.count
            guard bytes <= maximumBytes else { throw StudyError.limit }
            do {
                let event = try StudyEvent.decode(data)
                guard event.id == fileID, event.boardID == boardID.uuidString.lowercased() else { throw StudyError.invalidEvent }
                events.append(event)
            } catch { warnings.append(String(localized: "部分复习记录无效，原文件已保留。")) }
        }
        try verifyDirectory(fd, path: path)
        guard try FileManager.default.contentsOfDirectory(atPath: path.path).filter({ !$0.hasPrefix(".pending-") }).sorted() == names else { throw StudyError.conflict }
        let grouped = Dictionary(grouping: events, by: \.id)
        var valid: [StudyEvent] = []
        for group in grouped.values {
            if group.dropFirst().contains(where: { $0 != group[0] }) { warnings.append(String(localized: "复习记录标识冲突，已暂停保存。")) }
            else { valid.append(group[0]) }
        }
        return .init(events: valid, cards: try StudyProjection.cards(valid), warnings: warnings, bytes: bytes)
    }
}

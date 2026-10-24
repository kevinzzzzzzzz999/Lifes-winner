import Foundation
import AVFoundation
import Observation

struct BoardSubtitleCue: Sendable {
    let start: Double
    let end: Double
    let text: String
}

struct BoardSubtitleDocument: Sendable {
    let cues: [BoardSubtitleCue]
    let plainText: String?
    private let maximumEnd: [Double]
    init(cues: [BoardSubtitleCue], plainText: String? = nil) {
        self.cues = cues; self.plainText = plainText
        var end = 0.0
        maximumEnd = cues.map { end = max(end, $0.end); return end }
    }
    func text(at seconds: Double) -> String {
        if let plainText { return plainText }
        guard seconds.isFinite, seconds >= 0 else { return "" }
        var lower = 0, upper = cues.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if cues[middle].start <= seconds { lower = middle + 1 } else { upper = middle }
        }
        var index = lower - 1, active: [String] = []
        while index >= 0 && maximumEnd[index] > seconds && active.count < 8 {
            let cue = cues[index]
            if cue.start <= seconds && seconds < cue.end { active.append(cue.text) }
            index -= 1
        }
        return active.reversed().joined(separator: "\n")
    }
}

enum BoardSubtitleError: LocalizedError {
    case unsupported, tooLarge, encoding, malformed, unavailable
    var errorDescription: String? {
        switch self {
        case .unsupported: return String(localized: "请选择 SRT、VTT 或 TXT 字幕文件。")
        case .tooLarge: return String(localized: "字幕读取上限为 2 MB、20 万字符、一万段，每段最多 2000 个字符。")
        case .encoding: return String(localized: "字幕编码无法读取，请另存为 UTF-8 或带字节标记的 UTF-16。")
        case .malformed: return String(localized: "字幕时间码或内容无效；SRT/VTT 需要有效的开始和结束时间。")
        case .unavailable: return String(localized: "字幕暂不可读，请确认文件已下载并重新选择。")
        }
    }
}

enum BoardSubtitleParser {
    static let maximumBytes = 2 * 1024 * 1024
    static func parse(data: Data, fileExtension: String) throws -> BoardSubtitleDocument {
        guard ["srt", "vtt", "txt"].contains(fileExtension.lowercased()) else { throw BoardSubtitleError.unsupported }
        guard data.count <= maximumBytes else { throw BoardSubtitleError.tooLarge }
        let encoding: String.Encoding = data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]) ? .utf16 : .utf8
        guard var text = String(data: data, encoding: encoding) else { throw BoardSubtitleError.encoding }
        if text.first == "\u{feff}" { text.removeFirst() }
        guard !text.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 13].contains($0.value) }) else { throw BoardSubtitleError.encoding }
        text = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw BoardSubtitleError.malformed }
        guard text.unicodeScalars.count <= 200_000 else { throw BoardSubtitleError.tooLarge }
        if fileExtension.lowercased() == "txt" {
            return BoardSubtitleDocument(cues: [], plainText: text)
        }
        if fileExtension.lowercased() == "vtt" {
            let header = text.components(separatedBy: "\n")[0]
            guard header == "WEBVTT" || header.hasPrefix("WEBVTT ") || header.hasPrefix("WEBVTT\t") else { throw BoardSubtitleError.malformed }
        }
        var blocks: [[String]] = [], block: [String] = []
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                if !block.isEmpty { blocks.append(block); block = [] }
            } else { block.append(line) }
        }
        if !block.isEmpty { blocks.append(block) }
        var cues: [BoardSubtitleCue] = []
        for (index, lines) in blocks.enumerated() {
            let first = lines[0].trimmingCharacters(in: .whitespaces)
            if fileExtension.lowercased() == "vtt" {
                if index == 0 && (first == "WEBVTT" || first.hasPrefix("WEBVTT ") || first.hasPrefix("WEBVTT\t")) { continue }
                if first == "NOTE" || first.hasPrefix("NOTE ") || first == "STYLE" || first == "REGION" { continue }
            }
            guard let timingIndex = lines.firstIndex(where: { $0.contains("-->") }), timingIndex <= 1 else { throw BoardSubtitleError.malformed }
            if fileExtension.lowercased() == "srt", timingIndex == 1 {
                let index = lines[0].trimmingCharacters(in: .whitespaces)
                guard !index.isEmpty, index.allSatisfy({ $0.isASCII && $0.isNumber }) else { throw BoardSubtitleError.malformed }
            }
            let timing = lines[timingIndex].components(separatedBy: "-->")
            guard timing.count == 2,
                  let start = timestamp(timing[0].trimmingCharacters(in: .whitespaces)),
                  let endToken = timing[1].split(whereSeparator: \.isWhitespace).first,
                  let end = timestamp(String(endToken)), end > start else { throw BoardSubtitleError.malformed }
            let body = lines.dropFirst(timingIndex + 1).joined(separator: "\n")
                .replacingOccurrences(of: "(?i)</?(b|i|u)>", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty else { throw BoardSubtitleError.malformed }
            guard body.utf16.count <= 2_000, cues.count < 10_000 else { throw BoardSubtitleError.tooLarge }
            cues.append(BoardSubtitleCue(start: start, end: end, text: body))
        }
        guard !cues.isEmpty else { throw BoardSubtitleError.malformed }
        let sorted = cues.enumerated().sorted { $0.element.start == $1.element.start ? $0.offset < $1.offset : $0.element.start < $1.element.start }.map(\.element)
        return BoardSubtitleDocument(cues: sorted)
    }
    private static func timestamp(_ source: String) -> Double? {
        let parts = source.replacingOccurrences(of: ",", with: ".").split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 || parts.count == 3 else { return nil }
        func integer(_ text: Substring) -> Int? {
            guard !text.isEmpty, text.count <= 6, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            return Int(text)
        }
        let fraction = parts.last!.split(separator: ".", omittingEmptySubsequences: false)
        guard fraction.count == 2, let seconds = integer(fraction[0]), seconds < 60,
              (1...3).contains(fraction[1].count), let millis = integer(fraction[1]),
              let minutes = integer(parts[parts.count - 2]), minutes < 60 else { return nil }
        let hours: Int
        if parts.count == 3 { guard let value = integer(parts[0]) else { return nil }; hours = value } else { hours = 0 }
        return Double(hours) * 3600 + Double(minutes) * 60 + Double(seconds) + Double(millis) / pow(10, Double(fraction[1].count))
    }
}

private final class SubtitleReadControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var coordinator: NSFileCoordinator?
    func cancel() { lock.lock(); cancelled = true; let coordinator = coordinator; lock.unlock(); coordinator?.cancel() }
    func install(_ value: NSFileCoordinator) throws {
        lock.lock(); let stopped = cancelled; if !stopped { coordinator = value }; lock.unlock()
        if stopped { throw CancellationError() }
    }
    func check() throws { lock.lock(); let stopped = cancelled; lock.unlock(); if stopped { throw CancellationError() } }
}

@MainActor @Observable final class BoardVideoSubtitles {
    private(set) var text = ""
    private(set) var transcriptLines: [String] = []
    private(set) var filename: String?
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var enabled = true
    private(set) var hasPendingChange = false
    private(set) var persistenceMessage: String?
    private(set) var associationReady = false
    private(set) var errorMessage: String?
    private(set) var currentTime = 0.0
    private(set) var duration = 0.0
    private(set) var isPlaying = false
    @ObservationIgnored private var document: BoardSubtitleDocument?
    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var observer: Any?
    @ObservationIgnored private var jumpObserver: NSObjectProtocol?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var associationLoadTask: Task<(String, BoardSubtitleAssociationSnapshot), Error>?
    @ObservationIgnored private var loadID = UUID()
    @ObservationIgnored private var playerID = UUID()
    @ObservationIgnored private var associationStore: BoardSubtitleAssociationStore?
    @ObservationIgnored private var associationIdentity: String?
    @ObservationIgnored private var associationSHA: String?
    @ObservationIgnored private var source: BoardSubtitleSource?
    @ObservationIgnored private var contextID = UUID()
    @ObservationIgnored private var usesAssociation = false
    private struct Pending {
        let id = UUID()
        let source: BoardSubtitleSource?
        let expectedSHA: String?
    }
    // Retain the complete imported text after a failed/unfinished save even if
    // its player is closed. These are retries, never silently auto-published.
    private static var pendingChanges: [String: Pending] = [:]
    private static var activeSaves: Set<String> = []
    private static let savedNotification = Notification.Name("InkSpace.subtitle-association-completed")
    @ObservationIgnored private var associationObserver: NSObjectProtocol?

    func bind(_ request: BoardVideoRequest) async {
        loadTask?.cancel(); associationLoadTask?.cancel(); loadID = UUID(); contextID = UUID()
        if let associationObserver { NotificationCenter.default.removeObserver(associationObserver) }; associationObserver = nil
        let context = contextID
        usesAssociation = true; associationReady = false; isLoading = true
        document = nil; source = nil; text = ""; filename = nil; transcriptLines = []
        errorMessage = nil; persistenceMessage = nil; hasPendingChange = false
        let repository = BoardSubtitleAssociationStore(rootURL: request.rootURL, videoPath: request.relativePath)
        associationStore = repository; associationIdentity = nil; associationSHA = nil
        let task = Task {
            let identity = try await repository.identity()
            return (identity, try await repository.load())
        }
        associationLoadTask = task
        do {
            let (identity, snapshot) = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: { task.cancel() }
            guard contextID == context else { return }
            try Task.checkCancellation()
            associationLoadTask = nil
            associationIdentity = identity
            associationObserver = NotificationCenter.default.addObserver(forName: Self.savedNotification, object: nil, queue: .main) { [weak self] event in
                guard event.object as? String == identity else { return }
                Task { @MainActor in await self?.finishedPendingSave(identity: identity, context: context) }
            }
            associationIdentity = identity; associationSHA = snapshot.sha256; associationReady = true; isLoading = false
            try apply(snapshot.subtitle)
            hasPendingChange = Self.pendingChanges[identity] != nil
            isSaving = Self.activeSaves.contains(identity)
            if hasPendingChange && !isSaving { errorMessage = BoardSubtitleAssociationError.unavailable.errorDescription }
            else if snapshot.subtitle != nil { persistenceMessage = String(localized: "已加载保存的字幕。") }
        } catch {
            guard contextID == context else { return }
            associationLoadTask = nil; isLoading = false
            if !(error is CancellationError) { errorMessage = associationError(error, reading: true) }
        }
    }


    private func finishedPendingSave(identity: String, context: UUID) async {
        guard contextID == context, associationIdentity == identity, !Self.activeSaves.contains(identity), let repository = associationStore else { return }
        isSaving = false
        hasPendingChange = Self.pendingChanges[identity] != nil
        if hasPendingChange {
            if errorMessage == nil { errorMessage = BoardSubtitleAssociationError.unavailable.errorDescription }
            return
        }
        do {
            let saved = try await repository.load()
            guard contextID == context else { return }
            associationSHA = saved.sha256; try apply(saved.subtitle)
        } catch { guard contextID == context else { return }; errorMessage = associationError(error, reading: true) }
    }
    private func apply(_ source: BoardSubtitleSource?) throws {
        let parsed = try source?.validated()
        self.source = source; document = parsed; filename = source?.name; enabled = source?.enabled ?? true
        transcriptLines = enabled ? parsed?.plainText?.components(separatedBy: "\n") ?? [] : []
        update()
    }

    private func associationError(_ error: Error, reading: Bool = false) -> String {
        if let error = error as? BoardSubtitleAssociationError {
            switch error {
            case .malformed, .conflict, .pendingLimit: return error.errorDescription ?? ""
            case .timedOut: return (reading ? error : .unavailable).errorDescription ?? ""
            case .unavailable, .readUnavailable: break
            }
        }
        if let error = error as? BoardSubtitleError { return error.errorDescription ?? "" }
        return (reading ? BoardSubtitleAssociationError.readUnavailable : .unavailable).errorDescription ?? ""
    }

    func setEnabled(_ value: Bool) {
        guard !isSaving, let source else { return }
        persist(BoardSubtitleSource(name: source.name, text: source.text, enabled: value))
    }
    func removeAssociation() { guard !isSaving else { return }; persist(nil) }
    func retrySave() {
        guard !isSaving, let identity = associationIdentity, let pending = Self.pendingChanges[identity] else { return }
        submit(pending, identity: identity)
    }
    func discardPendingAndReload(_ request: BoardVideoRequest) async {
        guard !isSaving else { return }
        if let identity = associationIdentity { Self.pendingChanges.removeValue(forKey: identity) }
        await bind(request)
    }
    func cancelLoading() {
        loadID = UUID(); loadTask?.cancel(); loadTask = nil
        associationLoadTask?.cancel(); associationLoadTask = nil; isLoading = false
    }

    private func persist(_ proposed: BoardSubtitleSource?) {
        guard !isSaving else { return }
        guard associationReady, let identity = associationIdentity else {
            errorMessage = BoardSubtitleAssociationError.readUnavailable.errorDescription; return
        }
        guard Self.pendingChanges[identity] != nil || Self.pendingChanges.count < 16 else {
            errorMessage = BoardSubtitleAssociationError.pendingLimit.errorDescription; return
        }
        let pending = Pending(source: proposed, expectedSHA: associationSHA)
        Self.pendingChanges[identity] = pending; hasPendingChange = true
        submit(pending, identity: identity)
    }
    private func submit(_ pending: Pending, identity: String) {
        guard let repository = associationStore else { return }
        guard !Self.activeSaves.contains(identity) else { isSaving = true; return }
        Self.activeSaves.insert(identity)
        let context = contextID
        isSaving = true; errorMessage = nil; persistenceMessage = nil
        // Intentionally not assigned to loadTask: closing/cancelling playback
        // cannot cancel an already-authorized atomic subtitle association save.
        Task { [self] in
            defer {
                Self.activeSaves.remove(identity)
                NotificationCenter.default.post(name: Self.savedNotification, object: identity)
            }
            do {
                let saved = try await repository.save(pending.source, expectedSHA256: pending.expectedSHA)
                if Self.pendingChanges[identity]?.id == pending.id { Self.pendingChanges.removeValue(forKey: identity) }
                guard contextID == context else { return }
                associationSHA = saved.sha256; try apply(saved.subtitle)
                isSaving = false; hasPendingChange = false
                persistenceMessage = saved.subtitle == nil ? String(localized: "字幕关联已移除。")
                    : saved.subtitle?.enabled == false ? String(localized: "字幕已隐藏，下次打开保持隐藏。")
                    : String(localized: "字幕已保存，下次打开会自动加载。")
            } catch {
                DiagnosticsCenter.shared.record(code: .fileOperationFailed, operation: .fileAccess, error: error, severity: .warning)
                guard contextID == context else { return }
                isSaving = false; hasPendingChange = true; errorMessage = associationError(error)
            }
        }
    }
    func attach(_ player: AVPlayer?) {
        detachPlayer()
        self.player = player
        guard let player else { update(); return }
        let id = playerID
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self, self.playerID == id else { return }; self.update() }
        }
        jumpObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemTimeJumped, object: player.currentItem, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self, self.playerID == id else { return }; self.update() }
        }
        update()
    }
    private func detachPlayer() {
        playerID = UUID()
        if let observer { player?.removeTimeObserver(observer) }; observer = nil
        if let jumpObserver { NotificationCenter.default.removeObserver(jumpObserver) }; jumpObserver = nil
        player = nil
    }
    private func update() {
        let time = player?.currentTime().seconds ?? 0, length = player?.currentItem?.duration.seconds ?? 0
        currentTime = time.isFinite ? max(0, time) : 0
        duration = length.isFinite ? max(0, length) : 0
        isPlaying = (player?.rate ?? 0) > 0
        text = enabled && document?.plainText == nil ? document?.text(at: currentTime) ?? "" : ""
    }
    func load(_ url: URL) {
        guard !isSaving, !usesAssociation || associationReady else { return }
        loadTask?.cancel(); let id = UUID(); loadID = id; isLoading = true; errorMessage = nil; persistenceMessage = nil
        loadTask = Task { [weak self] in
            do {
                let source = try await Self.readSource(url)
                try Task.checkCancellation()
                guard let self, self.loadID == id else { return }
                self.isLoading = false
                if self.usesAssociation { self.persist(source) }
                else { try self.apply(source) }
            } catch is CancellationError { }
            catch {
                guard let self, self.loadID == id else { return }
                self.isLoading = false; self.errorMessage = (error as? BoardSubtitleError)?.errorDescription ?? BoardSubtitleError.unavailable.errorDescription
            }
        }
    }
    func clear() {
        loadID = UUID(); loadTask?.cancel(); loadTask = nil
        associationLoadTask?.cancel(); associationLoadTask = nil
        document = nil; source = nil; filename = nil; errorMessage = nil; text = ""; transcriptLines = []; isLoading = false
    }
    func stop() {
        contextID = UUID(); clear(); detachPlayer(); update()
        if let associationObserver { NotificationCenter.default.removeObserver(associationObserver) }; associationObserver = nil
        associationStore = nil; associationIdentity = nil; associationSHA = nil; associationReady = false
        isSaving = false; hasPendingChange = false; persistenceMessage = nil
    }
    nonisolated static func read(_ url: URL) async throws -> BoardSubtitleDocument { try await readSource(url).validated() }
    nonisolated static func readSource(_ url: URL) async throws -> BoardSubtitleSource {
        let control = SubtitleReadControl()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = Result {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        try control.check(); let coordinator = NSFileCoordinator(); try control.install(coordinator)
                        var coordinationError: NSError?, readResult: Result<BoardSubtitleSource, Error>?
                        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { readable in
                            readResult = Result {
                                try control.check()
                                let values = try readable.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
                                guard values.isRegularFile == true, values.isSymbolicLink != true else { throw BoardSubtitleError.unavailable }
                                guard let size = values.fileSize, size <= BoardSubtitleParser.maximumBytes else { throw BoardSubtitleError.tooLarge }
                                let handle = try FileHandle(forReadingFrom: readable); defer { try? handle.close() }
                                let data = try handle.read(upToCount: BoardSubtitleParser.maximumBytes + 1) ?? Data()
                                try control.check()
                                let encoding: String.Encoding = data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]) ? .utf16 : .utf8
                                guard let text = String(data: data, encoding: encoding) else { throw BoardSubtitleError.encoding }
                                let source = BoardSubtitleSource(name: url.lastPathComponent, text: text, enabled: true)
                                _ = try source.validated()
                                return source
                            }
                        }
                        try control.check()
                        if let coordinationError { throw coordinationError }
                        guard let readResult else { throw BoardSubtitleError.unavailable }
                        return try readResult.get()
                    }
                    continuation.resume(with: result)
                }
            }
        } onCancel: { control.cancel() }
    }
}

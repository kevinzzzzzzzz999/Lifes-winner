import Foundation
import AVFoundation
import Observation
import UIKit

/// Existing schema-1 document cards remain readable by older clients.
enum BoardVideo {
    static let extensions: Set<String> = ["mp4", "mov", "m4v"]
    static func isVideo(path: String?) -> Bool {
        path.map { extensions.contains(($0 as NSString).pathExtension.lowercased()) } ?? false
    }
    static func isVideo(_ item: BoardItem) -> Bool { item.kind == .document && isVideo(path: item.sourcePath) }
}

struct BoardVideoRequest: Identifiable {
    let id = UUID()
    let rootURL: URL
    let relativePath: String
    let title: String
}

enum BoardVideoError: LocalizedError {
    case unavailable, outsideVault, unsupported, timedOut, cannotExpand, audioUnavailable
    var errorDescription: String? {
        switch self {
        case .audioUnavailable: return String(localized: "视频声音未能启用，请关闭其他播放后重试，并检查系统音量与输出设备。")
        case .unavailable: return String(localized: "视频暂不可用，请确认原文件已下载并重新授权文件夹。")
        case .outsideVault: return String(localized: "请先将视频放入已授权的仓库文件夹，再添加视频卡片；不会自动复制视频。")
        case .unsupported: return String(localized: "无法播放此视频编码。请使用此设备支持的 MP4、MOV 或 M4V 文件。")
        case .cannotExpand: return String(localized: "视频可直接播放，不能展开为 PDF 页面。")
        case .timedOut: return String(localized: "视频加载超时，请检查下载状态后重试。")
        }
    }
}

/// The original security-scoped directory URL is retained for the whole playback.
final class BoardVideoLease: @unchecked Sendable {
    let rootURL: URL
    let acquired: Bool
    let url: URL
    init(rootURL: URL, relativePath: String) throws {
        self.rootURL = rootURL
        acquired = rootURL.startAccessingSecurityScopedResource()
        do { url = try Self.resolve(rootURL: rootURL, relativePath: relativePath) }
        catch { if acquired { rootURL.stopAccessingSecurityScopedResource() }; throw error }
    }
    deinit { if acquired { rootURL.stopAccessingSecurityScopedResource() } }

    static func resolve(rootURL: URL, relativePath: String) throws -> URL {
        guard BoardVideo.isVideo(path: relativePath),
              let resolved = VaultPathResolver.resolve(relativePath: relativePath, within: rootURL) else {
            throw BoardVideoError.outsideVault
        }
        // Never follow even an in-vault symbolic link for a streaming resource.
        var current = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        for component in relativePath.split(separator: "/") {
            current.appendPathComponent(String(component))
            let values = try current.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw BoardVideoError.outsideVault }
        }
        let values = try resolved.resourceValues(forKeys: [.isRegularFileKey])
        guard values.isRegularFile == true else { throw BoardVideoError.unavailable }
        return resolved
    }
}

private final class VideoReadControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var coordinator: NSFileCoordinator?
    func cancel() { lock.lock(); cancelled = true; let value = coordinator; lock.unlock(); value?.cancel() }
    func install(_ value: NSFileCoordinator) throws {
        lock.lock(); let stopped = cancelled; if !stopped { coordinator = value }; lock.unlock()
        if stopped { value.cancel(); throw CancellationError() }
    }
    func check() throws { lock.lock(); let stopped = cancelled; lock.unlock(); if stopped { throw CancellationError() } }
}

@MainActor @Observable
final class BoardVideoPlayback {
    private(set) var player: AVPlayer?
    private(set) var isLoading = false
    private(set) var isPlaying = false
    private(set) var errorMessage: String?
    private static weak var activeSession: BoardVideoPlayback?
    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored private let recordFailure: @MainActor (Error) -> Void
    @ObservationIgnored private var lease: BoardVideoLease?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var timeout: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var itemObservation: NSKeyValueObservation?
    @ObservationIgnored private var timeObservation: NSKeyValueObservation?
    @ObservationIgnored private var audioActivated = false
    @ObservationIgnored private var previousAudio: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
    var ownsPlaybackAudio: Bool { audioActivated && Self.activeSession === self }
    /// Explicit speech playback takes over from video. Stop the old owner
    /// before configuring spokenAudio so it cannot deactivate the new session.
    static func stopForReadAloud() { activeSession?.stop() }
    private func activateAudio() throws {
        guard Self.activeSession === self else { throw CancellationError() }
        BoardReadAloudController.pauseForVideo()
        let audio = AVAudioSession.sharedInstance()
        if !audioActivated { previousAudio = (audio.category, audio.mode, audio.categoryOptions) }
        do {
            // Explicit media playback should remain audible when the device's
            // silent switch is on. This does not alter system volume or routing.
            try audio.setCategory(.playback, mode: .moviePlayback)
            try audio.setActive(true)
            audioActivated = true
        } catch {
            if let previousAudio { try? audio.setCategory(previousAudio.0, mode: previousAudio.1, options: previousAudio.2) }
            previousAudio = nil
            throw BoardVideoError.audioUnavailable
        }
    }
    private func releaseAudio() {
        guard audioActivated else { return }
        audioActivated = false
        guard Self.activeSession === self else { previousAudio = nil; return }
        let audio = AVAudioSession.sharedInstance()
        if audio.category == .playback, audio.mode == .moviePlayback {
            try? audio.setActive(false, options: .notifyOthersOnDeactivation)
            if let previousAudio { try? audio.setCategory(previousAudio.0, mode: previousAudio.1, options: previousAudio.2) }
        }
        previousAudio = nil
    }

    init(recordFailure: (@MainActor (Error) -> Void)? = nil) {
        self.recordFailure = recordFailure ?? { DiagnosticsCenter.shared.record(code: .fileOperationFailed, operation: .fileAccess, error: $0) }
    }
    deinit {
        task?.cancel(); timeout?.cancel()
    }

    /// Called only by an explicit play/open action. Merely displaying a card does no AV I/O.
    func start(_ request: BoardVideoRequest) {
        if Self.activeSession !== self { Self.activeSession?.stop() }
        stop()
        Self.activeSession = self
        let token = UUID(); generation = token
        isLoading = true; errorMessage = nil; onChange?()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled, let self, self.generation == token, self.isLoading else { return }
            self.fail(BoardVideoError.timedOut)
        }
        task = Task { [weak self] in
            do {
                let lease = try await Self.prepare(request)
                try Task.checkCancellation()
                let asset = AVURLAsset(url: lease.url)
                guard try await asset.load(.isPlayable) else { throw BoardVideoError.unsupported }
                try Task.checkCancellation()
                guard let self, self.generation == token else { return }
                self.lease = lease
                let item = AVPlayerItem(asset: asset)
                let player = AVPlayer(playerItem: item)
                try self.activateAudio()
                player.isMuted = false
                player.volume = 1
                // The existing audio background mode permits explicit video playback
                // to continue audibly; closing the owner still releases the session.
                player.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
                player.preventsDisplaySleepDuringVideoPlayback = true
                self.player = player
                self.itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
                    Task { @MainActor in
                        guard let self, self.generation == token, let item else { return }
                        if item.status == .failed { self.fail(BoardVideoError.unsupported) }
                        else if item.status == .readyToPlay { self.isLoading = false; self.timeout?.cancel(); self.onChange?() }
                    }
                }
                self.timeObservation = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self, weak player] _, _ in
                    Task { @MainActor in
                        guard let self, self.generation == token, let player else { return }
                        self.isPlaying = player.timeControlStatus == .playing
                        if player.timeControlStatus == .paused { self.releaseAudio() }
                        else if !self.audioActivated {
                            do { try self.activateAudio() } catch { self.fail(error); return }
                        }
                        self.onChange?()
                    }
                }
                player.play()
                self.onChange?()
            } catch is CancellationError { }
            catch {
                guard let self, self.generation == token else { return }
                self.fail(error)
            }
        }
    }

    /// Text selection freezes the current timeline without changing speed preferences.
    func pauseForTextSelection() {
        player?.pause(); releaseAudio()
    }

    func toggle(_ request: BoardVideoRequest) {
        guard let player else { if isLoading { stop() } else { start(request) }; return }
        if player.rate > 0 { player.pause(); releaseAudio() }
        else {
            if let item = player.currentItem, item.duration.seconds.isFinite,
               player.currentTime().seconds >= item.duration.seconds { player.seek(to: .zero) }
            do { try activateAudio(); player.play() } catch { fail(error) }
        }
    }

    func stop() {
        generation = UUID()
        task?.cancel(); task = nil; timeout?.cancel(); timeout = nil
        itemObservation = nil; timeObservation = nil
        player?.pause(); player?.replaceCurrentItem(with: nil); player = nil
        lease = nil; isLoading = false; isPlaying = false; errorMessage = nil
        releaseAudio()
        if Self.activeSession === self { Self.activeSession = nil }
        onChange?()
    }

    private func fail(_ error: Error) {
        stop()
        errorMessage = (error as? BoardVideoError)?.errorDescription ?? BoardVideoError.unavailable.errorDescription
        recordFailure(error)
        onChange?()
    }

    private static func prepare(_ request: BoardVideoRequest) async throws -> BoardVideoLease {
        let control = VideoReadControl()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = Result {
                        try control.check()
                        let lease = try BoardVideoLease(rootURL: request.rootURL, relativePath: request.relativePath)
                        let coordinator = NSFileCoordinator()
                        try control.install(coordinator)
                        var coordinationError: NSError?
                        var readError: Error?
                        coordinator.coordinate(readingItemAt: lease.url, options: [], error: &coordinationError) { readable in
                            do {
                                try control.check()
                                let resolved = try BoardVideoLease.resolve(rootURL: request.rootURL, relativePath: request.relativePath)
                                guard readable.standardizedFileURL.resolvingSymlinksInPath() == resolved else { throw BoardVideoError.outsideVault }
                                // No entire-file read/copy or retained coordinator while AVPlayer streams.
                                let handle = try FileHandle(forReadingFrom: readable)
                                try handle.close()
                            } catch { readError = error }
                        }
                        try control.check()
                        if let error = coordinationError ?? readError { throw error }
                        return lease
                    }
                    continuation.resume(with: result)
                }
            }
        } onCancel: { control.cancel() }
    }
}

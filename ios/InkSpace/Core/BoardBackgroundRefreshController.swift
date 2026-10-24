import Foundation
import Observation
import UIKit
import BackgroundTasks
import Darwin

/// BGAppRefresh is a system-scheduled opportunity, not a persistent process.
/// SwiftUI completes its registered task when the async handler returns and
/// cancels it on expiration. No audio/location mode or file-protection change.
/// https://developer.apple.com/documentation/swiftui/scene/backgroundtask(_:action:)
@MainActor protocol BoardRefreshScheduling {
    func hasPendingRequest(identifier: String) async -> Bool
    func submit(identifier: String, earliest: Date) throws
}

@MainActor struct BoardSystemRefreshScheduler: BoardRefreshScheduling {
    func hasPendingRequest(identifier: String) async -> Bool {
        await withCheckedContinuation { continuation in
            BGTaskScheduler.shared.getPendingTaskRequests { requests in
                continuation.resume(returning: requests.contains { $0.identifier == identifier })
            }
        }
    }
    func submit(identifier: String, earliest: Date) throws {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = earliest
        try BGTaskScheduler.shared.submit(request)
    }
}

@MainActor @Observable final class BoardBackgroundRefreshController {
    static let shared = BoardBackgroundRefreshController()
    static let taskIdentifier = "org.inkspace.app.board-refresh"
    static let minimumDelay: TimeInterval = 15 * 60
    private(set) var status = String(localized: "返回前台或解锁后会检查当前白板；后台检查时间由系统决定。")
    private(set) var foregroundRefreshPending = false
    @ObservationIgnored private var active = false
    @ObservationIgnored private var hasBeenActive = false
    @ObservationIgnored private var leaveSaveIssued = false
    @ObservationIgnored private var refreshEpoch = 0
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var scheduling = false
    @ObservationIgnored private var systemRefreshRunning = false
    @ObservationIgnored private var foregroundRestoreTask: Task<Void, Never>?
    @ObservationIgnored private var restoredForForeground = false
    @ObservationIgnored private let scheduler: any BoardRefreshScheduling
    @ObservationIgnored private let protectedDataAvailable: @MainActor () -> Bool
    @ObservationIgnored private let saveBackground: @MainActor (BoardStore) -> Void
    @ObservationIgnored private let restoreForeground: @MainActor (BoardStore) async -> Void
    @ObservationIgnored private let prefetch = BoardCurrentFilePrefetcher()

    init(scheduler: (any BoardRefreshScheduling)? = nil,
         protectedDataAvailable: @escaping @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable },
         saveBackground: @escaping @MainActor (BoardStore) -> Void = { $0.saveForBackground() },
         restoreForeground: @escaping @MainActor (BoardStore) async -> Void = {
             await $0.boardCatalog.load(); await DiagnosticsCenter.shared.refresh(); await $0.restoreVault()
         }) {
        self.scheduler = scheduler ?? BoardSystemRefreshScheduler(); self.protectedDataAvailable = protectedDataAvailable
        self.saveBackground = saveBackground
        self.restoreForeground = restoreForeground
    }

    func enteredForeground(store: BoardStore) {
        active = true; hasBeenActive = true; leaveSaveIssued = false
        if protectedDataAvailable() { store.retryPendingAutosave() }
        requestForegroundRefresh(store: store)
    }
    func leftForeground(store: BoardStore) {
        active = false
        guard hasBeenActive, !leaveSaveIssued else { return }
        leaveSaveIssued = true
        saveBackground(store)
    }
    func protectedDataBecameAvailable(store: BoardStore) {
        if active { store.retryPendingAutosave() }
        requestForegroundRefresh(store: store)
        Task { await restoreForForegroundIfNeeded(store: store); await retryForegroundRefresh(store: store) }
    }
    func restoreForForegroundIfNeeded(store: BoardStore) async {
        guard active, protectedDataAvailable(), !restoredForForeground else { return }
        if let task = foregroundRestoreTask { await task.value; return }
        if store.vaultURL != nil { restoredForForeground = true; return }
        // The caller's scene task may be cancelled by a quick app switch. The
        // one foreground-started restore retains its target and finishes once;
        // a later foreground waits for it instead of attaching a second time.
        let task = Task { [self] in
            await restoreForeground(store)
            restoredForForeground = store.vaultURL != nil || !store.hasRememberedWindowLocation
            foregroundRestoreTask = nil
        }
        foregroundRestoreTask = task
        await task.value
    }
    func requestForegroundRefresh(store: BoardStore) {
        foregroundRefreshPending = true; refreshEpoch += 1
        Task { await retryForegroundRefresh(store: store) }
    }
    func retryForegroundRefresh(store: BoardStore) async {
        guard active, foregroundRefreshPending, !refreshing, protectedDataAvailable(),
              store.canRefreshForLifecycle, !Task.isCancelled else { return }
        refreshing = true; defer { refreshing = false }
        let epoch = refreshEpoch, url = store.boardURL
        // Never materialize an entire folder or all of a board's linked assets.
        if let root = store.vaultURL, let url, let path = store.relativePath(for: url) {
            _ = try? await prefetch.requestCurrentFile(root: root, path: path)
        }
        guard active, protectedDataAvailable(), !Task.isCancelled, store.boardURL == url,
              store.canRefreshForLifecycle else { return }
        let loaded = await store.refreshExternalChanges(force: true)
        if loaded, epoch == refreshEpoch, active, store.boardURL == url {
            foregroundRefreshPending = false
            status = String(localized: "已检查当前白板；尚未到达的 iCloud 更改仍需等待。")
        }
    }
    func scheduleNextRefresh() async {
        guard !scheduling, !Task.isCancelled else { return }
        scheduling = true; defer { scheduling = false }
        // Preserve the original earliest date rather than postponing it on each
        // inactive/background notification or repeated app switch.
        if await scheduler.hasPendingRequest(identifier: Self.taskIdentifier) { return }
        guard !Task.isCancelled else { return }
        do {
            try scheduler.submit(identifier: Self.taskIdentifier, earliest: Date().addingTimeInterval(Self.minimumDelay))
            status = String(localized: "已请求系统择机检查当前白板；不保证固定间隔或熄屏实时更新。")
        } catch {
            status = String(localized: "系统暂未允许后台刷新；返回前台后仍会检查更新。")
        }
    }
    func performSystemRefresh(store: BoardStore, defaults: UserDefaults = .standard) async {
        guard !systemRefreshRunning else { return }
        systemRefreshRunning = true; defer { systemRefreshRunning = false }
        // The request being delivered is no longer pending. Schedule its next
        // opportunity before bounded work; cancellation never starts new work.
        await scheduleNextRefresh()
        guard !Task.isCancelled, protectedDataAvailable() else { return }
        do {
            if let root = store.vaultURL, let url = store.boardURL, let path = store.relativePath(for: url) {
                let preloaded = try await prefetch.requestCurrentFile(root: root, path: path)
                guard !Task.isCancelled, protectedDataAvailable(), store.boardURL == url,
                      store.canRefreshForLifecycle else {
                    if !Task.isCancelled { status = String(localized: "当前编辑或文件状态暂不允许刷新；返回前台后会重试。") }
                    return
                }
                // Only the already-open board is decoded; cold launches still prefetch
                // one bounded leaf below. Accommodates the 64 MiB desktop conversion cap.
                let refreshed = await store.refreshExternalChanges(force: true, includeLinkedAssets: false,
                                                                    maximumReadBytes: 64 * 1024 * 1024)
                guard !Task.isCancelled else { return }
                status = refreshed
                    ? String(localized: "已检查当前白板；尚未到达的 iCloud 更改仍需等待。")
                    : (preloaded.requestedDownload ? String(localized: "已请求当前白板文件；下载和可用更新仍需等待系统处理。")
                        : String(localized: "当前编辑或文件状态暂不允许刷新；返回前台后会重试。"))
            } else if let bookmark = defaults.data(forKey: "vaultBookmark"),
                      let path = defaults.string(forKey: "lastBoardPath") {
                // A background-only cold launch must not restoreVault/attachVault,
                // rebuild a catalog, decode PencilKit, or load linked documents.
                _ = try await prefetch.requestLastFile(bookmark: bookmark, path: path)
                if !Task.isCancelled { status = String(localized: "已请求当前白板文件；下载和可用更新仍需等待系统处理。") }
            }
        } catch is CancellationError { }
        catch { status = String(localized: "后台文件暂不可用；解锁或返回前台后会重试。") }
    }
}

/// Metadata/materialization and an optional 64 KiB coordinated read of exactly
/// one current board. Actor isolation keeps provider I/O off the main thread.
actor BoardCurrentFilePrefetcher {
    struct Result: Equatable { let requestedDownload: Bool; let bytesRead: Int }
    private let requestDownload: @Sendable (URL) throws -> Void
    init(requestDownload: @escaping @Sendable (URL) throws -> Void = { try FileManager.default.startDownloadingUbiquitousItem(at: $0) }) {
        self.requestDownload = requestDownload
    }
    func requestLastFile(bookmark: Data, path: String) throws -> Result {
        try Task.checkCancellation()
        var stale = false
        let root = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        return try requestCurrentFile(root: root, path: path)
    }
    func requestCurrentFile(root: URL, path: String) throws -> Result {
        try Task.checkCancellation()
        guard VaultPath.isSafeRelative(path), path.lowercased().hasSuffix(".inkspace.json"), root.isFileURL else { throw VaultWriteError.unavailable }
        let scope = root.startAccessingSecurityScopedResource()
        defer { if scope { root.stopAccessingSecurityScopedResource() } }
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
        var url = canonicalRoot
        let components = path.split(separator: "/")
        var missingLeaf = false
        for (index, component) in components.enumerated() {
            try Task.checkCancellation()
            url.appendPathComponent(String(component))
            let attributes: [FileAttributeKey: Any]
            do { attributes = try FileManager.default.attributesOfItem(atPath: url.path) }
            catch {
                let e = error as NSError
                guard index == components.count - 1, e.domain == NSCocoaErrorDomain,
                      [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(e.code) else { throw error }
                missingLeaf = true; break
            }
            guard attributes[.type] as? FileAttributeType != .typeSymbolicLink else { throw VaultWriteError.unavailable }
            if index < components.count - 1 {
                guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw VaultWriteError.unavailable }
            }
        }
        // A cloud-only leaf can have no local inode yet. Ask the system about
        // exactly that authorized path without inventing an empty local file.
        if missingLeaf {
            try Task.checkCancellation(); try requestDownload(url)
            return Result(requestedDownload: true, bytesRead: 0)
        }
        guard let safe = VaultPathResolver.resolve(relativePath: path, within: canonicalRoot), safe == url else { throw VaultWriteError.unavailable }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else { throw VaultWriteError.unavailable }
        let values = try url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
        if values.isUbiquitousItem == true {
            try Task.checkCancellation()
            try requestDownload(url)
            if values.ubiquitousItemDownloadingStatus != .current && values.ubiquitousItemDownloadingStatus != .downloaded {
                return Result(requestedDownload: true, bytesRead: 0)
            }
        }
        try Task.checkCancellation()
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var error: NSError?, count = 0
        var failure: Error?
        coordinator.coordinate(readingItemAt: url, options: .withoutChanges, error: &error) { target in
            do {
                try Task.checkCancellation()
                guard target.standardizedFileURL.resolvingSymlinksInPath() == url else { throw VaultWriteError.unavailable }
                // Walk directory descriptors so an uncoordinated symlink swap
                // cannot redirect the bounded read outside its authorized root.
                var fd = Darwin.open(canonicalRoot.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
                guard fd >= 0 else { throw VaultWriteError.unavailable }
                defer { Darwin.close(fd) }
                for (index, component) in components.enumerated() {
                    let flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | (index < components.count - 1 ? O_DIRECTORY : 0)
                    let next = String(component).withCString { Darwin.openat(fd, $0, flags) }
                    guard next >= 0 else { throw VaultWriteError.unavailable }
                    Darwin.close(fd); fd = next
                }
                var statBefore = stat()
                guard fstat(fd, &statBefore) == 0, (statBefore.st_mode & S_IFMT) == S_IFREG, statBefore.st_nlink == 1 else { throw VaultWriteError.unavailable }
                let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
                count = try handle.read(upToCount: 64 * 1024)?.count ?? 0
                try Task.checkCancellation()
            } catch { failure = error }
        }
        if let error { throw error }; if let failure { throw failure }
        return Result(requestedDownload: values.isUbiquitousItem == true, bytesRead: count)
    }
}

import Foundation
import Observation

/// Fixed identifiers only. Never use filenames, document text, URLs, or server bodies as diagnostic fields.
enum DiagnosticCode: String, Codable, CaseIterable, Sendable {
    case vaultAccessFailed, boardOpenFailed, boardCreateFailed, boardSaveFailed, boardConflict
    case pdfWritebackFailed, previewExportFailed, documentImportFailed, documentRenderFailed
    case sourceEditFailed, backupFailed, exportFailed, aiRequestFailed, settingsFailed, fileOperationFailed, catalogFailed

    var title: String {
        switch self {
        case .vaultAccessFailed: String(localized: "仓库连接未完成")
        case .boardOpenFailed: String(localized: "白板打开未完成")
        case .boardCreateFailed: String(localized: "白板创建未完成")
        case .boardSaveFailed: String(localized: "白板保存未完成")
        case .boardConflict: String(localized: "检测到外部修改或保存冲突")
        case .pdfWritebackFailed: String(localized: "PDF 批注同步未完成")
        case .previewExportFailed: String(localized: "白板预览更新未完成")
        case .documentImportFailed: String(localized: "资料添加未完成")
        case .documentRenderFailed: String(localized: "文档阅读版生成未完成")
        case .sourceEditFailed: String(localized: "原文编辑保存未完成")
        case .backupFailed: String(localized: "本机备份操作未完成")
        case .exportFailed: String(localized: "白板导出未完成")
        case .aiRequestFailed: String(localized: "AI 请求未完成")
        case .settingsFailed: String(localized: "设置保存或读取未完成")
        case .fileOperationFailed: String(localized: "文件操作未完成")
        case .catalogFailed: String(localized: "资料库保存或读取未完成")
        }
    }
}

enum DiagnosticOperation: String, Codable, CaseIterable, Sendable {
    case connectVault, openBoard, createBoard, saveBoard, syncPDF, exportPreview, importDocuments
    case renderDocument, editSource, localBackup, restoreBackup, exportBoard, aiAnalysis, settings, fileAccess, organizeBoards
    var title: String {
        switch self {
        case .connectVault: String(localized: "连接仓库")
        case .openBoard: String(localized: "打开白板")
        case .createBoard: String(localized: "新建白板")
        case .saveBoard: String(localized: "保存白板")
        case .syncPDF: String(localized: "同步 PDF 批注")
        case .exportPreview: String(localized: "更新 Obsidian 预览")
        case .importDocuments: String(localized: "添加资料")
        case .renderDocument: String(localized: "生成阅读版")
        case .editSource: String(localized: "保存原文")
        case .localBackup: String(localized: "本机备份")
        case .restoreBackup: String(localized: "恢复备份")
        case .exportBoard: String(localized: "导出白板")
        case .aiAnalysis: String(localized: "AI 分析")
        case .settings: String(localized: "更新设置")
        case .fileAccess: String(localized: "访问文件")
        case .organizeBoards: String(localized: "整理白板")
        }
    }
}

enum DiagnosticSeverity: String, Codable, CaseIterable, Sendable {
    case info, warning, error
    var title: String {
        switch self {
        case .info: String(localized: "提示")
        case .warning: String(localized: "警告")
        case .error: String(localized: "错误")
        }
    }
}

/// Unknown domains are replaced entirely, not truncated: a custom domain can contain private text.
enum DiagnosticErrorDomain: String, Codable, Sendable {
    case cocoa = "NSCocoaErrorDomain", url = "NSURLErrorDomain", posix = "NSPOSIXErrorDomain"
    case osStatus = "NSOSStatusErrorDomain", webKit = "WKErrorDomain", other
    static func allowed(_ value: String) -> Self { Self(rawValue: value) ?? .other }
}

struct DiagnosticEnvironment: Codable, Equatable, Sendable {
    let appVersion: String
    let appBuild: String
    let osVersion: String
    static var current: Self {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return .init(appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
                     appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                     osVersion: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)")
    }
    init(appVersion: String, appBuild: String, osVersion: String) {
        self.appVersion = Self.clean(appVersion); self.appBuild = Self.clean(appBuild); self.osVersion = Self.clean(osVersion)
    }
    private static func clean(_ value: String) -> String {
        guard value == "unknown" || (value.utf8.count <= 64 && value.range(of: "^[0-9]+(?:\\.[0-9]+){0,3}$", options: .regularExpression) != nil) else { return "unknown" }
        return value
    }
    var isValid: Bool { [appVersion, appBuild, osVersion].allSatisfy { Self.clean($0) == $0 } }
}

struct DiagnosticEvent: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let code: DiagnosticCode
    let operation: DiagnosticOperation
    let severity: DiagnosticSeverity
    let errorDomain: DiagnosticErrorDomain?
    let errorCode: Int?
    let environment: DiagnosticEnvironment
    var firstOccurredAt: Date
    var lastOccurredAt: Date
    var occurrences: Int
    var unread: Bool

    fileprivate func matches(_ other: Self) -> Bool {
        code == other.code && operation == other.operation && severity == other.severity &&
        errorDomain == other.errorDomain && errorCode == other.errorCode && environment == other.environment
    }
    /// The only Error bridge. userInfo, description, underlying errors and HTTP data are never inspected or retained.
    static func sanitized(code: DiagnosticCode, operation: DiagnosticOperation, error: Error?, severity: DiagnosticSeverity,
                          environment: DiagnosticEnvironment, now: Date = Date()) -> Self? {
        if error is CancellationError { return nil }
        let ns = error.map { $0 as NSError }
        if ns?.domain == NSURLErrorDomain && ns?.code == NSURLErrorCancelled { return nil }
        return .init(id: UUID(), code: code, operation: operation, severity: severity,
                     errorDomain: ns.map { .allowed($0.domain) }, errorCode: ns?.code,
                     environment: environment, firstOccurredAt: now, lastOccurredAt: now, occurrences: 1, unread: true)
    }
    fileprivate var isValid: Bool {
        environment.isValid && firstOccurredAt.timeIntervalSince1970.isFinite && lastOccurredAt.timeIntervalSince1970.isFinite &&
        firstOccurredAt <= lastOccurredAt && (1...1_000_000).contains(occurrences) && (errorDomain == nil) == (errorCode == nil)
    }
}

enum DiagnosticStorageIssue: String, Codable, Sendable {
    case unavailable, invalidLog, changedOnDisk, recoveryLimit
    var message: String {
        switch self {
        case .unavailable: String(localized: "问题记录暂时无法保存或读取，正常白板操作不受影响。可以稍后重试。")
        case .invalidLog: String(localized: "本机问题记录损坏或超过容量，原记录未被覆盖。可保留损坏文件并新建记录。")
        case .changedOnDisk: String(localized: "问题记录已被外部修改，本次未覆盖。请重新读取后再试。")
        case .recoveryLimit: String(localized: "已保留三份损坏记录，暂不再新建，以免无限占用空间。正常白板操作不受影响。")
        }
    }
}

struct DiagnosticSnapshot: Sendable {
    let sequence: UInt64
    let events: [DiagnosticEvent]
    let issue: DiagnosticStorageIssue?
}

/// Small bounded local store. All disk I/O runs on this actor, never on the drawing's main actor.
actor DiagnosticsStore {
    static let maximumEntries = 200
    static let maximumBytes = 512 * 1_024
    private struct Log: Codable { var schemaVersion = 1; var events: [DiagnosticEvent] = [] }
    private struct Report: Encodable {
        let schemaVersion = 1
        let scope = "Explicitly handled application errors only; no automatic crash capture or upload."
        let omitted = ["document contents", "file names and paths", "screenshots", "keys", "error descriptions", "HTTP bodies", "device identifiers"]
        let generatedAt: Date
        let environment: DiagnosticEnvironment
        let storageIssue: DiagnosticStorageIssue?
        let events: [DiagnosticEvent]
    }
    private let rootURL: URL
    private let environment: DiagnosticEnvironment
    private var log = Log()
    private var expectedBytes: Data?
    private var loaded = false
    private var issue: DiagnosticStorageIssue?
    private var sequence: UInt64 = 0
    private var fileURL: URL { rootURL.appendingPathComponent("events-v1.json") }

    init(rootURL: URL, environment: DiagnosticEnvironment = .current) {
        self.rootURL = rootURL.standardizedFileURL; self.environment = environment
    }
    func snapshot(reload: Bool = false) -> DiagnosticSnapshot {
        if reload { loaded = false }
        loadIfNeeded(); return snapshotValue()
    }
    func append(_ event: DiagnosticEvent) -> DiagnosticSnapshot {
        loadIfNeeded()
        guard issue == nil, event.isValid else { return snapshotValue() }
        var next = log
        if let index = next.events.firstIndex(where: { $0.matches(event) }) {
            next.events[index].firstOccurredAt = min(next.events[index].firstOccurredAt, event.firstOccurredAt)
            next.events[index].lastOccurredAt = max(next.events[index].lastOccurredAt, event.lastOccurredAt)
            next.events[index].occurrences = min(1_000_000, next.events[index].occurrences + 1)
            next.events[index].unread = true
        } else { next.events.append(event) }
        next.events.sort { $0.lastOccurredAt == $1.lastOccurredAt ? $0.id.uuidString < $1.id.uuidString : $0.lastOccurredAt > $1.lastOccurredAt }
        next.events = Array(next.events.prefix(Self.maximumEntries))
        persist(next); return snapshotValue()
    }
    func markRead(_ id: UUID? = nil) -> DiagnosticSnapshot {
        loadIfNeeded(); guard issue == nil else { return snapshotValue() }
        var next = log
        for index in next.events.indices where id == nil || next.events[index].id == id { next.events[index].unread = false }
        persist(next); return snapshotValue()
    }
    func clear() -> DiagnosticSnapshot {
        loadIfNeeded(); guard issue == nil else { return snapshotValue() }
        persist(Log()); return snapshotValue()
    }
    /// Explicit recovery preserves the unreadable file. It never exports its untrusted contents.
    func rebuildPreservingDamagedLog() -> DiagnosticSnapshot {
        loadIfNeeded()
        guard issue == .invalidLog || issue == .changedOnDisk else { return snapshotValue() }
        do {
            try prepareDirectory()
            let retained = try FileManager.default.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil)
                .filter { $0.lastPathComponent.hasPrefix("preserved-") && $0.pathExtension == "json" }
            guard retained.count < 3 else { issue = .recoveryLimit; return snapshotValue() }
            try requireRegularFileIfPresent(fileURL)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.moveItem(at: fileURL, to: rootURL.appendingPathComponent("preserved-\(UUID().uuidString).json"))
            }
            log = Log(); expectedBytes = nil; issue = nil; loaded = true
            persist(log)
        } catch { issue = .unavailable }
        return snapshotValue()
    }
    func report() -> (DiagnosticSnapshot, Data?) {
        loadIfNeeded()
        let report = Report(generatedAt: Date(), environment: environment, storageIssue: issue, events: log.events)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (snapshotValue(), try? encoder.encode(report))
    }
    private func snapshotValue() -> DiagnosticSnapshot {
        sequence &+= 1
        return .init(sequence: sequence, events: log.events, issue: issue)
    }
    private func prepareDirectory() throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: rootURL.path) {
            let values = try rootURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw CocoaError(.fileWriteNoPermission) }
        } else { try fm.createDirectory(at: rootURL, withIntermediateDirectories: true) }
        var url = rootURL, values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
    private func requireRegularFileIfPresent(_ url: URL) throws {
        // lstat via attributes rejects even dangling symbolic links.
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else { throw CocoaError(.fileWriteNoPermission) }
        } catch let error as NSError where error.domain == NSCocoaErrorDomain &&
            (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError) { return }
    }
    private func boundedRead() throws -> Data? {
        try requireRegularFileIfPresent(fileURL)
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        guard let size = attributes[.size] as? NSNumber, size.int64Value <= Int64(Self.maximumBytes) else { throw LogReadError.tooLarge }
        let handle = try FileHandle(forReadingFrom: fileURL); defer { try? handle.close() }
        let bytes = try handle.read(upToCount: Self.maximumBytes + 1) ?? Data()
        guard bytes.count <= Self.maximumBytes else { throw LogReadError.tooLarge }
        return bytes
    }
    private enum LogReadError: Error { case tooLarge }
    private func loadIfNeeded() {
        guard !loaded else { return }; loaded = true
        do {
            try prepareDirectory()
            guard let bytes = try boundedRead() else { log = Log(); expectedBytes = nil; issue = nil; return }
            let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
            let decoded: Log
            do { decoded = try decoder.decode(Log.self, from: bytes) }
            catch { issue = .invalidLog; return }
            guard decoded.schemaVersion == 1, decoded.events.count <= Self.maximumEntries,
                  Set(decoded.events.map(\.id)).count == decoded.events.count,
                  decoded.events.allSatisfy(\.isValid) else { issue = .invalidLog; return }
            log = decoded; expectedBytes = bytes; issue = nil
        } catch is LogReadError { issue = .invalidLog }
        catch { issue = .unavailable }
    }
    private func persist(_ next: Log) {
        do {
            try prepareDirectory()
            guard try boundedRead() == expectedBytes else { issue = .changedOnDisk; return }
            let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .millisecondsSince1970; encoder.outputFormatting = [.sortedKeys]
            let bytes = try encoder.encode(next)
            guard bytes.count <= Self.maximumBytes else { issue = .unavailable; return }
            try bytes.write(to: fileURL, options: .atomic)
            #if os(iOS)
            try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: fileURL.path)
            #endif
            log = next; expectedBytes = bytes; issue = nil
        } catch is LogReadError { issue = .invalidLog }
        catch { issue = .unavailable }
    }
}

/// Observe this service only in the problem-center badge/view, not in the native drawing model.
@MainActor @Observable final class DiagnosticsCenter {
    static let shared = DiagnosticsCenter()
    private let store: DiagnosticsStore
    private let environment: DiagnosticEnvironment
    private var appliedSequence: UInt64 = 0
    private var pendingRecords: Task<Void, Never>?
    private(set) var events: [DiagnosticEvent] = []
    private(set) var storageIssue: DiagnosticStorageIssue?
    private(set) var isLoaded = false
    var unreadCount: Int { events.filter(\.unread).count }

    init(rootURL: URL? = nil, environment: DiagnosticEnvironment = .current) {
        let directory = rootURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("InkSpace/Diagnostics", isDirectory: true)
        self.environment = environment; store = DiagnosticsStore(rootURL: directory, environment: environment)
    }
    func record(code: DiagnosticCode, operation: DiagnosticOperation, error: Error? = nil, severity: DiagnosticSeverity = .error) {
        guard let event = DiagnosticEvent.sanitized(code: code, operation: operation, error: error, severity: severity, environment: environment) else { return }
        // A short task chain keeps record/read/clear ordering without holding Error or userInfo across an await.
        let previous = pendingRecords
        pendingRecords = Task { [weak self, store] in
            await previous?.value
            let snapshot = await store.append(event)
            self?.apply(snapshot)
        }
    }
    func refresh() async { await pendingRecords?.value; apply(await store.snapshot(reload: true)) }
    func markAllRead() async { await pendingRecords?.value; apply(await store.markRead()) }
    func markRead(_ id: UUID) async { await pendingRecords?.value; apply(await store.markRead(id)) }
    func clear() async { await pendingRecords?.value; apply(await store.clear()) }
    func rebuildPreservingDamagedLog() async { await pendingRecords?.value; apply(await store.rebuildPreservingDamagedLog()) }
    func reportData() async -> Data? {
        await pendingRecords?.value
        let (snapshot, data) = await store.report(); apply(snapshot); return data
    }
    private func apply(_ snapshot: DiagnosticSnapshot) {
        guard snapshot.sequence > appliedSequence else { return }
        appliedSequence = snapshot.sequence; events = snapshot.events; storageIssue = snapshot.issue; isLoaded = true
    }
}

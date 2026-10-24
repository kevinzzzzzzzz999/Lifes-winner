import Foundation
import Observation

struct BoardBackupEntry: Identifiable {
    let scope: String
    let record: BoardBackupRecord
    var id: UUID { record.id }
}

/// The controller owns request order on MainActor; all filesystem work runs on
/// the dedicated store actor. A failure is status, never a thrown cloud-save error.
@MainActor @Observable final class BoardBackupController {
    // Every production window writes the same backup directory. One actor owns
    // its publication and garbage collection; window-specific UI stays here.
    private static var productionStore: LocalBoardBackupStore?
    private static var productionGeneration: UInt64 = 0
    private var store: LocalBoardBackupStore?
    private let usesProductionStore: Bool
    private var generation: UInt64 = 0
    private var visibleScope: String?
    private var latestStatusGeneration: [String: UInt64] = [:]
    private var operations = 0
    var isWorking: Bool { operations > 0 }
    private(set) var enabled = true
    private(set) var entries: [BoardBackupEntry] = []
    private(set) var policy = BoardBackupPolicy()
    private(set) var usageBytes: UInt64 = 0
    private(set) var lastStatus = String(localized: "本机备份默认开启。")
    private(set) var lastError: String?

    init(rootURL: URL? = nil) {
        usesProductionStore = rootURL == nil
        do {
            if let rootURL {
                // Explicit roots are isolated fixtures/owners, never aliases of
                // the application-wide production store.
                store = try LocalBoardBackupStore(rootURL: rootURL)
            } else if let shared = Self.productionStore {
                store = shared
            } else {
                let shared = try LocalBoardBackupStore()
                Self.productionStore = shared
                store = shared
            }
        }
        catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error); lastError = error.localizedDescription; lastStatus = String(localized: "本机备份暂时不可用；正常白板保存不受影响。") }
    }
    private func nextGeneration() -> UInt64 {
        // The shared actor compares generations per board. Per-window counters
        // would let a newer request from a second window look older indefinitely.
        if usesProductionStore {
            Self.productionGeneration &+= 1
            return Self.productionGeneration
        }
        generation &+= 1
        return generation
    }
    @discardableResult func captureEditableCheckpoint(document: BoardDocument, vaultURL: URL) async -> UInt64 {
        let request = nextGeneration()
        await captureInternal(document: document, vaultURL: vaultURL, reason: .checkpoint, generation: request, editableOnly: true)
        return request
    }
    func capture(document: BoardDocument, vaultURL: URL, reason: BoardBackupReason, generation request: UInt64? = nil) async {
        let sequence: UInt64
        if let request { sequence = request } else { sequence = nextGeneration() }
        await captureInternal(document: document, vaultURL: vaultURL, reason: reason, generation: sequence, editableOnly: false)
    }
    private func captureInternal(document: BoardDocument, vaultURL: URL, reason: BoardBackupReason, generation: UInt64, editableOnly: Bool) async {
        guard let store else { return }; operations += 1; defer { operations -= 1 }
        let scope = LocalBoardBackupStore.scope(document: document, vaultURL: vaultURL)
        do {
            let result = try await store.capture(document: document, vaultURL: vaultURL, reason: reason, generation: generation, editableOnly: editableOnly)
            if (visibleScope == nil || visibleScope == scope), generation >= (latestStatusGeneration[scope] ?? 0) {
                latestStatusGeneration[scope] = generation
                lastError = nil
                if result.disabled { lastStatus = String(localized: "此白板的本机备份已关闭；旧版本保留。") }
                else if let record = result.record {
                    lastStatus = record.complete ? String(localized: "完整本机备份已保留。") : String(localized: "可编辑状态已保留；\(record.missing.count) 项关联资料尚未完整核对。")
                }
                if visibleScope == scope { await refresh(scope: scope) }
            }
        } catch is CancellationError {
            if visibleScope == nil || visibleScope == scope { lastStatus = String(localized: "本次备份已取消；之前的版本保留。") }
        } catch {
            DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error)
            if (visibleScope == nil || visibleScope == scope), generation >= (latestStatusGeneration[scope] ?? 0) { lastError = error.localizedDescription; lastStatus = String(localized: "本机备份未完成；正常白板保存不受影响。") }
        }
    }
    func activate(document: BoardDocument, vaultURL: URL) async {
        await reload(document: document, vaultURL: vaultURL)
    }
    func reload(document: BoardDocument, vaultURL: URL) async {
        let scope = LocalBoardBackupStore.scope(document: document, vaultURL: vaultURL)
        visibleScope = scope; lastError = nil; lastStatus = String(localized: "正在读取此白板的本机历史…")
        await refresh(scope: scope)
        guard visibleScope == scope else { return }
        if !enabled { lastStatus = String(localized: "此白板的本机备份已关闭；旧版本保留。") }
        else if let record = entries.first?.record { lastStatus = record.complete ? String(localized: "完整本机备份已保留。") : String(localized: "可编辑状态已保留；关联资料尚未完整核对。") }
        else { lastStatus = String(localized: "本机备份已开启，等待首次保存。") }
    }
    private func refresh(scope: String) async {
        guard let store else { return }
        do {
            let isEnabled = await store.isEnabled(scope: scope), newPolicy = await store.policy()
            let records = try await store.records(scope: scope), usage = try await store.usageBytes()
            guard visibleScope == scope else { return }
            enabled = isEnabled; policy = newPolicy
            entries = records.map { .init(scope: scope, record: $0) }; usageBytes = usage
        } catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error); if visibleScope == scope { lastError = error.localizedDescription } }
    }
    func setEnabled(_ enabled: Bool, document: BoardDocument, vaultURL: URL) async {
        guard let store else { return }
        do { try await store.setEnabled(enabled, scope: LocalBoardBackupStore.scope(document: document, vaultURL: vaultURL)); self.enabled = enabled; lastError = nil }
        catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error); lastError = error.localizedDescription }
    }
    func setPolicy(_ new: BoardBackupPolicy) async {
        guard let store else { return }; do { try await store.setPolicy(new); policy = new; lastError = nil }
        catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error); lastError = error.localizedDescription }
    }
    func export(_ entry: BoardBackupEntry) async -> URL? {
        guard let store else { return nil }; operations += 1; defer { operations -= 1 }
        do { let url = try await store.export(scope: entry.scope, id: entry.id); lastError = nil; return url }
        catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error); lastError = error.localizedDescription; return nil }
    }
    func importArchive(_ url: URL) async {
        guard let store else { return }; operations += 1; defer { operations -= 1 }
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let imported = try await store.importArchive(url)
            entries.insert(.init(scope: imported.scope, record: imported.record), at: 0)
            lastError = nil; lastStatus = String(localized: "已验证并导入本机历史。选择恢复位置可创建独立副本。")
        } catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error); lastError = error.localizedDescription }
    }
    func restore(_ entry: BoardBackupEntry, vaultURL: URL, directoryPath: String, allowIncomplete: Bool = false) async -> String? {
        guard let store else { return nil }; operations += 1; defer { operations -= 1 }
        do {
            let path = try await store.restore(scope: entry.scope, id: entry.id, vaultURL: vaultURL, directoryPath: directoryPath, allowIncomplete: allowIncomplete)
            lastError = nil; lastStatus = String(localized: "已恢复为独立副本，原白板和资料保持不变。"); return path
        } catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .restoreBackup, error: error); lastError = error.localizedDescription; return nil }
    }
    func deleteHistory(_ entry: BoardBackupEntry) async {
        guard let store else { return }
        do { try await store.deleteHistory(scope: entry.scope, id: entry.id); entries.removeAll { $0.id == entry.id }; usageBytes = try await store.usageBytes(); lastError = nil }
        catch { DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error); lastError = error.localizedDescription }
    }
}

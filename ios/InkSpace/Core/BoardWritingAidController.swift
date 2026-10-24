import Foundation
import Observation

/// Auxiliary tools own their drafts and I/O. Ordinary PencilKit ink never waits
/// for this controller, and changing boards cannot redirect an accepted save.
@MainActor @Observable
final class BoardWritingAidController {
    var mode: BoardWritingAidMode = .off
    private(set) var nativeInkRequest: UUID?
    func selectMode(_ requested: BoardWritingAidMode) {
        mode = requested
        if requested == .off { nativeInkRequest = UUID() }
    }
    var settings = BoardWritingAidSettings.load() {
        didSet { if settings != oldValue { settings.save() } }
    }
    private(set) var tapes: BoardWritingAidTapeDocument?
    private(set) var canSaveTape = false
    private(set) var isSaving = false
    var status = ""
    private(set) var lastTapeCommit: TapeCommit?
    private(set) var tapeReloadRequest: UUID?
    struct TapeCommit {
        let id = UUID()
        var token: BoardWritingAidSessionToken
        var draft: BoardWritingAidTapeDocument
        var document: BoardWritingAidTapeDocument?
        var error: String?
    }
    var hasTapeDraft: Bool { identity.map { tapeDrafts[documentKey($0)] != nil } ?? false }
    @ObservationIgnored private let repository = BoardWritingAidRepository()
    @ObservationIgnored private var identity: Identity?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var saveTasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var textDrafts: [DocumentKey: String] = [:]
    @ObservationIgnored private var tapeDrafts: [DocumentKey: BoardWritingAidTapeDocument] = [:]

    @ObservationIgnored private var tapeDraftTokens: [DocumentKey: BoardWritingAidSessionToken] = [:]
    private struct DocumentKey: Hashable { var rootPath: String; var boardID: UUID }
    private func documentKey(_ value: Identity) -> DocumentKey {
        DocumentKey(rootPath: value.root?.standardizedFileURL.path ?? "", boardID: value.boardID)
    }
    private struct Identity: Equatable {
        var root: URL?
        var boardID: UUID
        var sessionID: UUID
    }

    func attach(root: URL?, boardID: UUID, sessionID: UUID) {
        let next = Identity(root: root, boardID: boardID, sessionID: sessionID)
        guard identity != next else { return }
        identity = next
        loadTask?.cancel()
        mode = .off; tapes = nil; canSaveTape = false; isSaving = false; status = ""
        guard let root else { return }
        let key = documentKey(next)
        loadTask = Task { [weak self, repository] in
            do {
                let loaded = try await repository.load(boardID: boardID, rootURL: root)
                guard let self, !Task.isCancelled, self.identity == next else { return }
                self.tapes = self.tapeDrafts[key] ?? loaded
                self.canSaveTape = true
                if self.tapeDrafts[key] != nil {
                    self.status = String(localized: "上次未保存的胶带草稿仍在，请重试保存。")
                }
            } catch {
                guard let self, !Task.isCancelled, self.identity == next else { return }
                self.status = error.localizedDescription
            }
        }
    }

    func rememberDraft(_ text: String, boardID: UUID) {
        guard text.utf8.count <= 100_000 else { return }
        guard let identity, identity.boardID == boardID else { return }
        let key = documentKey(identity)
        if text.isEmpty { textDrafts.removeValue(forKey: key) }
        else { textDrafts[key] = text }
    }
    func draft(boardID: UUID) -> String {
        guard let identity, identity.boardID == boardID else { return "" }
        return textDrafts[documentKey(identity)] ?? ""
    }

    func toggleTape(_ id: UUID) {
        guard !hasTapeDraft, let identity, let tapes, let next = try? tapes.toggling(id) else { return }
        _ = saveTapes(next, token: .init(sessionID: identity.sessionID, generation: 0, viewportRevision: 0)) { _, _ in }
    }

    func deleteTape(_ id: UUID) {
        guard !hasTapeDraft, let identity, var next = tapes, next.tapes.contains(where: { $0.id == id }) else { return }
        next.tapes.removeAll { $0.id == id }
        _ = saveTapes(next, token: .init(sessionID: identity.sessionID, generation: 0, viewportRevision: 0)) { _, _ in }
    }

    /// Even a host-rejected canvas request remains a real local draft. Keeping
    /// it here prevents Settings commands from racing an undisclosed draft.
    @discardableResult
    func rememberTapeDraft(_ draft: BoardWritingAidTapeDocument, token: BoardWritingAidSessionToken) -> Bool {
        guard let identity, identity.boardID == draft.boardID, identity.sessionID == token.sessionID,
              !isSaving, (try? draft.validate()) != nil else { return false }
        let key = documentKey(identity)
        tapeDrafts[key] = draft; tapeDraftTokens[key] = token
        status = String(localized: "胶带草稿尚未保存，请重试保存或明确放弃后重新载入。")
        return true
    }

    func retryTapeDraft() {
        guard let identity else { return }
        let key = documentKey(identity)
        guard let draft = tapeDrafts[key] else { return }
        let token = tapeDraftTokens[key].flatMap { $0.sessionID == identity.sessionID ? $0 : nil }
            ?? .init(sessionID: identity.sessionID, generation: 0, viewportRevision: 0)
        _ = saveTapes(draft, token: token) { _, _ in }
    }

    /// Called only after the UI confirms abandoning the local failed draft.
    /// Never raises its revision to overwrite another device's saved document.
    func reloadSavedTapes(discardLocalDraft: Bool) {
        guard !isSaving, let current = identity, !hasTapeDraft || discardLocalDraft else { return }
        if discardLocalDraft {
            let key = documentKey(current)
            tapeDrafts.removeValue(forKey: key); tapeDraftTokens.removeValue(forKey: key)
        }
        tapeReloadRequest = UUID()
        identity = nil
        attach(root: current.root, boardID: current.boardID, sessionID: current.sessionID)
    }

    @discardableResult
    func saveTapes(_ draft: BoardWritingAidTapeDocument, token: BoardWritingAidSessionToken,
                   completion: @escaping (BoardWritingAidTapeDocument?, String?) -> Void) -> Bool {
        guard let identity, let root = identity.root, identity.boardID == draft.boardID,
              identity.sessionID == token.sessionID, canSaveTape, !isSaving,
              (try? draft.validate()) != nil else { return false }
        let operationID = UUID()
        let key = documentKey(identity)
        tapeDrafts[key] = draft
        tapeDraftTokens[key] = token
        isSaving = true
        status = String(localized: "正在保存胶带…")
        saveTasks[operationID] = Task { [weak self, repository] in
            do {
                let saved = try await repository.save(draft, rootURL: root, expectedRevision: draft.revision)
                guard let self else { return }
                self.saveTasks.removeValue(forKey: operationID)
                if self.tapeDrafts[key] == draft, self.tapeDraftTokens[key] == token {
                    self.tapeDrafts.removeValue(forKey: key); self.tapeDraftTokens.removeValue(forKey: key)
                }
                if self.identity == identity {
                    self.tapes = saved; self.isSaving = false
                    self.lastTapeCommit = TapeCommit(token: token, draft: draft, document: saved)
                    self.status = String(localized: "胶带已保存")
                }
                completion(saved, nil)
            } catch {
                guard let self else { return }
                self.saveTasks.removeValue(forKey: operationID)
                if self.identity == identity {
                    self.isSaving = false; self.status = error.localizedDescription
                    self.lastTapeCommit = TapeCommit(token: token, draft: draft, document: nil, error: error.localizedDescription)
                }
                completion(nil, error.localizedDescription)
            }
        }
        return true
    }
}

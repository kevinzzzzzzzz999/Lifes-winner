import Foundation
import CoreGraphics

@MainActor extension BoardStore {
    func prepareBoardMerge(service: BoardMergeService, sourcePath: String, targetPath: String,
                           placement: BoardMergePlacement, mode: BoardMergeMode, position: CGPoint? = nil) async throws -> BoardMergePreview {
        guard !usesPhoneInterface, !isBusy, !externalInteractionActive, !reviewModeEnabled,
              reviews.draft == nil, !reviews.isWriting, !writingAids.isSaving, !writingAids.hasTapeDraft,
              readingCanvas?.snapshotInteractionActive != true, let root = vaultURL else { throw BoardMergeError.changed }
        let session = canvasSessionID
        isBusy = true; defer { isBusy = false }
        guard await flushEdits(), canvasSessionID == session, vaultURL == root else { throw BoardMergeError.changed }
        return try await service.prepare(root: root, sourcePath: sourcePath, targetPath: targetPath, placement: placement, mode: mode, position: position)
    }

    /// Shares the existing file-management write barrier. A partial rollback
    /// leaves this barrier in place, so autosave cannot clobber recovery files.
    func commitBoardMerge(service: BoardMergeService, preview: BoardMergePreview) async throws -> BoardMergeResult {
        guard !usesPhoneInterface, !isBusy, !externalInteractionActive, !reviewModeEnabled,
              reviews.draft == nil, !reviews.isWriting, !writingAids.isSaving, !writingAids.hasTapeDraft,
              readingCanvas?.snapshotInteractionActive != true, let root = vaultURL else { throw BoardMergeError.changed }
        let session = canvasSessionID, wasReading = isPadReading
        var recoveryRequired = false, activated = false
        isBusy = true
        defer {
            isBusy = false
            if !recoveryRequired { fileManagementInProgress = false }
            if activated && !wasReading { beginPadEditing() }
        }
        guard await flushEdits(), canvasSessionID == session, vaultURL == root else { throw BoardMergeError.changed }
        fileManagementInProgress = true
        clearChildSessions()
        do {
            let result = try await service.commit(preview.id)
            guard canvasSessionID == session, vaultURL == root,
                  let url = library?.resolve(relativePath: result.outputPath) else {
                throw BoardMergeError.recovery(result.backupPath + "/journal.json")
            }
            let loaded: BoardReadLoader.Loaded
            do { loaded = try await BoardReadLoader().load(url) }
            catch { throw BoardMergeError.recovery(result.backupPath + "/journal.json") }
            guard canvasSessionID == session, vaultURL == root, loaded.fingerprint == result.outputSHA256 else { throw BoardMergeError.recovery(result.backupPath + "/journal.json") }
            activateOpenedBoard(loaded.document, ink: loaded.drawing, fingerprint: loaded.fingerprint, url: url, relativePath: result.outputPath)
            activated = true
            writingAids.attach(root: root, boardID: loaded.document.id, sessionID: canvasSessionID)
            library?.clearCache()
            await boardCatalog.recordOpened(rootURL: root, relativePath: result.outputPath, title: loaded.document.title, boardID: loaded.document.id)
            await attachReviews()
            await backups.activate(document: loaded.document, vaultURL: root)
            status = String(localized: "合并完成 · 源白板保留 · 两张原板备份：\(result.backupPath)")
            return result
        } catch {
            if case BoardMergeError.recovery = error {
                recoveryRequired = true
                status = error.localizedDescription
            }
            throw error
        }
    }

    /// Explicit, complete merge undo. Later unsaved edits are refused rather
    /// than silently folded into the old target. PencilKit stroke undo remains
    /// independent and continues to operate on the current drawing only.
    func undoLastBoardMerge(service: BoardMergeService, result: BoardMergeResult) async throws -> BoardMergeUndoResult {
        guard !usesPhoneInterface, !isBusy, !isSaving, !isDirty, !childSessionsHavePendingEdits,
              !externalInteractionActive, !reviewModeEnabled, reviews.draft == nil,
              !reviews.isWriting, !writingAids.isSaving, !writingAids.hasTapeDraft,
              readingCanvas?.snapshotInteractionActive != true, let root = vaultURL,
              let current = boardURL, relativePath(for: current) == result.outputPath else { throw BoardMergeError.undoChanged }
        let session = canvasSessionID, wasReading = isPadReading, priorMode = mode
        let center = viewportCenter, priorZoom = zoom
        var recoveryRequired = false, activated = false
        isBusy = true; fileManagementInProgress = true
        defer {
            isBusy = false
            if !recoveryRequired { fileManagementInProgress = false }
            if activated && !wasReading {
                beginPadEditing()
                mode = priorMode == .place ? .arrange : priorMode
            }
        }
        clearChildSessions()
        do {
            let undone = try await service.undoLastBoardMerge(root: root, result: result)
            guard canvasSessionID == session, vaultURL == root,
                  let url = library?.resolve(relativePath: undone.restoredPath) else { throw BoardMergeError.recovery(result.backupPath + "/journal.json") }
            let loaded: BoardReadLoader.Loaded
            do { loaded = try await BoardReadLoader().load(url) }
            catch { throw BoardMergeError.recovery(result.backupPath + "/journal.json") }
            guard canvasSessionID == session, vaultURL == root, loaded.fingerprint == undone.restoredSHA256 else { throw BoardMergeError.recovery(result.backupPath + "/journal.json") }
            activateOpenedBoard(loaded.document, ink: loaded.drawing, fingerprint: loaded.fingerprint, url: url, relativePath: undone.restoredPath)
            activated = true
            if center.x.isFinite, center.y.isFinite, priorZoom.isFinite, priorZoom > 0 {
                viewportCenter = center; zoom = priorZoom
                command = CanvasCommand(action: .restoreViewport(center, zoom: priorZoom))
            }
            writingAids.attach(root: root, boardID: loaded.document.id, sessionID: canvasSessionID)
            library?.clearCache()
            await boardCatalog.recordOpened(rootURL: root, relativePath: undone.restoredPath, title: loaded.document.title, boardID: loaded.document.id)
            await attachReviews()
            await backups.activate(document: loaded.document, vaultURL: root)
            status = String(localized: "已完整撤销合并 · 笔迹、资料和附属记录已恢复 · 源白板及备份保留")
            return undone
        } catch {
            if case BoardMergeError.recovery = error { recoveryRequired = true; status = error.localizedDescription }
            throw error
        }
    }
}

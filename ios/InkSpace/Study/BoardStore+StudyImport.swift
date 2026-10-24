import Foundation

@MainActor extension BoardStore {
    func saveStudyImportNodes(_ items: [BoardItem], boardID: UUID, targetURL: URL) async throws {
        guard !usesPhoneInterface, !isBusy, !reviewModeEnabled, !externalInteractionActive,
              document.id == boardID, boardURL == targetURL, vaultURL != nil,
              FileManager.default.fileExists(atPath: targetURL.path) else { throw StudyCSVError.target }
        let reading = isPadReading, session = canvasSessionID
        defer {
            isBusy = false
            if reading { restoreReadingAfterStudyImport(session: session) }
        }
        if reading { beginPadEditing() }
        guard canEditBoardContents else { throw StudyCSVError.target }
        isBusy = true
        if !items.isEmpty { addItems(items) }
        let saved = await save()
        isBusy = false
        guard document.id == boardID, boardURL == targetURL else { throw StudyCSVError.target }
        guard saved else { throw StudyCSVError.save }
    }
}

import Foundation

/// All I/O is opt-in. Merely showing a board or choosing another pen creates no
/// directory. A revision precondition prevents one window replacing another's tape.
actor BoardWritingAidRepository {
    func load(boardID: UUID, rootURL: URL) throws -> BoardWritingAidTapeDocument {
        try Task.checkCancellation()
        let accessed = rootURL.startAccessingSecurityScopedResource()
        defer { if accessed { rootURL.stopAccessingSecurityScopedResource() } }
        let url = try location(boardID: boardID, rootURL: rootURL, create: false)
        guard FileManager.default.fileExists(atPath: url.path) else { return BoardWritingAidTapeDocument(boardID: boardID) }
        var result: Result<BoardWritingAidTapeDocument, Error>?
        var coordinationError: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { safeURL in
            result = Result { try self.read(safeURL, boardID: boardID) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw BoardWritingAidFailure.unavailable }
        return try result.get()
    }

    /// Returns the new committed revision. On error the caller keeps its draft
    /// visible and retries explicitly; errors are never converted into an empty file.
    func save(_ document: BoardWritingAidTapeDocument, rootURL: URL,
              expectedRevision: UInt64) throws -> BoardWritingAidTapeDocument {
        try Task.checkCancellation()
        try document.validate()
        guard document.revision == expectedRevision else { throw BoardWritingAidFailure.revisionConflict }
        let accessed = rootURL.startAccessingSecurityScopedResource()
        defer { if accessed { rootURL.stopAccessingSecurityScopedResource() } }
        let url = try location(boardID: document.boardID, rootURL: rootURL, create: true)
        var result: Result<BoardWritingAidTapeDocument, Error>?
        var coordinationError: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { safeURL in
            result = Result {
                let current = FileManager.default.fileExists(atPath: safeURL.path)
                    ? try self.read(safeURL, boardID: document.boardID)
                    : BoardWritingAidTapeDocument(boardID: document.boardID)
                guard current.revision == expectedRevision, expectedRevision < UInt64.max else { throw BoardWritingAidFailure.revisionConflict }
                var next = document; next.revision = expectedRevision + 1
                let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
                let data = try encoder.encode(next)
                guard data.count <= BoardWritingAidTapeDocument.maximumBytes else { throw BoardWritingAidFailure.tooComplex }
                try Task.checkCancellation()
                try self.rejectSymlink(safeURL)
                try data.write(to: safeURL, options: .atomic)
                return next
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw BoardWritingAidFailure.unavailable }
        return try result.get()
    }

    private func read(_ url: URL, boardID: UUID) throws -> BoardWritingAidTapeDocument {
        try rejectSymlink(url)
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize,
              size <= BoardWritingAidTapeDocument.maximumBytes else { throw BoardWritingAidFailure.tooComplex }
        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        guard bytes.count <= BoardWritingAidTapeDocument.maximumBytes else { throw BoardWritingAidFailure.tooComplex }
        // Decode the version first: unknown versions and malformed data are never
        // silently replaced. The original bytes stay available for a newer app.
        let version = try JSONDecoder().decode(Version.self, from: bytes)
        guard version.version == BoardWritingAidTapeDocument.currentVersion else { throw BoardWritingAidFailure.unsupportedVersion }
        let result = try JSONDecoder().decode(BoardWritingAidTapeDocument.self, from: bytes)
        guard result.boardID == boardID else { throw BoardWritingAidFailure.wrongBoard }
        try result.validate()
        return result
    }
    private struct Version: Decodable { var version: Int }

    private func location(boardID: UUID, rootURL: URL, create: Bool) throws -> URL {
        guard rootURL.isFileURL else { throw BoardWritingAidFailure.unsafeLocation }
        let root = rootURL.standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else { throw BoardWritingAidFailure.unsafeLocation }
        try rejectSymlink(root)
        var directory = root
        for name in [".inkspace", "writing-aids"] {
            directory.appendPathComponent(name, isDirectory: true)
            try rejectSymlink(directory)
            if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
                guard isDirectory.boolValue else { throw BoardWritingAidFailure.unsafeLocation }
            } else if create {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            }
        }
        let url = directory.appendingPathComponent(boardID.uuidString.lowercased() + ".json")
        try rejectSymlink(url)
        return url
    }

    private func rejectSymlink(_ url: URL) throws {
        // attributesOfItem sees a link itself, including a dangling link.
        if let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
           attributes[.type] as? FileAttributeType == .typeSymbolicLink { throw BoardWritingAidFailure.unsafeLocation }
    }
}

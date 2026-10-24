import Foundation
import CoreGraphics

extension BoardStore {
    /// This operation is intentionally absent from the phone reader. Build and
    /// validate a complete candidate before committing any editable nodes.
    func importNoteOutline(_ url: URL) async throws {
        guard canEditBoardContents, !isBusy, let root = vaultURL else { throw BoardStorageError.invalidDirectory }
        let expectedBoard = document.id
        guard let relative = relativePath(for: url), let safe = VaultPathResolver.resolve(relativePath: relative, within: root) else { throw BoardStorageError.invalidDirectory }
        let task = Task.detached(priority: .userInitiated) {
            guard ((try safe.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? Int.max) <= 1_048_576 else { throw NoteOutlineError.capacity }
            var error: NSError?, result: Result<[NoteOutlineNode], Error> = .failure(NoteOutlineError.empty)
            NSFileCoordinator().coordinate(readingItemAt: safe, options: [], error: &error) { source in result = Result { try NoteOutline.parse(Data(contentsOf: source)) } }
            if let error { throw error }; return try result.get()
        }
        let nodes = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
        guard canEditBoardContents, !isBusy, document.id == expectedBoard, vaultURL == root else { throw BoardStorageError.invalidDirectory }
        var candidate = document, ids: [UUID] = [], depths: [Int] = []
        let origin = insertionPoint ?? viewportCenter
        let width = 320.0, height = 100.0, row = 132.0, column = 380.0
        let x = min(max(0, origin.x), document.canvasWidth - column * 12)
        let y = min(max(0, origin.y), document.canvasHeight - row * Double(nodes.count))
        for (index, node) in nodes.enumerated() {
            let depth = node.parent.map { depths[$0] + 1 } ?? 0
            let item = BoardItem(kind: .text, x: x + Double(depth) * column, y: y + Double(index) * row, width: width, height: height,
                                 title: node.title, text: node.title, textFormat: "markdown")
            if let parent = node.parent { candidate.edges.append(BoardEdge(from: ids[parent], to: item.id)) }
            ids.append(item.id); depths.append(depth); candidate.items.append(item)
        }
        try candidate.validate()
        document = candidate; selectedIDs = Set(ids); mode = .arrange; changed()
        if let first = ids.first { _ = locateItem(first) }
        status = String(localized: "已导入 \(nodes.count) 个可编辑节点；Markdown 原文件仍保留。")
    }
    func exportNoteOutline() throws -> URL {
        let snapshot = outputSnapshot()
        let index = Dictionary(uniqueKeysWithValues: snapshot.items.enumerated().map { ($0.element.id, $0.offset) })
        let edges = try snapshot.edges.map { edge -> (Int, Int) in
            guard let from = index[edge.from], let to = index[edge.to] else { throw NoteOutlineError.graph }
            return (from, to)
        }
        let data = try NoteOutline.encode(titles: snapshot.items.map(\.title), edges: edges)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpace-Outline-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let url = folder.appendingPathComponent(String(localized: "节点纲要.md"))
        try data.write(to: url, options: .withoutOverwriting)
        return url
    }
}

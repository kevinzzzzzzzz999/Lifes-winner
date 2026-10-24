import Foundation
import Observation

struct StudyDraft: Equatable {
    var itemID: UUID
    var question: String
    var answer: String
    var mode: String
    var answerMode: String
    var questionBlocks: [StudyContentBlock] = []
    var answerBlocks: [StudyContentBlock] = []
    var payload: StudyCardPayload {
        .init(question: question, answer: answer, mode: mode, answerMode: mode == "qa" ? answerMode : "custom",
              questionBlocks: questionBlocks.isEmpty ? nil : questionBlocks, answerBlocks: answerBlocks.isEmpty ? nil : answerBlocks)
    }
}
struct StudyOutlineRow: Identifiable {
    var item: BoardItem
    var depth: Int
    var ancestors: [UUID]
    var hasChildren: Bool
    var id: UUID { item.id }
}
enum StudyNodes {
    static func answer(_ item: BoardItem?) -> String {
        guard let item else { return "" }
        if let text = item.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        return item.sourceReference?.quote ?? ""
    }
    static func isImage(_ item: BoardItem?) -> Bool {
        guard let item, item.kind == .document, let path = item.sourcePath, VaultPath.isSafeRelative(path) else { return false }
        return ["png", "jpg", "jpeg"].contains((path as NSString).pathExtension.lowercased())
    }
    static func hasAnswer(_ item: BoardItem?) -> Bool { isImage(item) || !answer(item).isEmpty }
    static func eligible(_ item: BoardItem) -> Bool { [.text, .formula, .inkGroup].contains(item.kind) || isImage(item) }
    static func outline(_ document: BoardDocument) -> [StudyOutlineRow] {
        let items = document.items, byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        var parents: [UUID: UUID] = [:], children: [UUID: [UUID]] = [:]
        for edge in document.edges where edge.relation == nil || edge.relation == "child" {
            guard edge.from != edge.to, byID[edge.from] != nil, byID[edge.to] != nil, parents[edge.to] == nil else { continue }
            var cursor: UUID? = edge.from, seen: Set<UUID> = [], cycle = false
            while let id = cursor { if id == edge.to || !seen.insert(id).inserted { cycle = true; break }; cursor = parents[id] }
            if cycle { continue }; parents[edge.to] = edge.from; children[edge.from, default: []].append(edge.to)
        }
        var result: [StudyOutlineRow] = [], visited: Set<UUID> = []
        let roots = items.filter { parents[$0.id] == nil } + items
        for root in roots {
            var stack: [(UUID, [UUID])] = [(root.id, [])]
            while let (id, ancestors) = stack.popLast() {
                guard visited.insert(id).inserted, let item = byID[id] else { continue }
                let next = children[id] ?? []; result.append(.init(item: item, depth: ancestors.count, ancestors: ancestors, hasChildren: !next.isEmpty))
                for child in next.reversed() { stack.append((child, ancestors + [id])) }
            }
        }
        return result
    }
}
@MainActor @Observable final class StudySession {
    var boardID: UUID?
    var cards: [StudyCardState] = []
    var warnings: [String] = []
    var busy = false
    var error: String?
    var loadFailed = false
    var tab = 0
    var dueOnly = true
    var currentID: String?
    var revealed = false
    var completed: Set<String> = []
    var collapsed: Set<UUID> = []
    var search = ""
    var draft: StudyDraft?
    var initialDraft: StudyDraft?
    var pending: StudyEvent?
    private var root: URL?
    static let deviceID: String = {
        let key = "InkSpaceStudyDeviceID"
        if let value = UserDefaults.standard.string(forKey: key), let uuid = UUID(uuidString: value) { return uuid.uuidString.lowercased() }
        let value = UUID().uuidString.lowercased(); UserDefaults.standard.set(value, forKey: key); return value
    }()
    var dirty: Bool { draft != nil && draft != initialDraft }
    var writingBlocked: Bool { busy || loadFailed || !warnings.isEmpty || root == nil }
    var current: StudyCardState? { cards.first { $0.itemID == currentID } }
    var queue: [StudyCardState] {
        cards.filter { !completed.contains($0.itemID) && (!dueOnly || (try? StudyTime.parse($0.dueAt)) ?? .distantFuture <= Date()) }
            .sorted { $0.dueAt == $1.dueAt ? $0.itemID < $1.itemID : $0.dueAt < $1.dueAt }
    }
    func load(root: URL?, boardID: UUID) async {
        guard !busy else { return }
        if self.boardID != boardID || self.root != root {
            self.boardID = boardID; self.root = root; cards = []; warnings = []; currentID = nil
            completed = []; revealed = false; draft = nil; initialDraft = nil; pending = nil; collapsed = []; search = ""
        }
        guard let root else { error = StudyError.unavailable.localizedDescription; loadFailed = true; return }
        busy = true; defer { busy = false }
        do {
            let snapshot = try await StudyRepository.load(root: root, boardID: boardID)
            let priorEvent = current?.eventID
            cards = snapshot.cards; warnings = snapshot.warnings; error = nil; loadFailed = false
            if current?.eventID != priorEvent { revealed = false }
            if current == nil { currentID = queue.first?.itemID; revealed = false }
        } catch { self.error = error.localizedDescription; loadFailed = true }
    }
    func restartQueue() { completed = []; currentID = queue.first?.itemID; revealed = false }
    func edit(_ item: BoardItem) {
        guard pending == nil, !busy else { return }
        let existing = cards.first { $0.itemID == item.id.uuidString.lowercased() }?.card
        let value = StudyDraft(itemID: item.id, question: existing?.question ?? String(localized: "回忆这个知识点"), answer: existing?.answer ?? "", mode: existing?.mode ?? "qa", answerMode: existing?.answerMode ?? (StudyNodes.hasAnswer(item) ? "node" : "custom"),
            questionBlocks: existing?.questionBlocks ?? [], answerBlocks: existing?.answerBlocks ?? [])
        draft = value; initialDraft = value; error = nil
    }
    func discardDraft() { draft = nil; initialDraft = nil; pending = nil; error = nil }
    func saveDraft() async -> Bool {
        guard let draft, let boardID, !writingBlocked else { return false }
        do { try draft.payload.validate() } catch { self.error = error.localizedDescription; return false }
        if pending?.kind != "card" || pending?.card != draft.payload || pending?.itemID != draft.itemID.uuidString.lowercased() {
            pending = makeEvent(boardID: boardID, itemID: draft.itemID.uuidString.lowercased(), kind: "card", card: draft.payload)
        }
        return await commit()
    }
    func rate(_ grade: StudyGrade) async {
        guard revealed, let current, let boardID, !writingBlocked, pending == nil else { return }
        let eventID = current.eventID
        if !current.card.imagePaths.isEmpty {
            guard let root else { return }
            busy = true
            do {
                for path in current.card.imagePaths { _ = try await VisualNoteAssets.image(root: root, path: path) }
                busy = false
                guard self.current?.eventID == eventID, revealed, pending == nil else { return }
            } catch { busy = false; self.error = error.localizedDescription; return }
        }
        pending = makeEvent(boardID: boardID, itemID: current.itemID, kind: "grade", grade: grade)
        _ = await commit()
    }
    func deleteCard(_ card: StudyCardState) async {
        guard let boardID, !writingBlocked, pending == nil else { return }
        pending = makeEvent(boardID: boardID, itemID: card.itemID, kind: "delete"); _ = await commit()
    }
    @discardableResult func commit() async -> Bool {
        guard let event = pending, let root, !busy else { return false }
        busy = true; defer { busy = false }
        do {
            let snapshot = try await StudyRepository.append(event, root: root)
            cards = snapshot.cards; warnings = snapshot.warnings; loadFailed = false; error = nil; pending = nil
            if event.kind == "card" { draft = nil; initialDraft = nil; completed.remove(event.itemID); currentID = event.itemID; revealed = false; tab = 0 }
            else { completed.insert(event.itemID); currentID = queue.first?.itemID; revealed = false }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    private func makeEvent(boardID: UUID, itemID: String, kind: String, card: StudyCardPayload? = nil, grade: StudyGrade? = nil) -> StudyEvent {
        .init(id: UUID().uuidString.lowercased(), deviceID: Self.deviceID, createdAt: StudyTime.string(Date()), boardID: boardID.uuidString.lowercased(), itemID: itemID, kind: kind, card: card, grade: grade)
    }
}

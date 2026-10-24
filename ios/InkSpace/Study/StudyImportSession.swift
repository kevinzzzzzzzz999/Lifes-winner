import Foundation
import Observation

struct StudyImportEntry: Identifiable {
    var row: StudyCSVRow
    var id: Int { row.id }
    var status: String // ready, duplicate, invalid, imported
    var message: String?
    var item: BoardItem?
    var event: StudyEvent?
}
@MainActor @Observable final class StudyImportSession {
    var entries: [StudyImportEntry] = []
    var selected: Set<Int> = []
    var busy = false
    var error: String?
    var stopRequested = false
    var completed = 0
    var attempted = false
    private(set) var boardID: UUID?
    private(set) var boardURL: URL?
    private var root: URL?
    var remainingSelected: Int { entries.filter { $0.status == "ready" && selected.contains($0.id) }.count }
    func prepare(rows: [StudyCSVRow], board: BoardDocument, boardURL: URL, root: URL, snapshot: StudySnapshot) throws {
        guard snapshot.warnings.isEmpty else { throw StudyError.incomplete }
        self.root = root; self.boardID = board.id; self.boardURL = boardURL
        entries = []; selected = []; completed = 0; attempted = false; error = nil
        var keys = Self.existingPairs(snapshot.cards, items: board.items)
        let existing = Dictionary(board.items.map { ($0.id,$0) }, uniquingKeysWith: { a,_ in a })
        let history = Dictionary(snapshot.events.map {($0.id,$0)},uniquingKeysWith:{a,_ in a})
        for row in rows {
            var entry = StudyImportEntry(row: row, status: row.pair == nil ? "invalid" : "ready", message: row.error)
            if let pair = row.pair {
                if keys.contains(pair) { entry.status="duplicate";entries.append(entry);continue }
                var generation = 0
                var itemID = StudyCSV.stableID(boardID: board.id, pair: pair, role: "item")
                var eventID = StudyCSV.stableID(boardID: board.id, pair: pair, role: "event").uuidString.lowercased()
                while let event = history[eventID] {
                    guard Self.matches(event,pair:pair,itemID:itemID) else {throw StudyCSVError.collision}
                    generation += 1
                    guard generation <= StudyRepository.maximumEvents else{throw StudyCSVError.limit}
                    itemID=StudyCSV.stableID(boardID:board.id,pair:pair,role:"item",generation:generation)
                    eventID=StudyCSV.stableID(boardID:board.id,pair:pair,role:"event",generation:generation).uuidString.lowercased()
                }
                if !keys.insert(pair).inserted { entry.status = "duplicate" }
                else {
                    if let old = existing[itemID], old.kind != .text || old.title != pair.question || old.text != pair.answer || old.textFormat != nil {
                        entry.status = "invalid"; entry.message = StudyCSVError.collision.localizedDescription
                    } else {
                        let position = entries.filter { $0.status == "ready" }.count
                        let x = min(max(0, board.viewport.x), max(0,board.canvasWidth - 1320)) + Double(position % 3) * 440
                        let y = min(max(0, board.viewport.y), max(0,board.canvasHeight - 240)) + Double(position / 3) * 260
                        entry.item = existing[itemID] ?? BoardItem(id:itemID,kind:.text,x:x,y:y,width:420,height:240,title:pair.question,text:pair.answer)
                        entry.event = StudyEvent(id:eventID,deviceID:StudySession.deviceID,createdAt:StudyTime.string(Date()),boardID:board.id.uuidString.lowercased(),itemID:itemID.uuidString.lowercased(),kind:"card",card:.init(question:pair.question,answer:pair.answer,mode:"qa",answerMode:"custom"))
                        selected.insert(row.id)
                    }
                }
            }
            entries.append(entry)
        }
        let newIndexes = entries.indices.filter { entries[$0].status == "ready" && entries[$0].item.map { existing[$0.id] == nil } == true }
        let columns = min(3,max(1,newIndexes.count)), rowsCount = max(1,(newIndexes.count+columns-1)/columns)
        let fullWidth = Double(columns-1)*440+420, fullHeight = Double(rowsCount-1)*260+240
        guard fullWidth <= board.canvasWidth,fullHeight <= board.canvasHeight else{throw StudyCSVError.limit}
        let originX = min(max(0,board.viewport.x),board.canvasWidth-fullWidth)
        let originY = min(max(0,board.viewport.y),board.canvasHeight-fullHeight)
        for (position,index) in newIndexes.enumerated() {
            entries[index].item?.x = originX+Double(position%columns)*440
            entries[index].item?.y = originY+Double(position/columns)*260
        }
    }
    static func matches(_ event:StudyEvent,pair:StudyCSVPair,itemID:UUID) -> Bool {
        event.kind == "card" && event.itemID == itemID.uuidString.lowercased() && event.card == StudyCardPayload(question:pair.question,answer:pair.answer,mode:"qa",answerMode:"custom")
    }
    static func existingPairs(_ cards: [StudyCardState], items: [BoardItem]) -> Set<StudyCSVPair> {
        let byID = Dictionary(items.map { ($0.id.uuidString.lowercased(),$0) }, uniquingKeysWith: { a,_ in a })
        return Set(cards.filter { $0.card.mode == "qa" && byID[$0.itemID] != nil }.map { card in
            StudyCSV.pair(card.card.question, card.card.answerMode == "node" ? StudyNodes.answer(byID[card.itemID]) : card.card.answer)
        })
    }
    /// Nodes are saved once, before immutable events. Interrupted rows retain their
    /// stable identities; reopening the same file recovers an already-saved node.
    func commit(current: () -> (UUID,URL?,[BoardItem]), saveNodes: ([BoardItem]) async throws -> Void) async {
        guard !busy, remainingSelected > 0, let root, let boardID, let boardURL else { return }
        busy = true; attempted = true; error = nil; stopRequested = false; defer { busy = false }
        do {
            func target() throws -> [BoardItem] { let value=current();guard value.0 == boardID,value.1 == boardURL else{throw StudyCSVError.target};return value.2 }
            let before = try await StudyRepository.load(root:root,boardID:boardID)
            guard before.warnings.isEmpty else { throw StudyError.incomplete }
            let items = try target(), existing = Dictionary(items.map { ($0.id,$0) }, uniquingKeysWith: { a,_ in a })
            let keys = Self.existingPairs(before.cards,items:items), history = Dictionary(before.events.map {($0.id,$0)},uniquingKeysWith:{a,_ in a})
            var indexes: [Int] = [], nodes: [BoardItem] = []
            for i in entries.indices where selected.contains(entries[i].id) && entries[i].status == "ready" {
                guard let pair=entries[i].row.pair,let item=entries[i].item,let event=entries[i].event else{continue}
                if let prior=history[event.id] {guard Self.matches(prior,pair:pair,itemID:item.id) else{throw StudyCSVError.collision};entries[i].status="duplicate";continue}
                if keys.contains(pair) {entries[i].status="duplicate";continue}
                if let old=existing[item.id] {guard old.kind == .text,old.title == item.title,old.text == item.text,old.textFormat == nil else{throw StudyCSVError.collision}}
                else {nodes.append(item)}
                indexes.append(i)
            }
            if stopRequested || Task.isCancelled || indexes.isEmpty { return }
            let eventBytes = try indexes.reduce(0) { sum,index in sum + (try entries[index].event!.data().count) }
            guard before.events.count+indexes.count <= StudyRepository.maximumEvents,before.bytes+eventBytes <= StudyRepository.maximumBytes else {throw StudyError.limit}
            // Even with no newly appended nodes, retry a previous failed board save.
            try await saveNodes(nodes);_ = try target()
            for i in indexes {
                if stopRequested || Task.isCancelled { break }
                _ = try target()
                let event=entries[i].event!
                let latest=try await StudyRepository.load(root:root,boardID:boardID)
                guard latest.warnings.isEmpty else{throw StudyError.incomplete}
                if let prior=latest.events.first(where:{$0.id == event.id}) {guard Self.matches(prior,pair:entries[i].row.pair!,itemID:entries[i].item!.id) else{throw StudyCSVError.collision};entries[i].status="duplicate";continue}
                let liveItems=try target()
                guard let live=liveItems.first(where:{$0.id.uuidString.lowercased()==event.itemID}),live.title==entries[i].item?.title,live.text==entries[i].item?.text,live.textFormat==nil else{throw StudyCSVError.collision}
                if Self.existingPairs(latest.cards,items:liveItems).contains(entries[i].row.pair!) {entries[i].status="duplicate";continue}
                _ = try await StudyRepository.append(event,root:root)
                entries[i].status="imported";completed += 1
            }
        } catch is CancellationError { stopRequested = true }
        catch { self.error=error.localizedDescription }
    }
}

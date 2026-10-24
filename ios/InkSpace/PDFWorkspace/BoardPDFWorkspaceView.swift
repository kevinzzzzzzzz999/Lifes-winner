import SwiftUI

/// Captures the receiving board when the reader opens; refreshes must not silently retarget excerpts.
struct BoardPDFWorkspaceView: View {
    var store: BoardStore
    let sourceURL: URL
    let page: Int
    let sourceReference: PDFSourceReference?
    let closeTitle: String?
    let onOpenBoard: () -> Void
    let onClose: () -> Void
    @State private var targetID: UUID
    @State private var targetURL: URL?
    @State private var targetTitle: String
    @State private var message: String?
    @State private var savedConflictID: UUID?
    init(store: BoardStore, sourceURL: URL, page: Int, sourceReference: PDFSourceReference?, closeTitle: String?, onOpenBoard: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.store = store; self.sourceURL = sourceURL; self.page = page; self.sourceReference = sourceReference; self.closeTitle = closeTitle; self.onOpenBoard = onOpenBoard; self.onClose = onClose
        _targetID = State(initialValue: store.document.id); _targetURL = State(initialValue: store.boardURL); _targetTitle = State(initialValue: store.document.title)
    }
    private var validTarget: Bool {
        guard let targetURL, store.vaultURL != nil, store.document.id == targetID, store.boardURL == targetURL else { return false }
        return FileManager.default.fileExists(atPath: targetURL.path)
    }
    var body: some View {
        PDFWorkspaceView(rootURL: store.vaultURL, sourceURL: sourceURL, page: page, sourceReference: sourceReference, closeTitle: closeTitle,
            excerptTargetTitle: savedConflictID == store.document.id ? String(localized:"已保留冲突副本：\(store.document.title)；请打开白板检查后重新关联。") : validTarget ? String(localized: "摘录自动加入：\(targetTitle)") : String(localized: "请先打开已保存的目标白板，再从白板阅读 PDF 并摘录。"),
            onOpenBoard: validTarget || savedConflictID == store.document.id ? onOpenBoard : nil,
            onExcerpt: validTarget ? { reference in
                guard validTarget else { message = String(localized: "接收白板已变化，摘录未保存。请回白板后重新打开 PDF。"); return false }
                let saved = await store.addPDFExcerpt(reference)
                message = saved ? String(localized: "摘录已加入接收白板，可继续阅读。") : store.status
                return saved
            } : nil,
            onImageExcerpt: validTarget && !store.usesPhoneInterface ? { excerpt in
                guard validTarget else { message=String(localized:"接收白板已变化，摘录未保存。请回白板后重新打开 PDF。");return false }
                let saved=await store.addPDFImageExcerpt(excerpt);message=store.status;if saved && !validTarget {savedConflictID=store.document.id};return saved
            } : nil, onClose: onClose)
            .safeAreaInset(edge: .bottom) {
                if let message { Text(message).font(.caption).padding(8).frame(maxWidth: .infinity).background(.regularMaterial).accessibilityIdentifier("pdfWorkspace.excerptResult") }
            }
    }
}

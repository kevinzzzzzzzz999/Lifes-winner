import Foundation
import Observation

@MainActor @Observable
final class BoardReviewStore {
    private(set) var records: [BoardReview] = []
    private(set) var isWriting = false
    private(set) var isLoading = false
    var draft: BoardReview?
    var overlaysVisible = true
    var selectedID: UUID?
    var captureEnabled = false
    var eraserEnabled = false
    private(set) var commentColors: [String]
    private(set) var highlightColors: [String]
    private var commentColor: String
    private var highlightColor: String
    private var commentWidth: Double
    private var highlightWidth: Double
    var colors: [String] { style == .highlight ? highlightColors : commentColors }
    var color: String {
        get { style == .highlight ? highlightColor : commentColor }
        set {
            guard Self.validColor(newValue) else { return }
            if style == .highlight { highlightColor = newValue.lowercased() } else { commentColor = newValue.lowercased() }
            persistTools()
        }
    }
    var strokeWidth: Double {
        get { style == .highlight ? highlightWidth : commentWidth }
        set {
            guard newValue.isFinite else { return }
            if style == .highlight { highlightWidth = min(48, max(6, newValue)) }
            else { commentWidth = min(20, max(1, newValue)) }
            persistTools()
        }
    }
    var hasPendingWrite: Bool { failed != nil }
    var style: BoardReviewStyle = .comment
    func selectStyle(_ value: BoardReviewStyle) {
        guard !isWriting, draft == nil else { return }
        style = value; eraserEnabled = false; overlaysVisible = true
    }
    func selectEraser() {
        guard !isWriting, draft == nil, failed == nil else { return }
        eraserEnabled = true; captureEnabled = true; overlaysVisible = true
    }
    @discardableResult func addColor(_ value: String) -> Bool {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.validColor(value), colors.count < 24 || colors.contains(value) else { return false }
        if style == .highlight { if !highlightColors.contains(value) { highlightColors.append(value) } }
        else if !commentColors.contains(value) { commentColors.append(value) }
        color = value; persistTools(); return true
    }
    func removeColor(_ value: String) {
        guard colors.count > 1 else { return }
        if style == .highlight { highlightColors.removeAll { $0 == value }; if highlightColor == value { highlightColor = highlightColors[0] } }
        else { commentColors.removeAll { $0 == value }; if commentColor == value { commentColor = commentColors[0] } }
        persistTools()
    }
    var status = ""
    private(set) var contextSession: UUID?
    @ObservationIgnored private let repository: ReviewRepository
    @ObservationIgnored private let defaults: UserDefaults
    private static let toolsKey = "inkspace.reviewTools65"
    private struct ToolSettings: Codable {
        var commentColors: [String]; var highlightColors: [String]
        var commentColor: String; var highlightColor: String
        var commentWidth: Double; var highlightWidth: Double
    }
    private static func validColor(_ value: String) -> Bool { value.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil }
    init(repository: ReviewRepository = ReviewRepository(), defaults: UserDefaults = .standard) {
        self.repository = repository; self.defaults = defaults
        let saved = defaults.data(forKey: Self.toolsKey).flatMap { try? JSONDecoder().decode(ToolSettings.self, from: $0) }
        func palette(_ saved: [String]?, fallback: [String]) -> [String] {
            guard let saved, !saved.isEmpty, saved.count <= 24, saved.allSatisfy(Self.validColor) else { return fallback }
            var result: [String] = []; for color in saved.map({ $0.lowercased() }) where !result.contains(color) { result.append(color) }; return result
        }
        let commentPalette = palette(saved?.commentColors, fallback: ["#ef4444", "#2563eb", "#a16207"])
        let highlightPalette = palette(saved?.highlightColors, fallback: ["#facc15", "#4ade80", "#f472b6"])
        commentColors = commentPalette; highlightColors = highlightPalette
        commentColor = commentPalette.contains(saved?.commentColor ?? "") ? saved!.commentColor : commentPalette[0]
        highlightColor = highlightPalette.contains(saved?.highlightColor ?? "") ? saved!.highlightColor : highlightPalette[0]
        commentWidth = saved?.commentWidth.isFinite == true ? min(20, max(1, saved!.commentWidth)) : 3
        highlightWidth = saved?.highlightWidth.isFinite == true ? min(48, max(6, saved!.highlightWidth)) : 16
    }
    private func persistTools() {
        let value = ToolSettings(commentColors: commentColors, highlightColors: highlightColors, commentColor: commentColor, highlightColor: highlightColor, commentWidth: commentWidth, highlightWidth: highlightWidth)
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: Self.toolsKey) }
    }
    @ObservationIgnored private var root: URL?
    @ObservationIgnored private var boardPath: String?
    @ObservationIgnored private var boardID: UUID?
    @ObservationIgnored private var failed: Pending?
    @ObservationIgnored private var loadEpoch = UUID()
    private enum Pending { case add(BoardReview), delete(UUID) }

    func attach(root: URL?, path: String?, boardID: UUID, session: UUID) async {
        guard contextSession != session || self.root != root || self.boardPath != path || self.boardID != boardID else { return }
        guard await flush(), !Task.isCancelled else { return }
        loadEpoch = UUID(); isLoading = false; failed = nil
        self.root = root; self.boardPath = path; self.boardID = boardID
        contextSession = session; records = []; selectedID = nil; overlaysVisible = true; draft = nil; captureEnabled = false; eraserEnabled = false; status = ""
        await reload()
    }
    func isBound(boardID: UUID, session: UUID) -> Bool { self.boardID == boardID && contextSession == session }
    func reload() async {
        guard !isLoading, !isWriting, let root, let boardPath, let boardID, let session = contextSession else { return }
        let epoch = UUID(); loadEpoch = epoch; isLoading = true
        defer { if loadEpoch == epoch { isLoading = false } }
        do {
            let result = try await repository.list(root: root)
            guard contextSession == session, loadEpoch == epoch, !Task.isCancelled else { return }
            records = result.records.filter { $0.boardID == boardID && $0.boardPath == boardPath }
            if let selectedID, !records.contains(where: { $0.id == selectedID }) { self.selectedID = nil }
            if result.warnings > 0 { status = String(localized: "有 \(result.warnings) 个批注文件无法读取；已删除记录不会重新显示") }
            else if failed == nil { status = String(localized: "待修改批注：\(records.count) · 仅保存独立审阅文件") }
        } catch {
            guard contextSession == session, loadEpoch == epoch, !Task.isCancelled else { return }
            status = String(localized: "批注刷新失败，已保留当前记录：\(error.localizedDescription)")
        }
    }
    func discardDraft() {
        if case .add(let value) = failed, value.id == draft?.id { failed = nil }
        draft = nil; captureEnabled = false
    }
    func compose(points worldPoints: [CGPoint], board: BoardDocument, zoom: CGFloat = 1) {
        guard draft == nil, !isWriting, failed == nil, !eraserEnabled, board.id == boardID, let path = boardPath, let first = worldPoints.first, !worldPoints.isEmpty else { return }
        let item = board.items.reversed().first { $0.rect.contains(first) }
        let boundary = item?.rect ?? CGRect(x: 0, y: 0, width: 8_000_000, height: 8_000_000)
        let points = worldPoints.map { CGPoint(x: min(max($0.x, boundary.minX), boundary.maxX), y: min(max($0.y, boundary.minY), boundary.maxY)) }
        // A highlighter needs a deliberate stroke; a tap keeps ordinary reading safe.
        if style == .highlight && points.count < 2 { return }
        let isPin = points.count == 1
        var bounds = points.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: CGSize(width: 0.01, height: 0.01))) }
        if isPin { bounds = CGRect(x: first.x - 8, y: first.y - 8, width: 16, height: 16) }
        bounds = bounds.insetBy(dx: -1, dy: -1).intersection(boundary)
        guard bounds.width > 0, bounds.height > 0 else { return }
        let normalized = isPin ? [] : points.map { [Double(min(1,max(0,($0.x - bounds.minX)/bounds.width))), Double(min(1,max(0,($0.y - bounds.minY)/bounds.height)))] }
        let anchor = item.map { value in ReviewAnchor(itemID: value.id, sourcePath: value.sourcePath,
            originalSourcePath: value.originalSourcePath, page: value.page,
            rect: ReviewRect(CGRect(x: (bounds.minX - value.x)/value.width, y: (bounds.minY - value.y)/value.height,
                                   width: bounds.width/value.width, height: bounds.height/value.height))) }
        let digest = item?.originalSourceSHA256 ?? board.pdfAnnotationSources?.first { $0.sourcePath == item?.sourcePath }?.sha256
        draft = BoardReview(boardPath: path, boardID: board.id, createdAt: ReviewRepository.timestamp(), comment: "", color: color,
                            rect: ReviewRect(bounds), points: normalized, anchor: anchor, sourceSHA256: digest,
                            style: style == .highlight ? .highlight : nil,
                            strokeWidth: isPin && style == .comment && strokeWidth == 3 ? nil : strokeWidth / Double(max(zoom, 0.00005)))
        captureEnabled = false
    }
    func addDraft(comment: String) async -> Bool {
        guard var value = draft else { return false }
        value.comment = comment
        return await write(.add(value))
    }
    func delete(_ id: UUID) async -> Bool { await write(.delete(id)) }
    func erase(_ ids: [UUID]) async {
        guard eraserEnabled, !isWriting, failed == nil, draft == nil else { return }
        var unique: [UUID] = []
        for id in ids where !unique.contains(id) && records.contains(where: { $0.id == id }) { unique.append(id) }
        for id in unique.prefix(100) { if !(await delete(id)) { captureEnabled = false; return } }
        if !unique.isEmpty { status = String(localized: "已擦除碰到的整条高亮或批注；原文与正式笔迹未改动") }
    }
    func flush() async -> Bool {
        while isWriting { do { try await Task.sleep(for: .milliseconds(30)) } catch { return false } }
        if let failed { return await write(failed) }
        return true
    }
    private func write(_ pending: Pending) async -> Bool {
        guard !isWriting, let root, let session = contextSession else { return false }
        isWriting = true
        do {
            switch pending {
            case .add(let record): try await repository.add(record, root: root)
            case .delete(let id): try await repository.delete(id, root: root)
            }
            guard contextSession == session else { isWriting = false; return false }
            switch pending {
            case .add(let record): if !records.contains(where: { $0.id == record.id }) { records.append(record) }
            case .delete(let id): records.removeAll { $0.id == id }; if selectedID == id { selectedID = nil }
            }
            failed = nil; draft = nil; isWriting = false
            await reload()
            if case .add(let record) = pending, record.isHighlight {
                status = String(localized: "高亮已独立保存；等待共享文件夹同步")
            } else { status = String(localized: "待修改批注已保存；等待共享文件夹同步") }
            return true
        } catch {
            isWriting = false
            if contextSession == session { failed = pending; status = String(localized: "尚未保存，请重试：\(error.localizedDescription)") }
            return false
        }
    }
    func rect(for review: BoardReview, items: [BoardItem]) -> CGRect {
        guard let anchor = review.anchor, let item = items.first(where: { $0.id == anchor.itemID }) else { return review.rect.cgRect }
        return CGRect(x: item.x + anchor.rect.x * item.width, y: item.y + anchor.rect.y * item.height,
                      width: anchor.rect.width * item.width, height: anchor.rect.height * item.height)
    }
}

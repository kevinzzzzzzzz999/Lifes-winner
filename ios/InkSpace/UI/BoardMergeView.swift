import SwiftUI
import Observation

/// A transient placement owns no document changes. Only the explicit commit
/// writes files; taps and camera gestures change this preview alone.
@MainActor @Observable
final class BoardMergePlacementSession: Identifiable {
    let id = UUID()
    let service: BoardMergeService
    let preview: BoardMergePreview
    let canvasSessionID: UUID
    let rootURL: URL
    let returnPath: String
    let previousMode: BoardMode
    let previouslyReading: Bool
    let previousCenter: CGPoint
    let previousZoom: CGFloat
    var position: CGPoint?
    var working = false
    var errorMessage: String?
    init(service: BoardMergeService, preview: BoardMergePreview, canvasSessionID: UUID,
         rootURL: URL, returnPath: String, previousMode: BoardMode, previouslyReading: Bool,
         previousCenter: CGPoint, previousZoom: CGFloat) {
        self.service = service; self.preview = preview; self.canvasSessionID = canvasSessionID
        self.rootURL = rootURL; self.returnPath = returnPath; self.previousMode = previousMode
        self.previouslyReading = previouslyReading; self.previousCenter = previousCenter; self.previousZoom = previousZoom
    }
    var bounds: CGRect {
        let size = preview.sourceBounds.isNull ? CGSize(width: 1, height: 1) : preview.sourceBounds.size
        return CGRect(origin: position ?? preview.placedBounds.origin, size: size)
    }
    var fitsCanvas: Bool {
        let b = bounds
        return !b.isNull && !b.isInfinite && [b.minX,b.minY,b.maxX,b.maxY].allSatisfy(\.isFinite)
            && b.minX >= 0 && b.minY >= 0 && b.maxX <= 8_000_000 && b.maxY <= 8_000_000
    }
    var canCommit: Bool { position != nil && fitsCanvas && !working }
    func choose(_ point: CGPoint) {
        guard !working, point.x.isFinite, point.y.isFinite else { return }
        position = point; errorMessage = nil
    }
}

struct BoardMergeUndoSession {
    let service: BoardMergeService
    let result: BoardMergeResult
    let rootURL: URL
}

/// Explicit source and target selection prevents a library tap from being a
/// destructive operation. The second step shows the exact saved SHA snapshot.
struct BoardMergeView: View {
    let store: BoardStore
    let onPlace: (BoardMergeService, BoardMergePreview) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var service = BoardMergeService()
    @State private var files: [String] = []
    @State private var sourcePath = ""
    @State private var targetPath = ""
    @State private var placement: BoardMergePlacement = .below
    @State private var mode: BoardMergeMode = .intoTarget
    @State private var preview: BoardMergePreview?
    @State private var busy = false
    @State private var loading = true
    @State private var errorMessage: String?
    @State private var choosingSource: Bool?
    @State private var showsPicker = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(String(localized: "把一张白板的完整内容加入另一张白板。源白板始终保留；两张原件会先备份。"))
                        .foregroundStyle(.secondary)
                }
                Section(String(localized: "两张白板")) {
                    chooseFile(title: String(localized: "从这张白板取出内容"), path: sourcePath, source: true)
                    chooseFile(title: String(localized: "合入这张目标白板"), path: targetPath, source: false)
                    if sourcePath == targetPath && !sourcePath.isEmpty {
                        Text(String(localized: "源白板与目标白板必须不同。"))
                            .font(.footnote).foregroundStyle(.red)
                    }
                    if loading { ProgressView(String(localized: "正在查找当前仓库的白板…")) }
                }
                Section(String(localized: "合并方式")) {
                    Picker(String(localized: "保存方式"), selection: $mode) {
                        ForEach(BoardMergeMode.allCases) { value in Text(value.title).tag(value) }
                    }
                    Picker(String(localized: "预览起始位置"), selection: $placement) {
                        ForEach(BoardMergePlacement.allCases) { value in Text(value.title).tag(value) }
                    }
                    Text(String(localized: "下方或右侧只是预览的起始位置。下一步在目标白板上点击，设定整块内容的左上角；可以平移、缩放和重新选位置，确认前不会写入。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let preview {
                    Section(String(localized: "已检查的源内容")) {
                        LabeledContent(String(localized: "原生笔迹"), value: String(preview.counts.nativeStrokes))
                        LabeledContent(String(localized: "资料与文字块"), value: String(preview.counts.items))
                        LabeledContent(String(localized: "定位点 / 连线 / 打印框"), value: "\(preview.counts.pins) / \(preview.counts.edges) / \(preview.counts.printFrames)")
                        LabeledContent(String(localized: "胶带 / 待批注 / 复习事件"), value: "\(preview.counts.tapes) / \(preview.counts.reviews) / \(preview.counts.studyEvents)")
                        Text(preview.outputPath).font(.footnote).textSelection(.enabled)
                        Text(String(localized: "提交前会再次核对两张白板和附属记录；如果其他设备已修改，会停止本次合并。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red).textSelection(.enabled)
                    }
                }
                Section {
                    Button {
                        Task { if let preview { await merge(preview) } else { await inspect() } }
                    } label: {
                        HStack {
                            if busy { ProgressView() }
                            Text(preview == nil ? String(localized: "检查完整内容") : String(localized: "在目标白板上放置"))
                                .fontWeight(.semibold)
                        }.frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .disabled(busy || loading || sourcePath.isEmpty || targetPath.isEmpty || sourcePath == targetPath)
                    .accessibilityIdentifier(preview == nil ? "board.merge.inspect" : "board.merge.commit")
                }
            }
            .disabled(busy)
            .navigationTitle(String(localized: "合并白板"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "关闭")) { dismiss() }.disabled(busy)
                }
            }
            .interactiveDismissDisabled(busy)
            .task { await load() }
            .onChange(of: sourcePath) { _, _ in resetPreview() }
            .onChange(of: targetPath) { _, _ in resetPreview() }
            .onChange(of: mode) { _, _ in resetPreview() }
            .onChange(of: placement) { _, _ in resetPreview() }
            .sheet(isPresented: $showsPicker) {
                BoardMergeFilePicker(files: files, selected: choosingSource == true ? sourcePath : targetPath) { path in
                    if choosingSource == true { sourcePath = path } else { targetPath = path }
                }
            }
        }
        .presentationDetents([.large])
    }

    private func chooseFile(title: String, path: String, source: Bool) -> some View {
        Button { choosingSource = source; showsPicker = true } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.subheadline).foregroundStyle(.secondary)
                HStack {
                    Image(systemName: "rectangle.on.rectangle")
                    Text(path.isEmpty ? String(localized: "选择白板") : path).multilineTextAlignment(.leading)
                    Spacer(); Image(systemName: "chevron.right").font(.caption)
                }.foregroundStyle(.primary)
            }.frame(minHeight: 48)
        }.disabled(loading).accessibilityIdentifier(source ? "board.merge.source" : "board.merge.target")
    }
    private func load() async {
        loading = true
        files = await store.boardFiles().compactMap { store.relativePath(for: $0) }
        if sourcePath.isEmpty { sourcePath = store.boardURL.flatMap { store.relativePath(for: $0) } ?? "" }
        loading = false
    }
    private func resetPreview() { preview = nil; errorMessage = nil }
    private func inspect() async {
        busy = true; errorMessage = nil; defer { busy = false }
        do { preview = try await store.prepareBoardMerge(service: service, sourcePath: sourcePath, targetPath: targetPath, placement: placement, mode: mode) }
        catch { errorMessage = error.localizedDescription }
    }
    private func merge(_ preview: BoardMergePreview) async {
        busy = true; errorMessage = nil; defer { busy = false }
        do {
            guard !store.isBusy, !store.isDirty else { throw BoardMergeError.changed }
            onPlace(service, preview); dismiss()
        }
        catch { self.preview = nil; errorMessage = error.localizedDescription }
    }
}

private struct BoardMergeFilePicker: View {
    let files: [String]; let selected: String; let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    var body: some View {
        NavigationStack {
            List(files.filter { search.isEmpty || $0.localizedCaseInsensitiveContains(search) }, id: \.self) { path in
                Button { choose(path); dismiss() } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(URL(fileURLWithPath: path).lastPathComponent.replacingOccurrences(of: ".inkspace.json", with: ""))
                            Text((path as NSString).deletingLastPathComponent).font(.caption).foregroundStyle(.secondary)
                        }.foregroundStyle(.primary)
                        Spacer()
                        if path == selected { Image(systemName: "checkmark").foregroundStyle(.tint) }
                    }.frame(minHeight: 44)
                }
            }
            .searchable(text: $search, prompt: String(localized: "课程、week 或白板名称"))
            .navigationTitle(String(localized: "选择白板")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } } }
        }
    }
}

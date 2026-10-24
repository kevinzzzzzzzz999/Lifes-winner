import SwiftUI
import PencilKit

struct StudyPanel: View {
    var store: BoardStore
    @Bindable var session: StudySession
    var onLocate: (BoardItem) -> Void
    var onSource: (BoardItem) -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDiscard = false
    @State private var showsTransfer = false
    @State private var deleteCandidate: StudyCardState?
    private var editingAllowed: Bool { !store.usesPhoneInterface }
    var body: some View {
        NavigationStack {
            Group {
                if session.draft != nil { StudyCardEditor(session: session, items: store.document.items, rootURL: store.vaultURL) }
                else { contents }
            }
            .navigationTitle(String(localized: "学习与复习"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "关闭")) { if session.dirty || session.pending != nil { confirmDiscard = true } else { dismiss() } }
                        .frame(minHeight: 44).disabled(session.busy).accessibilityIdentifier("study.close")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(store.usesPhoneInterface ? String(localized:"导出") : String(localized: "导入与导出")) { showsTransfer = true }
                        .frame(minHeight:44).disabled(session.busy || session.draft != nil || session.pending != nil)
                        .accessibilityIdentifier("study.transfer")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await session.load(root: store.vaultURL, boardID: store.document.id) } } label: { Image(systemName: "arrow.clockwise") }
                        .frame(minWidth: 44, minHeight: 44).disabled(session.busy || session.draft != nil || session.pending != nil)
                        .accessibilityLabel(String(localized: "刷新复习记录")).accessibilityIdentifier("study.refresh")
                }
            }
            .confirmationDialog(String(localized: "放弃未保存的卡片修改？"), isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button(String(localized: "放弃修改"), role: .destructive) { session.discardDraft(); dismiss() }
                Button(String(localized: "继续编辑"), role: .cancel) {}
            }
            .confirmationDialog(String(localized: "移除这张复习卡片？白板节点仍会保留。"), isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }), titleVisibility: .visible) {
                Button(String(localized: "移除卡片"), role: .destructive) { if let card = deleteCandidate { Task { await session.deleteCard(card) } }; deleteCandidate = nil }
            }
        }
        .sheet(isPresented: $showsTransfer, onDismiss: { Task { await session.load(root:store.vaultURL,boardID:store.document.id) } }) { StudyTransferView(store:store,study:session) }
        .interactiveDismissDisabled(session.dirty || session.busy || session.pending != nil)
        .task(id: store.document.id) { await session.load(root: store.vaultURL, boardID: store.document.id) }
    }
    private var contents: some View {
        VStack(spacing: 0) {
            Picker(String(localized: "学习视图"), selection: $session.tab) {
                Text(String(localized: "复习")).tag(0)
                Text(String(localized: "节点大纲")).tag(1)
                Text(String(localized: "卡片管理")).tag(2)
            }.pickerStyle(.segmented).padding().disabled(session.busy || session.pending != nil).accessibilityIdentifier("study.tabs")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    status
                    if session.tab == 0 { review }
                    else if session.tab == 1 { outline }
                    else { cardList }
                }.padding()
            }
        }.background(PadDesign.paper)
    }
    @ViewBuilder private var status: some View {
        if session.busy { ProgressView(String(localized: "正在读取或保存复习记录…")) }
        if let error = session.error {
            Text(error).font(.callout).foregroundStyle(.red).accessibilityIdentifier("study.error")
        }
        if session.pending != nil {
                Button(String(localized: "重试保存")) { Task { _ = await session.commit() } }
                    .buttonStyle(.borderedProminent).foregroundStyle(PadDesign.paper).frame(minHeight: 44).disabled(session.busy).accessibilityIdentifier("study.retry")
        }
        if !session.warnings.isEmpty {
            Label(String(localized: "部分复习记录未能读取，保存已暂停；原文件保留。"), systemImage: "exclamationmark.triangle")
                .font(.callout).foregroundStyle(PadDesign.bronze)
        }
    }
    @ViewBuilder private var review: some View {
        Toggle(String(localized: "只看待复习"), isOn: $session.dueOnly)
            .onChange(of: session.dueOnly) { _, _ in session.restartQueue() }
            .disabled(session.busy || session.pending != nil).accessibilityIdentifier("study.dueOnly")
        if let card = session.current {
            let item = store.document.items.first { $0.id.uuidString.lowercased() == card.itemID }
            StudyReviewCard(rootURL: store.vaultURL, card: card, item: item, revealed: session.revealed,
                blocked: session.writingBlocked || session.pending != nil,
                onReveal: { session.revealed = true }, onRate: { grade in Task { await session.rate(grade) } },
                onLocate: { if let item { onLocate(item) } }, onSource: { if let item, !onSource(item) { session.error = String(localized: "原文件当前不可用，复习进度已保留。") } })
                .id(card.eventID)
            if editingAllowed, let item, session.revealed {
                Button(String(localized: "编辑卡片")) { session.edit(item) }.frame(minHeight: 44)
                    .disabled(session.writingBlocked || session.pending != nil).accessibilityIdentifier("study.edit")
            }
        } else if !session.busy {
            ContentUnavailableView(String(localized: "当前没有待复习卡片"), systemImage: "checkmark.rectangle.stack",
                description: Text(String(localized: "可切换查看全部，或从节点大纲创建卡片。")))
            if !session.completed.isEmpty { Button(String(localized: "再复习一轮")) { session.restartQueue() }.frame(minHeight: 44) }
        }
    }
    private var outline: some View {
        let rows = StudyNodes.outline(store.document)
        let query = session.search.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = rows.filter { query.isEmpty || $0.item.title.localizedCaseInsensitiveContains(query) || StudyNodes.answer($0.item).localizedCaseInsensitiveContains(query) }
        let visible = Set(matches.flatMap { [$0.id] + $0.ancestors })
        return VStack(alignment: .leading, spacing: 12) {
            TextField(String(localized: "搜索当前白板节点"), text: $session.search).textFieldStyle(.roundedBorder).accessibilityIdentifier("study.search")
            if !store.selectedIDs.isEmpty, editingAllowed {
                Text(String(localized: "已选节点优先创建；大纲保留原来的父子关系。")) .font(.caption).foregroundStyle(.secondary)
                ForEach(store.document.items.filter { store.selectedIDs.contains($0.id) && StudyNodes.eligible($0) }) { item in
                    Button { session.edit(item) } label: { Label(item.title, systemImage: "rectangle.stack.badge.plus") }
                        .frame(minHeight: 44).disabled(session.writingBlocked || session.pending != nil)
                }
            }
            ForEach(rows.filter { visible.contains($0.id) && (!query.isEmpty || $0.ancestors.allSatisfy { !session.collapsed.contains($0) }) }) { row in
                StudyOutlineNode(row: row, collapsed: session.collapsed.contains(row.id), canEdit: editingAllowed && StudyNodes.eligible(row.item), blocked: session.writingBlocked || session.pending != nil,
                    onToggle: { if !session.collapsed.insert(row.id).inserted { session.collapsed.remove(row.id) } },
                    onLocate: { onLocate(row.item) }, onEdit: { session.edit(row.item) },
                    onSource: { if !onSource(row.item) { session.error = String(localized: "原文件当前不可用，复习进度已保留。") } })
            }
            if rows.isEmpty { Text(String(localized: "当前白板还没有节点。")) }
        }
    }
    private var cardList: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(session.cards) { card in
                let item = store.document.items.first { $0.id.uuidString.lowercased() == card.itemID }
                VStack(alignment: .leading, spacing: 8) {
                    Text(card.card.mode == "cloze" ? ((try? StudyCloze.front(card.card.question)) ?? "") : card.card.question).font(.headline)
                    Text(item == nil ? String(localized: "源节点已缺失；卡片记录仍保留。") : String(localized: "已复习 \(card.reviewCount) 次"))
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button(String(localized: "复习")) { session.currentID = card.itemID; session.revealed = false; session.tab = 0 }
                        if editingAllowed, let item { Button(String(localized: "编辑卡片")) { session.edit(item) } }
                        if editingAllowed { Button(String(localized: "移除卡片"), role: .destructive) { deleteCandidate = card } }
                    }.buttonStyle(.bordered).frame(minHeight: 44).disabled(session.writingBlocked || session.pending != nil)
                }.padding().padSurface()
            }
            if session.cards.isEmpty { Text(String(localized: "从节点大纲创建第一张卡片。")) }
        }
    }
}
private struct StudyReviewCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let rootURL: URL?
    let card: StudyCardState
    let item: BoardItem?
    let revealed: Bool
    let blocked: Bool
    let onReveal: () -> Void
    let onRate: (StudyGrade) -> Void
    let onLocate: () -> Void
    let onSource: () -> Void
    @State private var imageReady = false
    @State private var readyBlocks: Set<String> = []
    @State private var showsExport = false
    private var expectedImages: Set<String> { Set(((card.card.questionBlocks ?? []) + (card.card.answerBlocks ?? [])).filter { $0.kind == "image" }.map(\.id)) }
    private var richReady: Bool { expectedImages.isSubset(of: readyBlocks) }
    private func blockReady(_ id: String, _ ready: Bool) { if ready { readyBlocks.insert(id) } else { readyBlocks.remove(id) } }
    private var visualAnswer: Bool { card.card.mode == "qa" && card.card.answerMode == "node" && StudyNodes.isImage(item) }
    private var answer: String { card.card.answerMode == "node" ? StudyNodes.answer(item) : card.card.answer }
    private var sourceLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout())
    }
    private var gradeColumns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize ? [GridItem(.flexible())] : [GridItem(.adaptive(minimum: 120))]
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(card.card.mode == "cloze" ? ((try? StudyCloze.front(card.card.question)) ?? "") : card.card.question)
                .font(.title2.weight(.semibold)).textSelection(.enabled).accessibilityIdentifier("study.question")
            Button(String(localized: "图文卡片导出预览"), systemImage: "doc.richtext") { showsExport = true }
                .buttonStyle(.bordered).accessibilityIdentifier("study.export.open")
            if let blocks = card.card.questionBlocks {
                StudyContentBlocksView(rootURL: rootURL, blocks: blocks, revealed: revealed, onReady: blockReady)
            }
            if let reference = item?.sourceReference {
                Text(String(localized: "来源：\((reference.path as NSString).lastPathComponent) · 第 \(reference.page) 页"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if item == nil { Text(String(localized: "源节点已缺失；卡片记录仍保留。")) .foregroundStyle(PadDesign.bronze) }
            if revealed {
                Divider()
                if card.card.mode == "cloze" {
                    Text(StudyCloze.revealed(card.card.question)).font(.title3).textSelection(.enabled).accessibilityIdentifier("study.answer")
                }
                if visualAnswer, let path = item?.sourcePath {
                    StudyImageAnswer(rootURL: rootURL, path: path, onReady: { imageReady = $0 })
                        .id(path).accessibilityElement(children:.contain).accessibilityIdentifier("study.imageAnswer")
                } else if !answer.isEmpty { Text(answer).textSelection(.enabled).accessibilityIdentifier("study.answerText") }
                else if card.card.answerMode == "node" { Text(String(localized: "节点当前没有正文，请在 iPad 上设置自定义答案。")) .foregroundStyle(.secondary) }
                if let blocks = card.card.answerBlocks {
                    StudyContentBlocksView(rootURL: rootURL, blocks: blocks, revealed: true, onReady: blockReady)
                }
                if let item, item.kind == .inkGroup, let data = item.inkData { StudyInkAnswer(data: data) }
                if item != nil {
                    sourceLayout {
                        Button(String(localized: "定位节点"), action: onLocate)
                        if item?.sourceReference != nil { Button(String(localized: "返回原文"), action: onSource).accessibilityIdentifier("study.source") }
                    }.buttonStyle(.bordered).frame(minHeight: 44).disabled(blocked)
                }
                LazyVGrid(columns: gradeColumns, spacing: 10) {
                    ForEach(StudyGrade.allCases, id: \.rawValue) { grade in
                        Button(grade.label) { onRate(grade) }.frame(maxWidth: .infinity, minHeight: 44)
                            .buttonStyle(.borderedProminent).foregroundStyle(PadDesign.paper).disabled(blocked || item == nil || !richReady || (card.card.mode == "qa" && (visualAnswer ? !imageReady : answer.isEmpty && (card.card.answerBlocks?.isEmpty ?? true))))
                            .accessibilityIdentifier("study.grade." + grade.rawValue)
                    }
                }
            } else {
                Button(String(localized: "揭晓答案"), action: onReveal).frame(maxWidth: .infinity, minHeight: 44)
                    .buttonStyle(.borderedProminent).foregroundStyle(PadDesign.paper).disabled(blocked).accessibilityIdentifier("study.reveal")
            }
        }.padding(20).padSurface().accessibilityElement(children: .contain)
            .sheet(isPresented: $showsExport) { StudyCardExportView(rootURL: rootURL, card: card.card, item: item) }
            .onChange(of: revealed) { _, value in if !value { imageReady = false } }
            .onChange(of: card.eventID) { _, _ in readyBlocks = []; imageReady = false }
            .onChange(of: item?.sourcePath) { _, _ in imageReady = false }
    }
}
private extension StudyGrade {
    var label: String { switch self {
    case .again: String(localized: "再来一次")
    case .hard: String(localized: "较难")
    case .good: String(localized: "记住了")
    case .easy: String(localized: "很容易")
    } }
}
private struct StudyInkAnswer: View {
    var data: Data
    @State private var image: UIImage?
    var body: some View {
        Group { if let image { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 320).background(.white).accessibilityLabel(String(localized: "节点原生笔迹")) } }
            .task {
                guard let drawing = try? PKDrawing(data: data), !drawing.bounds.isEmpty else { return }
                let bounds = drawing.bounds.insetBy(dx: -8, dy: -8)
                UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                    image = drawing.image(from: bounds, scale: min(2, 1200 / max(bounds.width, bounds.height)))
                }
            }
    }
}
private struct StudyOutlineNode: View {
    var row: StudyOutlineRow
    var collapsed: Bool
    var canEdit: Bool
    var blocked: Bool
    var onToggle: () -> Void
    var onLocate: () -> Void
    var onEdit: () -> Void
    var onSource: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                if row.hasChildren { Button(action: onToggle) { Image(systemName: collapsed ? "chevron.right" : "chevron.down") }.frame(width: 44, height: 44).accessibilityLabel(String(localized: "展开或收起子节点")) }
                Text(row.item.title.isEmpty ? String(localized: "未命名节点") : row.item.title).font(.headline).fixedSize(horizontal: false, vertical: true)
            }
            if StudyNodes.isImage(row.item) { Label(String(localized:"图片节点 · 可制作图片答案卡"), systemImage:"photo").font(.caption).foregroundStyle(.secondary) }
            ViewThatFits(in: .horizontal) {
                HStack { actionButtons }; VStack(alignment: .leading) { actionButtons }
            }.buttonStyle(.bordered).disabled(blocked)
        }.padding().padSurface().padding(.leading, CGFloat(min(6, row.depth)) * 12)
    }
    @ViewBuilder private var actionButtons: some View {
            Button(String(localized: "定位节点"), action: onLocate).frame(minHeight: 44)
            if row.item.sourceReference != nil { Button(String(localized: "返回原文"), action: onSource).frame(minHeight: 44) }
            if canEdit { Button(String(localized: "制作卡片"), action: onEdit).frame(minHeight: 44).accessibilityIdentifier("study.create." + row.id.uuidString.lowercased()) }
    }
}

import SwiftUI

private enum BoardContentsFilter: CaseIterable, Hashable {
    case all, sources, notes
    var title: String {
        switch self {
        case .all: return String(localized: "全部")
        case .sources: return String(localized: "文件资料")
        case .notes: return String(localized: "白板笔记")
        }
    }
    func includes(_ item: BoardItem) -> Bool {
        let hasSource = item.originalSourcePath != nil || item.sourcePath != nil
        return self == .all || (self == .sources ? hasSource : !hasSource)
    }
}

/// Navigation shared by phone/tablet and reading/editing. It never edits items.
struct BoardReadingContentsView: View {
    let store: BoardStore
    let onOpen: (BoardItem) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var filter: BoardContentsFilter = .all

    private var items: [BoardItem] {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return store.document.items.filter { item in
            guard filter.includes(item) else { return false }
            var fields = [item.title, item.sourcePath ?? "", item.originalSourcePath ?? ""]
            if let page = item.page { fields += [String(page), String(localized: "第 \(page) 页")] }
            let searchable = fields.joined(separator: "\n")
            return terms.allSatisfy { searchable.localizedCaseInsensitiveContains($0) }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(store.document.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Spacer(minLength: 8)
                        Text(String(localized: "显示 \(items.count) / \(store.document.items.count) 项"))
                            .font(.caption).foregroundStyle(.secondary)
                    }.accessibilityElement(children: .combine).accessibilityIdentifier("board.locate.summary")
                    Picker(String(localized: "资料类型"), selection: $filter) {
                        ForEach(BoardContentsFilter.allCases, id: \.self) { kind in Text(kind.title).tag(kind) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("board.locate.filter")
                    Text(String(localized: "轻点项目回到白板中的位置；打开原文可阅读对应文件。"))
                        .font(.caption).foregroundStyle(.secondary)
                }.padding().background(.bar)
                List(items) { item in itemRow(item) }
                    .listStyle(.insetGrouped)
                    .overlay { if items.isEmpty { emptyState } }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: String(localized: "搜索标题、路径或页码"))
            .navigationTitle(String(localized: "定位资料")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "关闭")) { dismiss() }.accessibilityIdentifier("board.locate.close")
                }
            }
        }
    }

    private func itemRow(_ item: BoardItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if store.locateItem(item.id) { dismiss() }
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: symbol(item)).font(.title3).foregroundStyle(.teal)
                        .frame(width: 34, height: 34).background(Color.teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.body.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                        if let path = item.originalSourcePath ?? item.sourcePath {
                            Text(path).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        if let page = item.page {
                            Text(String(localized: "第 \(page) 页")).font(.caption).foregroundStyle(.secondary)
                        }
                        Label(String(localized: "在白板中定位"), systemImage: "scope").font(.caption.weight(.medium)).foregroundStyle(.teal)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("board.locate.item." + item.id.uuidString)
                .disabled(store.isBusy || store.externalInteractionActive)
            if item.sourcePath != nil || item.originalSourcePath != nil {
                Button { onOpen(item) } label: {
                    Label(String(localized: "打开原文"), systemImage: "arrow.up.forward.app").frame(minHeight: 44)
                }.buttonStyle(.bordered)
                    .accessibilityIdentifier("board.locate.source." + item.id.uuidString)
                    .disabled(store.isBusy || store.externalInteractionActive)
            }
        }.padding(.vertical, 6)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(store.document.items.isEmpty ? String(localized: "白板中还没有资料") : String(localized: "没有匹配的资料"), systemImage: "doc.text.magnifyingglass")
        } description: {
            Text(store.document.items.isEmpty ? String(localized: "添加文件或创建笔记后，可在这里快速定位。") : String(localized: "试试其他资料类型，或搜索标题、文件路径和页码。"))
        } actions: {
            if !query.isEmpty || filter != .all {
                Button(String(localized: "显示全部资料")) { query = ""; filter = .all }
                    .frame(minHeight: 44).accessibilityIdentifier("board.locate.resetSearch")
            }
        }
    }

    private func symbol(_ item: BoardItem) -> String {
        switch item.kind {
        case .text: return "text.bubble"
        case .formula: return "function"
        case .inkGroup: return "pencil.tip"
        case .pdfPage: return "doc.richtext"
        case .document:
            let path = item.originalSourcePath ?? item.sourcePath ?? ""
            switch (path as NSString).pathExtension.lowercased() {
            case "png", "jpg", "jpeg", "heic": return "photo"
            case "mp4", "mov", "m4v": return "play.rectangle"
            case "xls", "xlsx", "xlsm": return "tablecells"
            case "ppt", "pptx": return "rectangle.stack"
            default: return "doc.text"
            }
        }
    }
}

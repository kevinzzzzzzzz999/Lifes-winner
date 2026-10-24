import SwiftUI

/// This view only organizes app-private metadata. The caller flushes and validates before switching boards.
struct BoardLibraryView: View {
    let catalog: BoardCatalogStore
    let currentBoardURL: URL?
    let onOpen: (BoardCatalogEntry) async -> Bool
    let onReconnect: (BoardCatalogEntry) -> Void
    var onChooseVault: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var filter = "all"
    @State private var openingID: UUID?
    @State private var openingError: String?
    @State private var route: LibraryRoute?
    @State private var confirmsRecovery = false
    @State private var refreshTask: Task<Void, Never>?

    private enum LibraryRoute: Identifiable {
        case categories, membership(BoardCatalogEntry)
        var id: String {
            switch self { case .categories: "categories"; case .membership(let entry): entry.id.uuidString }
        }
    }

    private var filteredEntries: [BoardCatalogEntry] {
        catalog.entries.filter { entry in
            guard catalog.matches(entry, query: query) else { return false }
            switch filter {
            case "recent": return entry.lastOpenedAt != nil
            case "current": return entry.vaultID == catalog.currentVaultID
            case "favorites": return entry.isFavorite
            case "all": return true
            default: return UUID(uuidString: filter).map { entry.categoryIDs.contains($0) } ?? false
            }
        }.sorted { lhs, rhs in
            if filter == "recent", lhs.lastOpenedAt != rhs.lastOpenedAt {
                return (lhs.lastOpenedAt ?? .distantPast) > (rhs.lastOpenedAt ?? .distantPast)
            }
            let order = lhs.title.localizedStandardCompare(rhs.title)
            if order != .orderedSame { return order == .orderedAscending }
            if lhs.vaultID != rhs.vaultID { return catalog.vaultLabel(for: lhs) < catalog.vaultLabel(for: rhs) }
            return lhs.relativePath.localizedStandardCompare(rhs.relativePath) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField(String(localized: "搜索名称、路径或仓库"), text: $query)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("boardLibrary.search")
                    }
                    Picker(String(localized: "显示"), selection: $filter) {
                        Text(String(localized: "最近打开")).tag("recent")
                        Text(String(localized: "当前仓库")).tag("current")
                        Text(String(localized: "收藏")).tag("favorites")
                        Text(String(localized: "全部记录")).tag("all")
                        ForEach(catalog.categories) { Text($0.name).tag($0.id.uuidString) }
                    }.accessibilityIdentifier("boardLibrary.filter")
                    Button { route = .categories } label: { Label(String(localized: "管理分类"), systemImage: "folder.badge.gearshape") }
                        .accessibilityIdentifier("boardLibrary.manageCategories")
                }
                if let warning = catalog.warning {
                    Section {
                        Text(warning).foregroundStyle(.secondary).font(.footnote)
                        if catalog.needsRecovery {
                            Button(String(localized: "保留旧记录并恢复")) { confirmsRecovery = true }
                                .accessibilityIdentifier("boardLibrary.recover")
                        }
                        Button(String(localized: "重新读取记录")) { Task { await catalog.load() } }
                            .accessibilityIdentifier("boardLibrary.reload")
                    }
                }
                if let scanWarning = catalog.scanWarning { Text(scanWarning).font(.footnote).foregroundStyle(.secondary) }
                if let openingError { Text(openingError).font(.footnote).foregroundStyle(.red) }
                if catalog.isScanning { ProgressView(String(localized: "正在查找各文件夹中的白板…")) }
                Section {
                    if filteredEntries.isEmpty {
                        ContentUnavailableView(String(localized: "没有符合条件的白板"), systemImage: "rectangle.on.rectangle",
                            description: Text(String(localized: "可切换“当前仓库”、更改搜索条件，或选择其他仓库。以前的白板会在成功打开后加入历史。")))
                    }
                    ForEach(filteredEntries) { entry in
                        BoardLibraryRow(entry: entry, catalog: catalog,
                            isCurrent: catalog.isCurrent(entry, boardURL: currentBoardURL),
                            isOpening: openingID == entry.id,
                            onOpen: { open(entry) }, onReconnect: { onReconnect(entry) },
                            onClassify: { route = .membership(entry) })
                    }
                } header: { Text(String(localized: "白板：\(filteredEntries.count)")) }
                Section {
                    if let onChooseVault {
                        Button(action: onChooseVault) { Label(String(localized: "选择其他仓库"), systemImage: "folder") }
                            .accessibilityIdentifier("boardLibrary.chooseVault")
                    }
                    Text(String(localized: "收藏、分类和最近打开记录保存在本机，不会移动或重命名白板。这里保留使用此版本后成功打开的历史，以及当前仓库已发现的白板。其他仓库不会自动扫描。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .disabled(openingID != nil)
            .navigationTitle(String(localized: "白板资料库"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "关闭")) { dismiss() }.disabled(openingID != nil)
                        .accessibilityIdentifier("boardLibrary.close")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(String(localized: "刷新")) { refresh() }
                        .disabled(catalog.isScanning || openingID != nil)
                        .accessibilityIdentifier("boardLibrary.refresh")
                }
            }
            .sheet(item: $route) { route in
                switch route {
                case .categories: BoardCategoryManager(catalog: catalog)
                case .membership(let entry): BoardCategoryMembership(catalog: catalog, entry: entry)
                }
            }
            .alert(String(localized: "恢复资料库记录？"), isPresented: $confirmsRecovery) {
                Button(String(localized: "取消"), role: .cancel) { }
                Button(String(localized: "恢复")) { Task { await catalog.recoverCatalog() } }
            } message: {
                Text(String(localized: "会先保留无法读取的本机记录，再使用可读备份恢复；没有可读备份时会重建空资料库。不会修改或删除白板文件。"))
            }
            .task {
                await catalog.load()
                await catalog.refreshCurrentVault()
            }
            .onDisappear { refreshTask?.cancel() }
            .onChange(of: catalog.categories) { _, categories in
                if !["recent", "current", "favorites", "all"].contains(filter),
                   !categories.contains(where: { $0.id.uuidString == filter }) { filter = "all" }
            }
        }
        .interactiveDismissDisabled(openingID != nil)
    }

    private func refresh() {
        refreshTask?.cancel()
        refreshTask = Task { await catalog.refreshCurrentVault() }
    }
    private func open(_ entry: BoardCatalogEntry) {
        guard openingID == nil else { return }
        openingID = entry.id; openingError = nil
        Task {
            let succeeded = await onOpen(entry)
            openingID = nil
            if succeeded { dismiss() }
            else { openingError = String(localized: "暂时无法打开，当前白板已保留。请确认文件已下载；如果仓库授权失效，可在该白板的菜单中重新授权。") }
        }
    }
}

private struct BoardLibraryRow: View {
    let entry: BoardCatalogEntry
    let catalog: BoardCatalogStore
    let isCurrent: Bool
    let isOpening: Bool
    let onOpen: () -> Void
    let onReconnect: () -> Void
    let onClassify: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: 10) {
                    if isOpening { ProgressView() }
                    else { Image(systemName: "rectangle.and.pencil.and.ellipsis").padding(.top, 3) }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(entry.title).font(.headline).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                        Text(catalog.vaultLabel(for: entry)).font(.caption).foregroundStyle(.secondary)
                        Text(entry.relativePath).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        if let date = entry.lastOpenedAt {
                            Text(date, format: .dateTime.year().month().day().hour().minute()).font(.caption2).foregroundStyle(.secondary)
                        }
                        if isCurrent {
                            Label(String(localized: "当前白板"), systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
                                .accessibilityIdentifier("boardLibrary.current.\(entry.id.uuidString)")
                        }
                        if entry.isMissing {
                            Text(String(localized: "上次扫描未找到；可重试或重新授权"))
                                .font(.caption).foregroundStyle(.orange)
                        }
                        let categories = catalog.categories.filter { entry.categoryIDs.contains($0.id) }
                        if !categories.isEmpty {
                            Text(categories.map(\.name).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }.frame(minHeight: 52, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("boardLibrary.open.\(entry.id.uuidString)")
            VStack(spacing: 16) {
                Button {
                    Task { await catalog.setFavorite(entry.id, !entry.isFavorite) }
                } label: {
                    Image(systemName: entry.isFavorite ? "star.fill" : "star")
                        .foregroundStyle(entry.isFavorite ? .yellow : .secondary)
                }.buttonStyle(.borderless).disabled(!catalog.isWritable)
                    .accessibilityLabel(entry.isFavorite ? String(localized: "取消收藏") : String(localized: "收藏"))
                    .accessibilityIdentifier("boardLibrary.favorite.\(entry.id.uuidString)")
                Menu {
                    Button(action: onClassify) { Label(String(localized: "设置分类"), systemImage: "folder") }
                        .disabled(!catalog.isWritable).accessibilityIdentifier("boardLibrary.classify.\(entry.id.uuidString)")
                    Button(action: onReconnect) { Label(String(localized: "重新授权仓库"), systemImage: "folder.badge.questionmark") }
                        .accessibilityIdentifier("boardLibrary.reconnect.\(entry.id.uuidString)")
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel(String(localized: "白板选项"))
                .accessibilityIdentifier("boardLibrary.options.\(entry.id.uuidString)")
            }
        }.padding(.vertical, 4)
    }
}

private struct BoardCategoryMembership: View {
    let catalog: BoardCatalogStore
    let entry: BoardCatalogEntry
    @Environment(\.dismiss) private var dismiss
    @State private var showsManager = false
    private var current: BoardCatalogEntry { catalog.entries.first { $0.id == entry.id } ?? entry }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(entry.title).font(.headline)
                    Text(String(localized: "可加入多个分类；取消勾选只会移出分类，不会删除白板。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let warning = catalog.warning { Text(warning).font(.footnote).foregroundStyle(.red) }
                ForEach(catalog.categories) { category in
                    Button {
                        Task { await catalog.setCategory(category.id, for: entry.id, included: !current.categoryIDs.contains(category.id)) }
                    } label: {
                        HStack {
                            Text(category.name).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: current.categoryIDs.contains(category.id) ? "checkmark.circle.fill" : "circle")
                        }
                    }.disabled(!catalog.isWritable).accessibilityIdentifier("boardLibrary.membership.\(category.id.uuidString)")
                        .accessibilityValue(current.categoryIDs.contains(category.id) ? String(localized: "已加入") : String(localized: "未加入"))
                }
                Button(String(localized: "管理分类")) { showsManager = true }.accessibilityIdentifier("boardLibrary.manageCategories")
            }
            .navigationTitle(String(localized: "设置分类")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("boardLibrary.membership.done") } }
            .sheet(isPresented: $showsManager) { BoardCategoryManager(catalog: catalog) }
        }
    }
}

private struct BoardCategoryManager: View {
    let catalog: BoardCatalogStore
    @Environment(\.dismiss) private var dismiss
    @State private var editing: BoardCatalogCategory?
    @State private var deleting: BoardCatalogCategory?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { editing = BoardCatalogCategory(id: UUID(), name: "") } label: {
                        Label(String(localized: "新建分类"), systemImage: "folder.badge.plus")
                    }.disabled(!catalog.isWritable).accessibilityIdentifier("boardLibrary.addCategory")
                    Text(String(localized: "分类只用于本机整理，不会创建文件夹、移动或重命名原文件。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let warning = catalog.warning { Text(warning).font(.footnote).foregroundStyle(.red) }
                ForEach(catalog.categories) { category in
                    HStack {
                        Button { editing = category } label: {
                            VStack(alignment: .leading) {
                                Text(category.name).foregroundStyle(.primary)
                                Text(String(localized: "白板：\(catalog.entries.filter { $0.categoryIDs.contains(category.id) }.count)"))
                                    .font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("boardLibrary.category.\(category.id.uuidString)")
                        Button(role: .destructive) { deleting = category } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless).accessibilityLabel(String(localized: "删除分类"))
                            .accessibilityIdentifier("boardLibrary.deleteCategory.\(category.id.uuidString)")
                    }.disabled(!catalog.isWritable)
                }
            }
            .navigationTitle(String(localized: "管理分类")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("boardLibrary.categories.done") } }
            .sheet(item: $editing) { category in BoardCategoryEditor(catalog: catalog, category: category) }
            .alert(String(localized: "删除分类？"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button(String(localized: "取消"), role: .cancel) { deleting = nil }
                Button(String(localized: "删除分类"), role: .destructive) {
                    if let id = deleting?.id { Task { await catalog.deleteCategory(id) } }
                    deleting = nil
                }
            } message: { Text(String(localized: "只会移除这个分类。里面的白板、收藏和历史记录都会保留。")) }
        }
    }
}

private struct BoardCategoryEditor: View {
    let catalog: BoardCatalogStore
    let category: BoardCatalogCategory
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var saving = false
    init(catalog: BoardCatalogStore, category: BoardCatalogCategory) {
        self.catalog = catalog; self.category = category; _name = State(initialValue: category.name)
    }
    var body: some View {
        NavigationStack {
            Form {
                TextField(String(localized: "分类名称"), text: $name).accessibilityIdentifier("boardLibrary.categoryName")
                if let warning = catalog.warning { Text(warning).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle(category.name.isEmpty ? String(localized: "新建分类") : String(localized: "重命名分类"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() }.disabled(saving).accessibilityIdentifier("boardLibrary.category.cancel") }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "保存")) {
                        saving = true
                        Task {
                            if await catalog.saveCategory(id: category.id, name: name) { dismiss() }
                            saving = false
                        }
                    }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("boardLibrary.saveCategory")
                }
            }
        }.interactiveDismissDisabled(saving).presentationDetents([.medium, .large])
    }
}

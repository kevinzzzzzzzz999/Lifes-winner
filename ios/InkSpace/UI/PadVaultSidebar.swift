import SwiftUI

/// Lightweight directory metadata only; opening a file stays with the workspace's
/// existing coordinated reader/save-before-switch path.
enum PadSidebarRoutes {
    static func directory(for entry: ManagedVaultEntry) -> String {
        entry.isDirectory ? entry.path : (entry.path as NSString).deletingLastPathComponent
    }
    static func isBoard(_ entry: ManagedVaultEntry) -> Bool {
        !entry.isDirectory && entry.path.lowercased().hasSuffix(".inkspace.json")
    }
    static func canAdd(_ entry: ManagedVaultEntry) -> Bool {
        !entry.isDirectory && !isBoard(entry)
            && DocumentLibrary.supportedExtensions.contains((entry.path as NSString).pathExtension.lowercased())
    }
    static func ancestors(of directory: String) -> [String] {
        var path = ""
        return directory.split(separator: "/").map { component in
            path = path.isEmpty ? String(component) : path + "/" + component
            return path
        }
    }
}

private struct PadSidebarRow: Identifiable {
    let entry: ManagedVaultEntry
    let depth: Int
    var id: String { entry.path }
}

struct PadVaultSidebar: View {
    let rootURL: URL
    let currentBoardPath: String?
    let initialDirectory: String
    let refreshToken: UUID
    let canOpen: Bool
    let canChange: Bool
    let readerOnly: Bool
    let onOpen: (ManagedVaultEntry) async -> Bool
    let onAdd: ([ManagedVaultEntry]) -> Void
    let onNewBoard: (String) -> Void
    let onManage: (String, [String]) -> Void
    let onChooseVault: () -> Void
    let onClose: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var service: VaultFileManagement
    @State private var directories: [String: [ManagedVaultEntry]] = [:]
    @State private var expanded = Set<String>()
    @State private var loading = Set<String>()
    @State private var loadTasks: [String: Task<Void, Never>] = [:]
    @State private var requests: [String: UUID] = [:]
    @State private var selected = Set<String>()
    @State private var selecting = false
    @State private var showsSelection = false
    @State private var location: String
    @State private var query = ""
    @State private var message: String?
    @State private var opening: String?
    @State private var reloadToken = UUID()
    @State private var pendingScrollPath: String?

    init(rootURL: URL, currentBoardPath: String?, initialDirectory: String, refreshToken: UUID,
         canOpen: Bool, canChange: Bool, readerOnly: Bool = false,
         onOpen: @escaping (ManagedVaultEntry) async -> Bool,
         onAdd: @escaping ([ManagedVaultEntry]) -> Void,
         onNewBoard: @escaping (String) -> Void,
         onManage: @escaping (String, [String]) -> Void,
         onChooseVault: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.rootURL = rootURL; self.currentBoardPath = currentBoardPath
        self.initialDirectory = initialDirectory; self.refreshToken = refreshToken
        self.canOpen = canOpen; self.canChange = canChange; self.readerOnly = readerOnly
        self.onOpen = onOpen; self.onAdd = onAdd; self.onNewBoard = onNewBoard
        self.onManage = onManage; self.onChooseVault = onChooseVault; self.onClose = onClose
        _service = State(initialValue: VaultFileManagement(rootURL: rootURL))
        _location = State(initialValue: initialDirectory)
        _expanded = State(initialValue: Set(PadSidebarRoutes.ancestors(of: initialDirectory)))
    }

    private var rows: [PadSidebarRow] {
        var result: [PadSidebarRow] = []
        func append(_ directory: String, depth: Int) {
            guard depth < 64, result.count < 10_000 else { return }
            for entry in directories[directory] ?? [] {
                guard result.count < 10_000 else { break }
                result.append(PadSidebarRow(entry: entry, depth: depth))
                if entry.isDirectory && expanded.contains(entry.path) { append(entry.path, depth: depth + 1) }
            }
        }
        if showsSelection { result = chosen.map { PadSidebarRow(entry: $0, depth: 0) } }
        else { append("", depth: 0) }
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return result }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.filter { $0.entry.title.localizedCaseInsensitiveContains(needle) || $0.entry.path.localizedCaseInsensitiveContains(needle) }
    }
    private var chosen: [ManagedVaultEntry] {
        let all = directories.values.flatMap { $0 }
        var seen = Set<String>()
        return all.filter { selected.contains($0.path) && seen.insert($0.path).inserted }
            .sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }
    private var canAddSelection: Bool { !chosen.isEmpty && chosen.allSatisfy(PadSidebarRoutes.canAdd) }
    private var busy: Bool { !canOpen || opening != nil }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let currentBoardPath { currentBoardLocation(currentBoardPath) }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(PadDesign.secondaryInk)
                TextField(showsSelection ? String(localized: "搜索已选文件") : String(localized: "搜索已展开文件夹"), text: $query)
                    .font(.subheadline).foregroundStyle(PadDesign.ink)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("padSidebar.search")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(PadDesign.secondaryInk).frame(width: 44, height: 44) }
                        .accessibilityLabel(String(localized: "清除搜索"))
                        .accessibilityIdentifier("padSidebar.clearSearch")
                }
            }.padding(.horizontal, 12).frame(minHeight: 46)
                .padSurface(radius: 12).padding(.horizontal, 12).padding(.bottom, 6)
            folderLocation
            // PencilKit's palette is a window-level overlay at the bottom.
            // Keep file actions above the scrolling list so selecting, adding,
            // and managing files remain reachable while the pen is active.
            footer
            if let message { Text(message).font(.caption).foregroundStyle(PadDesign.bronze).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.bottom, 8).accessibilityIdentifier("padSidebar.message") }
            ScrollViewReader { proxy in
                List {
                    if loading.contains("") { ProgressView(String(localized: "正在读取当前文件夹…")) }
                    ForEach(rows) { item in
                        row(item).id(item.id)
                            .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                    if directories[""] != nil && rows.isEmpty && loading.isEmpty {
                        Text(showsSelection ? (query.isEmpty ? String(localized: "还没有选择。返回文件夹后轻点项目即可勾选。") : String(localized: "已选项目中没有匹配项。")) : query.isEmpty ? (readerOnly ? String(localized: "此文件夹暂无可阅读的资料。") : String(localized: "此文件夹为空。可在这里新建白板。")) : String(localized: "已展开的文件夹中没有匹配项"))
                            .font(.footnote).foregroundStyle(PadDesign.secondaryInk)
                            .listRowBackground(Color.clear)
                    }
                }.listStyle(.plain).scrollContentBackground(.hidden)
                    .onChange(of: location) { _, path in
                        guard !path.isEmpty else { return }
                        withAnimation { proxy.scrollTo(path, anchor: .center) }
                    }
                    .onChange(of: pendingScrollPath) { _, _ in scrollToRequestedRow(proxy) }
                    .onChange(of: loading) { _, _ in scrollToRequestedRow(proxy) }
            }
        }
        .background(PadDesign.sidebar)
        .tint(PadDesign.accent)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("padSidebar")
        .task(id: refreshToken.uuidString + reloadToken.uuidString) { await reload() }
        .onChange(of: currentBoardPath) { _, path in
            guard let path else { return }
            location = (path as NSString).deletingLastPathComponent
            reveal(location)
        }
        .onDisappear {
            for task in loadTasks.values { task.cancel() }
            loadTasks.removeAll(); requests.removeAll(); loading.removeAll()
        }
    }

    private func currentBoardLocation(_ path: String) -> some View {
        let entry = ManagedVaultEntry(path: path, isDirectory: false)
        let directory = (path as NSString).deletingLastPathComponent
        return Button {
            query = ""; showsSelection = false
            reveal(directory)
            pendingScrollPath = path
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "square.grid.2x2.fill").font(.title3).foregroundStyle(PadDesign.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(String(localized: "当前白板")).font(.caption2.weight(.medium)).foregroundStyle(PadDesign.accent)
                    Text(displayTitle(entry)).font(.subheadline.weight(.semibold)).foregroundStyle(PadDesign.ink).lineLimit(2)
                    Text(directory.isEmpty ? String(localized: "仓库根目录") : directory).font(.caption2).foregroundStyle(PadDesign.secondaryInk).lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "folder").foregroundStyle(PadDesign.accent)
            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(12)
                .background(PadDesign.accentWash, in: RoundedRectangle(cornerRadius: 14))
                .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(PadDesign.hairline, lineWidth: 1).allowsHitTesting(false) }
        }.buttonStyle(.plain).disabled(busy).padding(.horizontal, 12).padding(.bottom, 8)
            .accessibilityHint(String(localized: "显示当前白板所在文件夹，保留已选项目。"))
            .accessibilityIdentifier("padSidebar.currentBoard")
    }

    private var folderLocation: some View {
        HStack(spacing: 4) {
            Button { showsSelection = false; query = ""; revealParent() } label: {
                Image(systemName: "arrow.up").frame(width: 44, height: 44)
            }.disabled(location.isEmpty || busy).accessibilityLabel(String(localized: "上一级"))
                .accessibilityIdentifier("padSidebar.up")
            Menu {
                Button(String(localized: "仓库根目录"), systemImage: "folder") { showsSelection = false; query = ""; reveal("") }
                ForEach(PadSidebarRoutes.ancestors(of: location), id: \.self) { path in
                    Button(path) { showsSelection = false; query = ""; reveal(path) }
                }
            } label: {
                HStack(spacing: 6) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(showsSelection ? String(localized: "查看已选项目") : String(localized: "浏览位置")).font(.caption2).foregroundStyle(PadDesign.secondaryInk)
                        Text(location.isEmpty ? String(localized: "仓库根目录") : location)
                            .font(.caption.weight(.medium)).foregroundStyle(PadDesign.ink).lineLimit(2)
                            .accessibilityIdentifier("padSidebar.location")
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").font(.caption2)
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }.disabled(busy).accessibilityIdentifier("padSidebar.locationMenu")
        }.padding(.horizontal, 8).padding(.bottom, 4)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder.fill").foregroundStyle(PadDesign.accent)
            Text(rootURL.lastPathComponent).font(.headline).foregroundStyle(PadDesign.ink)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1).truncationMode(.middle)
            Spacer(minLength: 0)
            Menu {
                Button(String(localized: "刷新"), systemImage: "arrow.clockwise") { reloadToken = UUID() }
                Button(String(localized: "收起全部文件夹"), systemImage: "arrow.up.left.and.arrow.down.right") { expanded.removeAll(); location = "" }
                Button(String(localized: "选择仓库文件夹"), systemImage: "folder.badge.plus", action: onChooseVault)
            } label: { Image(systemName: "ellipsis.circle").frame(width: 44, height: 44) }
                .disabled(busy).accessibilityLabel(String(localized: "资料侧栏选项"))
                .accessibilityIdentifier("padSidebar.options")
            Button(action: onClose) { Image(systemName: "sidebar.left").frame(width: 44, height: 44) }
                .accessibilityLabel(String(localized: "收起资料侧栏"))
                .accessibilityIdentifier("padSidebar.close")
        }.padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 6)
    }

    private func row(_ row: PadSidebarRow) -> some View {
        let entry = row.entry
        let current = currentBoardPath == entry.path
        let highlighted = current || (selecting && selected.contains(entry.path))
        return HStack(spacing: 4) {
            if entry.isDirectory {
                Button { toggleFolder(entry.path) } label: {
                    Group {
                        if loading.contains(entry.path) { ProgressView().controlSize(.small) }
                        else { Image(systemName: expanded.contains(entry.path) ? "chevron.down" : "chevron.right").font(.caption) }
                    }.frame(width: 44, height: 44)
                }.buttonStyle(.borderless).disabled(busy)
                    .accessibilityLabel((expanded.contains(entry.path) ? String(localized: "收起文件夹") : String(localized: "展开文件夹")) + " " + entry.title)
                    .accessibilityIdentifier("padSidebar.expand." + entry.path)
            } else { Color.clear.frame(width: 12, height: 1).accessibilityHidden(true) }
            Button {
                if selecting { toggleSelection(entry.path) }
                else if entry.isDirectory { toggleFolder(entry.path) }
                else { open(entry) }
            } label: {
                let labelLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                    : AnyLayout(HStackLayout(spacing: 8))
                labelLayout {
                    HStack(spacing: 8) {
                        if selecting { Image(systemName: selected.contains(entry.path) ? "checkmark.circle.fill" : "circle").foregroundStyle(PadDesign.accent) }
                        Image(systemName: symbol(entry)).font(.system(size: 15, weight: .medium)).foregroundStyle(tint(entry))
                            .frame(width: 28, height: 32)
                            .background(PadDesign.surface, in: RoundedRectangle(cornerRadius: 8))
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayTitle(entry)).foregroundStyle(PadDesign.ink).font(.subheadline.weight(current ? .semibold : .regular))
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1).truncationMode(.middle)
                        if current { Text(String(localized: "当前白板")).font(.caption2.weight(.medium)).foregroundStyle(PadDesign.accent) }
                        else if entry.isDirectory && entry.path == location { Text(String(localized: "浏览位置")).font(.caption2).foregroundStyle(PadDesign.secondaryInk) }
                        if !query.isEmpty || showsSelection { Text(entry.path).font(.caption2).foregroundStyle(PadDesign.secondaryInk).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1) }
                        else if !entry.isDirectory && !current { Text(PadSidebarRoutes.isBoard(entry) ? String(localized: "白板") : (entry.path as NSString).pathExtension.uppercased()).font(.caption2).foregroundStyle(PadDesign.secondaryInk) }
                    }.frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil, alignment: .leading)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    if opening == entry.path { ProgressView().controlSize(.small) }
                    else if current { Image(systemName: "checkmark.circle.fill").foregroundStyle(PadDesign.accent).font(.caption) }
                }.frame(minHeight: 48).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(busy).layoutPriority(1)
                .accessibilityIdentifier("padSidebar.entry." + entry.path)
                .accessibilityValue(selecting ? (selected.contains(entry.path) ? String(localized: "已选择") : String(localized: "未选择")) : current ? String(localized: "当前白板") : "")
            Menu { entryMenu(entry) } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(PadDesign.secondaryInk)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless).fixedSize().disabled(busy)
            .accessibilityLabel(String(localized: "更多操作") + " " + displayTitle(entry))
            .accessibilityIdentifier("padSidebar.entryOptions." + entry.path)
        }
        .padding(.leading, CGFloat(min(row.depth, 4)) * 10)
        .padding(.trailing, 6)
        .background(highlighted ? PadDesign.accentWash : entry.path == location ? PadDesign.surface : .clear, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(highlighted ? PadDesign.hairline : .clear, lineWidth: 1).allowsHitTesting(false) }
        .contextMenu { entryMenu(entry) }
    }

    @ViewBuilder private func entryMenu(_ entry: ManagedVaultEntry) -> some View {
        if entry.isDirectory {
            Button(String(localized: "展开文件夹"), systemImage: "folder") { reveal(entry.path) }.disabled(busy)
            if !readerOnly {
                Button(String(localized: "在此文件夹新建白板"), systemImage: "doc.badge.plus") { onNewBoard(entry.path) }.disabled(!canChange || busy)
            }
        } else {
            Button(String(localized: "打开"), systemImage: "doc") { open(entry) }.disabled(busy)
            if !readerOnly && PadSidebarRoutes.canAdd(entry) {
                Button(String(localized: "添加到当前白板"), systemImage: "plus.rectangle.on.rectangle") { onAdd([entry]) }.disabled(!canChange || busy)
            }
        }
        if !readerOnly {
        Divider()
        Button(String(localized: "选择"), systemImage: "checkmark.circle") { selecting = true; toggleSelection(entry.path) }.disabled(busy)
        Button(String(localized: "移动、分享或删除…"), systemImage: "folder.badge.gearshape") {
            onManage((entry.path as NSString).deletingLastPathComponent, [entry.path])
        }.disabled(!canChange || busy)
        }
    }

    private var footer: some View {
        Group {
            if readerOnly {
                Text(String(localized: "手机只读浏览；在 iPad 上编排白板。"))
                    .font(.caption).foregroundStyle(PadDesign.secondaryInk)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .background(PadDesign.surface).accessibilityIdentifier("phone.sidebar.readOnly")
            } else { editableFooter }
        }
    }

    private var editableFooter: some View {
        VStack(spacing: 8) {
            HStack {
                Button {
                    selecting.toggle()
                    if !selecting { selected.removeAll(); showsSelection = false }
                } label: {
                    Text(selecting ? String(localized: "完成选择") : String(localized: "多选")).frame(minHeight: 44)
                }.accessibilityIdentifier("padSidebar.select")
                Spacer()
                if selecting {
                    Button {
                        showsSelection.toggle(); query = ""
                    } label: {
                        Label(showsSelection ? String(localized: "返回文件夹") : String(localized: "已选 \(selected.count) 项"), systemImage: showsSelection ? "folder" : "checkmark.circle")
                            .frame(minHeight: 44)
                    }.font(.subheadline).accessibilityIdentifier("padSidebar.reviewSelection")
                }
                else {
                    Button { onNewBoard(location) } label: { Label(String(localized: "新建白板"), systemImage: "plus").frame(minHeight: 44) }
                        .disabled(!canChange || busy).accessibilityIdentifier("padSidebar.newBoard")
                }
            }.disabled(busy)
            if selecting {
                Button { onAdd(chosen) } label: {
                    Label(String(localized: "添加到当前白板"), systemImage: "plus.rectangle.on.rectangle")
                        .foregroundStyle(PadDesign.paper)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(.borderedProminent).tint(PadDesign.accent)
                    .disabled(!canChange || busy || !canAddSelection)
                    .accessibilityIdentifier("padSidebar.addSelected")
                HStack {
                    Button { selected.removeAll() } label: { Text(String(localized: "清空选择")).frame(minHeight: 44) }
                        .disabled(busy || selected.isEmpty)
                        .accessibilityIdentifier("padSidebar.clearSelection")
                    Spacer(minLength: 4)
                    Button { onManage(location, chosen.map(\.path)) } label: {
                        Label(String(localized: "管理"), systemImage: "folder.badge.gearshape").frame(minHeight: 44)
                    }.disabled(!canChange || busy || chosen.isEmpty).accessibilityIdentifier("padSidebar.manageSelected")
                }.font(.subheadline)
                if !chosen.isEmpty && !canAddSelection {
                    Text(String(localized: "文件夹、白板或不支持的文件不能添加。可查看已选项目后取消勾选，或进入管理。"))
                        .font(.caption2).foregroundStyle(PadDesign.secondaryInk).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("padSidebar.selectionHint")
                }
            }
            Text(canChange ? (selecting ? String(localized: "切换文件夹会保留选择。添加后，在白板上轻点放置资料。") : String(localized: "点文件打开阅读；多选可添加到当前白板。新白板建在上方浏览位置。")) : String(localized: "可直接打开阅读；添加或管理文件前，请先开启编辑。"))
                .font(.caption2).foregroundStyle(PadDesign.secondaryInk).fixedSize(horizontal: false, vertical: true)
        }.padding(12).background(PadDesign.surface)
            .overlay(alignment: .top) { Rectangle().fill(PadDesign.hairline).frame(height: 1).allowsHitTesting(false) }
    }

    private func tint(_ entry: ManagedVaultEntry) -> Color {
        if entry.isDirectory || PadSidebarRoutes.isBoard(entry) { return PadDesign.accent }
        switch (entry.path as NSString).pathExtension.lowercased() {
        case "pdf", "ppt", "pptx": return PadDesign.bronze
        case "xls", "xlsx", "xlsm", "csv": return PadDesign.accent
        default: return PadDesign.secondaryInk
        }
    }

    private func symbol(_ entry: ManagedVaultEntry) -> String {
        if entry.isDirectory { return "folder" }
        if PadSidebarRoutes.isBoard(entry) { return "square.grid.2x2" }
        switch (entry.path as NSString).pathExtension.lowercased() {
        case "pdf": return "doc.richtext"
        case "ppt", "pptx": return "rectangle.stack"
        case "xls", "xlsx", "xlsm", "csv": return "tablecells"
        case "png", "jpg", "jpeg", "heic": return "photo"
        case "mp4", "mov", "m4v": return "play.rectangle"
        default: return "doc.text"
        }
    }
    private func displayTitle(_ entry: ManagedVaultEntry) -> String {
        PadSidebarRoutes.isBoard(entry) ? String(entry.title.dropLast(".inkspace.json".count)) : entry.title
    }
    private func toggleSelection(_ path: String) {
        if selected.contains(path) { selected.remove(path) }
        else if selected.count < VaultFileManagement.maximumSelection { selected.insert(path) }
        else { message = String(localized: "一次最多选择 100 项。") }
    }
    private func toggleFolder(_ path: String) {
        location = path
        if expanded.contains(path) { expanded.remove(path) }
        else { reveal(path) }
    }
    private func reveal(_ path: String) {
        let ancestors = PadSidebarRoutes.ancestors(of: path)
        expanded.formUnion(ancestors)
        for directory in [""] + ancestors where directories[directory] == nil { startLoad(directory) }
        location = path
    }
    private func revealParent() {
        location = (location as NSString).deletingLastPathComponent
        reveal(location)
    }
    private func startLoad(_ path: String) {
        guard loadTasks[path] == nil else { return }
        let request = UUID()
        loadTasks[path] = Task {
            await load(path, request: request)
            if requests[path] == request { loadTasks[path] = nil }
        }
    }
    private func load(_ path: String, request: UUID = UUID()) async {
        guard directories.count < 200 || directories[path] != nil else {
            message = String(localized: "已展开较多文件夹，请收起后刷新再继续。")
            return
        }
        requests[path] = request; loading.insert(path)
        defer { if requests[path] == request { loading.remove(path) } }
        do {
            let entries = try await service.listDirectory(path)
            let order = (try? await service.folderOrder(path)) ?? []
            guard !Task.isCancelled, requests[path] == request else { return }
            let otherEntryCount = directories.filter { $0.key != path }.values.reduce(0) { $0 + $1.count }
            guard otherEntryCount + entries.count <= 25_000 else {
                message = String(localized: "已展开较多文件夹，请收起后刷新再继续。")
                return
            }
            let orderIndices = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($0.element, $0.offset) })
            directories[path] = entries.sorted { left, right in
                let a = orderIndices[left.path] ?? Int.max, b = orderIndices[right.path] ?? Int.max
                if a != b { return a < b }
                if left.isDirectory != right.isDirectory { return left.isDirectory }
                return left.title.localizedStandardCompare(right.title) == .orderedAscending
            }
        } catch {
            guard !Task.isCancelled, requests[path] == request else { return }
            message = error.localizedDescription
        }
    }
    private func reload() async {
        for task in loadTasks.values { task.cancel() }
        loadTasks.removeAll(); requests.removeAll(); loading.removeAll(); message = nil
        // Retain metadata for choices in collapsed folders when refreshing.
        let selectionDirectories = selected.map { ($0 as NSString).deletingLastPathComponent }.filter { !$0.isEmpty }
        let wanted = expanded.union(PadSidebarRoutes.ancestors(of: location)).union(selectionDirectories)
        directories.removeAll()
        await load("")
        for path in wanted.sorted(by: { $0.count < $1.count }) {
            guard !Task.isCancelled else { return }
            await load(path)
        }
        let known = Set(directories.values.flatMap { $0 }.map(\.path))
        selected.formIntersection(known)
    }
    private func scrollToRequestedRow(_ proxy: ScrollViewProxy) {
        guard let path = pendingScrollPath, rows.contains(where: { $0.id == path }) else { return }
        withAnimation { proxy.scrollTo(path, anchor: .center) }
        pendingScrollPath = nil
    }
    private func open(_ entry: ManagedVaultEntry) {
        guard !busy else { return }
        opening = entry.path; message = nil
        Task {
            let opened = await onOpen(entry)
            opening = nil
            if !opened { message = String(localized: "暂时无法打开，当前白板已保留。请检查保存状态、文件下载和文件夹权限。") }
        }
    }
}

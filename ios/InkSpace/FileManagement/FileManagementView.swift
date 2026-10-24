import SwiftUI
import UIKit

enum VaultFileManagementAction: Sendable {
    case move([String], to: String), trash([String]), restore(String), share([String])
}
private enum FileManagerSort: String, CaseIterable, Identifiable {
    case name, modified, manual
    var id: String { rawValue }
    var title: String {
        switch self {
        case .name: String(localized: "按名称")
        case .modified: String(localized: "按修改日期")
        case .manual: String(localized: "手动顺序")
        }
    }
}
private struct FileManagerShare: Identifiable { let id = UUID(); let url: URL }

struct FileManagementView: View {
    let service: VaultFileManagement
    let onAction: (VaultFileManagementAction) async throws -> URL?
    let onNewBoard: (String) -> Void
    let onOpen: (ManagedVaultEntry) -> Void
    let onChecklist: ((String) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var currentPath = ""
    @State private var entries: [ManagedVaultEntry] = []
    @State private var selected = Set<String>()
    @State private var selectionMode = false
    @State private var isLoading = false
    @State private var isWorking = false
    @State private var message: String?
    @State private var query = ""
    @State private var refreshID = UUID()
    @State private var loadID = UUID()
    @State private var sort: FileManagerSort = .name
    @State private var manualOrder: [String] = []
    @State private var showsDestination = false
    @State private var showsTrash = false
    @State private var confirmsTrash = false
    @State private var share: FileManagerShare?
    init(service: VaultFileManagement, initialPath: String = "", initialSelection: [String] = [],
         onAction: @escaping (VaultFileManagementAction) async throws -> URL?,
         onNewBoard: @escaping (String) -> Void, onOpen: @escaping (ManagedVaultEntry) -> Void,
         onChecklist: ((String) -> Void)? = nil) {
        self.onChecklist = onChecklist
        self.service = service; self.onAction = onAction; self.onNewBoard = onNewBoard; self.onOpen = onOpen
        _currentPath = State(initialValue: initialPath)
        let initial = Set(initialSelection.prefix(VaultFileManagement.maximumSelection))
        _selected = State(initialValue: initial)
        _selectionMode = State(initialValue: !initial.isEmpty)
    }

    private var chosen: [String] { selected.sorted() }
    private var filtered: [ManagedVaultEntry] {
        let filtered = entries.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
        switch sort {
        case .name: return filtered.sorted { $0.isDirectory != $1.isDirectory ? $0.isDirectory : $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        case .modified: return filtered.sorted { ($0.modifiedAt ?? .distantPast) > ($1.modifiedAt ?? .distantPast) }
        case .manual:
            let indices = Dictionary(uniqueKeysWithValues: manualOrder.enumerated().map { ($0.element, $0.offset) })
            return filtered.sorted { (indices[$0.path] ?? Int.max) < (indices[$1.path] ?? Int.max) }
        }
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Button(String(localized: "上一级"), systemImage: "chevron.left") { navigate((currentPath as NSString).deletingLastPathComponent) }
                        .disabled(currentPath.isEmpty || isLoading || isWorking).accessibilityIdentifier("fileManager.up")
                    Text(currentPath.isEmpty ? service.rootURL.lastPathComponent : currentPath).font(.subheadline).lineLimit(2)
                    Spacer()
                    Menu {
                        Picker(String(localized: "排序"), selection: $sort) { ForEach(FileManagerSort.allCases) { Text($0.title).tag($0) } }
                    } label: { Image(systemName: "arrow.up.arrow.down") }
                    .accessibilityLabel(String(localized: "排序")).accessibilityIdentifier("fileManager.sort")
                }.padding(.horizontal).padding(.top, 8)
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(String(localized: "搜索当前文件夹"), text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("fileManager.search")
                    if !query.isEmpty { Button(String(localized: "清除")) { query = "" } }
                }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 10)).padding(.horizontal).padding(.top, 8)
                if let message { Text(message).font(.footnote).foregroundStyle(.orange).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(.top, 8) }
                List {
                    if isLoading || isWorking { ProgressView(isWorking ? String(localized: "正在安全处理文件…") : String(localized: "正在读取当前文件夹…")) }
                    ForEach(filtered) { entry in row(entry) }
                        .onMove { source, destination in reorder(source, destination) }
                        .moveDisabled(sort != .manual || selectionMode || !query.isEmpty || isWorking)
                    if entries.isEmpty && !isLoading { Text(String(localized: "此文件夹为空。可在这里新建白板。" )).foregroundStyle(.secondary) }
                }
                .listStyle(.plain)
                .environment(\.editMode, .constant(sort == .manual && !selectionMode && query.isEmpty ? .active : .inactive))
                .disabled(isWorking)
                if selectionMode { selectionBar }
                else {
                    if let onChecklist {
                        Button(String(localized: "课程清单"), systemImage: "checklist") { onChecklist(currentPath) }
                            .buttonStyle(.bordered).padding(.top, 8).disabled(isLoading || isWorking)
                            .accessibilityIdentifier("fileManager.checklist")
                    }
                    Button(String(localized: "在此文件夹新建白板"), systemImage: "doc.badge.plus") { onNewBoard(currentPath) }
                        .buttonStyle(.borderedProminent).padding().disabled(isLoading || isWorking)
                        .accessibilityIdentifier("fileManager.newBoard")
                }
                Text(sort == .manual ? String(localized: "拖动右侧排序柄调整显示顺序，不会重命名文件。") : String(localized: "长按进入多选。移动会核对白板引用；删除移入回收站，原位置恢复后重新关联。"))
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.bottom, 8)
            }
            .navigationTitle(String(localized: "管理文件")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() }.disabled(isWorking) }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button(selectionMode ? String(localized: "完成选择") : String(localized: "选择")) { selectionMode.toggle(); if !selectionMode { selected.removeAll() } }
                        .disabled(isWorking).accessibilityIdentifier("fileManager.select")
                    Menu {
                        Button(String(localized: "刷新"), systemImage: "arrow.clockwise") { refreshID = UUID() }
                        Button(String(localized: "回收站"), systemImage: "trash") { showsTrash = true }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .disabled(isWorking).accessibilityIdentifier("fileManager.more")
                }
            }
            .task(id: currentPath + refreshID.uuidString) { await reload() }
            .interactiveDismissDisabled(isWorking)
            .sheet(isPresented: $showsDestination) {
                FileDestinationPicker(service: service, excluded: chosen) { destination in
                    showsDestination = false; perform(.move(chosen, to: destination))
                }
            }
            .sheet(isPresented: $showsTrash) { VaultTrashView(service: service, onRestore: { id in _ = try await onAction(.restore(id)); refreshID = UUID() }) }
            .sheet(item: $share, onDismiss: { /* The temporary export is retained for the receiving system activity. */ }) { FileManagementShareSheet(url: $0.url) }
            .confirmationDialog(String(localized: "将所选内容移入回收站？"), isPresented: $confirmsTrash, titleVisibility: .visible) {
                Button(String(localized: "移入回收站"), role: .destructive) { perform(.trash(chosen)) }
                Button(String(localized: "取消"), role: .cancel) {}
            } message: { Text(String(localized: "其他白板引用和待修改批注会保留；恢复原位置后可重新关联。不会永久删除文件。")) }
        }
    }
    private func row(_ entry: ManagedVaultEntry) -> some View {
        Button {
            if selectionMode { toggle(entry.path) }
            else if entry.isDirectory { navigate(entry.path) }
            else { onOpen(entry) }
        } label: {
            HStack(spacing: 12) {
                if selectionMode { Image(systemName: selected.contains(entry.path) ? "checkmark.circle.fill" : "circle").foregroundStyle(selected.contains(entry.path) ? .teal : .secondary) }
                Image(systemName: entry.isDirectory ? "folder.fill" : entry.path.lowercased().hasSuffix(".inkspace.json") ? "square.grid.2x2" : "doc").foregroundStyle(entry.isDirectory ? .blue : .secondary)
                VStack(alignment: .leading) {
                    Text(entry.title).foregroundStyle(.primary).lineLimit(2)
                    if sort == .modified, let date = entry.modifiedAt { Text(date, style: .date).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if entry.isDirectory && !selectionMode { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
            }.frame(minHeight: 44)
        }
        .onLongPressGesture { selectionMode = true; toggle(entry.path) }
        .accessibilityIdentifier("fileManager.entry." + entry.path)
        .accessibilityValue(selected.contains(entry.path) ? String(localized: "已选择") : String(localized: "未选择"))
    }
    private var selectionBar: some View {
        VStack(spacing: 8) {
            HStack {
                Text(String(localized: "已选 \(selected.count) 项")); Spacer()
                Button(String(localized: "全选当前项")) {
                    let union = selected.union(filtered.map(\.path))
                    guard union.count <= VaultFileManagement.maximumSelection else { message = String(localized: "一次最多选择 100 项。"); return }
                    selected = union
                }.disabled(isWorking)
            }.font(.subheadline)
            HStack {
                Button(String(localized: "移动"), systemImage: "folder") { showsDestination = true }.accessibilityIdentifier("fileManager.move")
                Spacer()
                Button(String(localized: "分享"), systemImage: "square.and.arrow.up") { perform(.share(chosen)) }.accessibilityIdentifier("fileManager.share")
                Spacer()
                Button(String(localized: "删除"), systemImage: "trash", role: .destructive) { confirmsTrash = true }.accessibilityIdentifier("fileManager.trash")
            }.buttonStyle(.bordered).disabled(selected.isEmpty || isWorking || isLoading)
        }.padding().background(.bar)
    }
    private func toggle(_ path: String) {
        if selected.contains(path) { selected.remove(path) }
        else if selected.count < VaultFileManagement.maximumSelection { selected.insert(path) }
        else { message = String(localized: "一次最多选择 100 项。") }
    }
    private func navigate(_ path: String) { currentPath = path == "." ? "" : path; query = ""; entries = []; message = nil }
    private func reload() async {
        let path = currentPath, requestID = UUID(); loadID = requestID; isLoading = true
        defer { if loadID == requestID { isLoading = false } }
        do {
            let values = try await service.listDirectory(path)
            let order = try await service.folderOrder(path)
            guard !Task.isCancelled, path == currentPath, loadID == requestID else { return }
            entries = values
            let known = Set(order); manualOrder = order + values.map(\.path).filter { !known.contains($0) }
            let available = Set(values.map(\.path))
            selected = selected.filter { ($0 as NSString).deletingLastPathComponent != path || available.contains($0) }
        } catch { if !Task.isCancelled && path == currentPath && loadID == requestID { message = error.localizedDescription } }
    }
    private func perform(_ action: VaultFileManagementAction) {
        guard !isWorking else { return }; isWorking = true; message = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                if let url = try await onAction(action) { share = FileManagerShare(url: url) }
                else {
                    switch action {
                    case .move(let paths, let destination):
                        let moves = paths.sorted { $0.count < $1.count }.map { path in
                            VaultManagedMove(from: path, to: destination.isEmpty ? (path as NSString).lastPathComponent : destination + "/" + (path as NSString).lastPathComponent)
                        }
                        currentPath = VaultFileManagement.mapped(currentPath, by: moves)
                    case .trash(let paths):
                        if let ancestor = paths.sorted(by: { $0.count < $1.count }).first(where: { currentPath == $0 || currentPath.hasPrefix($0 + "/") }) {
                            currentPath = (ancestor as NSString).deletingLastPathComponent
                        }
                    default: break
                    }
                    selected.removeAll(); selectionMode = false; refreshID = UUID(); message = String(localized: "操作完成。文件夹内容已更新。")
                }
            } catch { message = error.localizedDescription; refreshID = UUID() }
        }
    }
    private func reorder(_ offsets: IndexSet, _ destination: Int) {
        var paths = filtered.map(\.path); paths.move(fromOffsets: offsets, toOffset: destination)
        guard !isWorking else { return }; isWorking = true
        Task { @MainActor in
            defer { isWorking = false }
            do { try await service.setFolderOrder(currentPath, children: paths); manualOrder = paths }
            catch { message = error.localizedDescription }
        }
    }
}

private struct FileManagementShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct FileDestinationPicker: View {
    let service: VaultFileManagement
    let excluded: [String]
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path = ""
    @State private var folders: [ManagedVaultEntry] = []
    @State private var message: String?
    @State private var loading = false
    private var isAllowed: Bool { !excluded.contains { path == $0 || path.hasPrefix($0 + "/") } }
    var body: some View {
        NavigationStack {
            List {
                if !path.isEmpty { Button(String(localized: "上一级"), systemImage: "chevron.left") { path = (path as NSString).deletingLastPathComponent } }
                Text(path.isEmpty ? service.rootURL.lastPathComponent : path).font(.headline)
                if loading { ProgressView() }
                if let message { Text(message).foregroundStyle(.orange) }
                ForEach(folders) { folder in Button(folder.title, systemImage: "folder") { path = folder.path }.disabled(excluded.contains { folder.path == $0 || folder.path.hasPrefix($0 + "/") }) }
            }
            .navigationTitle(String(localized: "移到文件夹"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(String(localized: "移到这里")) { onSelect(path); dismiss() }.disabled(!isAllowed || loading) }
            }
            .task(id: path) {
                let requested = path; loading = true
                do { let values = try await service.listDirectory(path); if !Task.isCancelled && path == requested { folders = values.filter(\.isDirectory); message = nil } }
                catch { if !Task.isCancelled && path == requested { message = error.localizedDescription; folders = [] } }
                if path == requested { loading = false }
            }
        }
    }
}

private struct VaultTrashView: View {
    let service: VaultFileManagement
    let onRestore: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var records: [VaultTrashManifest] = []
    @State private var message: String?
    @State private var busy = false
    var body: some View {
        NavigationStack {
            List {
                if let message { Text(message).foregroundStyle(.orange) }
                if records.isEmpty { Text(String(localized: "回收站为空。")) }
                ForEach(records) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.entries.prefix(3).map(\.originalPath).joined(separator: "\n")).lineLimit(3)
                        Text(record.createdAt).font(.caption).foregroundStyle(.secondary)
                        Button(String(localized: "恢复原位置")) {
                            busy = true
                            Task { @MainActor in
                                defer { busy = false }
                                do { try await onRestore(record.id); records = try await service.listTrash(); message = String(localized: "已恢复原位置。") }
                                catch { message = error.localizedDescription }
                            }
                        }.disabled(busy || record.state != "complete").accessibilityIdentifier("fileManager.restore." + record.id)
                        if record.state != "complete" { Text(String(localized: "记录未完成，请等待同步或检查恢复状态。" )).font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 4)
                }
            }
            .navigationTitle(String(localized: "回收站"))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .task { do { records = try await service.listTrash() } catch { message = error.localizedDescription } }
        }
    }
}

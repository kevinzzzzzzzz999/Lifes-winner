import SwiftUI

/// Creates real child files in a chosen folder, or links an existing file.
/// This view never copies child content into the parent document.
struct ChildBoardsSheet: View {
    @Bindable var store: BoardStore
    var ownerID: UUID? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var directory = ""
    @State private var files: [URL] = []
    @State private var query = ""
    @State private var loading = true
    @State private var working = false
    @State private var chooseFolder = false
    @State private var tab = 0

    private var canEdit: Bool { !store.isPadReading && !store.usesPhoneInterface && !working && !store.isBusy }
    private var references: [(owner: UUID, link: BoardChildLink)] {
        store.document.items.filter { ownerID == nil || $0.id == ownerID }.flatMap { item in
            (item.childBoards ?? []).map { (item.id, $0) }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if !references.isEmpty {
                    Section(String(localized: "已关联子白板")) {
                        ForEach(Array(references.enumerated()), id: \.offset) { _, entry in
                            VStack(alignment: .leading, spacing: 8) {
                                Button { open(entry.link) } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Label(entry.link.title, systemImage: "rectangle.on.rectangle")
                                        Text(entry.link.path).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                if canEdit {
                                    HStack {
                                        Button(entry.link.presentation?.expanded == true ? String(localized: "收起") : String(localized: "展开")) {
                                            Task {
                                                if entry.link.presentation?.expanded == true { await store.collapseChild(ownerID: entry.owner, linkID: entry.link.id) }
                                                else { await store.expandedChild(ownerID: entry.owner, linkID: entry.link.id) }
                                            }
                                        }
                                        Button(String(localized: "显示全部内容")) {
                                            Task { await store.expandedChild(ownerID: entry.owner, linkID: entry.link.id, fullContents: true) }
                                        }
                                    }.buttonStyle(.bordered)
                                }
                            }.padding(.vertical, 4)
                        }
                        if canEdit {
                            Button(String(localized: "全部展开并留出空间")) { Task { await store.expandAllChildren(); dismiss() } }
                                .accessibilityIdentifier("children.expandAll")
                            Button(String(localized: "全部收起")) { Task { await store.collapseAllChildren(); dismiss() } }
                                .accessibilityIdentifier("children.collapseAll")
                        }
                    }
                }
                if !store.isPadReading && !store.usesPhoneInterface {
                    Section {
                        Picker(String(localized: "添加方式"), selection: $tab) {
                            Text(String(localized: "新建子白板")).tag(0)
                            Text(String(localized: "关联已有白板")).tag(1)
                        }.pickerStyle(.segmented)
                    }
                    if tab == 0 {
                        Section(String(localized: "新建子白板")) {
                            TextField(String(localized: "名称，例如 VK1"), text: $title)
                                .accessibilityIdentifier("children.title")
                            Button { chooseFolder = true } label: {
                                Label(directory.isEmpty ? String(localized: "仓库根目录") : directory, systemImage: "folder")
                            }.disabled(!canEdit).accessibilityIdentifier("children.folder")
                            Text(String(localized: "选择 VK1、VK2 等文件夹。父白板只保存链接；展开书写和单独打开都会修改这里的同一个子白板文件。"))
                                .font(.footnote).foregroundStyle(.secondary)
                            Button(String(localized: "创建并添加标题卡片")) {
                                working = true
                                Task {
                                    let success = await store.createChildBoard(title: title, directory: directory, ownerID: ownerID)
                                    working = false
                                    if success { dismiss() }
                                }
                            }.disabled(!canEdit || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                .accessibilityIdentifier("children.create")
                        }
                    } else {
                        Section(String(localized: "选择已有白板")) {
                            TextField(String(localized: "搜索名称或文件夹"), text: $query)
                            if loading { ProgressView() }
                            if let warning = store.boardFilesWarning { Text(warning).font(.footnote).foregroundStyle(.secondary) }
                            ForEach(files.filter { query.isEmpty || $0.path.localizedCaseInsensitiveContains(query) }, id: \.self) { file in
                                let path = store.relativePath(for: file) ?? file.lastPathComponent
                                Button {
                                    working = true
                                    Task {
                                        let success = await store.linkChildBoard(path: path, ownerID: ownerID)
                                        working = false
                                        if success { dismiss() }
                                    }
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(file.lastPathComponent.replacingOccurrences(of: ".inkspace.json", with: ""))
                                        Text(path).font(.caption).foregroundStyle(.secondary)
                                    }
                                }.disabled(!canEdit || file == store.boardURL)
                            }
                        }
                    }
                } else if references.isEmpty {
                    Text(String(localized: "当前白板还没有关联子白板。可在 iPad 开启编辑后添加，或在 Mac 添加后同步。"))
                        .foregroundStyle(.secondary)
                }
                Section { Text(store.status).font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle(String(localized: "子白板")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(String(localized: "完成")) { dismiss() }.disabled(working) } }
            .overlay { if working { ProgressView().padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)) } }
            .task {
                directory = store.boardURL.flatMap { store.relativePath(for: $0) }.map { ($0 as NSString).deletingLastPathComponent } ?? "InkSpace"
                files = await store.boardFiles(); loading = false
            }
            .sheet(isPresented: $chooseFolder) {
                if let library = store.library {
                    BoardSaveDirectoryPicker(library: library, initialPath: directory) { directory = $0 }
                }
            }
        }
    }

    private func open(_ link: BoardChildLink) {
        working = true
        Task { await store.openChildBoard(link); working = false; dismiss() }
    }
}

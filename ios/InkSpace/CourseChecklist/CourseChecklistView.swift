import SwiftUI

private struct ChecklistDraft: Identifiable {
    let id = UUID()
    let taskID: String?
    var text: String
    var section: String
}
private enum ChecklistFilter: String, CaseIterable, Identifiable {
    case pending, completed, all
    var id: Self { self }
    var title: String {
        switch self {
        case .pending: String(localized: "待完成")
        case .completed: String(localized: "已完成")
        case .all: String(localized: "全部")
        }
    }
}

struct CourseChecklistView: View {
    let rootURL: URL
    private let service: CourseChecklistStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var directory: String
    @State private var path: String
    @State private var snapshot: CourseChecklistSnapshot?
    @State private var loaded = false
    @State private var loading = false
    @State private var loadToken = UUID()
    @State private var busy = false
    @State private var error: String?
    @State private var poems: [CoursePoem] = []
    @State private var draft: ChecklistDraft?
    @State private var reward: CoursePoem?
    @State private var filter: ChecklistFilter = .pending
    @State private var showsArchived = false
    @State private var showsPoems = false
    @State private var showsFolder = false
    init(rootURL: URL, initialDirectory: String, initialFilePath: String? = nil) {
        self.rootURL = rootURL
        self.service = CourseChecklistStore(rootURL: rootURL)
        let location = CourseChecklistStore.initialLocation(contextDirectory: initialDirectory, explicitFilePath: initialFilePath)
        _directory = State(initialValue: location.directory)
        _path = State(initialValue: location.path)
    }
    private var active: [CourseChecklistTask] { snapshot?.document.tasks.filter { $0.archivedAt == nil } ?? [] }
    private var completed: Int { active.filter(\.done).count }
    private var displayed: [CourseChecklistTask] {
        (snapshot?.document.tasks ?? []).filter { task in
            if showsArchived { return task.archivedAt != nil }
            guard task.archivedAt == nil else { return false }
            return filter == .all || (filter == .completed ? task.done : !task.done)
        }
    }
    private var earned: [CoursePoem] {
        let ids = Set(snapshot?.document.tasks.compactMap(\.rewardId) ?? [])
        return poems.filter { ids.contains($0.id) }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { showsFolder = true } label: {
                        Label(directory.isEmpty ? rootURL.lastPathComponent : directory, systemImage: "folder")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.accessibilityIdentifier("checklist.folder").disabled(busy || loading)
                    if let document = snapshot?.document {
                        Text(document.title).font(.title3.bold())
                        ProgressView(value: Double(completed), total: Double(max(active.count, 1)))
                        Text(String(format: String(localized: "已完成 %lld / %lld 项"), completed, active.count))
                            .font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("checklist.progress")
                    }
                    Text(String(localized: "清单默认保存在资料库主文件夹，通过 iCloud 同步。旧清单保留原位置，可点上方文件夹或从文件列表打开。完成后显示诗词奖励。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.orange).accessibilityIdentifier("checklist.error")
                        Button(String(localized: "刷新清单")) { Task { await reload() } }.disabled(busy || loading)
                    }
                }
                if busy || loading { ProgressView(String(localized: "正在保存或读取清单…")) }
                if snapshot != nil {
                    Section {
                        Toggle(String(localized: "查看已归档"), isOn: $showsArchived).accessibilityIdentifier("checklist.archived")
                        if !showsArchived {
                            Picker(String(localized: "任务状态"), selection: $filter) {
                                ForEach(ChecklistFilter.allCases) { Text($0.title).tag($0) }
                            }.pickerStyle(.segmented).accessibilityIdentifier("checklist.filter")
                        }
                        if displayed.isEmpty { Text(String(localized: "这里还没有任务。" )).foregroundStyle(.secondary) }
                        ForEach(displayed) { task in taskRow(task) }
                    }
                    Section {
                        Button(String(localized: "新增任务"), systemImage: "plus") { draft = ChecklistDraft(taskID: nil, text: "", section: "") }
                            .accessibilityIdentifier("checklist.add")
                        Button(String(localized: "我的诗词奖励"), systemImage: "book.closed") { showsPoems = true }
                            .accessibilityIdentifier("checklist.poems")
                    }.disabled(busy || loading)
                } else if loaded && error == nil {
                    ContentUnavailableView(String(localized: "此课程还没有清单"), systemImage: "checklist", description: Text(String(localized: "新建一份空白清单，再添加你的课程任务。")))
                    if directory.isEmpty {
                        Button(String(localized: "新建课程清单"), systemImage: "plus") { Task { await create() } }
                            .buttonStyle(.borderedProminent).disabled(busy || loading).accessibilityIdentifier("checklist.create")
                    } else {
                        Text(String(localized: "新清单只能保存在资料库主文件夹；旧清单仍可在原位置编辑。")).font(.caption).foregroundStyle(.secondary)
                        Button(String(localized: "在主文件夹创建或打开清单"), systemImage: "folder") {
                            directory = ""; path = CourseChecklistStore.checklistPath(directory: "")
                            snapshot = nil; loaded = false; error = nil
                        }.buttonStyle(.borderedProminent).disabled(busy || loading).accessibilityIdentifier("checklist.openRoot")
                    }
                }
            }
            .navigationTitle(String(localized: "课程清单"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "完成")) {
                        dismiss()
                    }.disabled(busy || loading).accessibilityIdentifier("checklist.close")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(String(localized: "刷新清单"), systemImage: "arrow.clockwise") { Task { await reload() } }
                        .disabled(busy || loading).accessibilityIdentifier("checklist.refresh")
                }
            }
            .refreshable { await reload() }
            .sheet(item: $draft) { item in
                ChecklistTaskEditor(draft: item, onReload: { await reload() }, onSave: { text, section in
                    let change: CourseChecklistDocument.Change = item.taskID.map { .edit(id: $0, text: text, section: section) } ?? .add(text: text, section: section)
                    _ = try await commit(change)
                })
            }
            .sheet(item: $reward) { poem in ChecklistPoemView(poem: poem) }
            .sheet(isPresented: $showsPoems) {
                NavigationStack {
                    List {
                        if earned.isEmpty { Text(String(localized: "完成一个任务后，在这里收藏诗词。")) }
                        ForEach(earned) { poem in NavigationLink { ChecklistPoemContent(poem: poem) } label: { VStack(alignment: .leading, spacing: 8) { Text(poem.text); Text("\(poem.author) · \(poem.title)").font(.caption).foregroundStyle(.secondary) } } }
                    }.navigationTitle(String(localized: "我的诗词奖励"))
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { showsPoems = false } } }
                }
            }
            .sheet(isPresented: $showsFolder) {
                ChecklistFolderPicker(service: service, initial: directory) { selected in
                    directory = selected; path = CourseChecklistStore.checklistPath(directory: selected)
                    snapshot = nil; loaded = false; error = nil
                }
            }
            .interactiveDismissDisabled(busy)
            .task(id: path) { if poems.isEmpty { poems = (try? CoursePoem.bundled()) ?? [] }; await reload() }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                if loaded && draft == nil && !showsFolder { await reload() }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(20)) } catch { return }
                    if draft == nil && !busy && !loading && !showsFolder { await reload() }
                }
            }
        }
    }
    private func taskRow(_ task: CourseChecklistTask) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if task.archivedAt == nil {
                Button {
                    Task {
                        do {
                            let saved = try await commit(.toggle(task.id))
                            if !task.done, let id = saved.document.tasks.first(where: { $0.id == task.id })?.rewardId { reward = poems.first { $0.id == id } }
                        } catch { self.error = error.localizedDescription }
                    }
                } label: { Image(systemName: task.done ? "checkmark.circle.fill" : "circle").font(.title2).frame(width: 44, height: 44) }
                    .buttonStyle(.borderless).disabled(busy || loading).accessibilityLabel(task.done ? String(localized: "取消完成") : String(localized: "标记完成"))
                    .accessibilityIdentifier("checklist.toggle." + task.id)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(task.text).strikethrough(task.done).foregroundStyle(task.done ? .secondary : .primary)
                if !task.section.isEmpty { Text(task.section).font(.caption).foregroundStyle(.secondary) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            Menu {
                if task.archivedAt == nil {
                    Button(String(localized: "编辑任务"), systemImage: "pencil") { draft = ChecklistDraft(taskID: task.id, text: task.text, section: task.section) }
                    Button(String(localized: "归档任务"), systemImage: "archivebox") { perform(.archive(task.id)) }
                } else { Button(String(localized: "恢复任务"), systemImage: "arrow.uturn.backward") { perform(.restore(task.id)) } }
                if let poem = poems.first(where: { $0.id == task.rewardId }) { Button(String(localized: "查看诗词"), systemImage: "book") { reward = poem } }
            } label: { Image(systemName: "ellipsis.circle").frame(width: 44, height: 44) }
                .disabled(busy || loading).accessibilityIdentifier("checklist.menu." + task.id)
        }.accessibilityElement(children: .contain)
    }
    @MainActor private func reload() async {
        guard !busy else { return }
        let requestedPath = path, token = UUID()
        loadToken = token; loading = true
        defer { if token == loadToken { loading = false } }
        do {
            let found = try await service.load(path: requestedPath)
            guard requestedPath == path, token == loadToken, !Task.isCancelled else { return }
            snapshot = found; loaded = true; error = nil
        } catch {
            guard requestedPath == path, token == loadToken, !Task.isCancelled else { return }
            self.error = error.localizedDescription; loaded = true
        }
    }
    @MainActor private func create() async {
        guard !busy, !loading else { return }; busy = true
        defer { busy = false }
        do {
            snapshot = try await service.create(path: path, title: directory.isEmpty ? rootURL.lastPathComponent : (directory as NSString).lastPathComponent)
            error = nil; loaded = true
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func commit(_ change: CourseChecklistDocument.Change) async throws -> CourseChecklistSnapshot {
        guard !busy, !loading, let snapshot, snapshot.path == path else { throw CourseChecklistError.missing }; busy = true
        defer { busy = false }
        let saved = try await service.change(snapshot, change, poems: poems)
        self.snapshot = saved; self.error = nil
        return saved
    }
    private func perform(_ change: CourseChecklistDocument.Change) {
        Task { do { _ = try await commit(change) } catch { self.error = error.localizedDescription } }
    }
}

private struct ChecklistTaskEditor: View {
    let draft: ChecklistDraft
    let onReload: () async -> Void
    let onSave: (String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var section: String
    @State private var busy = false
    @State private var error: String?
    @State private var confirmsDiscard = false
    private var dirty: Bool { text != draft.text || section != draft.section }
    init(draft: ChecklistDraft, onReload: @escaping () async -> Void, onSave: @escaping (String, String) async throws -> Void) {
        self.draft = draft; self.onReload = onReload; self.onSave = onSave
        _text = State(initialValue: draft.text); _section = State(initialValue: draft.section)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "任务内容")) {
                    TextField(String(localized: "例如：完成第二周阅读"), text: $text, axis: .vertical).lineLimit(3...8).accessibilityIdentifier("checklist.editor.text")
                    Text("\(text.utf16.count) / 1000").font(.caption).foregroundStyle(.secondary)
                }
                Section(String(localized: "分组（可选）")) { TextField(String(localized: "例如：Week 2"), text: $section).accessibilityIdentifier("checklist.editor.section") }
                if let error {
                    Text(error).foregroundStyle(.orange).accessibilityIdentifier("checklist.editor.error")
                    Button(String(localized: "刷新并保留输入")) { Task { busy = true; await onReload(); busy = false } }.disabled(busy)
                }
            }.disabled(busy).navigationTitle(draft.taskID == nil ? String(localized: "新增任务") : String(localized: "编辑任务"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { if dirty { confirmsDiscard = true } else { dismiss() } }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "保存")) {
                            Task {
                                busy = true
                                do { try await onSave(text.trimmingCharacters(in: .whitespacesAndNewlines), section.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() }
                                catch { self.error = error.localizedDescription }
                                busy = false
                            }
                        }.disabled(busy || !CourseChecklistDocument.validText(text, limit: 1000) || !CourseChecklistDocument.validText(section, limit: 200, empty: true)).accessibilityIdentifier("checklist.editor.save")
                    }
                }.interactiveDismissDisabled(busy || dirty)
                .confirmationDialog(String(localized: "要放弃尚未保存的任务输入吗？"), isPresented: $confirmsDiscard, titleVisibility: .visible) {
                    Button(String(localized: "放弃输入"), role: .destructive) { dismiss() }
                    Button(String(localized: "继续编辑"), role: .cancel) {}
                }
        }
    }
}

private struct ChecklistPoemContent: View {
    let poem: CoursePoem
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(.tint)
                Text(poem.text.replacingOccurrences(of: "，", with: "，\n")).font(.title2).lineSpacing(10).textSelection(.enabled).accessibilityIdentifier("checklist.reward.text")
                Text("\(poem.author) ·《\(poem.title)》").font(.headline)
                Text(poem.note).foregroundStyle(.secondary)
                if let url = URL(string: poem.sourceURL), ["https", "http"].contains(url.scheme) { Link(String(localized: "查看诗词出处"), destination: url) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(28)
        }.navigationTitle(String(localized: "诗词奖励"))
    }
}
private struct ChecklistPoemView: View {
    let poem: CoursePoem
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack { ChecklistPoemContent(poem: poem).toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("checklist.reward.done") } } }
    }
}
private struct ChecklistFolderPicker: View {
    let service: CourseChecklistStore
    let onChoose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path: String
    @State private var folders: [String] = []
    @State private var error: String?
    @State private var loading = false
    init(service: CourseChecklistStore, initial: String, onChoose: @escaping (String) -> Void) {
        self.service = service; self.onChoose = onChoose; _path = State(initialValue: initial)
    }
    var body: some View {
        NavigationStack {
            List {
                Text(path.isEmpty ? service.rootURL.lastPathComponent : path).font(.headline)
                Button(String(localized: "上一级"), systemImage: "chevron.left") { path = (path as NSString).deletingLastPathComponent }.disabled(path.isEmpty || loading)
                if let error { Text(error).foregroundStyle(.orange) }
                if loading { ProgressView() }
                ForEach(folders, id: \.self) { folder in Button { path = folder } label: { Label((folder as NSString).lastPathComponent, systemImage: "folder") }.disabled(loading) }
                Button(String(localized: "使用此课程文件夹")) { onChoose(path); dismiss() }.disabled(loading || error != nil).accessibilityIdentifier("checklist.folder.choose")
            }.navigationTitle(String(localized: "选择课程文件夹"))
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } } }
                .task(id: path) {
                    loading = true
                    do { let found = try await service.folders(in: path); if !Task.isCancelled { folders = found; error = nil } }
                    catch { if !Task.isCancelled { self.error = error.localizedDescription; folders = [] } }
                    if !Task.isCancelled { loading = false }
                }
        }
    }
}

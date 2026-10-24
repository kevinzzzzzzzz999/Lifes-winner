import SwiftUI
import UniformTypeIdentifiers

struct BoardBackupSettingsView: View {
    let controller: BoardBackupController
    var backgroundRefresh: BoardBackgroundRefreshController = .shared
    let document: BoardDocument
    let vaultURL: URL
    let onRestore: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var importPresented = false
    @State private var restoreEntry: BoardBackupEntry?
    @State private var exportURL: URL?
    @State private var work: Task<Void, Never>?
    @State private var workID: UUID?
    @State private var isVisible = false
    @State private var retention = 10
    @State private var capacity = 2

    var body: some View {
        NavigationStack {
            List {
                Section(String(localized: "后台与同步")) {
                    Text(String(localized: "离开应用时会申请有限时间保存；返回前台或解锁后会检查当前白板。"))
                    Text(String(localized: "系统可能在后台检查上次白板，但不保证固定间隔、永久运行或熄屏实时更新。锁屏文件保护、网络、省电模式及系统后台刷新设置都可能延迟更新。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(String(localized: "iCloud 传输由系统管理；请求下载不表示上传或跨设备同步已经完成。后台检查不会扫描整套资料。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(backgroundRefresh.status).font(.caption)
                        .accessibilityIdentifier("background.refresh.status")
                }
                Section(String(localized: "此白板")) {
                    Toggle(String(localized: "使用结束后保留本机备份"), isOn: Binding(get: { controller.enabled }, set: { value in
                        Task { await controller.setEnabled(value, document: document, vaultURL: vaultURL) }
                    })).accessibilityIdentifier("backup.enabled")
                    Text(String(localized: "保存在此 iPad，与 iCloud 仓库独立。关闭开关会保留旧版本。删除应用会删除本机历史，请先导出完整备份包。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(controller.lastStatus)
                    if let error = controller.lastError { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
                    Button(String(localized: "立即备份"), systemImage: "externaldrive.badge.plus") {
                        run { await controller.capture(document: document, vaultURL: vaultURL, reason: .manual) }
                    }.disabled(!controller.enabled || controller.isWorking).accessibilityIdentifier("backup.capture")
                }
                Section(String(localized: "空间与版本")) {
                    Text(String(localized: "已用 \(ByteCountFormatter.string(fromByteCount: Int64(controller.usageBytes), countStyle: .file))，相同资料只存一份。"))
                    Stepper(String(localized: "最近 \(retention) 次有变化的会话"), value: $retention, in: 1...100)
                    Picker(String(localized: "本机备份容量"), selection: $capacity) {
                        ForEach([1, 2, 4, 8, 16], id: \.self) { Text("\($0) GB").tag($0) }
                    }
                    Button(String(localized: "应用保留设置")) {
                        var policy = controller.policy; policy.sessionCount = retention; policy.maximumBytes = UInt64(capacity) * 1024 * 1024 * 1024
                        Task { await controller.setPolicy(policy) }
                    }
                    Text(String(localized: "另保留最新检查点和最近完整版本。达到限额时停止本次备份并提示；不会为了腾空间删除仅剩的完整备份。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section(String(localized: "本机历史")) {
                    if controller.entries.isEmpty { Text(String(localized: "还没有本机备份。")) }
                    ForEach(controller.entries) { entry in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(entry.record.title).font(.headline)
                            Text(entry.record.date.formatted(date: .abbreviated, time: .standard)).font(.caption)
                            Label(entry.record.complete ? String(localized: "完整备份") : String(localized: "可编辑状态 · 资料未齐"), systemImage: entry.record.complete ? "checkmark.shield" : "exclamationmark.triangle")
                            if !entry.record.complete {
                                Text(String(localized: "缺少或未核对 \(entry.record.missing.count) 项。仅恢复笔迹会暂停这个副本的 PDF 写回。"))
                                    .font(.footnote).foregroundStyle(.secondary)
                                ForEach(Array(entry.record.missing.prefix(5).enumerated()), id: \.offset) { _, item in
                                    Text(item.path + "：" + item.reason).font(.caption).textSelection(.enabled)
                                }
                            }
                            HStack {
                                Button(String(localized: "导出备份包")) { run { exportURL = await controller.export(entry) } }
                                Button(entry.record.complete ? String(localized: "恢复为独立副本") : String(localized: "仅恢复笔迹")) { restoreEntry = entry }
                            }.buttonStyle(.bordered).disabled(controller.isWorking)
                        }.padding(.vertical, 4)
                    }
                }
                Section(String(localized: "导入与分享")) {
                    Button(String(localized: "从备份包导入"), systemImage: "square.and.arrow.down") { importPresented = true }
                        .disabled(controller.isWorking).accessibilityIdentifier("backup.import")
                    if let exportURL { ShareLink(String(localized: "分享已导出的备份包"), item: exportURL).accessibilityIdentifier("backup.share") }
                    Text(String(localized: "完整备份包包含可编辑白板和关联资料，可离线恢复。恢复会在所选课程文件夹内新建独立目录。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if controller.isWorking {
                    Section {
                        ProgressView(String(localized: "正在处理本机备份…"))
                        if workID != nil { Button(String(localized: "取消本次操作")) { work?.cancel() } }
                    }
                }
            }
            .navigationTitle(String(localized: "本机备份")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
            .onAppear { isVisible = true }
            .onDisappear { isVisible = false; work?.cancel(); work = nil; workID = nil }
            .task {
                await controller.reload(document: document, vaultURL: vaultURL)
                retention = controller.policy.sessionCount; capacity = max(1, Int(controller.policy.maximumBytes / (1024 * 1024 * 1024)))
            }
            .fileImporter(isPresented: $importPresented, allowedContentTypes: [.zip]) { result in
                if case .success(let url) = result { run { await controller.importArchive(url) } }
            }
            .sheet(item: $restoreEntry) { entry in
                BoardSaveDirectoryPicker(library: DocumentLibrary(rootURL: vaultURL), initialPath: "") { directory in
                    run {
                        if let path = await controller.restore(entry, vaultURL: vaultURL, directoryPath: directory, allowIncomplete: !entry.record.complete) {
                            guard !Task.isCancelled, isVisible else { return }
                            onRestore(path); dismiss()
                        }
                    }
                }
            }
        }
    }
    private func run(_ operation: @escaping @MainActor () async -> Void) {
        work?.cancel(); let id = UUID(); workID = id
        work = Task {
            await operation()
            if workID == id { work = nil; workID = nil }
        }
    }
}

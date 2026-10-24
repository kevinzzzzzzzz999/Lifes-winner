import SwiftUI
import UniformTypeIdentifiers

struct BrowserExtensionManagerView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Group {
                if #available(iOS 18.4, *) { BrowserExtensionList() }
                else {
                    ContentUnavailableView(String(localized: "需要更新系统"), systemImage: "puzzlepiece.extension",
                        description: Text(String(localized: "内置浏览器扩展需要 iOS / iPadOS 18.4 或更高版本。当前仍可浏览网页和剪藏。")))
                }
            }
            .navigationTitle(String(localized: "浏览器扩展"))
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
        }
    }
}

@available(iOS 18.4, *)
private struct BrowserExtensionList: View {
    @State private var host = BrowserExtensionHost.shared
    @State private var importing = false
    @State private var candidate: BrowserExtensionCandidate?
    @State private var allowed: Set<String> = []
    @State private var failure: String?
    @State private var removing: BrowserExtensionRecord?

    var body: some View {
        List {
            Section {
                Text(String(localized: "支持 Manifest V3 网页脚本、样式与扩展本地存储。请选择已解压、包含 manifest.json 的文件夹；不支持 Safari 商店应用、CRX、后台服务、弹窗或原生通信。"))
                    .font(.footnote).foregroundStyle(.secondary)
                Text(String(localized: "授权的网站允许扩展读取与修改网页内容，包括你在该网页输入的信息。只安装你信任的扩展。所有网站默认关闭，可在安装时或安装后逐项授权。"))
                    .font(.footnote).foregroundStyle(.secondary)
                Button(String(localized: "选择扩展文件夹"), systemImage: "folder.badge.plus") { importing = true }
                    .disabled(host.busy).accessibilityIdentifier("browser.extension.install")
                if host.busy { ProgressView() }
                if let status = host.status { Text(status).foregroundStyle(.red).font(.caption) }
            }
            ForEach(host.records) { record in
                Section {
                    Toggle(isOn: Binding(get: { record.enabled }, set: { value in Task { await host.setEnabled(value, id: record.id) } })) {
                        VStack(alignment: .leading) {
                            Text(record.name)
                            Text(record.version).font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(host.busy)
                    if let error = host.error(for: record.id) { Text(error).font(.caption).foregroundStyle(.red) }
                    if !record.permissions.isEmpty {
                        Text(String(localized: "权限：\(record.permissions.joined(separator: ", "))")).font(.caption)
                    }
                    DisclosureGroup(String(localized: "允许访问的网站")) {
                        ForEach(record.websites, id: \.self) { website in
                            Toggle(website, isOn: Binding(get: { record.allowedWebsites.contains(website) }, set: { host.setWebsite(website, allowed: $0, id: record.id) }))
                                .font(.caption).disabled(host.busy)
                        }
                    }
                    Button(String(localized: "移除扩展及其数据"), role: .destructive) { removing = record }.disabled(host.busy)
                } footer: { Text(String(localized: "启用、停用及网站权限改变会刷新已打开的网页。")) }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
            Task { @MainActor in
                do {
                    guard let url = try result.get().first else { return }
                    candidate = try await host.prepare(folder: url); allowed = []
                } catch { failure = error.localizedDescription }
            }
        }
        .sheet(item: $candidate, onDismiss: { allowed = [] }) { value in
            NavigationStack {
                List {
                    Section(value.record.name) {
                        Text(value.record.version)
                        Text(value.webExtension.displayDescription ?? "")
                        Text(value.record.permissions.isEmpty ? String(localized: "不请求额外浏览器权限") : String(localized: "权限：\(value.record.permissions.joined(separator: ", "))"))
                    }
                    Section(String(localized: "允许读取和修改这些网站")) {
                        ForEach(value.record.websites, id: \.self) { website in
                            Toggle(website, isOn: Binding(get: { allowed.contains(website) }, set: { if $0 { allowed.insert(website) } else { allowed.remove(website) } }))
                        }
                        Text(String(localized: "未勾选的网站不会授权；安装后也可更改。星号 * 表示匹配多个网站或路径，<all_urls> 表示全部网站。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .navigationTitle(String(localized: "确认扩展权限"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(String(localized: "取消")) { host.discard(value); candidate = nil }.disabled(host.busy)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "安装")) {
                            Task { @MainActor in
                                do { try await host.install(value, allowing: allowed); candidate = nil }
                                catch { host.discard(value); candidate = nil; failure = error.localizedDescription }
                            }
                        }.disabled(host.busy)
                    }
                }.interactiveDismissDisabled()
            }
        }
        .alert(String(localized: "无法安装扩展"), isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button(String(localized: "好"), role: .cancel) { failure = nil }
        } message: { Text(failure ?? "") }
        .confirmationDialog(String(localized: "移除扩展及其数据？"), isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button(String(localized: "移除"), role: .destructive) { if let record = removing { Task { await host.remove(record.id) } }; removing = nil }
        }
    }
}

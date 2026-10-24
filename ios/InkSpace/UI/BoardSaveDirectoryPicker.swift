import SwiftUI

/// Browses existing authorized folders only; changing folders never changes the vault bookmark.
struct BoardSaveDirectoryPicker: View {
    let library: DocumentLibrary
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var currentPath: String
    @State private var folders: [VaultFolder] = []
    @State private var warning: String?
    @State private var isLoading = true
    @State private var loadID = UUID()
    @State private var refreshID = UUID()

    init(library: DocumentLibrary, initialPath: String, onSelect: @escaping (String) -> Void) {
        self.library = library
        self.onSelect = onSelect
        _currentPath = State(initialValue: initialPath.isEmpty || VaultPath.isSafeRelative(initialPath) ? initialPath : "")
    }

    var body: some View {
        NavigationStack {
            List {
                Section(String(localized: "当前位置")) {
                    Label(currentPath.isEmpty ? library.rootURL.lastPathComponent : currentPath, systemImage: "folder")
                        .textSelection(.enabled)
                    if !currentPath.isEmpty {
                        Button(String(localized: "上一级"), systemImage: "chevron.up") {
                            navigate(to: (currentPath as NSString).deletingLastPathComponent)
                        }.accessibilityIdentifier("saveDirectory.up")
                        Button(String(localized: "返回仓库根目录"), systemImage: "house") { navigate(to: "") }
                            .accessibilityIdentifier("saveDirectory.root")
                    }
                }
                Section(String(localized: "子文件夹")) {
                    if isLoading { ProgressView(String(localized: "正在读取文件夹…")) }
                    if let warning {
                        Text(warning).foregroundStyle(.secondary)
                        Button(String(localized: "重新读取")) { refreshID = UUID() }
                    }
                    if !isLoading && warning == nil && folders.isEmpty {
                        Text(String(localized: "没有子文件夹，可以保存到当前位置。 ")).foregroundStyle(.secondary)
                    }
                    ForEach(folders) { folder in
                        Button { navigate(to: folder.relativePath) } label: {
                            HStack { Label(folder.title, systemImage: "folder"); Spacer(); Image(systemName: "chevron.right") }
                                .frame(minHeight: 44)
                        }.accessibilityIdentifier("saveDirectory.folder.\(folder.relativePath)")
                    }
                }
            }
            .navigationTitle(String(localized: "选择保存文件夹")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "存放在这里")) { onSelect(currentPath); dismiss() }
                        .disabled(isLoading || warning != nil)
                        .accessibilityIdentifier("saveDirectory.confirm")
                }
            }
            .task(id: currentPath + refreshID.uuidString) { await reload() }
        }
    }

    private func navigate(to path: String) {
        loadID = UUID()
        isLoading = true
        folders = []
        warning = nil
        currentPath = path
    }

    private func reload() async {
        let id = UUID(), path = currentPath
        loadID = id
        isLoading = true
        let listing = await library.listDirectory(relativePath: path)
        guard !Task.isCancelled, loadID == id, currentPath == path else { return }
        folders = listing.folders
        warning = listing.warning
        isLoading = false
    }
}

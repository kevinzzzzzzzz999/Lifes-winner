import SwiftUI

/// Saving is a separate user action. Dismissing this list never cancels a download.
struct WebDownloadsView: View {
    let store: WebDownloadStore
    @Environment(\.dismiss) private var dismiss
    @State private var saving: SaveRequest?
    @State private var preview: NativeFileSaveRequest?
    @State private var sharing: NativeFileSaveRequest?
    private struct SaveRequest: Identifiable {
        let id = UUID()
        let downloadID: UUID
        let file: URL
    }
    var body: some View {
        NavigationStack {
            List {
                if store.records.isEmpty {
                    ContentUnavailableView(WebDownloadStore.text("暂无下载", "No downloads"), systemImage: "arrow.down.circle",
                        description: Text(WebDownloadStore.text("在网页点击下载链接，完成后在这里存储到文件。", "Tap a download link in the website, then save the completed file here.")))
                }
                ForEach(store.records) { entry in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verbatim: entry.name).font(.headline).lineLimit(2)
                        Text(verbatim: entry.source).font(.caption).foregroundStyle(.secondary)
                        if entry.state == .downloading {
                            if entry.total > 0 {
                                ProgressView(value: min(1, Double(entry.received) / Double(entry.total)))
                                Text("\(ByteCountFormatter.string(fromByteCount: entry.received, countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: entry.total, countStyle: .file))").font(.caption).monospacedDigit()
                            } else {
                                ProgressView()
                                Text(ByteCountFormatter.string(fromByteCount: entry.received, countStyle: .file)).font(.caption).monospacedDigit()
                            }
                            Button(WebDownloadStore.text("取消此下载", "Cancel download"), role: .destructive) { store.cancel(entry.id) }
                                .accessibilityIdentifier("webDownload.cancel")
                        } else if entry.state == .cancelling { ProgressView() }
                        if !entry.message.isEmpty {
                            Text(verbatim: entry.message).font(.caption).foregroundStyle(entry.state == .failed ? .red : .secondary)
                                .accessibilityIdentifier("webDownload.status")
                        }
                        if entry.state == .completed, let file = entry.fileURL {
                            Button(WebDownloadStore.text("存储到文件", "Save to Files"), systemImage: "folder") {
                                saving = SaveRequest(downloadID: entry.id, file: file)
                            }.disabled(saving != nil).accessibilityIdentifier("webDownload.save")
                            HStack(spacing: 16) {
                                Button(WebDownloadStore.text("预览", "Preview"), systemImage: "doc.text.magnifyingglass") {
                                    preview = NativeFileSaveRequest(files: [file])
                                }.accessibilityIdentifier("webDownload.preview")
                                Button(WebDownloadStore.text("分享", "Share"), systemImage: "square.and.arrow.up") {
                                    sharing = NativeFileSaveRequest(files: [file])
                                }.accessibilityIdentifier("webDownload.share")
                            }
                        }
                        if entry.state != .downloading && entry.state != .cancelling {
                            Button(WebDownloadStore.text("移除此记录", "Remove download"), role: .destructive) { store.remove(entry.id) }
                                .disabled(saving != nil).font(.caption).accessibilityIdentifier("webDownload.remove")
                        }
                    }.padding(.vertical, 6)
                }
            }
            .navigationTitle(WebDownloadStore.text("下载", "Downloads"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(WebDownloadStore.text("完成", "Done")) { dismiss() }.disabled(saving != nil)
            } }
            .safeAreaInset(edge: .bottom) {
                Text(WebDownloadStore.text("关闭此列表或隐藏网页后，下载仍会继续。完成文件在本次网页会话中保留，直到你移除；下载完成不表示已存储到文件。", "Downloads continue when this list or the website panel is hidden. Completed files stay in this website session until removed. Downloaded does not mean saved to Files."))
                    .font(.caption).foregroundStyle(.secondary).padding(12).frame(maxWidth: .infinity).background(.regularMaterial)
            }
            .sheet(item: $saving) { request in
                NativeFileSavePicker(files: [request.file]) { saved in
                    store.recordSaveResult(request.downloadID, saved: saved); saving = nil
                }
            }
            .sheet(item: $preview) { request in NativeFilePreview(files: request.files) }
            .sheet(item: $sharing) { request in NativeFileShare(files: request.files) }
        }
    }
}

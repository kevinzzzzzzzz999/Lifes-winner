import SwiftUI
import WebKit

private struct RetainedChatGPTWebView: UIViewRepresentable {
    let session: ChatGPTWebSession
    func makeUIView(context: Context) -> UIView {
        let host = UIView(); attach(to: host); return host
    }
    func updateUIView(_ host: UIView, context: Context) { attach(to: host) }
    private func attach(to host: UIView) {
        let web = session.view()
        host.subviews.filter { $0 !== web }.forEach { $0.removeFromSuperview() }
        guard web.superview !== host else { return }
        web.removeFromSuperview(); web.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: host.leadingAnchor), web.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            web.topAnchor.constraint(equalTo: host.topAnchor), web.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }
    // Session owns the web view: detaching a presentation never reloads or clears
    // its website store. UIKit removes old parent constraints when it is reparented.
}

struct ChatGPTWebPanel: View {
    let session: ChatGPTWebSession
    @Bindable var capture: TemporaryBoardCapture
    let fullScreen: Bool
    let canCapture: Bool
    let onCapture: () -> Void
    let onFullScreen: () -> Void
    let onClose: () -> Void
    let onAPI: () -> Void
    @State private var showsImagePreview = false
    @State private var showsDownloads = false
    @AppStorage(AIWebProvider.preferenceKey) private var providerRaw = AIWebProvider.chatgpt.rawValue
    @State private var pasteStatus = ""
    @State private var isPasting = false
    @State private var pasteRequest = UUID()
    private var selectedProvider: AIWebProvider { AIWebProvider(rawValue: providerRaw) ?? .chatgpt }

    private func cancelPaste() {
        pasteRequest = UUID(); isPasting = false; pasteStatus = ""; session.cancelPendingPaste()
    }
    private func pasteScreenshot() {
        guard let image = capture.image, capture.copyImage() else { return }
        let request = UUID(); pasteRequest = request; isPasting = true
        let changeCount = UIPasteboard.general.changeCount
        Task { @MainActor in
            let outcome = await session.pasteCopiedImage(expectedChangeCount: changeCount)
            guard pasteRequest == request else { return }
            isPasting = false
            guard capture.image === image else { return }
            switch outcome {
            case .requested: pasteStatus = String(localized: "已尝试放入网页，请确认图片附件；若未出现，请点击输入框长按粘贴。尚未发送。")
            case .manual: pasteStatus = String(localized: "已复制截图。请在 AI 网页输入框长按粘贴，确认附件后由你发送。")
            case .cancelled: pasteStatus = String(localized: "网页或服务已切换，已取消放入。截图仍在剪贴板；请确认接收方后再粘贴。")
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Menu {
                    Picker(String(localized: "AI 网页服务"), selection: $providerRaw) {
                        ForEach(AIWebProvider.allCases) { provider in Text(verbatim: provider.title).tag(provider.rawValue) }
                    }
                } label: { Label(session.provider.title, systemImage: "chevron.down").font(.headline) }
                    .accessibilityIdentifier("aiWeb.provider")
                Spacer(minLength: 8)
                Button { session.goBack() } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel(String(localized: "网页后退"))
                Button { session.reload() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel(String(localized: "刷新网页")).accessibilityIdentifier("chatgpt.reload")
                Button { showsDownloads = true } label: {
                    Image(systemName: session.downloads.activeCount > 0 ? "arrow.down.circle.fill" : "arrow.down.circle")
                }.accessibilityLabel(WebDownloadStore.text("下载", "Downloads")).accessibilityIdentifier("aiWeb.downloads")
                if !fullScreen {
                    Button(action: onFullScreen) { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                        .accessibilityLabel(String(localized: "网页全屏")).accessibilityIdentifier("chatgpt.fullscreen")
                }
                Button(action: onClose) { Image(systemName: fullScreen ? "xmark" : "sidebar.right") }
                    .accessibilityLabel(fullScreen ? String(localized: "返回白板") : String(localized: "隐藏 AI 网页"))
                    .accessibilityIdentifier("chatgpt.close")
            }.buttonStyle(.borderless).padding(14)
            Text(String(localized: "在网页内自行登录；下次仍打开当前 AI。")).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 6)
            if session.loading { ProgressView().frame(maxWidth: .infinity).padding(.bottom, 6) }
            if let message = session.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 8)
            }
            RetainedChatGPTWebView(session: session).frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("chatgpt.host")
            Divider()
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Button(String(localized: "框选截图"), systemImage: "viewfinder", action: onCapture)
                        .disabled(!canCapture || capture.isSelecting).accessibilityIdentifier("chatgpt.capture")
                    Spacer()
                    Button(String(localized: "API 高级页"), action: onAPI).font(.footnote)
                        .accessibilityIdentifier("chatgpt.api")
                }
                if let image = capture.image {
                    HStack(spacing: 12) {
                        Button { showsImagePreview = true } label: {
                            Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 120, maxHeight: 80)
                        }.accessibilityLabel(String(localized: "查看选区大图"))
                        VStack(alignment: .leading, spacing: 8) {
                            Button(String(localized: "1 · 复制截图"), systemImage: "doc.on.doc") { pasteStatus = ""; capture.copyImage() }
                                .buttonStyle(.borderedProminent).accessibilityIdentifier("chatgpt.copy")
                            Button(String(localized: "放入 AI 输入框"), systemImage: "arrow.up.doc") { pasteScreenshot() }
                                .buttonStyle(.bordered).disabled(isPasting || session.loading || capture.isSelecting)
                                .accessibilityIdentifier("aiWeb.pasteImage")
                            Button(String(localized: "移除截图"), role: .destructive) { cancelPaste(); capture.discardImage() }
                                .font(.caption)
                        }
                    }
                    Text(String(localized: "接收方：\(session.provider.title) 网页。点击放入后，请确认附件再发送。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                TextField(String(localized: "补充问题，例如：解释这段内容"), text: $capture.prompt, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(1...3)
                    .accessibilityIdentifier("chatgpt.prompt")
                if !capture.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(String(localized: "2 · 复制问题"), systemImage: "text.bubble") { capture.copyPrompt() }
                        .accessibilityIdentifier("chatgpt.copyPrompt")
                }
                if !pasteStatus.isEmpty { Text(pasteStatus).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("aiWeb.pasteStatus") }
                if pasteStatus.isEmpty && !capture.status.isEmpty { Text(capture.status).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                if !canCapture { Text(String(localized: "请先完成或取消当前放置、批注或读取操作，再框选截图。")) .font(.caption).foregroundStyle(.secondary) }
                HStack(alignment: .top) {
                    Text(String(localized: "先在网页输入框长按粘贴图片，确认附件出现；再复制并粘贴问题，最后由你发送。复制成功不表示网页已接收。")) .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Link(String(localized: "系统浏览器"), destination: session.provider.startURL).font(.caption)
                        .environment(\.openURL, OpenURLAction { .systemAction($0) })
                }
            }.padding(12)
        }
        .background(.background)
        .onAppear { session.selectProvider(selectedProvider) }
        .onChange(of: providerRaw) { _, _ in cancelPaste(); session.selectProvider(selectedProvider) }
        .onChange(of: capture.image) { _, _ in cancelPaste() }
        .onDisappear { cancelPaste() }
        .sheet(isPresented: $showsDownloads) { WebDownloadsView(store: session.downloads) }
        .sheet(isPresented: $showsImagePreview) {
            NavigationStack {
                Group {
                    if let image = capture.image {
                        Image(uiImage: image).resizable().scaledToFit().padding()
                    }
                }
                .navigationTitle(String(localized: "选区预览"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "完成")) { showsImagePreview = false }
                    }
                }
            }
        }
    }
}

import SwiftUI
import UIKit

struct PDFTranslationOverlay: View {
    let session: PDFTranslationSession
    @State private var start: CGPoint?
    @State private var end: CGPoint?
    @State private var dragOrigin: CGPoint?
    @State private var resizeOrigin: CGSize?
    private var rect: CGRect? {
        guard let start, let end else { return nil }
        return CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(start.x-end.x), height: abs(start.y-end.y))
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                if session.capture.isSelecting {
                    Color.black.opacity(0.03).contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 2).onChanged { value in
                            guard session.capture.continueSelection() else { start = nil; end = nil; return }
                            if start == nil { start = value.startLocation }
                            end = value.location
                        }.onEnded { value in
                            end = value.location
                            if let rect { session.selected(rect, availableSize: geometry.size) }
                            else { session.capture.cancel() }
                            start = nil; end = nil
                        }).accessibilityIdentifier("translation.selection")
                    if let rect {
                        Rectangle().fill(.teal.opacity(0.1)).overlay(Rectangle().stroke(.teal, style: StrokeStyle(lineWidth: 2, dash: [6,4])))
                            .frame(width: rect.width, height: rect.height).position(x: rect.midX, y: rect.midY).allowsHitTesting(false)
                    }
                    HStack {
                        Text(String(localized: "圈选内容会发送至 \(session.provider.title)，松手开始翻译。"))
                        Button(String(localized: "取消")) { session.capture.cancel() }.accessibilityIdentifier("translation.cancelSelection")
                    }.font(.callout).padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)).padding(12)
                }
                if session.cardID != nil {
                    card(in: geometry.size)
                        .frame(width: session.cardSize.width, height: session.cardSize.height)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.secondary.opacity(0.3)))
                        .shadow(radius: 8).offset(x: session.cardOrigin.x, y: session.cardOrigin.y)

                } else if !session.capture.isSelecting, !session.capture.status.isEmpty {
                    HStack {
                        Text(String(localized: "请等待 PDF 页面清晰显示，再在同一页内框选文字。"))
                        Button(String(localized: "关闭")) { session.close() }
                    }.font(.callout).padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)).padding(12)
                }
            }
            .onChange(of: geometry.size) { _, size in session.clamp(to: size) }
        }
        .allowsHitTesting(session.capture.isSelecting || session.cardID != nil || !session.capture.status.isEmpty)
        .sheet(isPresented: Binding(get: { session.showsSettings }, set: { session.showsSettings = $0 })) { PDFTranslationSettingsView(onChanged: session.settingsChanged) }
    }
    private func card(in bounds: CGSize) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(String(localized: "临时翻译")).font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle()).gesture(DragGesture().onChanged { value in
                        guard !session.isPinned else { return }
                        if dragOrigin == nil { dragOrigin = session.cardOrigin }
                        session.cardOrigin = CGPoint(x: dragOrigin!.x + value.translation.width, y: dragOrigin!.y + value.translation.height)
                        session.clamp(to: bounds)
                    }.onEnded { _ in dragOrigin = nil })
                    .accessibilityIdentifier("translation.drag")
                Button { session.isPinned.toggle() } label: { Image(systemName: session.isPinned ? "pin.fill" : "pin") }
                    .accessibilityLabel(session.isPinned ? String(localized: "解除固定位置") : String(localized: "固定位置"))
                    .accessibilityIdentifier("translation.pin")
                Button { session.showsSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel(String(localized: "翻译设置")).accessibilityIdentifier("translation.settings")
                Button { session.close() } label: { Image(systemName: "xmark") }
                    .accessibilityLabel(String(localized: "关闭翻译")).accessibilityIdentifier("translation.close")
            }.buttonStyle(.borderless).padding(12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !session.requestDescription.isEmpty { Text(verbatim: session.requestDescription).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("translation.providerLabel") }
                    if session.isLoading {
                        ProgressView(String(localized: "正在翻译选区…"))
                        Button(String(localized: "取消请求")) { session.cancelRequest() }.accessibilityIdentifier("translation.cancelRequest")
                    }
                    if !session.error.isEmpty { Text(session.error).foregroundStyle(.orange).accessibilityIdentifier("translation.error") }
                    if !session.text.isEmpty { Text(verbatim: session.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("translation.result") }
                    if !session.isLoading && (session.text.isEmpty || !session.error.isEmpty) {
                        HStack {
                            Button(String(localized: "重试翻译")) { session.translate() }.accessibilityIdentifier("translation.retry")
                            Button(String(localized: "翻译设置")) { session.showsSettings = true }
                        }
                    }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Text(String(localized: "仅临时显示，不写入原文或白板。"))
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "arrow.down.right.and.arrow.up.left").frame(width: 36, height: 32).contentShape(Rectangle())
                    .gesture(DragGesture().onChanged { value in
                        guard !session.isPinned else { return }
                        if resizeOrigin == nil { resizeOrigin = session.cardSize }
                        session.cardSize = CGSize(width: resizeOrigin!.width + value.translation.width, height: resizeOrigin!.height + value.translation.height)
                        session.clamp(to: bounds)
                    }.onEnded { _ in resizeOrigin = nil })
                    .accessibilityLabel(String(localized: "调整翻译卡大小")).accessibilityIdentifier("translation.resize")
            }.padding(.leading, 12)
        }
    }
}

struct PDFTranslationSettingsView: View {
    let onChanged: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var provider = PDFTranslationProvider.selected(in: .standard)
    @State private var keys: [PDFTranslationProvider: String] = [:]
    @State private var models: [PDFTranslationProvider: String] = [:]
    @State private var language = UserDefaults.standard.string(forKey: "PDFTranslation.language") ?? "简体中文"
    @State private var error = ""
    @State private var loadedKeys: Set<PDFTranslationProvider> = []
    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "翻译服务")) {
                    Picker(String(localized: "服务"), selection: $provider) {
                        ForEach(PDFTranslationProvider.allCases) { Text(verbatim: $0.title).tag($0) }
                    }.accessibilityIdentifier("translation.provider")
                    SecureField("API Key", text: Binding(get: { keys[provider] ?? "" }, set: { keys[provider] = $0 }))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("translation.apiKey")
                    TextField(String(localized: "模型名称"), text: Binding(get: { models[provider] ?? provider.defaultModel }, set: { models[provider] = $0 }))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("translation.model")
                    Text(String(localized: "模型需要支持图像输入；每家服务独立保存 Key 和模型，不会自动切换服务。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Button(String(localized: "清空当前服务 Key"), role: .destructive) {
                        do { try PDFTranslationKeyStore.save("", for: provider); keys[provider] = ""; onChanged() }
                        catch { self.error = error.localizedDescription }
                    }.disabled(!loadedKeys.contains(provider)).accessibilityIdentifier("translation.clearKey")
                    Picker(String(localized: "目标语言"), selection: $language) {
                        Text("简体中文").tag("简体中文"); Text("English").tag("English")
                    }
                }
                Section(String(localized: "官方接口")) {
                    Text(verbatim: provider.endpoint).font(.caption).textSelection(.enabled)
                    Button(String(localized: "复制接口地址")) {
                        UIPasteboard.general.setItems([["public.utf8-plain-text": provider.endpoint]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
                    }
                }
                Section {
                    Text(String(localized: "只发送圈选图像；API 按账户计费。Key 仅保存在本设备钥匙串，不同步到 iCloud。翻译可能有误，请核对论文原文。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(String(localized: "保存应用当前服务的设置；取消不保存改动。清空 Key 按钮会立即删除当前服务的密钥。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    if !error.isEmpty { Text(error).foregroundStyle(.orange) }
                }
            }.navigationTitle(String(localized: "翻译设置")).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button(String(localized: "保存")) {
                        do {
                            let model = try PDFTranslationInput.model(models[provider] ?? provider.defaultModel)
                            let key = try PDFTranslationInput.key(keys[provider] ?? "", allowEmpty: true)
                            try PDFTranslationKeyStore.save(key, for: provider)
                            UserDefaults.standard.set(provider.rawValue, forKey: "PDFTranslation.provider")
                            UserDefaults.standard.set(model, forKey: provider.modelKey)
                            UserDefaults.standard.set(language, forKey: "PDFTranslation.language")
                            onChanged(); keys = [:]; dismiss()
                        } catch { self.error = error.localizedDescription }
                    }.disabled(!loadedKeys.contains(provider)).accessibilityIdentifier("translation.saveSettings") }
                }.task {
                    for service in PDFTranslationProvider.allCases {
                        models[service] = service.model(in: .standard)
                        do { keys[service] = try PDFTranslationKeyStore.read(service); loadedKeys.insert(service) }
                        catch { self.error = error.localizedDescription }
                    }
                }
                .onChange(of: provider) { _, _ in onChanged() }
                .onDisappear { keys = [:] }
        }
    }
}

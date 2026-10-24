import SwiftUI

struct BoardReadAloudControls: View {
    let store: BoardStore
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var showsVocabulary = false
    private var active: Bool { store.readAloud.isPreparing || store.readAloud.isSpeaking || store.readAloud.isPaused }
    private var compact: Bool { verticalSizeClass == .compact }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                if store.readAloud.isPreparing {
                    ProgressView(String(localized: "正在准备朗读…")).font(.callout)
                } else if store.readAloud.isPaused {
                    Button(String(localized: "继续朗读"), systemImage: "play.fill") { store.readAloud.resume() }
                        .accessibilityIdentifier("readAloud.resume")
                } else if store.readAloud.isSpeaking {
                    Button(String(localized: "暂停朗读"), systemImage: "pause.fill") { store.readAloud.pause() }
                        .accessibilityIdentifier("readAloud.pause")
                } else {
                    Button(String(localized: "朗读当前画面"), systemImage: "speaker.wave.2") { store.beginBoardReadAloud() }
                        .disabled(store.isBusy || store.boardURL == nil).accessibilityIdentifier("readAloud.start")
                }
                if active {
                    Button(String(localized: "停止"), systemImage: "stop.fill") { store.readAloud.stop() }
                        .accessibilityIdentifier("readAloud.stop")
                }
                Spacer(minLength: 0)
                if compact { progressText }
                Menu {
                    Picker(String(localized: "朗读语言"), selection: Binding(get: { store.readAloud.languageMode }, set: { store.readAloud.languageMode = $0 })) {
                        ForEach(BoardReadAloudLanguage.allCases) { Text($0.title).tag($0) }
                    }
                    Picker(String(localized: "朗读速度"), selection: Binding(get: { store.readAloud.rate }, set: { store.readAloud.rate = $0 })) {
                        Text(String(localized: "慢速")).tag(Float(0.2))
                        Text(String(localized: "稍慢")).tag(Float(0.35))
                        Text(String(localized: "标准")).tag(Float(0.5))
                        Text(String(localized: "稍快")).tag(Float(0.6))
                        Text(String(localized: "快速")).tag(Float(0.7))
                    }
                    Button(String(localized: "识别常用词"), systemImage: "text.badge.plus") { showsVocabulary = true }
                    if !store.readAloud.status.isEmpty { Text(store.readAloud.status) }
                    Text(String(localized: "朗读当前可见区域；识别文字可能有误，请核对原文。"))
                } label: { Image(systemName: "slider.horizontal.3").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(String(localized: "朗读设置")).accessibilityIdentifier("readAloud.options")
            }.font(.callout).buttonStyle(.borderless).frame(minHeight: 44)
            if !compact { progressText }
        }
        .padding(.horizontal, 12).padding(.vertical, 4).background(.regularMaterial)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("readAloud.progress")
        .accessibilityValue(store.readAloud.progressAccessibilityValue)
        .sheet(isPresented: $showsVocabulary) { RecognitionVocabularySheet(controller: store.readAloud) }
    }
    @ViewBuilder private var progressText: some View {
            if active, !store.readAloud.currentText.isEmpty {
                Text(store.readAloud.currentText).font(.caption).lineLimit(2)
                    .padding(.horizontal, 6).padding(.vertical, 3).background(.yellow.opacity(0.28), in: RoundedRectangle(cornerRadius: 4))
                    .accessibilityIdentifier("readAloud.currentText")
            }
            if (!compact || !active || store.readAloud.currentText.isEmpty), !store.readAloud.status.isEmpty {
                Text(store.readAloud.status).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    .accessibilityIdentifier("readAloud.status")
            }
    }
}

struct RecognitionVocabularySheet: View {
    let controller: BoardReadAloudController
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    private var terms: [String] { text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var valid: Bool { terms.count <= 200 && terms.allSatisfy { $0.utf16.count <= 64 } }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(String(localized: "每行填写一个已核对的姓名、术语或常用词，帮助下次朗读识别当前画面。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    TextEditor(text: $text).frame(minHeight: 240).autocorrectionDisabled()
                        .accessibilityIdentifier("recognition.vocabulary.text")
                    Text(String(localized: "最多 200 个词，每词最多 64 个字符；仅保存在本设备。"))
                        .font(.caption).foregroundStyle(valid ? Color.secondary : Color.red)
                    Text(String(localized: "常用词帮助文字识别匹配，不会训练手写模型，也不会修改原笔迹。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(String(localized: "识别常用词")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "取消")) { dismiss() }.accessibilityIdentifier("recognition.vocabulary.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "保存")) { controller.saveRecognitionVocabulary(text); dismiss() }
                        .disabled(!valid).accessibilityIdentifier("recognition.vocabulary.save")
                }
            }
            .onAppear { text = controller.recognitionVocabularyText }
        }
    }
}

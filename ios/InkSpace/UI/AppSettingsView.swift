import SwiftUI
import UIKit

/// The home and reader share the same device preferences as the video player,
/// replay viewer and translation reader. No duplicate preference store is used.
struct AppSettingsView: View {
    private enum Destination: String, Identifiable {
        case translation, subtitles, diagnostics
        var id: String { rawValue }
    }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var destination: Destination?
    @State private var settingsError: String?
    @AppStorage(AIWebProvider.preferenceKey) private var aiWebProvider = AIWebProvider.chatgpt.rawValue
    @AppStorage("videoSeekInterval") private var seekInterval = 5
    @AppStorage("videoPlaybackRate") private var playbackRate = 1.0
    @AppStorage(BoardSubtitleAppearance.storageKey) private var subtitleAppearanceData = Data()
    @AppStorage(InkReplayDisplayMode.preferenceKey) private var replayMode = InkReplayDisplayMode.dimmed.rawValue
    @AppStorage("PDFTranslation.provider") private var translationProvider = PDFTranslationProvider.openAI.rawValue

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "界面语言")) {
                    LabeledContent(String(localized: "当前语言"), value: displayLanguage)
                    Button(String(localized: "在系统设置中更改语言"), systemImage: "globe") {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        openURL(url) { accepted in
                            if !accepted { settingsError = String(localized: "未能打开系统设置，请从主屏幕打开“设置”。") }
                        }
                    }.accessibilityIdentifier("settings.language")
                    Text(String(localized: "界面使用此 App 的系统语言设置。"))
                        .font(.footnote).foregroundStyle(PadDesign.secondaryInk)
                    if let settingsError { Text(settingsError).font(.footnote).foregroundStyle(.orange) }
                }
                Section(String(localized: "AI 网页助手")) {
                    Picker(String(localized: "AI 网页服务"), selection: $aiWebProvider) {
                        ForEach(AIWebProvider.allCases) { provider in
                            Text(verbatim: provider.title).tag(provider.rawValue).accessibilityIdentifier("settings.aiWebProvider." + provider.rawValue)
                        }
                    }.accessibilityIdentifier("settings.aiWebProvider")
                    Text(String(localized: "在网页内自行登录；下次仍打开当前 AI。"))
                        .font(.footnote).foregroundStyle(PadDesign.secondaryInk)
                    Text(String(localized: "无需 API 密钥。此选择只影响网页助手，API 高级页单独设置。"))
                        .font(.caption).foregroundStyle(PadDesign.secondaryInk)
                }
                Section(String(localized: "视频播放")) {
                    Picker(String(localized: "快进步长"), selection: $seekInterval) {
                        ForEach([1, 3, 5, 15, 30], id: \.self) { value in
                            Text(String(localized: "\(value) 秒")).tag(value)
                                .accessibilityIdentifier("settings.seek.\(value)")
                        }
                    }.accessibilityIdentifier("settings.seekInterval")
                    Picker(String(localized: "播放速度"), selection: $playbackRate) {
                        ForEach([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], id: \.self) { rate in
                            Text(String(format: "%g×", rate)).tag(rate)
                        }
                    }.accessibilityIdentifier("settings.playbackRate")
                    Button(String(localized: "字幕外观"), systemImage: "captions.bubble") {
                        destination = .subtitles
                    }.accessibilityIdentifier("settings.subtitles")
                }
                Section(String(localized: "翻译服务")) {
                    Button {
                        destination = .translation
                    } label: {
                        HStack {
                            Label(String(localized: "翻译设置"), systemImage: "character.bubble")
                            Spacer(minLength: 8)
                            Text(verbatim: selectedProvider.title).foregroundStyle(PadDesign.secondaryInk)
                        }
                    }.accessibilityIdentifier("settings.translation")
                }
                Section(String(localized: "阅读与回放")) {
                    Picker(String(localized: "笔迹回放显示"), selection: $replayMode) {
                        ForEach(InkReplayDisplayMode.allCases, id: \.rawValue) { mode in
                            Text(mode.title).tag(mode.rawValue)
                        }
                    }.accessibilityIdentifier("settings.replayMode")
                }
                Section(String(localized: "诊断")) {
                    Button(String(localized: "问题记录"), systemImage: "exclamationmark.bubble") {
                        destination = .diagnostics
                    }.accessibilityIdentifier("settings.diagnostics")
                }
            }
            .scrollContentBackground(.hidden)
            .background(PadDesign.paper)
            .navigationTitle(String(localized: "设置"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(String(localized: "完成")) { dismiss() }
                    .accessibilityIdentifier("settings.done")
            } }
            .sheet(item: $destination) { destination in
                switch destination {
                case .translation:
                    PDFTranslationSettingsView(onChanged: {})
                case .subtitles:
                    BoardSubtitleAppearanceSheet(appearance: Binding(
                        get: { BoardSubtitleAppearance.decode(subtitleAppearanceData) },
                        set: { subtitleAppearanceData = $0.encoded }))
                case .diagnostics:
                    DiagnosticsCenterView(center: .shared)
                }
            }
            .tint(PadDesign.accent)
        }
    }

    private var selectedProvider: PDFTranslationProvider {
        PDFTranslationProvider(rawValue: translationProvider) ?? .openAI
    }
    private var displayLanguage: String {
        let language = Bundle.main.preferredLocalizations.first ?? Locale.current.identifier
        return Locale.current.localizedString(forIdentifier: language) ?? language
    }
}

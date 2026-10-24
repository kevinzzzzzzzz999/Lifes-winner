import SwiftUI

struct PDFReadAloudControls: View {
    let pane: PDFWorkspacePane
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var showsRange = false
    @State private var fromPage = 1
    @State private var toPage = 1
    private var active: Bool { pane.readAloud.isPreparing || pane.readAloud.isSpeaking || pane.readAloud.isPaused }
    private var compact: Bool { verticalSizeClass == .compact }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                if pane.readAloud.isPreparing { ProgressView(String(localized: "正在准备朗读…")).font(.callout) }
                else if pane.readAloud.isPaused {
                    Button(String(localized: "继续朗读"), systemImage: "play.fill") { pane.readAloud.resume() }
                        .accessibilityIdentifier("pdfReadAloud.resume")
                } else if pane.readAloud.isSpeaking {
                    Button(String(localized: "暂停朗读"), systemImage: "pause.fill") { pane.readAloud.pause() }
                        .accessibilityIdentifier("pdfReadAloud.pause")
                } else {
                    Menu {
                        Button(String(localized: "朗读整篇 PDF")) { pane.beginReadAloud(pages: nil) }
                            .accessibilityIdentifier("pdfReadAloud.whole")
                        Button(String(localized: "朗读指定页")) { fromPage = pane.page; toPage = pane.page; showsRange = true }
                            .accessibilityIdentifier("pdfReadAloud.range")
                    } label: { Label(String(localized: "朗读"), systemImage: "speaker.wave.2") }
                        .disabled(pane.document == nil || pane.isLoading || pane.isSaving || pane.hasPendingWrite)
                        .accessibilityIdentifier("pdfReadAloud.start")
                }
                if active {
                    Button(String(localized: "停止"), systemImage: "stop.fill") { pane.readAloud.stop() }
                        .accessibilityIdentifier("pdfReadAloud.stop")
                }
                Spacer(minLength: 0)
                if compact { progressText }
                Menu {
                    Picker(String(localized: "朗读语言"), selection: Binding(get: { pane.readAloud.languageMode }, set: { pane.readAloud.languageMode = $0 })) {
                        ForEach(BoardReadAloudLanguage.allCases) { Text($0.title).tag($0) }
                    }
                    Picker(String(localized: "朗读速度"), selection: Binding(get: { pane.readAloud.rate }, set: { pane.readAloud.rate = $0 })) {
                        Text(String(localized: "慢速")).tag(Float(0.2)); Text(String(localized: "标准")).tag(Float(0.5)); Text(String(localized: "快速")).tag(Float(0.7))
                    }
                    if !pane.readAloud.status.isEmpty { Text(pane.readAloud.status) }
                } label: { Image(systemName: "slider.horizontal.3").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(String(localized: "朗读设置")).accessibilityIdentifier("pdfReadAloud.settings")
            }.font(.callout).buttonStyle(.borderless).frame(minHeight: 44)
            if !compact { progressText }
        }.padding(.horizontal, 12).padding(.vertical, 4).background(.regularMaterial)
        .sheet(isPresented: $showsRange) {
            NavigationStack {
                Form {
                    Stepper(String(localized: "从第 \(fromPage) 页"), value: $fromPage, in: 1...max(1, pane.pageCount)).accessibilityIdentifier("pdfReadAloud.from")
                    Stepper(String(localized: "到第 \(toPage) 页"), value: $toPage, in: 1...max(1, pane.pageCount)).accessibilityIdentifier("pdfReadAloud.to")
                    Text(String(localized: "优先读取 PDF 文字；扫描页会先识别文字。可锁屏继续，通过播放控件暂停或继续。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .navigationTitle(String(localized: "朗读指定页")).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { showsRange = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "开始朗读")) { pane.beginReadAloud(pages: fromPage...toPage); showsRange = false }
                            .disabled(fromPage > toPage).accessibilityIdentifier("pdfReadAloud.beginRange")
                    }
                }
            }
        }
    }
    @ViewBuilder private var progressText: some View {
        if active, !pane.readAloud.currentText.isEmpty {
            Text(pane.readAloud.currentText).font(.caption).lineLimit(2)
                .padding(.horizontal, 6).padding(.vertical, 3).background(.yellow.opacity(0.28), in: RoundedRectangle(cornerRadius: 4))
                .accessibilityIdentifier("pdfReadAloud.currentText")
        }
        if (!compact || !active || pane.readAloud.currentText.isEmpty), !pane.readAloud.status.isEmpty {
            Text(pane.readAloud.status).font(.caption).foregroundStyle(.secondary).lineLimit(2).accessibilityIdentifier("pdfReadAloud.status")
        }
    }
}

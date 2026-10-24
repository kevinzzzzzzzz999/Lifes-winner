import SwiftUI

struct StudyCardEditor: View {
    @Bindable var session: StudySession
    let items: [BoardItem]
    let rootURL: URL?
    @State private var discard = false
    private func field(_ key: WritableKeyPath<StudyDraft, String>) -> Binding<String> {
        Binding(get: { session.draft?[keyPath: key] ?? "" }, set: { session.draft?[keyPath: key] = $0 })
    }
    private func blocks(_ key: WritableKeyPath<StudyDraft, [StudyContentBlock]>) -> Binding<[StudyContentBlock]> {
        Binding(get: { session.draft?[keyPath: key] ?? [] }, set: { session.draft?[keyPath: key] = $0 })
    }
    private var hasNodeAnswer: Bool { StudyNodes.hasAnswer(items.first { $0.id == session.draft?.itemID }) }
    private var imageAnswer: Bool { StudyNodes.isImage(items.first { $0.id == session.draft?.itemID }) }
    var body: some View {
        Form {
            Section(String(localized: "卡片类型")) {
                Picker(String(localized: "卡片类型"), selection: field(\.mode)) {
                    Text(String(localized: "问答")).tag("qa")
                    Text(String(localized: "挖空")).tag("cloze")
                    Text(String(localized: "图片遮盖")).tag("occlusion")
                }.pickerStyle(.segmented).accessibilityIdentifier("study.editor.mode")
            }
            Section(String(localized: "问题")) {
                TextEditor(text: field(\.question)).frame(minHeight: 130).accessibilityIdentifier("study.editor.question")
                if session.draft?.mode == "cloze" {
                    Text(String(localized: "用 {{双花括号}} 标出要回忆的内容，可设置多个挖空。")) .font(.caption)
                } else { Text(String(localized: "不要把答案写进问题；默认使用中性提示。")) .font(.caption) }
            }
            if session.draft?.mode == "qa" {
                Section(String(localized: "答案来源")) {
                    Picker(String(localized: "答案来源"), selection: field(\.answerMode)) {
                        if hasNodeAnswer || session.draft?.answerMode == "node" { Text(imageAnswer ? String(localized: "当前节点图片") : String(localized: "当前节点正文")).tag("node") }
                        Text(String(localized: "自定义答案")).tag("custom")
                    }.accessibilityIdentifier("study.editor.answerMode")
                    if session.draft?.answerMode == "node" {
                        Text(imageAnswer ? String(localized: "揭晓后读取节点图片；图片未下载或损坏时暂停评分。") : String(localized: "揭晓时读取节点的最新正文；不会修改原文。")) .font(.caption)
                        if !hasNodeAnswer { Text(String(localized: "节点当前没有正文，请在 iPad 上设置自定义答案。")) .foregroundStyle(.orange) }
                    }
                }
            }
            if session.draft?.mode != "cloze" {
                Section(String(localized: "问题图文")) {
                    StudyContentBlockEditor(rootURL: rootURL, items: items, allowsRegions: session.draft?.mode == "occlusion", blocks: blocks(\.questionBlocks))
                }
                Section(String(localized: "答案图文")) {
                    StudyContentBlockEditor(rootURL: rootURL, items: items, allowsRegions: false, blocks: blocks(\.answerBlocks))
                }
            }
            if session.draft?.mode == "cloze" || session.draft?.answerMode == "custom" || session.draft?.mode == "occlusion" {
                Section(session.draft?.mode == "cloze" ? String(localized: "补充解释（可选）") : String(localized: "答案")) {
                    TextEditor(text: field(\.answer)).frame(minHeight: 150).accessibilityIdentifier("study.editor.answer")
                }
            }
            Section {
                if let error = session.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("study.error") }
                if session.busy { ProgressView() }
                Button(session.pending == nil ? String(localized: "保存卡片") : String(localized: "重试保存")) { Task { _ = await session.saveDraft() } }
                    .frame(minHeight: 44).disabled(session.writingBlocked).accessibilityIdentifier("study.editor.save")
                Button(String(localized: "取消"), role: .cancel) { if session.dirty || session.pending != nil { discard = true } else { session.discardDraft() } }
                    .frame(minHeight: 44).disabled(session.busy).accessibilityIdentifier("study.editor.cancel")
            }
        }
        .disabled(session.busy)
        .onChange(of: session.draft?.mode) { previous, value in
            if value == "occlusion" {
                if session.draft?.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                    session.draft?.answer = String(localized: "核对已揭晓的图片区域。")
                }
                if session.draft?.questionBlocks.isEmpty == true,
                   let item = items.first(where: { $0.id == session.draft?.itemID }), StudyNodes.isImage(item), let path = item.sourcePath {
                    session.draft?.questionBlocks = [.image(path)]
                }
            } else if value == "cloze", !(session.draft?.questionBlocks.isEmpty ?? true) || !(session.draft?.answerBlocks.isEmpty ?? true) {
                session.draft?.mode = previous ?? "qa"
                session.error = String(localized: "请先移除图文块，再切换到文字挖空。")
            }
        }
        .confirmationDialog(String(localized: "放弃未保存的卡片修改？"), isPresented: $discard, titleVisibility: .visible) {
            Button(String(localized: "放弃修改"), role: .destructive) { session.discardDraft() }
            Button(String(localized: "继续编辑"), role: .cancel) {}
        }
    }
}

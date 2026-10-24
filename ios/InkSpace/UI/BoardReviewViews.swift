import SwiftUI

struct ReviewControls: View {
    @Bindable var store: BoardStore
    let onList: () -> Void
    var onPlace: (() -> Void)? = nil
    @State private var toolSheet: ToolSheet?
    private enum ToolSheet: String, Identifiable { case settings; var id: String { rawValue } }
    private func colorName(_ color: String) -> String {
        switch color {
        case "#facc15": String(localized: "黄色")
        case "#4ade80": String(localized: "绿色")
        case "#f472b6": String(localized: "粉色")
        case "#2563eb": String(localized: "蓝色")
        case "#a16207": String(localized: "琥珀色")
        case "#ef4444": String(localized: "红色")
        default: color.uppercased()
        }
    }
    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 16) {
                        Button {
                            store.reviews.selectStyle(.highlight)
                            store.reviews.captureEnabled = true
                        } label: { Label(String(localized: "荧光笔"), systemImage: "highlighter").frame(minHeight: 44) }
                            .accessibilityIdentifier("review.highlighter")
                            .accessibilityAddTraits(store.reviews.style == .highlight && !store.reviews.eraserEnabled ? .isSelected : [])
                        Button {
                            store.reviews.selectStyle(.comment)
                            if let onPlace { onPlace() } else { store.reviews.captureEnabled = true }
                        } label: {
                            Label(onPlace == nil ? String(localized: "圈画或评论") : String(localized: "选位置加评论"), systemImage: "bubble.and.pencil")
                                .frame(minHeight: 44)
                        }.accessibilityIdentifier("review.capture")
                        Button { store.reviews.selectEraser() } label: {
                            Label(String(localized: "擦除"), systemImage: "eraser").frame(minHeight: 44)
                        }.accessibilityIdentifier("review.eraser")
                            .accessibilityAddTraits(store.reviews.eraserEnabled ? .isSelected : [])
                        Menu {
                            ForEach(store.reviews.colors, id: \.self) { color in
                                Button { store.reviews.color = color } label: {
                                    Label(colorName(color), systemImage: "circle.fill")
                                        .foregroundStyle(Color(uiColor: ReviewOverlayView.uiColor(color)))
                                }.accessibilityIdentifier("review.color." + String(color.dropFirst()))
                            }
                            Divider()
                            Button(String(localized: "编辑色板与粗细")) { toolSheet = .settings }
                        } label: {
                            Image(systemName: "circle.fill").foregroundStyle(Color(uiColor: ReviewOverlayView.uiColor(store.reviews.color)))
                                .frame(minWidth: 44, minHeight: 44)
                        }.accessibilityLabel(String(localized: "批注颜色")).accessibilityIdentifier("review.color")
                        Button { toolSheet = .settings } label: {
                            Label(String(localized: "粗细"), systemImage: "lineweight").frame(minHeight: 44)
                        }.accessibilityIdentifier("review.settings")
                        Button(action: onList) {
                            Label(String(localized: "列表（\(store.reviews.records.count)）"), systemImage: "list.bullet").frame(minHeight: 44)
                        }.accessibilityIdentifier("review.list")
                    }.fixedSize(horizontal: true, vertical: false)
                }
                Button(String(localized: "完成")) { Task { await store.endTemporaryReview() } }
                    .frame(minWidth: 44, minHeight: 44).accessibilityIdentifier("review.done")
            }.font(.callout).buttonStyle(.borderless)
            Text(store.reviews.eraserEnabled ? String(localized: "单指划过要擦除的高亮或批注，整条擦除；双指移动缩放") : store.reviews.style == .highlight
                 ? String(localized: "单指划过重点，松手后自动保存高亮；双指移动缩放")
                 : store.reviews.captureEnabled ? String(localized: "单指圈画或轻点加评论；双指移动缩放")
                 : String(localized: "待修改批注独立保存，原文和正式笔迹保持不变"))
                .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("review.modeHint")
            HStack {
                Text(store.reviews.status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    .accessibilityIdentifier("review.status")
                if store.reviews.hasPendingWrite {
                    Button(String(localized: "重试保存")) { Task { if await store.reviews.flush() { store.reviews.captureEnabled = store.reviews.eraserEnabled } } }
                        .accessibilityIdentifier("review.retry")
                }
                Spacer(minLength: 8)
                Text("\(Int(store.zoom * 100))%").font(.caption.monospacedDigit()).accessibilityIdentifier("review.zoom")
            }
        }.padding(.horizontal, 12).padding(.vertical, 8).background(.regularMaterial).disabled(store.reviews.isWriting)
            .sheet(item: $toolSheet) { _ in ReviewToolSettingsView(reviews: store.reviews) }
    }
}

private struct ReviewToolSettingsView: View {
    @Bindable var reviews: BoardReviewStore
    @Environment(\.dismiss) private var dismiss
    @State private var customColor = Color.orange
    @State private var hex = "#ff9500"
    @State private var colorError = false
    private var chosenStyle: Binding<BoardReviewStyle> { Binding(get: { reviews.style }, set: { reviews.selectStyle($0) }) }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(String(localized: "批注工具"), selection: chosenStyle) {
                        Text(String(localized: "荧光笔")).tag(BoardReviewStyle.highlight)
                        Text(String(localized: "圈画或评论")).tag(BoardReviewStyle.comment)
                    }.pickerStyle(.segmented).accessibilityIdentifier("review.settings.style")
                    HStack {
                        Text(String(localized: "粗细"))
                        Spacer()
                        Text(String(format: "%.1f", reviews.strokeWidth)).monospacedDigit().accessibilityIdentifier("review.widthValue")
                    }
                    Slider(value: $reviews.strokeWidth, in: reviews.style == .highlight ? 6...48 : 1...20, step: 0.5)
                        .accessibilityLabel(String(localized: "批注粗细")).accessibilityIdentifier("review.width")
                    RoundedRectangle(cornerRadius: reviews.strokeWidth / 2)
                        .fill(Color(uiColor: ReviewOverlayView.uiColor(reviews.color)).opacity(reviews.style == .highlight ? 0.32 : 1))
                        .frame(height: reviews.strokeWidth).frame(maxWidth: .infinity, minHeight: 50)
                    Text(String(localized: "两种工具分别记住颜色与粗细；仅影响接下来画的批注。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section(String(localized: "常用颜色")) {
                    ForEach(reviews.colors, id: \.self) { color in
                        HStack {
                            Button { reviews.color = color } label: {
                                HStack {
                                    Circle().fill(Color(uiColor: ReviewOverlayView.uiColor(color))).frame(width: 24, height: 24)
                                    Text(color.uppercased()).foregroundStyle(.primary)
                                    if reviews.color == color { Image(systemName: "checkmark") }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.borderless).accessibilityIdentifier("review.swatch." + String(color.dropFirst()))
                            Button(role: .destructive) { reviews.removeColor(color) } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.borderless).disabled(reviews.colors.count <= 1)
                                .accessibilityLabel(String(localized: "移除颜色") + " " + color)
                                .accessibilityIdentifier("review.removeColor." + String(color.dropFirst()))
                        }
                    }
                }
                Section(String(localized: "添加颜色")) {
                    ColorPicker(String(localized: "自选颜色"), selection: $customColor, supportsOpacity: false)
                        .accessibilityIdentifier("review.customColor")
                        .onChange(of: customColor) { _, value in
                            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                            if UIColor(value).getRed(&r, green: &g, blue: &b, alpha: &a) { hex = String(format: "#%02x%02x%02x", Int((r*255).rounded()), Int((g*255).rounded()), Int((b*255).rounded())) }
                        }
                    TextField(String(localized: "颜色代码，例如 #FF9500"), text: $hex).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.asciiCapable).accessibilityIdentifier("review.colorHex")
                    Button(String(localized: "添加到色板")) { colorError = !reviews.addColor(hex) }
                        .accessibilityIdentifier("review.addColor")
                    if colorError { Text(String(localized: "请输入 # 加六位颜色代码；色板最多保留 24 色。")).font(.caption).foregroundStyle(.red) }
                }
            }.navigationTitle(String(localized: "批注笔设置")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("review.settings.done") } }
        }
    }
}

struct ReviewComposerView: View {
    @Bindable var reviews: BoardReviewStore
    let draft: BoardReview
    @State private var comment = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(String(localized: "高亮与批注仅写入共享资料夹的独立审阅记录，不会修改原文或正式笔迹。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    TextEditor(text: $comment).frame(minHeight: 150).accessibilityIdentifier("review.comment")
                    Text(String(localized: "评论可留空；添加后可在 Mac 查看并删除。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !reviews.status.isEmpty { Text(reviews.status).font(.footnote) }
            }
            .navigationTitle(draft.isHighlight ? String(localized: "保存高亮") : String(localized: "添加待修改批注"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button(String(localized: "取消")) { reviews.discardDraft(); dismiss() }.accessibilityIdentifier("review.cancel") }
                ToolbarItem(placement:.confirmationAction) {
                    Button(String(localized: "添加")) { Task { if await reviews.addDraft(comment: comment) { dismiss() } } }
                        .disabled(comment.utf16.count > 10_000).accessibilityIdentifier("review.add")
                }
            }
            .disabled(reviews.isWriting).interactiveDismissDisabled(reviews.isWriting)
            .onDisappear { if reviews.draft?.id == draft.id { reviews.discardDraft() } }
        }
    }
}
struct ReviewListView: View {
    @Bindable var reviews: BoardReviewStore
    let onJump: (BoardReview) -> Void
    @State private var deletion: BoardReview?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(String(localized: "完成原文修改后，可删除对应批注。这里只显示当前白板的待批注，删除不会清除正式笔迹或撤销原文修改。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(String(localized: "每条批注与删除标记另存本机恢复副本；不包含在普通白板备份恢复中。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(reviews.status).font(.footnote).accessibilityIdentifier("review.listStatus")
                }
                ForEach(reviews.records) { review in
                    VStack(alignment:.leading,spacing:8) {
                        Button { onJump(review); dismiss() } label: {
                            VStack(alignment:.leading,spacing:4) {
                                Text(review.comment.isEmpty ? (review.isHighlight ? String(localized: "荧光笔高亮") : String(localized: "圈画批注")) : review.comment).foregroundStyle(.primary).lineLimit(4)
                                if let page = review.anchor?.page { Text(String(localized: "页码：\(page)")).font(.caption).foregroundStyle(.secondary) }
                                Text(review.createdAt).font(.caption2).foregroundStyle(.secondary)
                            }.frame(maxWidth:.infinity,alignment:.leading)
                        }.buttonStyle(.plain).accessibilityIdentifier("review.jump.\(review.id.uuidString.lowercased())")
                        Button(String(localized: "删除批注"),role:.destructive) { deletion = review }
                            .buttonStyle(.borderless)
                            .accessibilityIdentifier("review.delete.\(review.id.uuidString.lowercased())")
                    }
                }
                if reviews.records.isEmpty { Text(String(localized: "没有高亮或待修改批注")) }
            }
            .navigationTitle(String(localized: "待批注"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button(String(localized:"关闭")) { dismiss() }.accessibilityIdentifier("review.close") }
                ToolbarItem(placement:.primaryAction) { Button(String(localized:"刷新")) { Task { await reviews.reload() } }.accessibilityIdentifier("review.refresh") }
            }
            .disabled(reviews.isWriting)
            .confirmationDialog(String(localized:"删除这条待修改批注？"),isPresented:Binding(get:{deletion != nil},set:{if !$0 {deletion = nil}}),titleVisibility:.visible) {
                Button(String(localized:"删除批注"),role:.destructive) { if let id = deletion?.id { Task { _ = await reviews.delete(id) } };deletion = nil }
                    .accessibilityIdentifier("review.confirmDelete")
                Button(String(localized:"取消"),role:.cancel) {deletion = nil}
            } message: { Text(String(localized:"只写入删除标记，原文件和正式笔迹保持不变。")) }
        }
    }
}

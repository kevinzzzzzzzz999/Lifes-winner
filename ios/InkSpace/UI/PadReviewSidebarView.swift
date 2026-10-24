import SwiftUI

/// A presentation of the shared review sidecar. Closing this column never ends
/// a board session or changes a review, and locating does not dismiss the list.
struct PadReviewSidebarView: View {
    @Bindable var reviews: BoardReviewStore
    let boardTitle: String
    let onJump: (BoardReview) -> Void
    let onAdd: () -> Void
    let onClose: () -> Void
    @State private var deletion: BoardReview?
    @State private var deletionSession: UUID?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(String(localized: "待批注")).font(.headline).lineLimit(1).minimumScaleFactor(0.75)
                Text("\(reviews.records.count)").font(.subheadline.monospacedDigit())
                    .padding(.horizontal, 8).padding(.vertical, 3).background(PadDesign.accentWash, in: Capsule())
                    .accessibilityIdentifier("review.sidebar.count")
                Spacer(minLength: 0)
                Button(action: onClose) { Image(systemName: "sidebar.right").frame(width: 36, height: 44) }
                    .accessibilityLabel(String(localized: "隐藏待批注列表")).accessibilityIdentifier("review.sidebar.hide")
            }.padding(.horizontal, 12)
            Text(boardTitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.bottom, 8)
            HStack(spacing: 8) {
                Button {
                    reviews.overlaysVisible.toggle()
                    if !reviews.overlaysVisible { reviews.captureEnabled = false }
                } label: {
                    Label(reviews.overlaysVisible ? String(localized: "隐藏浮层") : String(localized: "显示浮层"),
                          systemImage: reviews.overlaysVisible ? "eye.slash" : "eye")
                }.lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("review.sidebar.overlays")
                    .accessibilityValue(reviews.overlaysVisible ? String(localized: "已显示") : String(localized: "已隐藏"))
                Spacer(minLength: 0)
                Button { Task { await reviews.reload() } } label: { Image(systemName: "arrow.clockwise").frame(width: 36, height: 36) }
                    .disabled(reviews.isWriting || reviews.isLoading)
                    .accessibilityLabel(String(localized: "刷新")).accessibilityIdentifier("review.refresh")
            }.font(.callout).padding(.horizontal, 14)
            Button(action: onAdd) { Label(String(localized: "添加待批注"), systemImage: "bubble.and.pencil").frame(maxWidth: .infinity, minHeight: 32) }
                .buttonStyle(.bordered).disabled(reviews.isWriting || reviews.draft != nil || reviews.hasPendingWrite)
                .padding(.horizontal, 14).padding(.bottom, 10).accessibilityIdentifier("review.open")
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if reviews.isLoading { ProgressView().frame(maxWidth: .infinity).accessibilityLabel(String(localized: "刷新")) }
                    if reviews.records.isEmpty && !reviews.isLoading {
                        Text(String(localized: "没有高亮或待修改批注")).font(.callout).foregroundStyle(.secondary)
                            .padding(.vertical, 24).frame(maxWidth: .infinity)
                    }
                    ForEach(reviews.records) { review in
                        PadReviewCard(review: review, selected: reviews.selectedID == review.id,
                            onJump: { onJump(review) }, onDelete: { deletion = review; deletionSession = reviews.contextSession })
                    }
                    if !reviews.status.isEmpty {
                        Text(reviews.status).font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("review.listStatus")
                    }
                    if reviews.hasPendingWrite {
                        Button(String(localized: "重试保存")) { Task { _ = await reviews.flush() } }
                            .accessibilityIdentifier("review.sidebar.retry")
                    }
                    Text(String(localized: "完成原文修改后，可删除对应批注。这里只显示当前白板的待批注，删除不会清除正式笔迹或撤销原文修改。"))
                        .font(.caption2).foregroundStyle(.secondary)
                }.padding(14).disabled(reviews.isWriting)
            }.accessibilityIdentifier("review.sidebar.cards")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PadDesign.surface).tint(PadDesign.accent)
        .accessibilityElement(children: .contain).accessibilityIdentifier("review.sidebar")
        .onChange(of: reviews.contextSession) { _, _ in deletion = nil; deletionSession = nil }
        .confirmationDialog(String(localized: "删除这条待修改批注？"), isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }), titleVisibility: .visible) {
            Button(String(localized: "删除批注"), role: .destructive) {
                if let value = deletion, deletionSession == reviews.contextSession,
                   reviews.records.contains(where: { $0.id == value.id }) {
                    Task { _ = await reviews.delete(value.id) }
                }
                deletion = nil; deletionSession = nil
            }.accessibilityIdentifier("review.sidebar.confirmDelete")
            Button(String(localized: "取消"), role: .cancel) { deletion = nil; deletionSession = nil }
        }
    }
}

private struct PadReviewCard: View {
    let review: BoardReview
    let selected: Bool
    let onJump: () -> Void
    let onDelete: () -> Void

    private static func date(_ value: String) -> Date? {
        (try? Date(value, strategy: .iso8601)) ?? (try? Date(value, strategy: .iso8601.time(includingFractionalSeconds: true)))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle().fill(Color(uiColor: ReviewOverlayView.uiColor(review.color))).frame(width: 10, height: 10)
                Text(review.isHighlight ? String(localized: "荧光笔高亮") : String(localized: "圈画批注")).font(.caption.weight(.medium))
                Spacer(minLength: 0)
                if selected { Image(systemName: "scope").foregroundStyle(PadDesign.accent).accessibilityHidden(true) }
            }
            if !review.comment.isEmpty { Text(review.comment).font(.callout).textSelection(.enabled) }
            if let page = review.anchor?.page { Text(String(localized: "页码：\(page)")).font(.caption).foregroundStyle(.secondary) }
            if let created = Self.date(review.createdAt) {
                Text(created, format: .dateTime.year().month(.abbreviated).day().hour().minute()).font(.caption2).foregroundStyle(.secondary)
            } else { Text(review.createdAt).font(.caption2).foregroundStyle(.secondary) }
            HStack {
                Button(action: onJump) { Label(String(localized: "定位"), systemImage: "scope") }
                    .accessibilityIdentifier("review.jump.\(review.id.uuidString.lowercased())")
                Spacer(minLength: 0)
                Button(role: .destructive, action: onDelete) { Image(systemName: "trash").frame(width: 36, height: 32) }
                    .accessibilityLabel(String(localized: "删除批注"))
                    .accessibilityIdentifier("review.delete.\(review.id.uuidString.lowercased())")
            }.buttonStyle(.borderless).font(.callout)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? PadDesign.accentWash : PadDesign.paper, in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? PadDesign.accent : PadDesign.hairline, lineWidth: selected ? 1.5 : 0.6).allowsHitTesting(false) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("review.card.\(review.id.uuidString.lowercased())")
    }
}

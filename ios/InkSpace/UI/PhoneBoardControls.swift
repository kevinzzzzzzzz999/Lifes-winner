import SwiftUI

/// Phone controls only navigate the existing board and create independent review records.
struct PhoneBoardControls: View {
    @Bindable var store: BoardStore
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private var compact: Bool { verticalSizeClass == .compact }
    let onStatus: () -> Void
    let onReview: () -> Void
    let onHighlight: () -> Void
    let onReviewList: () -> Void
    let onScan: () -> Void
    var onCancelPlacement: () -> Void = {}

    var body: some View {
        VStack(spacing: 6) {
            if compact { compactControls } else {
            HStack(spacing: 8) {
                Button(action: onHighlight) {
                    Label(String(localized: "荧光笔"), systemImage: "highlighter")
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }.disabled(store.boardURL == nil).accessibilityIdentifier("phone.highlighter")
                Menu {
                    Button(String(localized: "添加白板批注"), systemImage: "bubble.and.pencil", action: onReview)
                        .accessibilityIdentifier("review.open")
                    Button(String(localized: "查看与删除批注"), systemImage: "list.bullet", action: onReviewList)
                        .accessibilityIdentifier("phone.reviews")
                } label: {
                    Label(String(localized: "批注"), systemImage: "bubble.and.pencil")
                        .frame(minWidth: 66, minHeight: 44).contentShape(Rectangle())
                }.accessibilityIdentifier("phone.reviewMenu")
                Button(action: onScan) {
                    Label(String(localized: "扫描"), systemImage: "doc.viewfinder")
                        .frame(minWidth: 66, minHeight: 44).contentShape(Rectangle())
                }.accessibilityIdentifier("phone.scan")
            }.font(.callout).buttonStyle(.bordered).disabled(store.externalInteractionActive)
            if store.mode == .place {
                HStack {
                    Text(String(localized: "轻点白板，选定独立批注的位置。"))
                        .font(.callout).accessibilityIdentifier("phone.placementHint")
                    Spacer(minLength: 0)
                    Button(String(localized: "取消选位置"), action: onCancelPlacement)
                        .frame(minHeight: 44).accessibilityIdentifier("phone.cancelPlacement")
                }
            } else {
                HStack(spacing: 12) {
                    Label(String(localized: "只读白板"), systemImage: "lock.shield")
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("phone.readOnlyState")
                    Spacer(minLength: 0)
                    Button { store.jumpToLastInk() } label: {
                        Label(String(localized: "最后一笔"), systemImage: "pencil.tip.crop.circle.badge.arrow.forward")
                            .font(.caption).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }.accessibilityIdentifier("board.lastInk")
                    Button { store.command = CanvasCommand(action: .fitAll) } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44)
                    }.accessibilityLabel(String(localized: "总览")).accessibilityIdentifier("phone.fit")
                    Text("\(Int(store.zoom * 100))%").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }.buttonStyle(.borderless)
            }
            if !store.status.isEmpty || !store.pdfSyncStatus.isEmpty {
                HStack(spacing: 7) {
                    Text(store.status).lineLimit(2).font(.caption2).foregroundStyle(.secondary)
                        .accessibilityIdentifier("phone.saveStatus")
                    Spacer(minLength: 0)
                    if !store.pdfSyncStatus.isEmpty {
                        Button(action: onStatus) { Image(systemName: "info.circle").frame(width: 44, height: 44) }
                            .accessibilityLabel(String(localized: "查看原因"))
                    }
                }
            }
            if !store.externalRefreshStatus.isEmpty {
                Text(store.externalRefreshStatus).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    .accessibilityIdentifier("phone.externalRefreshStatus")
            }
            Text(String(localized: "高亮与批注独立保存，可查看或删除；资料与高亮已移至首页。"))
                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                .accessibilityIdentifier("phone.modeHint")
            }
        }
        .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
        .background(.regularMaterial).disabled(store.isBusy)
    }
    private var compactControls: some View {
        VStack(spacing: 2) {
            HStack(spacing: 8) {
                Button(action: onHighlight) { Label(String(localized: "荧光笔"), systemImage: "highlighter").frame(minHeight: 44) }
                    .disabled(store.boardURL == nil).accessibilityIdentifier("phone.highlighter")
                Menu {
                    Button(String(localized: "添加白板批注"), systemImage: "bubble.and.pencil", action: onReview)
                        .accessibilityIdentifier("review.open")
                    Button(String(localized: "查看与删除批注"), systemImage: "list.bullet", action: onReviewList)
                        .accessibilityIdentifier("phone.reviews")
                } label: { Label(String(localized: "批注"), systemImage: "bubble.and.pencil").frame(minHeight: 44) }
                    .accessibilityIdentifier("phone.reviewMenu")
                Button(action: onScan) { Label(String(localized: "扫描"), systemImage: "doc.viewfinder").frame(minHeight: 44) }
                    .accessibilityIdentifier("phone.scan")
                Spacer(minLength: 4)
                Button { store.jumpToLastInk() } label: {
                    Label(String(localized: "最后一笔"), systemImage: "pencil.tip.crop.circle.badge.arrow.forward").frame(minHeight: 44)
                }.accessibilityIdentifier("board.lastInk")
                Button { store.command = CanvasCommand(action: .fitAll) } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44)
                }.accessibilityLabel(String(localized: "总览")).accessibilityIdentifier("phone.fit")
                Menu {
                    Label(String(localized: "只读白板"), systemImage: "lock.shield").accessibilityIdentifier("phone.readOnlyState")
                    Text("\(Int(store.zoom * 100))%")
                    if !store.status.isEmpty { Text(store.status).accessibilityIdentifier("phone.saveStatus") }
                    if !store.externalRefreshStatus.isEmpty { Text(store.externalRefreshStatus).accessibilityIdentifier("phone.externalRefreshStatus") }
                    if !store.pdfSyncStatus.isEmpty { Button(String(localized: "查看原因"), action: onStatus) }
                    Text(String(localized: "高亮与批注独立保存，可查看或删除；资料与高亮已移至首页。"))
                        .accessibilityIdentifier("phone.modeHint")
                } label: { Image(systemName: "info.circle").frame(width: 44, height: 44) }
                    .accessibilityLabel(String(localized: "只读白板")).accessibilityIdentifier("phone.details")
            }.font(.callout).buttonStyle(.borderless).disabled(store.externalInteractionActive)
            if store.mode == .place {
                HStack {
                    Text(String(localized: "轻点白板，选定独立批注的位置。")).font(.caption).accessibilityIdentifier("phone.placementHint")
                    Spacer(minLength: 0)
                    Button(String(localized: "取消选位置"), action: onCancelPlacement).frame(minHeight: 44)
                        .accessibilityIdentifier("phone.cancelPlacement")
                }
            }
        }
    }
}

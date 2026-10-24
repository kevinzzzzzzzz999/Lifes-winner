import SwiftUI

/// Home-level recent navigation, independent of the whiteboard catalogue.
/// The owner routes opens so saving and window ownership use the ordinary paths.
struct RecentBrowseSection: View {
    let store: RecentBrowseStore
    var isEnabled = true
    var limit = 8
    let onOpen: (RecentBrowseEntry) -> Void
    var onOpenInNewWindow: ((RecentBrowseEntry) -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showsAll = false
    @State private var actionError: String?

    private var visibleEntries: [RecentBrowseEntry] {
        showsAll ? store.entries : Array(store.entries.prefix(max(1, limit)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(String(localized: "最近浏览")).font(.headline).foregroundStyle(PadDesign.ink)
                    Text(String(localized: "文件夹、白板和文件，按最近打开排序"))
                        .font(.caption).foregroundStyle(PadDesign.secondaryInk)
                }
                Spacer(minLength: 8)
                if store.entries.count > max(1, limit) {
                    Button(showsAll ? String(localized: "收起") : String(localized: "全部")) { showsAll.toggle() }
                        .font(.subheadline).tint(PadDesign.accent).frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("home.recentBrowse.showAll")
                }
            }
            VStack(spacing: 0) {
                if visibleEntries.isEmpty {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "clock").foregroundStyle(PadDesign.accent).frame(width: 26).accessibilityHidden(true)
                        Text(String(localized: "打开文件夹、白板或文件后，会在这里保留入口。"))
                            .font(.subheadline).foregroundStyle(PadDesign.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading).padding(16)
                    .accessibilityIdentifier("home.recentBrowse.empty")
                } else {
                    ForEach(visibleEntries) { entry in
                        row(entry)
                        if entry.id != visibleEntries.last?.id { Divider().padding(.leading, 54) }
                    }
                }
                if let issue = actionError ?? store.storageIssue {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(issue).font(.caption).foregroundStyle(PadDesign.bronze).fixedSize(horizontal: false, vertical: true)
                        Button(String(localized: "重新读取")) { actionError = nil; store.reload() }
                            .font(.caption).tint(PadDesign.accent).frame(minHeight: 44)
                            .accessibilityIdentifier("home.recentBrowse.reload")
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .accessibilityIdentifier("home.recentBrowse.warning")
                }
            }.padSurface(radius: 14)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.recentBrowse")
    }

    private func readableLocation(_ entry: RecentBrowseEntry) -> String {
        let parts = entry.rootDisplayPath.split(separator: "/").map(String.init)
        let root: [String]
        if let cloud = parts.lastIndex(where: { $0.contains("CloudDocs") }) {
            root = [String(localized: "iCloud 云盘")] + parts.dropFirst(cloud + 1)
        } else if parts.contains("Containers"), let documents = parts.lastIndex(of: "Documents") {
            root = [String(localized: "我的 iPad"), String(localized: "人生赢家")] + parts.dropFirst(documents + 1)
        } else { root = [entry.rootDisplayName] }
        return (root + entry.relativePath.split(separator: "/").map(String.init)).joined(separator: " / ")
    }

    private func row(_ entry: RecentBrowseEntry) -> some View {
        Button { onOpen(entry) } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: entry.kind.systemImage).font(.system(size: 20))
                    .foregroundStyle(PadDesign.accent).frame(width: 26, height: 26).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(entry.title).font(.subheadline.weight(.semibold)).foregroundStyle(PadDesign.ink)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    Text(readableLocation(entry)).font(.caption).foregroundStyle(PadDesign.secondaryInk)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2).truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(entry.kind.displayName)
                        Text("·").accessibilityHidden(true)
                        Text(entry.lastOpenedAt, style: .relative)
                    }.font(.caption2).foregroundStyle(PadDesign.secondaryInk)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PadDesign.secondaryInk).frame(width: 18, height: 26).accessibilityHidden(true)
            }.padding(16).frame(maxWidth: .infinity, minHeight: 72, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!isEnabled)
        .accessibilityIdentifier("home.recentBrowse.entry." + entry.id.uuidString)
        .contextMenu {
            Button(String(localized: "打开"), systemImage: "arrow.up.forward.app") { onOpen(entry) }
            if let onOpenInNewWindow {
                Button(String(localized: "在新窗口打开"), systemImage: "plus.rectangle.on.rectangle") { onOpenInNewWindow(entry) }
                    .accessibilityIdentifier("home.recentBrowse.newWindow." + entry.id.uuidString)
            }
            Button(String(localized: "从最近浏览移除"), systemImage: "clock.badge.xmark", role: .destructive) {
                do { try store.remove(id: entry.id); actionError = nil }
                catch { actionError = error.localizedDescription }
            }
        }
    }
}

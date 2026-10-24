import SwiftUI
import Combine
import PencilKit

struct InkReplayView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let drawing: PKDrawing
    let items: [BoardItem]
    let webInk: BoardWebInk?
    let boardID: UUID
    let rootURL: URL?
    var pdfOwnerIDs: Set<UUID> = []
    var embedded = false
    var initialViewport: BoardViewport? = nil
    var onClose: (() -> Void)? = nil
    @AppStorage(InkReplayDisplayMode.preferenceKey) private var modeValue = InkReplayDisplayMode.dimmed.rawValue
    @State private var snapshot: InkReplaySnapshot?
    @State private var error = ""
    @State private var progress = 0.0
    @State private var playing = false
    @State private var following = true
    @State private var overviewRequest = 0
    @State private var reloadRequest = 0
    @State private var rate = 1.0
    @State private var lastTick: Date?
    @State private var location = String(localized: "正在定位笔记")
    @State private var backgroundStatus = ""
    private let timer = Timer.publish(every: 0.08, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if embedded {
                replayContent
                    .background(Color(uiColor: .systemBackground))
            } else {
                NavigationStack {
                    replayContent
                        .navigationTitle(String(localized: "笔迹回放"))
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) {
                            Button(String(localized: "完成"), action: close).accessibilityIdentifier("inkReplay.close")
                        } }
                }
            }
        }
        .task { modeValue = InkReplayDisplayMode.preferred.rawValue; following = initialViewport == nil; await prepare() }
        .onReceive(timer, perform: tick)
        .onChange(of: scenePhase) { _, phase in if phase != .active { pause() } }
        .onDisappear(perform: pause)
    }

    private var replayContent: some View {
        VStack(spacing: 4) {
            if embedded {
                HStack {
                    Label(mediaText("回放", "Replay"), systemImage: "clock.arrow.circlepath").font(.callout.weight(.semibold))
                    Spacer()
                    Button(mediaText("退出回放", "Exit replay"), action: close)
                        .frame(minHeight: 44).accessibilityIdentifier("inkReplay.close")
                }.padding(.horizontal)
            }
            if let snapshot {
                // Keep the original documents visible even for an empty ink history.
                InkReplayCanvas(snapshot: snapshot, items: items, boardID: boardID, rootURL: rootURL,
                    pdfOwnerIDs: pdfOwnerIDs, initialViewport: initialViewport,
                    count: snapshot.visibleCount(at: progress), displayMode: InkReplayDisplayMode.resolved(modeValue), following: following, overviewRequest: overviewRequest, reloadRequest: reloadRequest,
                    onManualNavigation: userNavigated, onStatus: updateStatus)
                    .accessibilityIdentifier("inkReplay.content")
                if snapshot.strokes.isEmpty {
                    Text(String(localized: "还没有可回放的笔迹")).font(.callout).padding()
                } else {
                    InkReplayControls(snapshot: snapshot, progress: $progress, rate: $rate, modeValue: $modeValue,
                        playing: playing, following: following, location: location, backgroundStatus: backgroundStatus,
                        onScrub: pause, onBeginning: beginning, onPlay: togglePlayback,
                        onFollow: toggleFollowing, onOverview: overview, onReload: reloadBackground)
                }
            } else if !error.isEmpty {
                ContentUnavailableView(String(localized: "暂时无法回放"), systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                Spacer(); ProgressView(String(localized: "正在准备笔迹")); Spacer()
            }
        }.padding(.vertical, 4)
         .accessibilityElement(children: .contain)
         .accessibilityIdentifier(embedded ? "inkReplay.inline" : "inkReplay.presentation")
    }

    private func prepare() async {
        do {
            let result = try await InkReplay.load(drawingData: drawing.dataRepresentation(), items: items, webInk: webInk)
            guard !Task.isCancelled else { return }
            // A preview must be useful before Play: show all surviving ink at its
            // last local writing position, rather than an unexplained 0/N canvas.
            progress = result.duration
            snapshot = result
        } catch { self.error = error.localizedDescription }
    }
    private func pause() { playing = false; lastTick = nil }
    private func beginning() { pause(); progress = snapshot?.revealTimes.first ?? 0; following = true }
    private func togglePlayback() {
        guard let snapshot else { return }
        if progress >= snapshot.duration { progress = snapshot.revealTimes.first ?? 0; following = true }
        lastTick = nil; playing.toggle()
    }
    private func toggleFollowing() { following.toggle() }
    private func overview() { pause(); following = false; overviewRequest += 1 }
    private func reloadBackground() { reloadRequest += 1 }
    private func userNavigated() { pause(); following = false }
    private func updateStatus(_ position: String, _ status: String) {
        if location != position { location = position }
        if backgroundStatus != status { backgroundStatus = status }
    }
    private func close() { pause(); if let onClose { onClose() } else { dismiss() } }
    private func tick(_ now: Date) {
        guard playing, let snapshot else { lastTick = nil; return }
        if let lastTick { progress = min(snapshot.duration, progress + max(0, min(0.25, now.timeIntervalSince(lastTick))) * rate) }
        lastTick = now
        if progress >= snapshot.duration { playing = false }
    }
}

/// Small stable component: navigation gestures update only playback state, never
/// the editable board. Two compact rows also fit the iPhone's narrow viewport.
private struct InkReplayControls: View {
    let snapshot: InkReplaySnapshot
    @Binding var progress: Double
    @Binding var rate: Double
    @Binding var modeValue: String
    let playing: Bool
    let following: Bool
    let location: String
    let backgroundStatus: String
    let onScrub: () -> Void
    let onBeginning: () -> Void
    let onPlay: () -> Void
    let onFollow: () -> Void
    let onOverview: () -> Void
    let onReload: () -> Void

    var body: some View {
        VStack(spacing: 4) {
            Picker(String(localized: "笔迹显示"), selection: Binding(get: { InkReplayDisplayMode.resolved(modeValue).rawValue }, set: { modeValue = $0 })) {
                ForEach(InkReplayDisplayMode.allCases, id: \.rawValue) { mode in Text(mode.title).tag(mode.rawValue) }
            }.pickerStyle(.menu).frame(minHeight: 44).accessibilityIdentifier("inkReplay.displayMode")
            Text(location).font(.caption).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("inkReplay.location")
            if !backgroundStatus.isEmpty {
                HStack(spacing: 8) {
                    Text(backgroundStatus).font(.caption2).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("inkReplay.backgroundStatus")
                    Button(action: onReload) { Image(systemName: "arrow.clockwise").frame(width: 44, height: 44) }
                        .accessibilityLabel(String(localized: "重新加载资料背景"))
                        .accessibilityIdentifier("inkReplay.reloadBackground")
                }
            }
            Slider(value: $progress, in: 0...snapshot.duration) { editing in if editing { onScrub() } }
                .accessibilityLabel(String(localized: "回放进度")).accessibilityIdentifier("inkReplay.progress")
            HStack(spacing: 8) {
                Button(action: onBeginning) { Image(systemName: "backward.end.fill").frame(width: 44, height: 44) }
                    .accessibilityLabel(String(localized: "回到开头")).accessibilityIdentifier("inkReplay.beginning")
                Button(action: onPlay) { Image(systemName: playing ? "pause.fill" : "play.fill").frame(width: 44, height: 44) }
                    .accessibilityLabel(playing ? String(localized: "暂停回放") : String(localized: "开始回放"))
                    .accessibilityIdentifier("inkReplay.play")
                Text("\(snapshot.visibleCount(at: progress)) / \(snapshot.strokes.count)")
                    .monospacedDigit().font(.caption).accessibilityIdentifier("inkReplay.count")
                Spacer(minLength: 0)
                Picker(String(localized: "回放速度"), selection: $rate) {
                    ForEach([0.5, 1, 2, 4], id: \.self) { value in Text("\(value.formatted())×").tag(value) }
                }.pickerStyle(.menu).frame(minWidth: 44, minHeight: 44).accessibilityIdentifier("inkReplay.rate")
            }
            HStack(spacing: 8) {
                Button(action: onFollow) {
                    Label(String(localized: "跟随当前笔"), systemImage: following ? "scope" : "hand.draw")
                        .font(.callout).frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(.bordered).tint(following ? .accentColor : .secondary)
                    .accessibilityValue(following ? String(localized: "已开启") : String(localized: "已关闭"))
                    .accessibilityIdentifier("inkReplay.follow")
                Button(action: onOverview) {
                    Label(String(localized: "看全局"), systemImage: "arrow.up.left.and.arrow.down.right")
                        .font(.callout).frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(.bordered).accessibilityIdentifier("inkReplay.overview")
            }
            Text(snapshot.hasRecordedTimes ? String(localized: "按书写时间逐笔回放 · 长停顿已压缩") : String(localized: "顺序回放 · 旧笔迹缺少完整时间信息"))
                .font(.caption2).foregroundStyle(.secondary)
        }.padding(.horizontal)
    }
}

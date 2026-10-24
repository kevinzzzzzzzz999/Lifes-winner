import SwiftUI
import AVKit
import UniformTypeIdentifiers

struct BoardVideoPlayerView: View {
    let request: BoardVideoRequest
    @State private var playback = BoardVideoPlayback()
    @State private var subtitles = BoardVideoSubtitles()
    @State private var activeRequestID: UUID?
    @State private var isExpanded = false
    @State private var picksSubtitles = false
    @State private var picksAfterFullscreen = false
    @State private var transcriptExpanded = true
    @State private var selectionError: String?
    private enum AppearanceRoute: String, Identifiable {
        case ordinary, fullscreen, textOrdinary, textFullscreen
        var id: String { rawValue }
        var isText: Bool { self == .textOrdinary || self == .textFullscreen }
    }
    @State private var subtitleSelectionText = ""
    @State private var frameSelectionID: UUID?
    @State private var frameSelectionStatus = ""
    @State private var appearanceRoute: AppearanceRoute?
    @AppStorage(BoardSubtitleAppearance.storageKey) private var subtitleAppearanceData = Data()
    @AppStorage("videoSeekInterval") private var seekInterval = 5
    @AppStorage("videoPlaybackRate") private var playbackRate = 1.0
    @State private var isSeeking = false
    @State private var seekTarget = 0.0
    @State private var pendingSeek: Double?
    @State private var seekSequence = 0
    @State private var volume = 1.0
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        playerPage(expanded: false)
            .fullScreenCover(isPresented: $isExpanded, onDismiss: {
                if picksAfterFullscreen { picksAfterFullscreen = false; picksSubtitles = true }
            }) { playerPage(expanded: true) }
            .fileImporter(isPresented: $picksSubtitles,
                allowedContentTypes: [UTType(filenameExtension: "srt") ?? .plainText, UTType(filenameExtension: "vtt") ?? .plainText, .plainText],
                allowsMultipleSelection: false) { result in
                    switch result {
                    case .success(let urls): if let url = urls.first { selectionError = nil; subtitles.load(url) }
                    case .failure(let error):
                        if (error as NSError).code != NSUserCancelledError { selectionError = BoardSubtitleError.unavailable.errorDescription }
                    }
                }
            .task(id: request.id) {
                guard activeRequestID != request.id else { return }
                endFrameSelection(); activeRequestID = request.id; subtitles.stop(); selectionError = nil
                if ![1, 3, 5, 15, 30].contains(seekInterval) { seekInterval = 5 }
                if ![0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].contains(playbackRate) { playbackRate = 1 }
                playback.start(request)
                await subtitles.bind(request)
            }
            .onChange(of: playback.player) { _, player in
                endFrameSelection(); seekSequence += 1; pendingSeek = nil
                subtitles.attach(player); volume = Double(player?.volume ?? 1)
                player?.defaultRate = Float(playbackRate)
                if let player, player.rate > 0 { player.rate = Float(playbackRate) }
            }
            .onChange(of: playbackRate) { _, rate in
                playback.player?.defaultRate = Float(rate)
                if let player = playback.player, player.rate > 0 { player.rate = Float(rate) }
            }
            .onDisappear { if !isExpanded { stop() } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { endFrameSelection() } }
            .onChange(of: isExpanded) { _, _ in endFrameSelection() }
    }

    private func playerPage(expanded: Bool) -> some View {
        NavigationStack {
            VStack(spacing: 8) {
                ZStack(alignment: .bottom) {
                    if let player = playback.player, expanded || !isExpanded {
                        SubtitleVideoSurface(player: player, showsVideo: scenePhase != .background, selectionID: frameSelectionID,
                            onKey: keyboard, onStatus: { id, status in
                                Task { @MainActor in if frameSelectionID == id { frameSelectionStatus = status } }
                            }, onSelectionEnded: { id in
                                Task { @MainActor in if frameSelectionID == id { endFrameSelection() } }
                            })
                            .accessibilityIdentifier("video.player")
                    } else {
                        VStack(spacing: 16) {
                            Image(systemName: "play.rectangle").font(.system(size: 64)).foregroundStyle(.secondary)
                            if playback.isLoading { ProgressView(String(localized: "正在加载视频…")) }
                            else {
                                Button(String(localized: "播放视频"), systemImage: "play.fill") { playback.start(request) }
                                    .buttonStyle(.borderedProminent).accessibilityIdentifier("video.play")
                            }
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    if frameSelectionID == nil, !subtitles.text.isEmpty {
                        BoardSubtitleCaption(text: subtitles.text, appearance: BoardSubtitleAppearance.decode(subtitleAppearanceData))
                            .padding(12).accessibilityIdentifier("video.subtitle.text")
                    }
                }.background(.black).frame(maxWidth: .infinity, maxHeight: .infinity)
                controls
                if frameSelectionID != nil {
                    Text(frameSelectionStatus).font(.footnote).foregroundStyle(.secondary)
                        .lineLimit(2).frame(height: 36).padding(.horizontal)
                        .accessibilityIdentifier("video.frameSelection.status")
                }
                if !subtitles.transcriptLines.isEmpty {
                    DisclosureGroup(String(localized: "字幕文字稿（不按时间切换）"), isExpanded: $transcriptExpanded) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 5) {
                                ForEach(Array(subtitles.transcriptLines.enumerated()), id: \.offset) { _, line in
                                    Text(verbatim: line).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }.padding(8)
                        }.frame(maxHeight: 140).accessibilityIdentifier("video.subtitle.transcript")
                    }.font(.callout).padding(.horizontal)
                }
                if subtitles.isLoading {
                    HStack { ProgressView(String(localized: "正在读取字幕…")); if subtitles.associationReady { Button(String(localized: "取消")) { subtitles.cancelLoading() } } }
                }
                if subtitles.isSaving {
                    ProgressView(String(localized: "正在保存字幕关联…")).font(.footnote).accessibilityIdentifier("video.subtitle.saving")
                } else if let message = subtitles.persistenceMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary).padding(.horizontal).accessibilityIdentifier("video.subtitle.saved")
                }
                if subtitles.hasPendingChange && !subtitles.isSaving {
                    HStack {
                        Button(String(localized: "重试保存字幕")) { subtitles.retrySave() }.accessibilityIdentifier("video.subtitle.retry")
                        Button(String(localized: "放弃本次更改并重新读取")) { Task { await subtitles.discardPendingAndReload(request) } }
                            .accessibilityIdentifier("video.subtitle.discard")
                    }.font(.footnote).padding(.horizontal)
                } else if !subtitles.associationReady && !subtitles.isLoading {
                    Button(String(localized: "重新读取字幕关联")) { Task { await subtitles.bind(request) } }
                        .font(.footnote).accessibilityIdentifier("video.subtitle.reload")
                }
                if let error = playback.errorMessage ?? subtitles.errorMessage ?? selectionError {
                    Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal).accessibilityIdentifier("video.error")
                }
                if !expanded {
                    Text(String(localized: "字幕保存在视频旁，下次打开自动加载。共享 iCloud 文件夹中的字幕关联会随文件同步；不修改原视频。应用内全屏支持字幕，不提供画中画字幕。"))
                        .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                    Text(String(localized: "轻点视频画面后：空格播放/暂停，左右键按所选步长跳转，上下键调整视频音量。"))
                        .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                    Text(String(localized: "直接播放仓库内原视频；切到后台可继续声音，关闭或切板后停止。画面选字会暂停视频。"))
                        .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                }
            }.padding(.bottom, 8)
            .navigationTitle(request.title).navigationBarTitleDisplayMode(.inline)
            .sheet(item: appearanceRouteBinding(expanded: expanded)) { route in
                if route.isText { BoardSubtitleTextSheet(text: subtitleSelectionText) }
                else {
                    BoardSubtitleAppearanceSheet(appearance: Binding(
                        get: { BoardSubtitleAppearance.decode(subtitleAppearanceData) },
                        set: { subtitleAppearanceData = $0.encoded }))
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if expanded {
                        Button(String(localized: "退出全屏")) { isExpanded = false }.accessibilityIdentifier("video.fullscreen.close")
                    } else {
                        Button(String(localized: "关闭")) { stop(); dismiss() }.accessibilityIdentifier("video.close")
                    }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Menu {
                        Button(String(localized: "选择字幕文字"), systemImage: "text.cursor") {
                            endFrameSelection(); playback.pauseForTextSelection()
                            subtitleSelectionText = subtitles.text.isEmpty ? subtitles.transcriptLines.joined(separator: "\n") : subtitles.text
                            appearanceRoute = expanded ? .textFullscreen : .textOrdinary
                        }.disabled(subtitles.text.isEmpty && subtitles.transcriptLines.isEmpty)
                            .accessibilityIdentifier("video.subtitle.selectText")
                        Button(String(localized: "选择字幕文件"), systemImage: "doc.badge.plus") {
                            endFrameSelection()
                            if expanded { picksAfterFullscreen = true; isExpanded = false }
                            else { picksSubtitles = true }
                        }.disabled(subtitles.isLoading || subtitles.isSaving || !subtitles.associationReady)
                            .accessibilityIdentifier("video.subtitle.choose")
                        Button(String(localized: "字幕外观"), systemImage: "textformat.size") {
                            endFrameSelection(); appearanceRoute = expanded ? .fullscreen : .ordinary
                        }.accessibilityIdentifier("video.subtitle.appearance")
                        if subtitles.filename != nil {
                            Button(subtitles.enabled ? String(localized: "隐藏字幕") : String(localized: "显示字幕"), systemImage: subtitles.enabled ? "eye.slash" : "eye") {
                                subtitles.setEnabled(!subtitles.enabled)
                            }.disabled(subtitles.isLoading || subtitles.isSaving).accessibilityIdentifier("video.subtitle.visibility")
                            Button(String(localized: "移除字幕关联"), systemImage: "xmark", role: .destructive) { subtitles.removeAssociation() }
                                .disabled(subtitles.isLoading || subtitles.isSaving).accessibilityIdentifier("video.subtitle.clear")
                        }
                        if let filename = subtitles.filename { Text(filename) }
                    } label: { Label(String(localized: "字幕"), systemImage: "captions.bubble") }
                        .accessibilityIdentifier("video.subtitle.menu")
                    if !expanded {
                        Button(String(localized: "全屏"), systemImage: "arrow.up.left.and.arrow.down.right") { isExpanded = true }
                            .accessibilityIdentifier("video.fullscreen")
                    }
                    Button(String(localized: "停止播放"), systemImage: "stop.fill") { endFrameSelection(); playback.stop(); subtitles.attach(nil) }
                        .disabled(playback.player == nil && !playback.isLoading).accessibilityIdentifier("video.stop")
                }
            }
        }
    }

    private func appearanceRouteBinding(expanded: Bool) -> Binding<AppearanceRoute?> {
        let routes: [AppearanceRoute] = expanded ? [.fullscreen, .textFullscreen] : [.ordinary, .textOrdinary]
        return Binding(get: { appearanceRoute.flatMap { routes.contains($0) ? $0 : nil } }, set: { value in
            if let value { appearanceRoute = value }
            else if let current = appearanceRoute, routes.contains(current) { appearanceRoute = nil }
        })
    }

    private var controls: some View {
        VStack(spacing: 5) {
            HStack(spacing: 10) {
                Text(time(subtitles.currentTime)).monospacedDigit().font(.caption)
                Slider(value: Binding(get: { isSeeking ? seekTarget : min(pendingSeek ?? subtitles.currentTime, max(1, subtitles.duration)) }, set: { seekTarget = $0 }),
                    in: 0...max(1, subtitles.duration), onEditingChanged: { editing in
                        isSeeking = editing
                        if editing { endFrameSelection(); seekTarget = subtitles.currentTime } else { seek(to: seekTarget) }
                    })
                    .disabled(playback.player == nil || subtitles.duration <= 0)
                    .accessibilityLabel(String(localized: "播放进度")).accessibilityIdentifier("video.seek")
                Text(time(subtitles.duration)).monospacedDigit().font(.caption)
            }
            HStack(spacing: 14) {
                Button { seek(by: -Double(seekInterval)) } label: { Image(systemName: "backward.end.fill").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(String(localized: "后退 \(seekInterval) 秒")).accessibilityIdentifier("video.seek.backward")
                Button { endFrameSelection(); playback.toggle(request) } label: { Image(systemName: subtitles.isPlaying ? "pause.fill" : "play.fill").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(String(localized: "播放或暂停视频")).accessibilityIdentifier("video.transport.play")
                Button { seek(by: Double(seekInterval)) } label: { Image(systemName: "forward.end.fill").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(String(localized: "前进 \(seekInterval) 秒")).accessibilityIdentifier("video.seek.forward")
            }.frame(maxWidth: .infinity)
            Button(frameSelectionID == nil ? String(localized: "选择画面文字") : String(localized: "结束画面选字"), systemImage: "text.viewfinder") {
                if frameSelectionID != nil { endFrameSelection() }
                else {
                    playback.pauseForTextSelection()
                    frameSelectionStatus = String(localized: "正在读取暂停画面…")
                    frameSelectionID = UUID()
                }
            }.disabled(playback.player == nil || playback.isLoading || isSeeking || pendingSeek != nil)
                .accessibilityIdentifier("video.frameSelection.toggle")
            HStack {
                Picker(String(localized: "快进步长"), selection: $seekInterval) {
                    ForEach([1, 3, 5, 15, 30], id: \.self) { Text(String(localized: "\($0) 秒")).tag($0) }
                }.pickerStyle(.menu).accessibilityIdentifier("video.seek.interval")
                Spacer(minLength: 12)
                Picker(String(localized: "播放速度"), selection: $playbackRate) {
                    ForEach([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], id: \.self) { rate in
                        Text(String(format: "%g×", rate)).tag(rate)
                    }
                }.pickerStyle(.menu).accessibilityIdentifier("video.rate")
            }
            HStack(spacing: 10) {
                Image(systemName: "speaker.wave.2").accessibilityHidden(true)
                Slider(value: Binding(get: { volume }, set: { setVolume($0) }), in: 0...1)
                    .disabled(playback.player == nil).accessibilityLabel(String(localized: "视频音量")).accessibilityIdentifier("video.volume")
                Text("\(Int((volume * 100).rounded()))%").monospacedDigit().font(.caption).frame(width: 42)
            }
        }.padding(.horizontal, 14)
    }
    private func keyboard(_ input: String) {
        guard appearanceRoute == nil, !picksSubtitles else { return }
        switch input {
        case " ": endFrameSelection(); playback.toggle(request)
        case UIKeyCommand.inputLeftArrow: seek(by: -Double(seekInterval))
        case UIKeyCommand.inputRightArrow: seek(by: Double(seekInterval))
        case UIKeyCommand.inputUpArrow: setVolume(volume + 0.05)
        case UIKeyCommand.inputDownArrow: setVolume(volume - 0.05)
        default: break
        }
    }
    private func seek(by delta: Double) {
        guard let player = playback.player else { return }
        let current = player.currentTime().seconds
        seek(to: (pendingSeek ?? (current.isFinite ? current : 0)) + delta)
    }
    private func seek(to value: Double) {
        guard let player = playback.player, subtitles.duration > 0 else { return }
        endFrameSelection()
        let seconds = min(subtitles.duration, max(0, value))
        seekSequence += 1; let sequence = seekSequence; pendingSeek = seconds
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            Task { @MainActor in
                guard seekSequence == sequence, playback.player === player else { return }
                pendingSeek = nil
            }
        }
    }
    private func setVolume(_ value: Double) {
        volume = min(1, max(0, value)); playback.player?.volume = Float(volume)
        if volume > 0 { playback.player?.isMuted = false }
    }
    private func time(_ seconds: Double) -> String {
        let value = Int(min(86_400_000, max(0, seconds.isFinite ? seconds : 0)))
        return value >= 3600 ? String(format: "%d:%02d:%02d", value / 3600, value / 60 % 60, value % 60) : String(format: "%d:%02d", value / 60, value % 60)
    }
    private func endFrameSelection() { frameSelectionID = nil; frameSelectionStatus = "" }
    private func stop() { endFrameSelection(); appearanceRoute = nil; seekSequence += 1; pendingSeek = nil; picksAfterFullscreen = false; picksSubtitles = false; subtitles.stop(); playback.stop() }
}

/// A plain AVPlayerLayer keeps captions in the app's own full-screen hierarchy.
/// Keyboard shortcuts belong only to this view while it is first responder;
/// the system file picker/search field and all other text inputs retain theirs.
struct SubtitleVideoSurface: UIViewRepresentable {
    let player: AVPlayer
    let showsVideo: Bool
    let selectionID: UUID?
    let onKey: (String) -> Void
    let onStatus: (UUID, String) -> Void
    let onSelectionEnded: (UUID) -> Void
    func makeUIView(context: Context) -> SubtitleVideoSurfaceView { SubtitleVideoSurfaceView() }
    func updateUIView(_ view: SubtitleVideoSurfaceView, context: Context) {
        view.onKey = onKey; view.onStatus = onStatus; view.onSelectionEnded = onSelectionEnded
        view.setPlayer(showsVideo ? player : nil)
        view.setSelection(showsVideo ? selectionID : nil)
    }
    static func dismantleUIView(_ view: SubtitleVideoSurfaceView, coordinator: ()) { view.tearDown() }
}

final class SubtitleVideoSurfaceView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    var onKey: ((String) -> Void)?
    var onStatus: ((UUID, String) -> Void)?
    var onSelectionEnded: ((UUID) -> Void)?
    private var selectionID: UUID?
    private var requestedSelectionID: UUID?
    private var generation = UUID()
    private var frameTask: Task<Void, Never>?
    private var generator: AVAssetImageGenerator?
    private var selector: BoardInlineTextSelection?
    private var frameImage: UIImage?
    private var capturedBounds = CGRect.zero
    private var capturedVideoRect = CGRect.zero
    private var rateObservation: NSKeyValueObservation?
    private var itemObservation: NSKeyValueObservation?
    private var videoRectObservation: NSKeyValueObservation?
    private var timeJumpObserver: NSObjectProtocol?
    override var canBecomeFirstResponder: Bool { true }
    override init(frame: CGRect) {
        super.init(frame: frame)
        playerLayer.videoGravity = .resizeAspect; backgroundColor = .black
        videoRectObservation = playerLayer.observe(\.videoRect, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.invalidateChangedGeometry() }
        }
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
    deinit { if let timeJumpObserver { NotificationCenter.default.removeObserver(timeJumpObserver) } }

    func setPlayer(_ player: AVPlayer?) {
        guard playerLayer.player !== player else { return }
        finishSelection(notify: true)
        rateObservation = nil; itemObservation = nil
        if let timeJumpObserver { NotificationCenter.default.removeObserver(timeJumpObserver) }; timeJumpObserver = nil
        playerLayer.player = player
        guard let player else { return }
        rateObservation = player.observe(\.rate, options: [.new]) { [weak self] player, _ in
            guard player.rate != 0 else { return }
            Task { @MainActor in
                guard let self, self.playerLayer.player === player, player.rate != 0 else { return }
                self.finishSelection(notify: true)
            }
        }
        itemObservation = player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.finishSelection(notify: true) }
        }
        timeJumpObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemTimeJumped,
            object: player.currentItem, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.finishSelection(notify: true) }
            }
    }

    /// A non-nil id can only come from the user's explicit selection action.
    func setSelection(_ id: UUID?) {
        // Native invalidation consumes this request; a periodic SwiftUI update
        // must not restart OCR until the user creates a new id.
        guard requestedSelectionID != id else { return }
        requestedSelectionID = id
        finishSelection(notify: false)
        guard let id else { return }
        selectionID = id
        let token = UUID(); generation = token
        frameTask = Task { [weak self] in
            // Let the status row/layout settle before fixing selection coordinates.
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            guard let self, self.generation == token else { return }
            guard self.window != nil, let player = self.playerLayer.player, player.rate == 0,
                  let item = player.currentItem, item.status == .readyToPlay else {
                self.onStatus?(id, String(localized: "画面尚未准备好，请结束选字并稍后重试。")); return
            }
            let time = player.currentTime()
            let rect = self.playerLayer.videoRect
            guard time.isNumeric, self.bounds.width >= 8, self.bounds.height >= 8,
                  !rect.isEmpty, !rect.isInfinite, rect.width.isFinite, rect.height.isFinite else {
                self.onStatus?(id, String(localized: "画面尚未准备好，请结束选字并稍后重试。")); return
            }
            self.capturedBounds = self.bounds; self.capturedVideoRect = rect
            let generator = AVAssetImageGenerator(asset: item.asset)
            generator.appliesPreferredTrackTransform = true
            generator.videoComposition = item.videoComposition
            generator.maximumSize = CGSize(width: 2600, height: 2600)
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            self.generator = generator
            do {
                let result = try await generator.image(at: time)
                try Task.checkCancellation()
                guard self.generation == token else { return }
                guard self.selectionID == id, self.window != nil, self.playerLayer.player === player,
                      player.currentItem === item, player.rate == 0, CMTimeCompare(player.currentTime(), time) == 0,
                      self.bounds == self.capturedBounds, self.playerLayer.videoRect == rect else {
                    self.finishSelection(notify: true); return
                }
                self.frameImage = UIImage(cgImage: result.image)
                let selector = self.selector ?? BoardInlineTextSelection(content: self)
                self.selector = selector
                selector.capture = { [weak self] _ in
                    guard let self, self.generation == token else { return nil }
                    return self.frameImage
                }
                selector.analysisContentsRect = { [weak self] in
                    guard let self, self.bounds.width > 0, self.bounds.height > 0 else { return .zero }
                    let rect = self.capturedVideoRect
                    return CGRect(x: rect.minX / self.bounds.width, y: rect.minY / self.bounds.height,
                                  width: rect.width / self.bounds.width, height: rect.height / self.bounds.height)
                }
                selector.canInteract = { [weak self, weak player, weak item] point in
                    guard let self, let player, let item else { return false }
                    return self.generation == token && self.selectionID == id && player.rate == 0
                        && self.playerLayer.player === player && player.currentItem === item
                        && CMTimeCompare(player.currentTime(), time) == 0
                        && self.bounds == self.capturedBounds && self.playerLayer.videoRect == self.capturedVideoRect
                        && self.capturedVideoRect.contains(point)
                }
                selector.onStatus = { [weak self] status in
                    guard let self, self.generation == token else { return }
                    self.onStatus?(id, status.replacingOccurrences(of: "白板", with: "画面"))
                }
                selector.update(BoardTextSelectionSnapshotKey(sessionID: id, boardID: id,
                    size: self.bounds.size, offset: .zero, zoom: 1, documentRevision: 0,
                    updatedAt: Date(timeIntervalSince1970: 0), previewEpoch: 0, imageRevision: 0, renderedRevision: 0))
                _ = selector.revealText()
            } catch is CancellationError { }
            catch {
                guard self.generation == token else { return }
                self.onStatus?(id, String(localized: "无法读取当前视频画面，请结束选字并稍后重试。"))
            }
            if self.generation == token { self.generator = nil; self.frameTask = nil }
        }
    }

    override func layoutSubviews() { super.layoutSubviews(); invalidateChangedGeometry() }
    private func invalidateChangedGeometry() {
        guard selectionID != nil, capturedBounds != .zero else { return }
        if bounds != capturedBounds || playerLayer.videoRect != capturedVideoRect { finishSelection(notify: true) }
    }
    override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { finishSelection(notify: true) } }
    private func finishSelection(notify: Bool) {
        let old = selectionID
        selectionID = nil; generation = UUID()
        frameTask?.cancel(); frameTask = nil; generator?.cancelAllCGImageGeneration(); generator = nil
        selector?.update(nil); frameImage = nil; capturedBounds = .zero; capturedVideoRect = .zero
        if notify, let old { onSelectionEnded?(old) }
    }
    func tearDown() {
        finishSelection(notify: false); selector?.tearDown(); selector = nil
        rateObservation = nil; itemObservation = nil; videoRectObservation = nil
        if let timeJumpObserver { NotificationCenter.default.removeObserver(timeJumpObserver) }; timeJumpObserver = nil
        playerLayer.player = nil; onKey = nil; onStatus = nil; onSelectionEnded = nil; resignFirstResponder()
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        if selectionID == nil { becomeFirstResponder() }
    }
    override var keyCommands: [UIKeyCommand]? {
        guard isFirstResponder else { return [] }
        return [" ", UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow, UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow].map {
            let command = UIKeyCommand(input: $0, modifierFlags: [], action: #selector(key(_:)))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
    }
    @objc func key(_ command: UIKeyCommand) { guard isFirstResponder, let input = command.input else { return }; onKey?(input) }
}

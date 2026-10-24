import AVKit
import SwiftUI
import UniformTypeIdentifiers

private enum MediaEditorSheet: String, Identifiable {
    case importMedia, importLayer, openProject, saveAs, export, editClip, settings, effects, compositionPreview
    var id: String { rawValue }
}
private enum MediaPendingAction { case new, open, close }

struct MediaEditorView: View {
    let library: DocumentLibrary
    private let initialProjectURL: URL?
    @Environment(\.dismiss) private var dismiss
    @State private var project: MediaProject
    @State private var savedProject: MediaProject
    @State private var projectURL: URL?
    @State private var fingerprint: String?
    @State private var selectedID: UUID?
    @State private var undoHistory: [MediaProject] = []
    @State private var redoHistory: [MediaProject] = []
    @State private var sheet: MediaEditorSheet?
    @State private var pendingAction: MediaPendingAction?
    @State private var asksToSave = false
    @State private var operationTask: Task<Void, Never>?
    @State private var busy = false
    @State private var exporting = false
    @State private var progress = 0.0
    @State private var message = ""
    @State private var outputURL: URL?
    @State private var destinationDirectory: String
    @State private var exportService = MediaExportService()
    @State private var player: AVPlayer?
    @State private var playbackObserver: Any?
    @State private var endObserver: NSObjectProtocol?
    @State private var previewValidationCache: [UUID: String] = [:]
    @State private var continuousPlayback = false
    @State private var pendingPreviewPosition: Double?
    @State private var timelineScrubbing = false
    @State private var timelineScrubPosition = 0.0
    @State private var playhead = 0.0
    @State private var scrubbing = false
    @State private var previewMessage = ""
    @State private var listEditMode: EditMode = .inactive
    @State private var didLoadInitialProject = false
    @State private var previewRevision = UUID()
    @State private var compositionPreviewURL: URL?
    @State private var compositionPlayer: AVPlayer?


    init(library: DocumentLibrary, initialDirectory: String, initialProjectURL: URL? = nil) {
        self.library = library; self.initialProjectURL = initialProjectURL
        var initial = MediaProject(); initial.title = mediaText("新剪辑工程", "New media project")
        _project = State(initialValue: initial); _savedProject = State(initialValue: initial)
        _destinationDirectory = State(initialValue: initialDirectory)
    }
    private var selectedClip: MediaClip? { project.clips.first { $0.id == selectedID } }
    private var selectedSource: MediaSource? { selectedClip.flatMap { clip in project.sources.first { $0.id == clip.sourceID } } }
    private var isDirty: Bool { project != savedProject }
    private var timelinePlayhead: Double {
        guard let clip = selectedClip, let index = project.clips.firstIndex(where: { $0.id == clip.id }) else { return 0 }
        return project.clipStarts[index]
            + min(clip.duration, max(0, (playhead - clip.start) / clip.speed))
    }
    private var previewKey: String {
        guard let clip = selectedClip, let source = selectedSource else { return "none" }
        return "\(source.path)-\(clip.id)-\(clip.start)-\(clip.end)-\(clip.speed)-\(clip.volume)-\(previewRevision)"
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                if geometry.size.width > 780 {
                    HStack(spacing: 0) {
                        preview.frame(width: geometry.size.width * 0.46)
                        Divider(); timeline
                    }
                } else {
                    VStack(spacing: 0) {
                        preview.frame(height: selectedClip == nil ? 150 : 275)
                        Divider(); timeline
                    }
                }
            }
            .navigationTitle(project.title + (isDirty ? " •" : ""))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) { statusBar }
            .sheet(item: $sheet) { route in sheetContent(route) }
            .confirmationDialog(mediaText("保存当前剪辑工程？", "Save this project?"), isPresented: $asksToSave, titleVisibility: .visible) {
                Button(mediaText("保存并继续", "Save and continue")) { saveCurrent() }
                Button(mediaText("放弃未保存修改", "Discard unsaved changes"), role: .destructive) { finishPendingAction() }
                Button(mediaText("取消", "Cancel"), role: .cancel) { pendingAction = nil }
            } message: { Text(mediaText("原素材不会被修改或删除。", "Original media will not be changed or deleted.")) }
            .interactiveDismissDisabled(isDirty || busy)
            .task(id: previewKey) { await loadPreview() }
            .task {
                guard !didLoadInitialProject else { return }; didLoadInitialProject = true
                if let initialProjectURL { openProject(initialProjectURL) }
            }
            .onChange(of: sheet) { _, route in if route != nil { continuousPlayback = false; player?.pause() } }
            .accessibilityIdentifier("media.editor")
            .onDisappear { stopPreview(); discardCompositionPreview(); operationTask?.cancel(); exportService.cancel() }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(mediaText("关闭", "Close")) { request(.close) }.disabled(busy)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button { undo() } label: { Image(systemName: "arrow.uturn.backward") }.disabled(undoHistory.isEmpty || busy)
                .accessibilityLabel(mediaText("撤销", "Undo"))
            Button { redo() } label: { Image(systemName: "arrow.uturn.forward") }.disabled(redoHistory.isEmpty || busy)
                .accessibilityLabel(mediaText("重做", "Redo"))
            Menu {
                Button(mediaText("导入视频", "Import video"), systemImage: "plus") { sheet = .importMedia }
                Button(mediaText("导入画中画视频", "Import inset video"), systemImage: "rectangle.on.rectangle") { sheet = .importLayer }
                Button(mediaText("叠加轨与字幕", "Tracks and captions"), systemImage: "captions.bubble") { sheet = .effects }
                Button(mediaText("预览完整合成", "Preview composition"), systemImage: "play.rectangle") { previewComposition() }.disabled(project.clips.isEmpty)
                Button(mediaText("保存工程", "Save project"), systemImage: "square.and.arrow.down") { saveCurrent() }
                Button(mediaText("工程另存为", "Save project as")) { sheet = .saveAs }
                Button(mediaText("打开工程", "Open project"), systemImage: "folder") { request(.open) }
                Button(mediaText("新建工程", "New project")) { request(.new) }
                Divider()
                Button(mediaText("工程与输出设置", "Project and output settings"), systemImage: "slider.horizontal.3") { sheet = .settings }
                Button(mediaText("导出视频", "Export video"), systemImage: "square.and.arrow.up") { sheet = .export }.disabled(project.clips.isEmpty)
            } label: { Image(systemName: "ellipsis.circle") }.disabled(busy)
                .accessibilityLabel(mediaText("剪辑工程菜单", "Media project menu"))
        }
    }

    private var preview: some View {
        VStack(spacing: 8) {
            if let clip = selectedClip {
                if let player { VideoPlayer(player: player).frame(maxWidth: .infinity, maxHeight: .infinity) }
                else {
                    VStack {
                        ContentUnavailableView(mediaText("片段预览", "Clip preview"), systemImage: "play.rectangle", description: Text(previewMessage))
                        Button(mediaText("重试预览", "Retry preview")) { previewRevision = UUID() }.disabled(busy)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                Text(mediaText("素材预览（不含转场、叠加和字幕）", "Source preview (without transitions, overlays or captions)")).font(.caption2).foregroundStyle(.secondary)
                Text(selectedSource?.name ?? "").font(.caption).lineLimit(1)
                HStack {
                    Text(mediaTime(max(0, playhead - clip.start) / clip.speed)).monospacedDigit()
                    Slider(value: Binding(get: { min(clip.end, max(clip.start, playhead)) }, set: { playhead = $0 }), in: clip.start...clip.end, onEditingChanged: { editing in
                        scrubbing = editing
                        if !editing { player?.seek(to: CMTime(seconds: playhead, preferredTimescale: 600)) }
                    }).accessibilityLabel(mediaText("片段播放头", "Clip playhead"))
                    Text(mediaTime(clip.duration)).monospacedDigit()
                }.font(.caption)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        Button(mediaText("裁剪 / 速度 / 音量", "Trim / speed / volume"), systemImage: "slider.horizontal.3") { sheet = .editClip }
                        Button(mediaText("按播放头拆分", "Split at playhead"), systemImage: "scissors") { splitSelected() }
                        Button(mediaText("预览完整合成", "Preview composition"), systemImage: "play.rectangle") { previewComposition() }
                        Button(mediaText("复制片段", "Duplicate"), systemImage: "plus.square.on.square") { duplicate(clip.id) }
                    }.buttonStyle(.bordered).font(.caption)
                }.disabled(busy)
            } else {
                ContentUnavailableView(mediaText("添加素材开始剪辑", "Import media to start"), systemImage: "film.stack",
                    description: Text(mediaText("裁剪、拆分和合并视频；音频剪辑请在 Mac 上使用。", "Trim, split and combine videos. Audio editing is available on Mac.")))
            }
        }.padding(10)
    }

    private var timeline: some View {
        List {
            Section {
                Button(mediaText("预览完整合成", "Preview composition"), systemImage: "play.rectangle") { previewComposition() }.disabled(project.clips.isEmpty)
                    .accessibilityIdentifier("media.previewComposition")
                Button(mediaText("叠加轨与字幕", "Tracks and captions") + " · \(project.overlays.count) / \(project.captions.count)", systemImage: "captions.bubble") { sheet = .effects }
                    .accessibilityIdentifier("media.effects")
                timelinePlaybackControls
                HStack {
                    Button(mediaText("导入素材", "Import media"), systemImage: "plus") { sheet = .importMedia }
                    Spacer()
                    Button(listEditMode.isEditing ? mediaText("完成排序", "Done") : mediaText("排序", "Reorder")) {
                        withAnimation { listEditMode = listEditMode.isEditing ? .inactive : .active }
                    }.disabled(project.clips.isEmpty)
                }
                ForEach(Array(project.clips.enumerated()), id: \.element.id) { index, clip in
                    clipRow(clip, index: index)
                }
                .onDelete { offsets in
                    var next = project; next.clips.remove(atOffsets: offsets); commit(next)
                }
                .onMove { offsets, destination in
                    var next = project; next.clips.move(fromOffsets: offsets, toOffset: destination); commit(next)
                }
            } header: {
                HStack {
                    Text(mediaText("顺序时间线", "Sequential timeline") + " · \(project.clips.count)")
                    Spacer(); Text(mediaTime(project.duration)).monospacedDigit()
                }
            } footer: {
                Text(mediaText("点击片段预览。每个片段可裁剪、变速、调音量、拆分、复制、重排或删除。独立音频工程请在 Mac 上剪辑。", "Tap a clip to preview. Trim, change speed or volume, split, duplicate, reorder, or delete any clip. Edit standalone audio projects on Mac."))
            }
        }
        .environment(\.editMode, $listEditMode)
        .disabled(busy)
    }
    private func clipRow(_ clip: MediaClip, index: Int) -> some View {
        let source = project.sources.first { $0.id == clip.sourceID }
        return HStack(spacing: 10) {
            Button { continuousPlayback = false; player?.pause(); selectedID = clip.id } label: {
                HStack(spacing: 10) {
                    Image(systemName: source?.hasVideo == true ? "film" : "waveform").foregroundStyle(.teal)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(index + 1). " + (source?.name ?? mediaText("素材缺失", "Missing source"))).lineLimit(2)
                        Text("\(mediaTime(clip.start)) – \(mediaTime(clip.end)) · \(clip.speed.formatted())× · \(Int(clip.volume * 100))%")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if selectedID == clip.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(.teal) }
                }.frame(minHeight: 54).contentShape(Rectangle())
            }.buttonStyle(.plain)
            Menu {
                Button(mediaText("编辑片段", "Edit clip")) { selectedID = clip.id; sheet = .editClip }
                Button(mediaText("复制片段", "Duplicate")) { duplicate(clip.id) }
                Button(mediaText("向前移动", "Move earlier")) { move(clip.id, by: -1) }.disabled(index == 0)
                Button(mediaText("向后移动", "Move later")) { move(clip.id, by: 1) }.disabled(index == project.clips.count - 1)
                Button(mediaText("删除片段", "Delete clip"), role: .destructive) { var next = project; next.clips.removeAll { $0.id == clip.id }; commit(next) }
            } label: { Image(systemName: "ellipsis").frame(width: 40, height: 44) }
                .accessibilityLabel(mediaText("片段操作", "Clip actions"))
        }
        .accessibilityIdentifier("media.clip.\(clip.id)")
    }

    private var timelinePlaybackControls: some View {
        VStack(spacing: 8) {
            HStack {
                Button {
                    if continuousPlayback { continuousPlayback = false; player?.pause() }
                    else {
                        continuousPlayback = true
                        if selectedID == nil || timelinePlayhead >= project.duration - 0.02 {
                            seekTimeline(to: 0)
                        } else if let clip = selectedClip { player?.playImmediately(atRate: Float(clip.speed)) }
                    }
                } label: {
                    Label(continuousPlayback ? mediaText("暂停素材播放", "Pause sources") : mediaText("顺序播放素材", "Play sources in order"),
                          systemImage: continuousPlayback ? "pause.fill" : "play.fill")
                }.disabled(project.clips.isEmpty)
                Spacer()
                Text(mediaTime(timelinePlayhead) + " / " + mediaTime(project.duration)).font(.caption).monospacedDigit()
            }
            if project.duration > 0 {
                Slider(value: Binding(get: { timelineScrubbing ? timelineScrubPosition : timelinePlayhead }, set: { timelineScrubPosition = $0 }),
                       in: 0...project.duration, onEditingChanged: { editing in
                    if editing { timelineScrubPosition = timelinePlayhead; timelineScrubbing = true; player?.pause() }
                    else { timelineScrubbing = false; seekTimeline(to: timelineScrubPosition) }
                }).accessibilityLabel(mediaText("时间线播放头", "Timeline playhead"))
            }
        }
    }

    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            if busy {
                HStack {
                    if exporting { ProgressView(value: progress).frame(maxWidth: .infinity) } else { ProgressView() }
                    Button(mediaText("取消", "Cancel")) { operationTask?.cancel(); if exporting { exportService.cancel() } }
                }
            }
            if !message.isEmpty { Text(message).font(.caption).textSelection(.enabled) }
            if let outputURL { ShareLink(item: outputURL) { Label(mediaText("分享导出文件", "Share exported file"), systemImage: "square.and.arrow.up") } }
        }.padding(message.isEmpty && !busy && outputURL == nil ? 0 : 12).background(.regularMaterial)
    }

    @ViewBuilder private func sheetContent(_ route: MediaEditorSheet) -> some View {
        switch route {
        case .importMedia, .importLayer:
            MediaDocumentPicker(types: [.movie], multiple: true) { urls in sheet = nil; importSources(urls, asLayer: route == .importLayer) } onCancel: { sheet = nil }
        case .effects:
            MediaEffectsEditor(project: project, visibleRange: visibleCaptionRange) { commit($0) }
        case .compositionPreview:
            NavigationStack {
                VStack {
                    if let compositionPlayer { VideoPlayer(player: compositionPlayer).onAppear { compositionPlayer.play() } }
                    Text(mediaText("完整合成预览：包含转场、画中画、混音和烧录字幕。临时文件关闭后自动清理。", "Composition preview includes transitions, insets, audio mix and burnt captions. The temporary file is removed when closed.")).font(.caption).padding()
                }
                .navigationTitle(mediaText("完整合成预览", "Composition preview"))
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(mediaText("完成", "Done")) { sheet = nil } } }
                .onDisappear { discardCompositionPreview() }
            }
        case .openProject:
            MediaDocumentPicker(types: [.json], multiple: false, directoryURL: library.rootURL) { urls in sheet = nil; if let url = urls.first { openProject(url) } } onCancel: { sheet = nil }
        case .saveAs, .export:
            MediaDestinationSheet(library: library, initialDirectory: destinationDirectory,
                initialName: project.title, fileExtension: route == .saveAs ? "inkcut.json" : (project.output.kind == "video" ? "mp4" : "m4a"),
                title: route == .saveAs ? mediaText("保存剪辑工程", "Save media project") : mediaText("导出视频", "Export video"),
                onConfirm: { directory, name in
                    destinationDirectory = directory; sheet = nil
                    if route == .saveAs { saveProject(directory: directory, name: name) }
                    else { exportProject(directory: directory, name: name) }
                }, onCancel: { pendingAction = nil })
        case .editClip:
            if let clip = selectedClip, let source = selectedSource {
                MediaClipEditor(clip: clip, source: source, nextDuration: nextClipDuration) { changed in
                    var next = project
                    if let index = next.clips.firstIndex(where: { $0.id == changed.id }) { next.clips[index] = changed; commit(next) }
                }
            }
        case .settings:
            MediaProjectSettings(project: project) { commit($0) }
        }
    }

    private func commit(_ value: MediaProject) {
        var next = value
        guard next.supportsMobileEditing else { message = audioEditingOnMac; return }
        guard next != project else { return }
        next.schemaVersion = 2
        next.updatedAt = ISO8601DateFormatter().string(from: Date())
        do { try next.validate() } catch { message = error.localizedDescription; return }
        continuousPlayback = false; player?.pause(); pendingPreviewPosition = nil
        undoHistory.append(project); if undoHistory.count > 50 { undoHistory.removeFirst() }
        redoHistory = []; project = next
        if !project.clips.contains(where: { $0.id == selectedID }) { selectedID = project.clips.first?.id }
    }
    private func undo() {
        guard let previous = undoHistory.popLast() else { return }
        continuousPlayback = false; player?.pause(); pendingPreviewPosition = nil
        redoHistory.append(project); project = previous
        if !project.clips.contains(where: { $0.id == selectedID }) { selectedID = project.clips.first?.id }
    }
    private func redo() {
        guard let next = redoHistory.popLast() else { return }
        continuousPlayback = false; player?.pause(); pendingPreviewPosition = nil
        undoHistory.append(project); project = next
        if !project.clips.contains(where: { $0.id == selectedID }) { selectedID = project.clips.first?.id }
    }
    private func duplicate(_ id: UUID) {
        guard project.clips.count < 500 else { message = mediaText("每个工程最多 500 个片段。", "A project supports up to 500 clips."); return }
        guard let index = project.clips.firstIndex(where: { $0.id == id }) else { return }
        var next = project, clip = project.clips[index]; clip.id = UUID()
        next.clips.insert(clip, at: index + 1); commit(next); selectedID = clip.id
    }
    private func move(_ id: UUID, by offset: Int) {
        guard let index = project.clips.firstIndex(where: { $0.id == id }), project.clips.indices.contains(index + offset) else { return }
        var next = project; next.clips.swapAt(index, index + offset); commit(next)
    }
    private func splitSelected() {
        guard let clip = selectedClip, let index = project.clips.firstIndex(where: { $0.id == clip.id }) else { return }
        let split = playhead
        guard split > clip.start + 0.02, split < clip.end - 0.02 else {
            message = mediaText("请将播放头移到片段内部，再拆分。", "Move the playhead inside the clip before splitting."); return
        }
        var next = project, left = clip, right = clip
        left.end = split; left.transition = nil; right.id = UUID(); right.start = split
        next.clips.replaceSubrange(index...index, with: [left, right]); commit(next)
    }
    private func request(_ action: MediaPendingAction) {
        pendingAction = action
        if isDirty { asksToSave = true } else { finishPendingAction() }
    }
    private func finishPendingAction() {
        guard let action = pendingAction else { return }; pendingAction = nil
        switch action {
        case .close: stopPreview(); dismiss()
        case .open: sheet = .openProject
        case .new:
            stopPreview(); continuousPlayback = false; previewValidationCache = [:]; pendingPreviewPosition = nil
            var value = MediaProject(); value.title = mediaText("新剪辑工程", "New media project")
            project = value; savedProject = value; projectURL = nil; fingerprint = nil
            selectedID = nil; undoHistory = []; redoHistory = []; outputURL = nil; message = ""
        }
    }
    private var audioEditingOnMac: String {
        mediaText("此工程包含独立音频剪辑，请在 Mac 上继续编辑。工程与原素材均已保留。", "Continue editing this audio project on Mac. The project and original media are preserved.")
    }

    private func saveCurrent() {
        if projectURL != nil { saveProject(directory: nil, name: nil) }
        else { sheet = .saveAs }
    }

    private func importSources(_ urls: [URL], asLayer: Bool = false) {
        guard !urls.isEmpty, !busy else { return }
        guard project.sources.count + urls.count <= 200, asLayer ? project.overlays.count + urls.count <= 24 : project.clips.count + urls.count <= 500 else {
            message = mediaText("每个工程最多 200 个素材、500 个片段。", "A project supports up to 200 sources and 500 clips."); return
        }
        continuousPlayback = false; player?.pause(); busy = true
        operationTask = Task { @MainActor in
            defer { busy = false; operationTask = nil }
            do {
                let sources = try await MediaSourceImporter.load(urls, root: library.rootURL, videosOnly: true) { message = $0 }
                try Task.checkCancellation()
                var next = project
                for source in sources {
                    let value: MediaSource
                    if let existing = next.sources.first(where: { $0.path == source.path && $0.sha256 == source.sha256 }) { value = existing }
                    else { value = source; next.sources.append(source) }
                    if asLayer { next.overlays.append(MediaOverlay(sourceID: value.id, start: 0, end: value.duration, at: timelinePlayhead)) }
                    else { next.clips.append(MediaClip(sourceID: value.id, start: 0, end: value.duration)) }
                }
                try next.validate(); commit(next)
                for source in next.sources {
                    if let url = VaultPathResolver.resolve(relativePath: source.path, within: library.rootURL),
                       sources.contains(where: { $0.path == source.path && $0.sha256 == source.sha256 }),
                       let version = try? previewFileVersion(url: url, source: source) { previewValidationCache[source.id] = version }
                }
                if !asLayer { selectedID = next.clips.last?.id }
                message = mediaText("素材已加入时间线；请保存剪辑工程。", "Media added to the timeline. Save the project to keep your edit.")
            } catch is CancellationError { message = mediaText("已取消导入，原素材保留。", "Import cancelled. Original media is preserved.") }
              catch { message = error.localizedDescription }
        }
    }
    private func openProject(_ url: URL) {
        guard !busy else { return }
        guard url.lastPathComponent.lowercased().hasSuffix(".inkcut.json"), MediaSourceImporter.relativePath(url, root: library.rootURL) != nil else {
            message = mediaText("请选择当前资料库中的 .inkcut.json 剪辑工程。", "Choose an .inkcut.json project inside the current library."); return
        }
        busy = true; message = mediaText("正在打开工程…", "Opening project…")
        operationTask = Task { @MainActor in
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() }; busy = false; operationTask = nil }
            do {
                let (bytes, hash) = try await VaultFileIO().read(url)
                guard bytes.count <= 8 * 1024 * 1024 else { throw MediaEditError.invalidProject }
                let value = try JSONDecoder().decode(MediaProject.self, from: bytes); try value.validate()
                guard value.supportsMobileEditing else { message = audioEditingOnMac; return }
                try Task.checkCancellation()
                stopPreview(); continuousPlayback = false; previewValidationCache = [:]; pendingPreviewPosition = nil
                project = value; savedProject = value; projectURL = url; fingerprint = hash
                selectedID = value.clips.first?.id; undoHistory = []; redoHistory = []; outputURL = nil
                message = mediaText("工程已打开。缺失或已变化的素材会在预览、导出时提示。", "Project opened. Preview and export will report missing or changed source files.")
            } catch { message = error.localizedDescription }
        }
    }
    private func saveProject(directory: String?, name: String?) {
        guard !busy, project.supportsMobileEditing else { return }
        busy = true; message = mediaText("正在保存工程…", "Saving project…")
        let value = project, existing = projectURL, expected = fingerprint
        operationTask = Task { @MainActor in
            defer { busy = false; operationTask = nil }
            do {
                try value.validate()
                let target: URL
                if let directory, let name { target = try await destination(directory: directory, name: name, extension: "inkcut.json") }
                else if let existing { target = existing }
                else { throw MediaEditError.invalidProject }
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try Task.checkCancellation()
                let hash = try await VaultFileIO().write(encoder.encode(value), to: target, expectedFingerprint: directory == nil ? expected : nil)
                projectURL = target; fingerprint = hash; savedProject = value
                message = mediaText("工程已保存：", "Project saved: ") + (MediaSourceImporter.relativePath(target, root: library.rootURL) ?? target.lastPathComponent)
                finishPendingAction()
            } catch { message = error.localizedDescription; pendingAction = nil }
        }
    }
    private var nextClipDuration: Double? {
        guard let index = project.clips.firstIndex(where: { $0.id == selectedID }), project.clips.indices.contains(index + 1) else { return nil }
        return project.clips[index + 1].duration
    }
    private var visibleCaptionRange: ClosedRange<Double> {
        guard let index = project.clips.firstIndex(where: { $0.id == selectedID }) else { return 0...max(0, project.duration) }
        return project.clipStarts[index]...(project.clipStarts[index] + project.clips[index].duration)
    }
    private func discardCompositionPreview() {
        compositionPlayer?.pause(); compositionPlayer = nil
        if let compositionPreviewURL { MediaExportService.discardPreview(compositionPreviewURL); self.compositionPreviewURL = nil }
    }
    private func previewComposition() {
        guard !busy, !project.clips.isEmpty else { return }
        continuousPlayback = false; player?.pause(); discardCompositionPreview()
        busy = true; exporting = true; progress = 0
        message = mediaText("正在合成完整效果预览…", "Rendering composition preview…")
        let value = project
        operationTask = Task { @MainActor in
            defer { busy = false; exporting = false; operationTask = nil }
            do {
                let url = try await exportService.preview(project: value, root: library.rootURL) { progress = $0 }
                guard !Task.isCancelled else { MediaExportService.discardPreview(url); throw MediaEditError.cancelled }
                compositionPreviewURL = url; compositionPlayer = AVPlayer(url: url); sheet = .compositionPreview
                message = mediaText("完整合成预览已就绪。", "Composition preview is ready.")
            } catch { message = error.localizedDescription }
        }
    }
    private func exportProject(directory: String, name: String) {
        guard !busy, project.supportsMobileEditing else { return }
        continuousPlayback = false; player?.pause(); busy = true; exporting = true; progress = 0; outputURL = nil
        message = mediaText("正在导出，原素材保持不变…", "Exporting; original media remains unchanged…")
        let value = project
        operationTask = Task { @MainActor in
            defer { busy = false; exporting = false; operationTask = nil }
            do {
                let target = try await destination(directory: directory, name: name, extension: value.output.kind == "video" ? "mp4" : "m4a")
                let result = try await exportService.export(project: value, root: library.rootURL, to: target) { progress = $0 }
                outputURL = result
                message = mediaText("导出完成：", "Export completed: ") + (MediaSourceImporter.relativePath(result, root: library.rootURL) ?? result.lastPathComponent)
            } catch { message = error.localizedDescription }
        }
    }
    private func destination(directory: String, name: String, extension ext: String) async throws -> URL {
        let folder = try await BoardStorageLocations.prepareDirectory(root: library.rootURL, relativePath: directory)
        var stem = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: ":", with: "_")
        if stem.lowercased().hasSuffix("." + ext) { stem = String(stem.dropLast(ext.count + 1)) }
        stem = String(stem.filter { !$0.isNewline && $0 != "\0" })
        while stem.utf8.count > 180 { stem.removeLast() }
        if stem.isEmpty || stem.hasPrefix(".") { stem = "Media-" + String(UUID().uuidString.prefix(8)) }
        var target = folder.appendingPathComponent(stem + "." + ext), index = 2
        while FileManager.default.fileExists(atPath: target.path) { target = folder.appendingPathComponent("\(stem) (\(index)).\(ext)"); index += 1 }
        return target
    }

    private func seekTimeline(to seconds: Double) {
        let target = min(project.duration, max(0, seconds))
        for (index, clip) in project.clips.enumerated() {
            let elapsed = project.clipStarts[index]
            if target < elapsed + clip.duration || index == project.clips.count - 1 {
                let sourceTime = min(clip.end, max(clip.start, clip.start + (target - elapsed) * clip.speed))
                playhead = sourceTime
                if selectedID == clip.id, let player {
                    player.seek(to: CMTime(seconds: sourceTime, preferredTimescale: 600)) { _ in
                        Task { @MainActor in if continuousPlayback { player.playImmediately(atRate: Float(clip.speed)) } }
                    }
                } else {
                    pendingPreviewPosition = sourceTime; selectedID = clip.id
                }
                return
            }
        }
    }
    private func advanceTimeline(after id: UUID) {
        guard continuousPlayback, selectedID == id,
              let index = project.clips.firstIndex(where: { $0.id == id }) else { return }
        if project.clips.indices.contains(index + 1) {
            let next = project.clips[index + 1]
            pendingPreviewPosition = next.start; selectedID = next.id
        } else { continuousPlayback = false; player?.pause() }
    }
    private func previewFileVersion(url: URL, source: MediaSource) throws -> String {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey])
        guard values.isRegularFile == true else { throw MediaEditError.sourceChanged(source.name) }
        return "\(source.path)|\(source.sha256 ?? "")|\(values.fileSize ?? -1)|\(values.contentModificationDate?.timeIntervalSince1970 ?? -1)"
    }
    private func loadPreview() async {
        stopPreview()
        guard let clip = selectedClip, let source = selectedSource else { return }
        let start = min(clip.end, max(clip.start, pendingPreviewPosition ?? clip.start))
        pendingPreviewPosition = nil
        previewMessage = mediaText("正在读取素材…", "Loading source…"); playhead = start
        guard let url = VaultPathResolver.resolve(relativePath: source.path, within: library.rootURL) else { previewMessage = MediaEditError.sourceChanged(source.name).localizedDescription; continuousPlayback = false; return }
        do {
            let version = try previewFileVersion(url: url, source: source)
            if previewValidationCache[source.id] != version {
                let actual = try await MediaExportService.probe(url: url, relativePath: source.path)
                if let expected = source.sha256, expected.lowercased() != actual.sha256?.lowercased() { throw MediaEditError.sourceChanged(source.name) }
                guard abs(actual.duration - source.duration) < 0.1 else { throw MediaEditError.sourceChanged(source.name) }
                try Task.checkCancellation()
                previewValidationCache[source.id] = version
            }
            try Task.checkCancellation()
            guard selectedID == clip.id else { return }
            guard try await AVURLAsset(url: url).load(.isPlayable) else { throw MediaEditError.unsupported }
            try Task.checkCancellation()
            let item = AVPlayerItem(url: url); item.forwardPlaybackEndTime = CMTime(seconds: clip.end, preferredTimescale: 600)
            let next = AVPlayer(playerItem: item); next.volume = Float(clip.volume); next.defaultRate = Float(clip.speed)
            let sought = await next.seek(to: CMTime(seconds: start, preferredTimescale: 600))
            try Task.checkCancellation()
            guard sought else { throw item.error ?? MediaEditError.unsupported }
            guard selectedID == clip.id else { next.pause(); return }
            playbackObserver = next.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main) { time in
                guard !scrubbing, !timelineScrubbing, time.seconds.isFinite else { return }; playhead = time.seconds
            }
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { _ in
                Task { @MainActor in advanceTimeline(after: clip.id) }
            }
            player = next; previewMessage = ""
            if continuousPlayback { next.playImmediately(atRate: Float(clip.speed)) }
        } catch is CancellationError {} catch { previewMessage = error.localizedDescription; continuousPlayback = false }
    }
    private func stopPreview() {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver); self.endObserver = nil }
        if let playbackObserver { player?.removeTimeObserver(playbackObserver); self.playbackObserver = nil }
        player?.pause(); player = nil
    }
}

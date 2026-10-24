import SwiftUI
import UniformTypeIdentifiers

struct MediaEffectsEditor: View {
    @State private var draft: MediaProject
    let visibleRange: ClosedRange<Double>
    let onSave: (MediaProject) -> Void
    @State private var route: Route?
    @State private var error = ""
    @State private var importing = false
    @State private var importTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    private enum Route: Identifiable {
        case overlay(UUID), caption(UUID), importCaptions
        var id: String { switch self { case .overlay(let id): return "o" + id.uuidString; case .caption(let id): return "c" + id.uuidString; case .importCaptions: return "import" } }
    }
    init(project: MediaProject, visibleRange: ClosedRange<Double>, onSave: @escaping (MediaProject) -> Void) {
        _draft = State(initialValue: project); self.visibleRange = visibleRange; self.onSave = onSave
    }
    var body: some View {
        NavigationStack {
            Form {
                Section(mediaText("画中画与混音轨", "Picture-in-picture and audio tracks")) {
                    Menu(mediaText("从已导入素材添加轨道", "Add track from imported media")) {
                        ForEach(draft.sources) { source in
                            Button(source.name) {
                                let layer = MediaOverlay(sourceID: source.id, start: 0, end: source.duration, at: visibleRange.lowerBound)
                                draft.overlays.append(layer); route = .overlay(layer.id)
                            }
                        }
                    }.disabled(draft.sources.isEmpty || draft.overlays.count >= 24)
                    ForEach(Array(draft.overlays.enumerated()), id: \.element.id) { index, layer in
                        VStack(alignment: .leading, spacing: 8) {
                            Button { route = .overlay(layer.id) } label: {
                                Label((draft.sources.first { $0.id == layer.sourceID }?.name ?? "") + " · " + mediaTime(layer.at) + " – " + mediaTime(layer.at + layer.duration), systemImage: "slider.horizontal.3")
                            }
                            HStack {
                                Button(mediaText("下移一层", "Move behind")) { draft.overlays.swapAt(index, index - 1) }.disabled(index == 0)
                                Button(mediaText("上移一层", "Move in front")) { draft.overlays.swapAt(index, index + 1) }.disabled(index == draft.overlays.count - 1)
                                Spacer()
                                Button(role: .destructive) { draft.overlays.removeAll { $0.id == layer.id } } label: { Image(systemName: "trash") }
                            }.font(.caption).buttonStyle(.borderless)
                        }.padding(.vertical, 4)
                    }
                    Text(mediaText("列表末尾显示在最前。最多 24 个叠加轨，同时最多 8 层视频。音轨共同混合并留出防失真余量。", "Later rows appear in front. Up to 24 overlay tracks and 8 concurrent video layers. Audio tracks mix together with clipping headroom."))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section(mediaText("字幕", "Captions")) {
                    HStack {
                        Button(mediaText("添加字幕", "Add caption")) {
                            let cue = MediaCaption(start: visibleRange.lowerBound, end: visibleRange.upperBound, text: mediaText("新字幕", "New caption"))
                            draft.captions.append(cue); route = .caption(cue.id)
                        }.disabled(draft.duration <= 0 || draft.captions.count >= 1000)
                        Button(mediaText("导入 SRT / VTT / TXT", "Import SRT / VTT / TXT")) { route = .importCaptions }.disabled(draft.duration <= 0)
                    }
                    ForEach(draft.captions.sorted { $0.start < $1.start }) { cue in
                        HStack {
                            Button { route = .caption(cue.id) } label: {
                                VStack(alignment: .leading) {
                                    Text(cue.text).lineLimit(2)
                                    Text(mediaTime(cue.start) + " – " + mediaTime(cue.end)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Button(role: .destructive) { draft.captions.removeAll { $0.id == cue.id } } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                        }
                    }
                    Text(mediaText("字幕时间使用输出时间线秒数，不得重叠。无时间 TXT 将成为覆盖当前片段的一条可编辑字幕。带时间 TXT 使用 00:00:01.000 --> 00:00:03.000 字幕内容。", "Captions use output timeline seconds and must not overlap. Untimed TXT becomes one editable caption over the selected clip. Timed TXT uses 00:00:01.000 --> 00:00:03.000 caption text."))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section(mediaText("字幕样式", "Caption style")) {
                    mediaNumberField(mediaText("字号（720p）", "Font size at 720p"), value: $draft.captionStyle.fontSize)
                    TextField(mediaText("文字颜色 #RRGGBB", "Text color #RRGGBB"), text: $draft.captionStyle.textColor).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    Text(mediaText("背景不透明度", "Background opacity")); Slider(value: $draft.captionStyle.backgroundOpacity, in: 0...1)
                    Text(mediaText("视频导出会烧录字幕。音频导出保留混音效果，不含字幕画面。", "Video exports burn in captions. Audio exports retain the mix without caption images.")).font(.caption).foregroundStyle(.secondary)
                }
                if importing { HStack { ProgressView(); Button(mediaText("取消导入", "Cancel import")) { importTask?.cancel() } } }
                if !error.isEmpty { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(mediaText("叠加轨与字幕", "Tracks and captions")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(mediaText("取消", "Cancel")) { importTask?.cancel(); dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(mediaText("应用", "Apply")) {
                    draft.captions.sort { $0.start < $1.start }; draft.schemaVersion = 2
                    do { try draft.validate(); onSave(draft); dismiss() } catch { self.error = error.localizedDescription }
                }.disabled(importing) }
            }
            .sheet(item: $route) { route in
                switch route {
                case .overlay(let id):
                    if let layer = draft.overlays.first(where: { $0.id == id }), let source = draft.sources.first(where: { $0.id == layer.sourceID }) {
                        MediaOverlayEditor(layer: layer, source: source) { next in
                            if let i = draft.overlays.firstIndex(where: { $0.id == id }) { draft.overlays[i] = next }
                        }
                    }
                case .caption(let id):
                    if let cue = draft.captions.first(where: { $0.id == id }) {
                        MediaCaptionEditor(cue: cue, duration: draft.duration) { next in
                            if let i = draft.captions.firstIndex(where: { $0.id == id }) { draft.captions[i] = next }
                        }
                    }
                case .importCaptions:
                    MediaDocumentPicker(types: [UTType(filenameExtension: "srt") ?? .data, UTType(filenameExtension: "vtt") ?? .text, .plainText], multiple: false) { urls in
                        self.route = nil; if let url = urls.first { importCaptions(url) }
                    } onCancel: { self.route = nil }
                }
            }
            .interactiveDismissDisabled(importing)
            .onDisappear { importTask?.cancel() }
        }
    }
    private func importCaptions(_ url: URL) {
        importing = true; error = ""
        importTask = Task { @MainActor in
            defer { importing = false; importTask = nil }
            do {
                let cues = try await MediaCaptionImporter.load(url, fallback: visibleRange, duration: draft.duration)
                try Task.checkCancellation()
                var next = draft; next.captions += cues; next.captions.sort { $0.start < $1.start }
                try next.validate(); draft = next
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct MediaOverlayEditor: View {
    @State private var draft: MediaOverlay
    let source: MediaSource
    let onSave: (MediaOverlay) -> Void
    @Environment(\.dismiss) private var dismiss
    init(layer: MediaOverlay, source: MediaSource, onSave: @escaping (MediaOverlay) -> Void) { _draft = State(initialValue: layer); self.source = source; self.onSave = onSave }
    private var valid: Bool {
        [draft.start, draft.end, draft.speed, draft.volume, draft.at, draft.x, draft.y, draft.width, draft.height, draft.opacity].allSatisfy(\.isFinite)
        && draft.start >= 0 && draft.end > draft.start && draft.end <= source.duration && (0.25...4).contains(draft.speed)
        && (0...1).contains(draft.volume) && draft.at >= 0 && draft.at + draft.duration <= 43200
        && draft.x >= 0 && draft.y >= 0 && draft.width > 0 && draft.height > 0 && draft.x + draft.width <= 1 && draft.y + draft.height <= 1 && (0...1).contains(draft.opacity)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section { Text(source.name) }
                Section(mediaText("时间线与裁剪（秒）", "Timeline and trim (seconds)")) {
                    mediaNumberField(mediaText("时间线开始", "Timeline start"), value: $draft.at)
                    mediaNumberField(mediaText("素材开始", "Source start"), value: $draft.start)
                    mediaNumberField(mediaText("素材结束", "Source end"), value: $draft.end)
                    mediaNumberField(mediaText("速度", "Speed"), value: $draft.speed)
                    Text(mediaText("音量", "Volume")); Slider(value: $draft.volume, in: 0...1)
                }
                if source.hasVideo {
                    Section(mediaText("画中画位置（0–1）", "Inset position (0–1)")) {
                        mediaNumberField("X", value: $draft.x); mediaNumberField("Y", value: $draft.y)
                        mediaNumberField(mediaText("宽度", "Width"), value: $draft.width)
                        mediaNumberField(mediaText("高度", "Height"), value: $draft.height)
                        Text(mediaText("不透明度", "Opacity")); Slider(value: $draft.opacity, in: 0...1)
                        Text(mediaText("X/Y 从画面左上角计算，素材等比例包含在此区域内。", "X/Y starts at the upper-left corner. Media fits proportionally inside this rectangle.")).font(.caption)
                    }
                }
                if !valid { Text(mediaText("请检查时间、速度和画中画范围；区域不能超出画面。", "Check time, speed and inset bounds; the rectangle must remain inside the frame.")).foregroundStyle(.red) }
            }
            .navigationTitle(mediaText("编辑叠加轨", "Edit overlay track")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(mediaText("取消", "Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(mediaText("应用", "Apply")) { onSave(draft); dismiss() }.disabled(!valid) }
            }
        }
    }
}
struct MediaCaptionEditor: View {
    @State private var draft: MediaCaption
    let duration: Double
    let onSave: (MediaCaption) -> Void
    @Environment(\.dismiss) private var dismiss
    init(cue: MediaCaption, duration: Double, onSave: @escaping (MediaCaption) -> Void) { _draft = State(initialValue: cue); self.duration = duration; self.onSave = onSave }
    var body: some View {
        NavigationStack {
            Form {
                mediaNumberField(mediaText("开始（秒）", "Start (seconds)"), value: $draft.start)
                mediaNumberField(mediaText("结束（秒）", "End (seconds)"), value: $draft.end)
                TextEditor(text: $draft.text).frame(minHeight: 140)
                Text("\(draft.text.count) / 1000").font(.caption)
            }
            .navigationTitle(mediaText("编辑字幕", "Edit caption")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(mediaText("取消", "Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(mediaText("应用", "Apply")) { onSave(draft); dismiss() }
                    .disabled(!draft.start.isFinite || !draft.end.isFinite || draft.start < 0 || draft.end <= draft.start || draft.end > duration || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.text.count > 1000) }
            }
        }
    }
}
func mediaNumberField(_ title: String, value: Binding<Double>) -> some View {
    HStack {
        Text(title)
        TextField(title, value: value, format: .number.precision(.fractionLength(0...3))).multilineTextAlignment(.trailing).keyboardType(.decimalPad)
    }
}

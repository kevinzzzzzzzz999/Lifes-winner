import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct MediaDocumentPicker: UIViewControllerRepresentable {
    let types: [UTType]
    let multiple: Bool
    var directoryURL: URL? = nil
    let onSelect: ([URL]) -> Void
    let onCancel: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let view = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
        view.allowsMultipleSelection = multiple; view.directoryURL = directoryURL; view.delegate = context.coordinator
        return view
    }
    func updateUIViewController(_ view: UIDocumentPickerViewController, context: Context) {}
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let parent: MediaDocumentPicker
        init(parent: MediaDocumentPicker) { self.parent = parent }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { parent.onSelect(urls) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { parent.onCancel() }
    }
}

struct MediaDestinationSheet: View {
    let library: DocumentLibrary
    let fileExtension: String
    let title: String
    let onConfirm: (String, String) -> Void
    let onCancel: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var directory: String
    @State private var name: String
    @State private var choosesDirectory = false

    init(library: DocumentLibrary, initialDirectory: String, initialName: String, fileExtension: String,
         title: String, onConfirm: @escaping (String, String) -> Void, onCancel: @escaping () -> Void) {
        self.library = library; self.fileExtension = fileExtension; self.title = title
        self.onConfirm = onConfirm; self.onCancel = onCancel
        _directory = State(initialValue: initialDirectory); _name = State(initialValue: initialName)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section(mediaText("文件名", "Filename")) {
                    TextField(mediaText("名称", "Name"), text: $name).accessibilityIdentifier("media.saveName")
                    Text("." + fileExtension).font(.caption).foregroundStyle(.secondary)
                }
                Section(mediaText("保存位置", "Save location")) {
                    Button { choosesDirectory = true } label: {
                        HStack { Label(directory.isEmpty ? library.rootURL.lastPathComponent : directory, systemImage: "folder"); Spacer(); Image(systemName: "chevron.right") }
                    }
                    Text(mediaText("保存到当前资料库。已有同名文件会保留，新文件自动添加序号。", "Saved inside the current library. Existing files are preserved; a numbered name is used when necessary."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(mediaText("取消", "Cancel")) { onCancel(); dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(mediaText("继续", "Continue")) { onConfirm(directory, name) }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled()
            .sheet(isPresented: $choosesDirectory) {
                BoardSaveDirectoryPicker(library: library, initialPath: directory) { directory = $0 }
            }
        }
    }
}

struct MediaClipEditor: View {
    let source: MediaSource
    let onSave: (MediaClip) -> Void
    let nextDuration: Double?
    @State private var draft: MediaClip
    @Environment(\.dismiss) private var dismiss
    init(clip: MediaClip, source: MediaSource, nextDuration: Double? = nil, onSave: @escaping (MediaClip) -> Void) {
        self.source = source; self.nextDuration = nextDuration; self.onSave = onSave; _draft = State(initialValue: clip)
    }
    private var valid: Bool {
        [draft.start, draft.end, draft.speed, draft.volume].allSatisfy(\.isFinite) && draft.start >= 0 && draft.end > draft.start
            && draft.end <= source.duration && (0.25...4).contains(draft.speed) && (0...1).contains(draft.volume)
            && (draft.transition == nil || (draft.transition!.duration.isFinite && draft.transition!.duration > 0 && draft.transition!.duration <= transitionMaximum))
    }
    private var transitionMaximum: Double { min(5, draft.duration / 2, (nextDuration ?? 10) / 2) }
    var body: some View {
        NavigationStack {
            Form {
                Section { Text(source.name); Text(mediaText("原素材时长：", "Source duration: ") + mediaTime(source.duration)) }
                Section(mediaText("裁剪范围（源素材秒数）", "Trim range (source seconds)")) {
                    numberField(mediaText("开始", "Start"), value: $draft.start)
                    numberField(mediaText("结束", "End"), value: $draft.end)
                    Text(mediaText("只保存片段范围，不会裁掉或覆盖原文件。", "Only the clip range is saved. The original file is not trimmed or overwritten."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section(mediaText("速度", "Speed")) {
                    numberField(mediaText("倍速", "Rate"), value: $draft.speed)
                    Slider(value: $draft.speed, in: 0.25...4, step: 0.05)
                    Text("0.25× – 4×").font(.caption).foregroundStyle(.secondary)
                }
                Section(mediaText("音量", "Volume")) {
                    Slider(value: $draft.volume, in: 0...1)
                    Text("\(Int((min(1, max(0, draft.volume)) * 100).rounded()))%")
                    Toggle(mediaText("静音", "Mute"), isOn: Binding(get: { draft.volume == 0 }, set: { draft.volume = $0 ? 0 : 1 }))
                }
                Section(mediaText("到下一片段的转场", "Transition to the next clip")) {
                    Toggle(mediaText("交叉淡化", "Cross dissolve"), isOn: Binding(get: { draft.transition != nil }, set: {
                        draft.transition = $0 ? MediaTransition(duration: min(0.5, transitionMaximum)) : nil
                    }))
                    if draft.transition != nil {
                        numberField(mediaText("时长（秒）", "Duration (seconds)"), value: Binding(get: { draft.transition?.duration ?? 0.5 }, set: { draft.transition?.duration = $0 }))
                    }
                    Text(nextDuration == nil ? mediaText("最后一个片段的转场暂不生效。", "The last clip's transition has no effect yet.") : mediaText("画面与音频同时交叉淡化。最长：", "Picture and audio crossfade together. Maximum: ") + mediaTime(transitionMaximum))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if valid { Text(mediaText("片段输出时长：", "Clip output duration: ") + mediaTime(draft.duration)) }
                else { Text(mediaText("范围须满足 0 ≤ 开始 < 结束 ≤ 原时长，速度 0.25–4，音量 0–1。", "Use 0 ≤ start < end ≤ source duration, speed 0.25–4, and volume 0–1.")).foregroundStyle(.red) }
            }
            .navigationTitle(mediaText("编辑片段", "Edit clip")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(mediaText("取消", "Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(mediaText("应用", "Apply")) { onSave(draft); dismiss() }.disabled(!valid) }
            }
        }
    }
    private func numberField(_ title: String, value: Binding<Double>) -> some View {
        HStack {
            Text(title)
            TextField(title, value: value, format: .number.precision(.fractionLength(0...3)))
                .multilineTextAlignment(.trailing).keyboardType(.decimalPad)
        }
    }
}

struct MediaProjectSettings: View {
    @State private var draft: MediaProject
    let onSave: (MediaProject) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    init(project: MediaProject, onSave: @escaping (MediaProject) -> Void) { _draft = State(initialValue: project); self.onSave = onSave }
    var body: some View {
        NavigationStack {
            Form {
                Section(mediaText("工程名称", "Project name")) { TextField(mediaText("名称", "Name"), text: $draft.title) }
                Section(mediaText("导出", "Export")) {
                    Picker(mediaText("类型", "Type"), selection: $draft.output.kind) {
                        Text(mediaText("视频 MP4", "Video MP4")).tag("video")
                    }
                    Picker(mediaText("视频画幅", "Video resolution"), selection: Binding(get: { draft.output.height }, set: {
                        draft.output.height = $0; draft.output.width = $0 == 1080 ? 1920 : 1280
                    })) {
                        Text("720p · 1280 × 720").tag(720)
                        Text("1080p · 1920 × 1080").tag(1080)
                    }.disabled(draft.output.kind == "audio")
                    Text(mediaText("视频固定 30 fps，保留原素材的方向和声音。音频剪辑与 M4A 导出请使用 Mac。", "Video uses 30 fps, preserving source orientation and sound. Use Mac for audio editing and M4A export."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Text(mediaText("iPhone、iPad 与 Mac 使用相同 .inkcut.json 工程。原素材引用当前资料库中的相对路径；外部导入素材会复制到资料库。", "iPhone, iPad, and Mac use the same .inkcut.json project format. Sources use library-relative paths; external imports are copied into the library."))
                    Text(mediaText("每个工程最多 200 个素材、500 个片段，总时长不超过 12 小时。", "Up to 200 sources, 500 clips, and 12 hours per project."))
                }.font(.footnote).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(mediaText("工程与输出设置", "Project and output settings")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(mediaText("取消", "Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(mediaText("应用", "Apply")) {
                    do { try draft.validate(); onSave(draft); dismiss() } catch { self.error = error.localizedDescription }
                } }
            }
        }
    }
}

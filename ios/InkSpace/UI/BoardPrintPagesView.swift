import SwiftUI

struct BoardPrintSetupView: View {
    @Bindable var store: BoardStore
    let boardID: UUID
    let region: CGRect
    @State private var orientation: BoardPrintOrientation = .portrait
    @State private var splitMode: BoardPrintSplitMode = .tile
    @State private var scale: Double = 1
    @Environment(\.dismiss) private var dismiss

    private var result: Result<[BoardPrintFrame], Error> {
        Result {
            let frames = try PrintPageGeometry.frames(for: region, orientation: orientation,
                mode: splitMode, scale: scale, canvasSize: store.document.canvasWidth)
            try PrintPageGeometry.validate(frames: store.printFrames + frames, canvasSize: store.document.canvasWidth)
            return frames
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "纸张")) {
                    Text(String(localized: "美国信纸 Letter · 8.5 × 11 英寸"))
                    Picker(String(localized: "方向"), selection: $orientation) {
                        ForEach(BoardPrintOrientation.allCases) { Text($0.title).tag($0) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("print.orientation")
                    Text(String(localized: "四边预留半英寸，页脚中间按最终页序编号。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section(String(localized: "如何放入所选内容")) {
                    Picker(String(localized: "分页方式"), selection: $splitMode) {
                        ForEach(BoardPrintSplitMode.allCases) { Text($0.title).tag($0) }
                    }.accessibilityIdentifier("print.splitMode")
                    if splitMode == .tile {
                        HStack { Text(String(localized: "打印比例")); Spacer(); Text("\(Int(scale * 100))%").monospacedDigit() }
                        Slider(value: $scale, in: 0.1...2, step: 0.05).accessibilityIdentifier("print.scale")
                        Text(String(localized: "100% 保持白板内容比例。屏幕放大、缩小不改变导出的纸张尺寸。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    switch result {
                    case .success(let frames):
                        Label(String(localized: "将添加 \(frames.count) 页"), systemImage: "doc.on.doc")
                            .accessibilityIdentifier("print.pageCount")
                        Text(String(localized: "纸框只记录打印范围。原有笔迹、文件和节点保持原位，之后可在页面列表调整顺序。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    case .failure(let error): Text(error.localizedDescription).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(String(localized: "划分打印页面")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "添加纸框")) {
                        if store.document.id == boardID, !store.isBusy,
                           case .success(let frames) = result, store.appendPrintFrames(frames) {
                            store.printOrientation = orientation
                            store.printScale = scale
                            dismiss()
                        }
                    }.disabled({ if case .failure = result { return true }; return false }())
                     .accessibilityIdentifier("print.confirm")
                }
            }
        }
        .disabled(store.isBusy || store.document.id != boardID)
    }
}

struct BoardPrintPagesView: View {
    @Bindable var store: BoardStore
    let onExport: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle(String(localized: "在白板显示打印框"), isOn: $store.showsPrintFrames)
                        .accessibilityIdentifier("print.showFrames")
                        .onChange(of: store.showsPrintFrames) { _, visible in
                            if !visible { store.selectedPrintFrameID = nil }
                        }
                    Text(String(localized: "每个框是一页 Letter。拖动列表右侧手柄调整页序，页码会自动更新。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if store.printFrames.isEmpty {
                    ContentUnavailableView(String(localized: "还没有打印页面"), systemImage: "doc.badge.plus",
                        description: Text(String(localized: "回到白板，选择“打印”，可放置一页或框选已有内容分页。")))
                } else {
                    Section(String(localized: "打印顺序")) {
                        ForEach(Array(store.printFrames.enumerated()), id: \.element.id) { index, frame in
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(String(localized: "第 \(index + 1) 页 · \(frame.orientation.title)"))
                                    Text(String(localized: "Letter · 打印比例 \(Int(frame.pdfScale * 100))%"))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(String(localized: "定位")) { store.focusPrintFrame(frame); dismiss() }
                                    .buttonStyle(.borderless).accessibilityIdentifier("print.locate.\(frame.id)")
                            }
                        }
                        .onMove { store.movePrintFrames(from: $0, to: $1) }
                        .onDelete { indices in
                            let frames = store.printFrames
                            store.removePrintFrames(ids: Set(indices.compactMap { frames.indices.contains($0) ? frames[$0].id : nil }))
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "打印页面")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { dismiss() } }
                ToolbarItem(placement: .primaryAction) { EditButton() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "导出")) { onExport() }.disabled(store.printFrames.isEmpty)
                        .accessibilityIdentifier("print.export")
                }
            }
        }
        .disabled(store.isBusy)
    }
}

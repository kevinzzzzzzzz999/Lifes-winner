import SwiftUI

struct BoardWritingAidSettingsView: View {
    @Bindable var controller: BoardWritingAidController
    let canEdit: Bool
    @State private var confirmsReload = false

    var body: some View {
        Form {
            Section {
                ForEach(BoardWritingAidMode.allCases) { mode in
                    Button {
                        controller.selectMode(mode)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: symbol(mode)).frame(width: 26)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(mode.title).foregroundStyle(PadDesign.ink)
                                Text(detail(mode)).font(.caption).foregroundStyle(PadDesign.secondaryInk)
                            }
                            Spacer(minLength: 8)
                            if controller.mode == mode { Image(systemName: "checkmark.circle.fill") }
                        }.frame(minHeight: 48)
                    }
                    .disabled(!canEdit && mode != .off)
                    .accessibilityIdentifier("writingAid.mode.\(mode.rawValue)")
                    .accessibilityAddTraits(controller.mode == mode ? .isSelected : [])
                }
            } header: { Text(String(localized: "辅助笔模式")) }
            footer: {
                Text(String(localized: "普通书写默认关闭辅助笔。选回任何常用笔即可退出；单指移动和双指缩放仍可使用。激光轨迹不会保存，胶带单独保存，不改原笔迹。"))
            }
            Section(String(localized: "手写转文字")) {
                LabeledContent(String(localized: "固定字号"), value: "\(Int(controller.settings.fontSize))")
                Slider(value: $controller.settings.fontSize, in: BoardWritingAidSettings.fontSizeRange, step: 1)
                    .accessibilityLabel(String(localized: "固定字号"))
                    .accessibilityIdentifier("writingAid.scribble.fontSize")
                Toggle(String(localized: "停顿后自动生成文字卡"), isOn: $controller.settings.automaticallyCreatesText)
                    .accessibilityIdentifier("writingAid.scribble.automatic")
                LabeledContent(String(localized: "停顿时间"), value: String(format: "%.1f s", controller.settings.pauseDuration))
                Slider(value: $controller.settings.pauseDuration, in: BoardWritingAidSettings.pauseDurationRange, step: 0.1)
                    .accessibilityLabel(String(localized: "停顿时间"))
                Text(String(localized: "在底部文字输入区用 Pencil 随手写，检查识别结果后生成可编辑文字卡。系统需要启用随手写；无法识别时也可输入或修改文字。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section(String(localized: "激光演示")) {
                LabeledContent(String(localized: "轨迹消退"), value: String(format: "%.2f s", controller.settings.laserFadeDuration))
                Slider(value: $controller.settings.laserFadeDuration, in: 0.25...2, step: 0.05)
                    .accessibilityLabel(String(localized: "轨迹消退"))
            }
            if let tapes = controller.tapes, !tapes.tapes.isEmpty {
                Section(String(localized: "已保存胶带")) {
                    ForEach(Array(tapes.tapes.enumerated()), id: \.element.id) { index, tape in
                        HStack {
                            Button {
                                controller.toggleTape(tape.id)
                            } label: {
                                Label(tape.isRevealed ? String(localized: "胶带 \(index + 1) · 已揭开") : String(localized: "胶带 \(index + 1) · 遮挡中"), systemImage: tape.isRevealed ? "eye" : "eye.slash")
                            }
                            Spacer()
                            Button(role: .destructive) { controller.deleteTape(tape.id) } label: {
                                Image(systemName: "trash").frame(minWidth: 44, minHeight: 44)
                            }.accessibilityLabel(String(localized: "彻底删除胶带 \(index + 1)"))
                        }.disabled(!canEdit || controller.isSaving || controller.hasTapeDraft)
                    }
                    Text(String(localized: "眼睛用于揭开或重新遮挡，揭开后所有模式均干净显示原文，不留下边框或纹路；可在本清单重新遮挡。揭开不等于删除，垃圾桶会彻底删除胶带，原生橡皮只擦笔迹。胶带独立保存，可随完整备份恢复。目前在 iPad 显示，Mac 仍显示未遮挡原笔记。胶带仅作复习提示，不是隐私涂黑；导出 PDF、图片或原文件均不包含遮挡。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if !controller.status.isEmpty {
                Section {
                    Text(controller.status).font(.callout)
                    Button(String(localized: "重试保存胶带")) { controller.retryTapeDraft() }
                        .disabled(!canEdit || controller.isSaving)
                    Button(String(localized: "重新载入已保存胶带")) {
                        if controller.hasTapeDraft { confirmsReload = true }
                        else { controller.reloadSavedTapes(discardLocalDraft: false) }
                    }.disabled(controller.isSaving)
                }
            }
        }
        .tint(PadDesign.accent)
        .navigationTitle(String(localized: "辅助笔"))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(String(localized: "放弃本地未保存的胶带草稿？"), isPresented: $confirmsReload, titleVisibility: .visible) {
            Button(String(localized: "放弃草稿并重新载入"), role: .destructive) {
                controller.reloadSavedTapes(discardLocalDraft: true)
            }
            Button(String(localized: "保留草稿"), role: .cancel) {}
        } message: { Text(String(localized: "只放弃本次未保存的胶带，保留其他设备已保存的内容和原笔迹。")) }
    }

    private func symbol(_ mode: BoardWritingAidMode) -> String {
        switch mode {
        case .off: "pencil.tip"
        case .laser: "laser.burst"
        case .wavy: "water.waves"
        case .fill: "drop.fill"
        case .tape: "rectangle.fill.on.rectangle.fill"
        case .scribble: "character.cursor.ibeam"
        }
    }
    private func detail(_ mode: BoardWritingAidMode) -> String {
        switch mode {
        case .off: String(localized: "使用原生笔、橡皮擦和套索")
        case .laser: String(localized: "临时演示轨迹，自动消退")
        case .wavy: String(localized: "从起点到终点绘制波浪线")
        case .fill: String(localized: "圈出区域，收笔自动闭合并填色，可撤销和擦除")
        case .tape: String(localized: "iPad 复习遮挡；轻点揭开，再点重新遮住")
        case .scribble: String(localized: "识别并核对文字，生成文字卡")
        }
    }
}

import SwiftUI

struct DocumentExpansionSheet: View {
    let fileCount: Int
    let usesChosenPoint: Bool
    let onExpand: (DocumentExpansionOptions) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var options = DocumentExpansionOptions()

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "排列方向")) {
                    Picker(String(localized: "方向"), selection: $options.direction) {
                        ForEach(DocumentExpansionDirection.allCases) { direction in
                            Text(direction.title).tag(direction)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("expansion.direction")
                    if options.direction == .grid {
                        Stepper(String(localized: "每行 \(options.columns) 页"), value: $options.columns, in: 1...24)
                            .accessibilityIdentifier("expansion.columns")
                    }
                }
                Section {
                    HStack {
                        Text(String(localized: "页面大小"))
                        Spacer()
                        Text("\(Int((options.scale * 100).rounded()))%")
                            .monospacedDigit().accessibilityIdentifier("expansion.scaleValue")
                    }
                    Slider(value: $options.scale, in: 0.25...2, step: 0.25)
                        .accessibilityLabel(String(localized: "页面比例")).accessibilityIdentifier("expansion.scale")
                    HStack {
                        ForEach([0.5, 1.0, 1.5, 2.0], id: \.self) { scale in
                            Button("\(Int(scale * 100))%") { options.scale = scale }
                                .buttonStyle(.bordered)
                                .tint(options.scale == scale ? .teal : .gray)
                                .accessibilityIdentifier("expansion.scale.\(Int(scale * 100))")
                        }
                    }
                } footer: {
                    Text(String(localized: "调整的是页面在白板上的大小，页面长宽比保持不变。"))
                }
                Section(String(localized: "放置位置")) {
                    Label(usesChosenPoint ? String(localized: "从你选定的放置点开始") : String(localized: "从所选文件卡片的位置开始"), systemImage: "scope")
                    Text(String(localized: "\(fileCount) 个文件按文件名顺序展开。确认后以页面替换文件卡片；原文件保持关联。"))
                        .foregroundStyle(.secondary)
                }
                Section(String(localized: "文档与批注")) {
                    Text(String(localized: "PDF 的笔迹保存回原 PDF。Word、PPT、Excel、Markdown 和图片会在原文旁生成关联的 PDF 批注版，手写保存到批注版。"))
                    Text(String(localized: "Excel 按单元格生成阅读版，宽表按列分段，保留原表。图表和复杂对象请先从 Excel 导出 PDF；这里不会重算公式或沿用原表的打印区域。"))
                        .foregroundStyle(.secondary)
                    Text(String(localized: "Word 使用适合阅读的排版，可能与 Office 中的分页不同。原文更新后重新添加并展开，可生成新版本；已有页面和批注保留。"))
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(String(localized: "展开文件")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "展开")) { onExpand(options); dismiss() }
                        .fontWeight(.semibold).accessibilityIdentifier("expansion.confirm")
                }
            }
        }
        .presentationDetents([.large])
    }
}

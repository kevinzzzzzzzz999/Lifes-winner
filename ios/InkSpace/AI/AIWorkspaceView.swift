import SwiftUI
import UIKit

struct AIWorkspaceView: View {
    let store: BoardStore
    @Environment(\.dismiss) private var dismiss
    @State private var question = String(localized: "请提炼这些笔记的知识框架，并整理成思维导图。")
    @State private var includeSnapshot = false
    @State private var apiKey = ""
    @AppStorage("openaiModel") private var model = "gpt-6-astra"
    @State private var result: AIOutline?
    @State private var error: String?
    @State private var running = false
    @State private var showSettings = false
    @State private var analysisTask: Task<Void, Never>?
    @State private var inserted = false

    private var selected: [BoardItem] { store.document.items.filter { store.selectedIDs.contains($0.id) } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Label(String(localized: "从笔记到知识框架"), systemImage: "sparkles").font(.largeTitle.bold())
                    Text(String(localized: "将发送你选择的 \(selected.count) 个节点和下方的问题。截图只有勾选后才会发送。"))
                        .foregroundStyle(.secondary)
                    TextEditor(text: $question).frame(minHeight: 130).padding(8)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    Toggle(String(localized: "附上当前画面截图"), isOn: $includeSnapshot).disabled(store.lastSnapshot == nil)
                    if includeSnapshot, let image = store.lastSnapshot {
                        Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 260)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    if store.lastSnapshot == nil { Text(String(localized: "需要分析手写时，先返回画布点“截图”。")).font(.footnote).foregroundStyle(.secondary) }
                    HStack(spacing: 16) {
                        Button(action: analyze) {
                            Label(running ? String(localized: "正在分析…") : String(localized: "分析并提炼"), systemImage: "sparkles")
                        }.buttonStyle(.borderedProminent).disabled(running)
                        if running { Button(String(localized: "取消")) { analysisTask?.cancel() } }
                        Link(String(localized: "打开 ChatGPT"), destination: URL(string: "https://chatgpt.com")!)
                    }
                    if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                    if let result {
                        Divider()
                        Text(String(localized: "提炼结果")).font(.title2.bold())
                        OutlineTree(outline: result, depth: 0)
                        Button(inserted ? String(localized: "已插入白板") : String(localized: "插入为思维导图")) {
                            store.insertOutline(result)
                            inserted = true
                        }.buttonStyle(.borderedProminent).disabled(inserted)
                    }
                    Text(String(localized: "API 调用使用你在本机填写的密钥；密钥保存在本设备钥匙串，不写入白板或 iCloud 仓库。网页方式由你手动粘贴截图。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(28).frame(maxWidth: 900)
            }
            .navigationTitle(String(localized: "AI 工作台"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "返回画布")) { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button(String(localized: "API 设置"), systemImage: "key") { showSettings = true } }
            }
            .sheet(isPresented: $showSettings) {
                NavigationStack {
                    Form {
                        Section(String(localized: "个人 API 设置")) {
                            SecureField("OpenAI API Key", text: $apiKey).textInputAutocapitalization(.never).autocorrectionDisabled()
                            TextField(String(localized: "模型名称"), text: $model).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Text(String(localized: "使用你的 API 账户可用且支持图像与结构化输出的模型。此版本尚未进行真实 API 联调。"))
                        }
                    }.navigationTitle(String(localized: "API 设置"))
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "保存")) {
                            do { try APIKeyStore.save(apiKey); showSettings = false }
                            catch {
                                DiagnosticsCenter.shared.record(code: .settingsFailed, operation: .settings, error: error)
                                self.error = error.localizedDescription
                            }
                        } } }
                }.presentationDetents([.medium, .large])
            }
            .onAppear {
                do { apiKey = try APIKeyStore.read() }
                catch {
                    DiagnosticsCenter.shared.record(code: .settingsFailed, operation: .settings, error: error)
                    self.error = error.localizedDescription
                }
            }
            .onDisappear { analysisTask?.cancel() }
        }
        .opensExternalLinksInApp()
    }

    private func analyze() {
        error = nil
        result = nil
        inserted = false
        running = true
        let material = selected.map { item in
            String(localized: "标题：\(item.title)\n\(item.text ?? "")\n来源：\(item.sourcePath ?? String(localized: "白板"))\(item.page.map { String(localized: "，第\($0)页") } ?? "")")
        }.joined(separator: "\n\n")
        let text = question + (material.isEmpty ? "" : String(localized: "\n\n以下是选中内容：\n") + material)
        let image = includeSnapshot ? store.document.previewPNG : nil
        analysisTask = Task {
            defer { running = false }
            do {
                let outline = try await AIClient().outline(text: text, imagePNG: image, model: model, apiKey: apiKey)
                try Task.checkCancellation()
                result = outline
            } catch is CancellationError { error = String(localized: "分析已取消。") }
            catch {
                switch error {
                case AIError.missingKey, AIError.missingModel, AIError.noInput: break
                default: DiagnosticsCenter.shared.record(code: .aiRequestFailed, operation: .aiAnalysis, error: error)
                }
                self.error = error.localizedDescription
            }
        }
    }
}

private struct OutlineTree: View {
    let outline: AIOutline
    let depth: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(outline.title).font(depth == 0 ? .title3.bold() : .body)
            ForEach(Array(outline.children.enumerated()), id: \.offset) { _, child in
                OutlineTree(outline: child, depth: depth + 1).padding(.leading, 22)
            }
        }
    }
}

extension BoardStore {
    func insertOutline(_ outline: AIOutline) {
        guard canEditBoardContents else { return }
        guard (try? outline.validatedCount()) != nil else { status = String(localized: "导图数据未通过检查"); return }
        var nodes = [BoardItem]()
        var edges = [BoardEdge]()
        var cursorY: Double = 0
        let origin = CGPoint(x: min(990_000, max(100, viewportCenter.x)),
                             y: min(950_000, max(100, viewportCenter.y)))
        @discardableResult
        func place(_ entry: AIOutline, depth: Int, parent: UUID?) -> (UUID, Double) {
            let id = UUID()
            var childPositions: [Double] = []
            for child in entry.children { childPositions.append(place(child, depth: depth + 1, parent: id).1) }
            let y: Double
            if childPositions.isEmpty { y = cursorY; cursorY += 160 }
            else { y = (childPositions.first! + childPositions.last!) / 2 }
            nodes.append(BoardItem(id: id, kind: .text,
                                   x: origin.x + Double(depth) * 420, y: origin.y + y,
                                   width: 340, height: 120, title: entry.title, text: entry.title))
            if let parent { edges.append(BoardEdge(from: parent, to: id)) }
            return (id, y)
        }
        let root = place(outline, depth: 0, parent: nil).0
        if let parent = document.items.first(where: { selectedIDs.contains($0.id) }) {
            edges.append(BoardEdge(from: parent.id, to: root))
        }
        document.items.append(contentsOf: nodes)
        document.edges.append(contentsOf: edges)
        selectedIDs = [root]
        changed()
        command = CanvasCommand(action: .jump(CGPoint(x: origin.x + 200, y: origin.y + 200), zoom: zoom))
        status = String(localized: "已插入 \(nodes.count) 个导图节点")
    }
}

import SwiftUI
import Observation
import WebKit

@MainActor @Observable final class BoardRichTextEditorModel: NSObject, WKScriptMessageHandler {
    private(set) var page = BoardRichTextPage()
    private(set) var pageID = UUID()
    private(set) var ready = false
    private(set) var busy = false
    private(set) var preview = false
    private(set) var error: String?
    private var initial: BoardItem?
    private var baselineHTML = ""
    private var closed = false
    private var saving = false
    func start(_ item: BoardItem) async {
        guard initial == nil,!closed else { return };initial = item
        await load(item)
    }
    private func load(_ item: BoardItem) async {
        busy = true
        page.webView.configuration.userContentController.add(self,name:"richTextChanged")
        do {
            let value = try await page.load(item:item,editable:true)
            guard !closed else { return };baselineHTML = value["html"] as? String ?? "";ready = true;error = nil
        } catch { if !closed { self.error = error.localizedDescription } }
        busy = false
    }
    func retry() async {
        guard !closed,!busy,let initial else { return }
        page.webView.configuration.userContentController.removeScriptMessageHandler(forName:"richTextChanged");page.close()
        page = BoardRichTextPage();pageID = UUID();ready = false;preview = false
        await load(initial)
    }
    func snapshot() async throws -> BoardRichTextValue {
        guard ready,!busy,!closed else { throw BoardRichTextError.unavailable }
        busy = true;saving = true
        // Commit composition and freeze editing before serialization. The source
        // is captured from this exact edit session, never from the preview DOM.
        let result = try await BoardRichTextValue(page.call("return inkRich.freeze();"))
        guard !closed else { throw CancellationError() }
        if result.html == baselineHTML,let initial,let html = initial.richTextHTML {
            return try BoardRichTextValue(["html":html,"text":initial.text ?? ""])
        }
        return result
    }
    func finishSaving() async {
        guard saving,!closed else { return };saving = false
        _ = try? await page.call("return inkRich.thaw();")
        busy = false
    }
    func togglePreview() async {
        guard ready,!busy,!closed else { return };busy = true
        do { _ = try await page.call("return await inkRich.preview(show);",arguments:["show":!preview]);preview.toggle();error = nil }
        catch { self.error = error.localizedDescription }
        busy = false
    }
    func undoRedo(redo: Bool) async {
        guard ready,!busy,!preview,!closed else { return };busy = true
        do { _ = try await page.call("return inkRich.undoRedo(redo);",arguments:["redo":redo]);error = nil }
        catch { self.error = error.localizedDescription }
        busy = false
    }
    func appendLink(label: String,url: URL) async {
        guard ready,!busy,!closed else { return }
        if preview { await togglePreview() };guard !preview,!busy,!closed else { return };busy = true
        do { _ = try await page.call("return inkRich.appendLink(label,url);",arguments:["label":label,"url":url.absoluteString]);error = nil }
        catch { self.error = error.localizedDescription }
        busy = false
    }
    func userContentController(_ userContentController: WKUserContentController,didReceive message: WKScriptMessage) {
        guard !closed,message.name == "richTextChanged",message.frameInfo.isMainFrame else { return }
        if let body = message.body as? [String:Any],let error = body["error"] as? String { self.error = String(error.prefix(500)) }
    }
    func close() {
        guard !closed else { return };closed = true;ready = false
        page.webView.configuration.userContentController.removeScriptMessageHandler(forName:"richTextChanged");page.close()
    }
}

struct BoardRichTextEditor: View {
    let model: BoardRichTextEditorModel
    let item: BoardItem
    var body: some View {
        VStack(alignment:.leading,spacing:8) {
            HStack {
                Button(String(localized:"撤销"),systemImage:"arrow.uturn.backward") { Task { await model.undoRedo(redo:false) } }.accessibilityIdentifier("boardItem.undo")
                Button(String(localized:"重做"),systemImage:"arrow.uturn.forward") { Task { await model.undoRedo(redo:true) } }.accessibilityIdentifier("boardItem.redo")
            }.buttonStyle(.bordered).disabled(!model.ready || model.busy || model.preview)
            Button { Task { await model.togglePreview() } } label: {
                Text(model.preview ? String(localized:"编辑正文") : String(localized:"预览公式与表格"))
                    .frame(minHeight:44)
            }
                .buttonStyle(.bordered)
                .disabled(!model.ready || model.busy).accessibilityIdentifier("richText.preview")
            RichTextEditingWebView(model:model).id(model.pageID).frame(minHeight:300,maxHeight:480).accessibilityIdentifier("richText.editor")
            Text(String(localized:"直接编辑表格单元格；公式保留原输入，点预览查看排版。"))
                .font(.footnote).foregroundStyle(.secondary)
            if model.busy { ProgressView() }
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(.red)
                if !model.ready {
                    Button { Task { await model.retry() } } label: {
                        Text(String(localized:"重试")).frame(minHeight:44)
                    }.buttonStyle(.bordered).disabled(model.busy)
                }
            }
        }.task { await model.start(item) }
    }
}
private struct RichTextEditingWebView: UIViewRepresentable {
    let model: BoardRichTextEditorModel
    func makeUIView(context: Context) -> WKWebView { model.page.webView }
    func updateUIView(_ view: WKWebView,context: Context) {}
}

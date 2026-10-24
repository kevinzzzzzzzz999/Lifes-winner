import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// A local, offline calculator. The host grants only user-selected exports.
struct MathWorkbenchView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> MathWorkbenchController { MathWorkbenchController() }
    func updateUIViewController(_ controller: MathWorkbenchController, context: Context) {}
    static func dismantleUIViewController(_ controller: MathWorkbenchController, coordinator: ()) { controller.invalidate() }
}

@MainActor final class MathWorkbenchController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private var web: WKWebView!
    private var entry: URL?
    private var exportURL: URL?
    private var exportDirectory: URL?
    private weak var exportPicker: UIDocumentPickerViewController?
    private let errorLabel = UILabel()
    private var chinese: Bool { Locale.preferredLanguages.first?.hasPrefix("zh") == true }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = String(localized: "数学工作台")
        view.backgroundColor = .systemBackground
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(WeakMathMessageHandler(self), name: "mathLabExport")
        configuration.userContentController.add(WeakMathMessageHandler(self), name: "calculatorCopy")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.accessibilityIdentifier = "math.workbench"
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        errorLabel.textColor = .secondaryLabel
        errorLabel.translatesAutoresizingMaskIntoConstraints = false
        errorLabel.isHidden = true
        view.addSubview(errorLabel)
        NSLayoutConstraint.activate([errorLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),errorLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),errorLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        guard let file = Bundle.main.url(forResource: "simple", withExtension: "html", subdirectory: "MathLab") else {
            showError(); return
        }
        entry = file.standardizedFileURL
        var components = URLComponents(url: file, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "lang", value: chinese ? "zh" : "en")]
        web.loadFileURL(components.url ?? file, allowingReadAccessTo: file.deletingLastPathComponent())
    }

    private func showError() {
        errorLabel.text = String(localized: "数学工作台未能加载，请关闭后重试。")
        errorLabel.isHidden = false
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showError() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showError() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { showError() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.isFileURL, url.standardizedFileURL.path == entry?.path else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "calculatorCopy" {
            guard message.webView === web, message.frameInfo.isMainFrame,
                  web.url?.isFileURL == true, web.url?.standardizedFileURL.path == entry?.path,
                  message.frameInfo.request.url?.isFileURL == true,
                  message.frameInfo.request.url?.standardizedFileURL.path == entry?.path,
                  let body = message.body as? [String: Any], Set(body.keys) == ["text"],
                  let text = body["text"] as? String, text.utf8.count <= 128,
                  let value = Double(text), value.isFinite else { return }
            UIPasteboard.general.string = text
            web.evaluateJavaScript("window.postMessage({type:'calculator-copy-result',copied:true}, '*')", completionHandler: nil)
            return
        }
        guard message.name == "mathLabExport", message.webView === web, message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.isFileURL == true, web.url?.isFileURL == true,
              web.url?.standardizedFileURL.path == entry?.path,
              message.frameInfo.request.url?.standardizedFileURL.path == entry?.path,
              let body = message.body as? [String: Any], Set(body.keys).isSubset(of: ["name", "mime", "dataBase64"]),
              let name = body["name"] as? String, let mime = body["mime"] as? String,
              let encoded = body["dataBase64"] as? String, encoded.utf8.count <= 12 * 1024 * 1024,
              let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 8 * 1024 * 1024,
              let fileExtension = ["image/png": "png", "text/csv": "csv", "application/json": "json"][mime]
        else { reply(error: chinese ? "导出内容无效或过大。" : "Invalid or oversized export."); return }
        guard exportURL == nil, presentedViewController == nil else { reply(error: chinese ? "请先完成当前导出。" : "Finish the current export first."); return }
        if fileExtension == "png" && !data.starts(with: [137,80,78,71,13,10,26,10]) { reply(error: "Invalid PNG"); return }
        if fileExtension != "png" && String(data: data, encoding: .utf8) == nil { reply(error: "Invalid UTF-8"); return }
        if fileExtension == "json" && (try? JSONSerialization.jsonObject(with: data)) == nil { reply(error: "Invalid JSON"); return }
        let invalid = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\:"))
        var cleaned = name.components(separatedBy: invalid).joined(separator: "_").trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        if cleaned.lowercased().hasSuffix("." + fileExtension) { cleaned = String(cleaned.dropLast(fileExtension.count + 1)) }
        cleaned = String(cleaned.prefix(120)); if cleaned.isEmpty { cleaned = "Math worksheet" }
        do {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("MathExport-" + UUID().uuidString, isDirectory: true)
            exportDirectory = folder
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let output = folder.appendingPathComponent(cleaned + "." + fileExtension)
            try data.write(to: output, options: .atomic)
            exportURL = output
            let picker = UIDocumentPickerViewController(forExporting: [output], asCopy: true)
            exportPicker = picker
            picker.delegate = self
            picker.presentationController?.delegate = self
            present(picker, animated: true) { [weak self, weak picker] in
                guard let self, let picker, self.exportPicker === picker else { return }
                picker.presentationController?.delegate = self
            }
        } catch { cleanupExport(); reply(error: chinese ? "暂时无法导出，请重试。" : "Export failed. Please retry.") }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finishExport(from: controller, saved: !urls.isEmpty) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishExport(from: controller, saved: false) }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard let picker = exportPicker, presentationController.presentedViewController === picker else { return }
        finishExport(from: picker, saved: false)
    }
    private func finishExport(from picker: UIDocumentPickerViewController, saved: Bool) {
        guard exportPicker === picker, exportURL != nil else { return }
        cleanupExport()
        reply(saved: saved)
    }
    private func cleanupExport() {
        exportPicker?.delegate = nil
        exportPicker?.presentationController?.delegate = nil
        exportPicker = nil
        if let exportDirectory { try? FileManager.default.removeItem(at: exportDirectory) }
        exportURL = nil; exportDirectory = nil
    }
    func invalidate() {
        web?.stopLoading()
        web?.navigationDelegate = nil
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "mathLabExport")
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "calculatorCopy")
        cleanupExport()
    }
    private func reply(saved: Bool = false, error: String? = nil) {
        var value: [String: Any] = ["type": "math-lab-export-result", "saved": saved]
        if let error { value["error"] = error }
        guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
        web?.evaluateJavaScript("window.postMessage(\(json), '*')", completionHandler: nil)
    }
}

@MainActor private final class WeakMathMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: MathWorkbenchController?
    init(_ owner: MathWorkbenchController) { self.owner = owner }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) { owner?.userContentController(controller, didReceive: message) }
}

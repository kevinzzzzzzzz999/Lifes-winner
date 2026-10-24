import UIKit
import UniformTypeIdentifiers

/// File handoff deliberately requires no shared container or App Group capability.
/// The user chooses where to save, then imports from the app's browser panel.
final class ShareClipViewController: UIViewController, UIDocumentPickerDelegate {
    private let summary = UILabel()
    private let saveButton = UIButton(type: .system)
    private var payload: [String: Any]?
    private var temporaryFile: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel(); title.text = "人生赢家剪藏 · Web Clip"; title.font = .preferredFont(forTextStyle: .title2)
        summary.numberOfLines = 0; summary.text = "正在读取分享内容… / Reading shared content…"
        let explanation = UILabel(); explanation.numberOfLines = 0
        explanation.text = "保存剪藏文件后，打开人生赢家的浏览器面板 → 导入 Safari 剪藏文件。仅保存标题、来源链接和选中文字。\nSave this clip to Files, then import it from the life'winner in-app browser. Only the title, source link, and selected text are included."
        explanation.font = .preferredFont(forTextStyle: .footnote); explanation.textColor = .secondaryLabel
        saveButton.setTitle("保存剪藏文件 / Save Clip", for: .normal); saveButton.isEnabled = false
        saveButton.addTarget(self, action: #selector(saveClip), for: .touchUpInside)
        let cancel = UIButton(type: .system); cancel.setTitle("取消 / Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelClip), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, summary, explanation, saveButton, cancel])
        stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll); scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
        ])
        readInput()
    }

    private func readInput() {
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { [weak self] item, error in
                let values = (item as? [String: Any])?[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]
                DispatchQueue.main.async {
                    if let values { self?.accept(values) }
                    else { self?.readURL(providers, title: items.first?.attributedContentText?.string) }
                }
            }
        } else { readURL(providers, title: items.first?.attributedContentText?.string) }
    }

    private func readURL(_ providers: [NSItemProvider], title: String?) {
        guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) else {
            summary.text = "没有可剪藏的网页链接。请从 Safari 网页的分享按钮重试。\nNo webpage URL was shared. Use Safari's page Share button."
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
            let url = item as? URL ?? (item as? String).flatMap(URL.init(string:))
            DispatchQueue.main.async { self?.accept(["url": url?.absoluteString ?? "", "title": title ?? "", "text": ""]) }
        }
    }

    private func accept(_ values: [String: Any]) {
        guard let rawURL = values["url"] as? String, rawURL.count <= 16_384,
              let url = URL(string: rawURL), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else {
            summary.text = "仅支持 http / https 网页链接。\nOnly HTTP and HTTPS webpage links are supported."
            return
        }
        let title = String((values["title"] as? String ?? url.host ?? "Web Clip").prefix(500))
        let text = String((values["text"] as? String ?? "").prefix(50_000))
        payload = ["format": "inkspace.webclip", "version": 1, "title": title, "url": url.absoluteString, "text": text]
        summary.text = title + "\n" + String(url.absoluteString.prefix(500)) + (text.isEmpty ? "" : "\n\n" + String(text.prefix(250)))
        saveButton.isEnabled = true
    }

    @objc private func saveClip() {
        guard let payload else { return }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("Web Clip.inkclip.json")
            try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]).write(to: file, options: .atomic)
            temporaryFile = file
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = self; present(picker, animated: true)
        } catch { summary.text = error.localizedDescription }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        cleanup(); extensionContext?.completeRequest(returningItems: nil)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { cleanup() }
    @objc private func cancelClip() { cleanup(); extensionContext?.completeRequest(returningItems: nil) }
    private func cleanup() {
        if let file = temporaryFile { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        temporaryFile = nil
    }
}

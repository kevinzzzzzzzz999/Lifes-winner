import Foundation
import Observation
import WebKit

struct WebDownloadRecord: Identifiable {
    enum State { case downloading, cancelling, completed, cancelled, failed }
    let id: UUID
    var name: String
    let source: String
    var state: State = .downloading
    var received: Int64 = 0
    var total: Int64 = 0
    var fileURL: URL?
    var message = ""
}

/// The website session owns this store, independently of its presentation. All
/// bytes are downloaded by WebKit in that session, never by a second HTTP client.
@MainActor @Observable final class WebDownloadStore: NSObject, WKDownloadDelegate {
    private(set) var records: [WebDownloadRecord] = []
    @ObservationIgnored private var jobs: [ObjectIdentifier: Job] = [:]
    @ObservationIgnored private var completedDirectories: [UUID: URL] = [:]
    @ObservationIgnored private var timer: Timer?
    private static let maximumBytes: Int64 = 1536 * 1024 * 1024

    private final class Job {
        let id = UUID()
        let download: WKDownload
        // WKDownload.webView and delegate are weak. Keep the originating view
        // alive even when its tab closes or its panel is temporarily hidden.
        let webView: WKWebView
        let allowsURL: (URL) -> Bool
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("InkSpace-Web-" + UUID().uuidString, isDirectory: true)
        var destination: URL?
        var cancellationMessage: String?
        var terminal = false
        var lastReceived: Int64 = 0
        var lastProgress = ProcessInfo.processInfo.systemUptime
        init(_ download: WKDownload, _ view: WKWebView, _ allowsURL: @escaping (URL) -> Bool) {
            self.download = download; webView = view; self.allowsURL = allowsURL
        }
    }

    var activeCount: Int { records.filter { $0.state == .downloading || $0.state == .cancelling }.count }

    func adopt(_ download: WKDownload, from webView: WKWebView, source: String,
               allowsURL: @escaping (URL) -> Bool) {
        let key = ObjectIdentifier(download)
        guard jobs[key] == nil else { return }
        let job = Job(download, webView, allowsURL)
        jobs[key] = job
        records.insert(.init(id: job.id, name: "Download",
                             source: String(source.prefix(120))), at: 0)
        download.delegate = self
        if activeCount > 6 {
            cancel(job, message: Self.text("同时下载的文件较多，请稍后在网页重试。", "Too many active downloads. Try the link again shortly."))
        } else if let url = download.originalRequest?.url, !allowsURL(url) {
            cancel(job, message: Self.text("此下载链接不受支持，请用系统浏览器打开。", "This download link is not supported. Use the system browser."))
        }
        startTimer()
    }

    func cancel(_ id: UUID) {
        guard let job = jobs.values.first(where: { $0.id == id }) else { return }
        cancel(job, message: nil)
    }

    private func cancel(_ job: Job, message: String?) {
        guard !job.terminal, record(job.id)?.state == .downloading else { return }
        job.cancellationMessage = message
        update(job.id) { $0.state = .cancelling; $0.message = Self.text("正在取消…", "Cancelling…") }
        // WebKit may still be writing after cancel() returns. Only its completion
        // or a terminal delegate callback may release this private directory.
        job.download.cancel { [weak self, job] _ in
            self?.finish(job, state: job.cancellationMessage == nil ? .cancelled : .failed,
                         message: job.cancellationMessage ?? Self.text("下载已取消。", "Download cancelled."))
        }
    }

    func recordSaveResult(_ id: UUID, saved: Bool) {
        guard record(id)?.state == .completed else { return }
        update(id) { $0.message = saved
            ? Self.text("已存储到所选位置。可再次保存。", "Saved to the selected location. You can save another copy.")
            : Self.text("尚未存储到文件。下载副本保留，可重试。", "Not saved to Files. The downloaded copy is kept for another attempt.") }
    }

    func remove(_ id: UUID) {
        guard let entry = record(id), entry.state != .downloading, entry.state != .cancelling else { return }
        records.removeAll { $0.id == id }
        if let directory = completedDirectories.removeValue(forKey: id) { Self.removeDirectory(directory) }
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let job = jobs[ObjectIdentifier(download)], !job.terminal,
              record(job.id)?.state == .downloading, job.destination == nil else { completionHandler(nil); return }
        guard response.url.map(job.allowsURL) ?? true else {
            completionHandler(nil)
            cancel(job, message: Self.text("下载地址不受支持。", "The download address is not supported.")); return
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            completionHandler(nil)
            cancel(job, message: Self.text("网页未返回可下载文件，请回网页重试。", "The website did not return a downloadable file. Try the link again.")); return
        }
        guard response.expectedContentLength <= Self.maximumBytes else {
            completionHandler(nil)
            cancel(job, message: Self.text("文件超过 1.5 GiB，请用系统浏览器下载。", "This file exceeds 1.5 GiB. Use the system browser to download it.")); return
        }
        do {
            // A fresh UUID directory and a non-existing file satisfy WebKit's
            // destination contract. No user-chosen or library path is used here.
            try FileManager.default.createDirectory(at: job.directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            let name = Self.safeFilename(suggestedFilename)
            let destination = job.directory.appendingPathComponent(name, isDirectory: false)
            guard !FileManager.default.fileExists(atPath: destination.path) else { throw CocoaError(.fileWriteFileExists) }
            job.destination = destination
            update(job.id) { $0.name = name; $0.total = max(0, response.expectedContentLength) }
            completionHandler(destination)
        } catch {
            completionHandler(nil)
            cancel(job, message: Self.text("无法准备下载文件，请稍后重试。", "Could not prepare the download file. Try again shortly."))
        }
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let job = jobs[ObjectIdentifier(download)], !job.terminal,
              record(job.id)?.state == .downloading, let url = request.url, job.allowsURL(url) else {
            decisionHandler(.cancel)
            if let job = jobs[ObjectIdentifier(download)] {
                cancel(job, message: Self.text("下载重定向不受支持，请用系统浏览器继续。", "The download redirect is not supported. Continue in the system browser."))
            }
            return
        }
        decisionHandler(.allow)
    }

    func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Use WebKit's normal trust handling; do not bypass TLS or extract site credentials.
        completionHandler(.performDefaultHandling, nil)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let job = jobs[ObjectIdentifier(download)] else { return }
        if record(job.id)?.state == .cancelling {
            finish(job, state: job.cancellationMessage == nil ? .cancelled : .failed,
                   message: job.cancellationMessage ?? Self.text("下载已取消。", "Download cancelled.")); return
        }
        guard let destination = job.destination,
              let values = try? destination.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let bytes = values.fileSize, bytes <= Self.maximumBytes else {
            finish(job, state: .failed, message: Self.text("下载文件未完成，请回网页重试。", "The downloaded file is incomplete. Try the link again.")); return
        }
        update(job.id) { $0.received = Int64(bytes); $0.fileURL = destination }
        completedDirectories[job.id] = job.directory
        finish(job, state: .completed, message: Self.text("已下载，请存储到文件。", "Downloaded. Choose Save to Files."))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let job = jobs[ObjectIdentifier(download)] else { return }
        if record(job.id)?.state == .cancelling {
            finish(job, state: job.cancellationMessage == nil ? .cancelled : .failed,
                   message: job.cancellationMessage ?? Self.text("下载已取消。", "Download cancelled."))
        } else {
            // Website URLs/errors can contain signed tokens; show a public error only.
            finish(job, state: .failed, message: Self.text("下载失败，请检查网络后在网页重试。", "Download failed. Check the connection and try the link again."))
        }
    }

    private func finish(_ job: Job, state: WebDownloadRecord.State, message: String) {
        guard !job.terminal else { return }
        job.terminal = true
        update(job.id) { $0.state = state; $0.message = message; if state != .completed { $0.fileURL = nil } }
        job.download.delegate = nil
        jobs.removeValue(forKey: ObjectIdentifier(job.download))
        if state != .completed { Self.removeDirectory(job.directory) }
        if jobs.isEmpty { timer?.invalidate(); timer = nil }
    }

    private func startTimer() {
        guard timer == nil, !jobs.isEmpty else { return }
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshProgress() }
        }
        self.timer = timer; RunLoop.main.add(timer, forMode: .common)
    }

    private func refreshProgress() {
        for job in Array(jobs.values) where record(job.id)?.state == .downloading {
            let progress = job.download.progress
            let received = max(0, progress.completedUnitCount), total = max(0, progress.totalUnitCount)
            if received != job.lastReceived { job.lastReceived = received; job.lastProgress = ProcessInfo.processInfo.systemUptime }
            update(job.id) { $0.received = received; if total > 0 { $0.total = total } }
            if received > Self.maximumBytes || total > Self.maximumBytes {
                cancel(job, message: Self.text("文件超过 1.5 GiB，请用系统浏览器下载。", "This file exceeds 1.5 GiB. Use the system browser to download it."))
            } else if ProcessInfo.processInfo.systemUptime - job.lastProgress > 120 {
                cancel(job, message: Self.text("下载长时间没有进展，请检查网络后重试。", "The download stopped making progress. Check the connection and try again."))
            }
        }
    }

    private func record(_ id: UUID) -> WebDownloadRecord? { records.first { $0.id == id } }
    private func update(_ id: UUID, _ change: (inout WebDownloadRecord) -> Void) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        change(&records[index])
    }
    nonisolated private static func removeDirectory(_ directory: URL) {
        // Only exact UUID directories allocated by this store reach this function.
        Task.detached(priority: .utility) { try? FileManager.default.removeItem(at: directory) }
    }
    nonisolated static func text(_ zh: String, _ en: String) -> String {
        Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true ? zh : en
    }
    nonisolated static func safeFilename(_ input: String) -> String {
        let leaf = input.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? ""
        let forbidden = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: ":*?\"<>|/\\\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}"))
        var safe = String(String.UnicodeScalarView(leaf.unicodeScalars.map { forbidden.contains($0) ? "_" : $0 }))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while safe.first == "." { safe.removeFirst() }
        if safe.isEmpty { safe = "Download" }
        let extensionPart = (safe as NSString).pathExtension
        let suffix = extensionPart.isEmpty || extensionPart.utf8.count > 20 ? "" : "." + extensionPart
        var stem = suffix.isEmpty ? safe : String(safe.dropLast(suffix.count))
        while stem.utf8.count + suffix.utf8.count > 180 { stem.removeLast() }
        return (stem.isEmpty ? "Download" : stem) + suffix
    }
    nonisolated static func isWebURL(_ url: URL, httpsOnly: Bool = false) -> Bool {
        (httpsOnly ? ["https"] : ["https", "http"]).contains(url.scheme?.lowercased() ?? "") &&
        !(url.host ?? "").isEmpty && url.user == nil && url.password == nil
    }
    nonisolated static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard isWebURL(a), isWebURL(b) else { return false }
        func port(_ value: URL) -> Int { value.port ?? (value.scheme?.lowercased() == "https" ? 443 : 80) }
        return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased() && port(a) == port(b)
    }
    static func originURL(_ origin: WKSecurityOrigin) -> URL? {
        var components = URLComponents(); components.scheme = origin.protocol; components.host = origin.host
        if origin.port != 0 { components.port = origin.port }
        return components.url
    }
    nonisolated static func allowsBlob(_ url: URL, currentURL: URL?, sourceURL: URL?, explicit: Bool,
                                      allowsOrigin: (URL) -> Bool) -> Bool {
        guard explicit, url.scheme?.lowercased() == "blob", let currentURL, let sourceURL,
              let embedded = URL(string: String(url.absoluteString.dropFirst(5))),
              allowsOrigin(currentURL), allowsOrigin(sourceURL) else { return false }
        return sameOrigin(currentURL, sourceURL) && sameOrigin(embedded, sourceURL)
    }
    nonisolated static func shouldDownloadResponse(_ response: URLResponse, canShowMIMEType: Bool, isMainFrame: Bool) -> Bool {
        guard isMainFrame else { return false }
        let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?
            .split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return disposition == "attachment" || !canShowMIMEType
    }

    deinit {
        timer?.invalidate()
        let active = Array(jobs.values), completed = Array(completedDirectories.values)
        for job in active {
            Task { @MainActor in
                job.download.delegate = nil
                _ = await job.download.cancel()
                Self.removeDirectory(job.directory)
            }
        }
        for directory in completed { Self.removeDirectory(directory) }
    }
}

import Foundation
import Observation
import WebKit

struct BrowserExtensionRecord: Codable, Identifiable {
    let id: UUID
    var name: String
    var version: String
    var enabled: Bool
    var permissions: [String]
    var websites: [String]
    var allowedWebsites: [String]
}

enum BrowserExtensionFailure: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case let .invalid(message) = self { return message }; return nil }
}

@available(iOS 18.4, *)
struct BrowserExtensionCandidate: Identifiable {
    let id: UUID
    let directory: URL
    let webExtension: WKWebExtension
    let record: BrowserExtensionRecord
}

/// One controller serves all in-app browser windows. Other document WKWebViews
/// never receive it. Extensions are copied into private app storage before review.
@available(iOS 18.4, *)
@MainActor @Observable final class BrowserExtensionHost: NSObject, WKWebExtensionControllerDelegate {
    static let shared = BrowserExtensionHost()
    let controller = WKWebExtensionController()
    private(set) var records: [BrowserExtensionRecord] = []
    private(set) var busy = true
    var status: String?
    @ObservationIgnored private var contexts: [UUID: WKWebExtensionContext] = [:]
    @ObservationIgnored private var windows: [WeakBrowserWindow] = []
    @ObservationIgnored private let root: URL
    @ObservationIgnored private var errors: [UUID: String] = [:]

    init(directory: URL? = nil) {
        root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BrowserExtensions", isDirectory: true)
        super.init()
        controller.delegate = self
        Task { await restore() }
    }

    private var indexURL: URL { root.appendingPathComponent("index.json") }
    private func directory(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }

    func register(_ session: EmbeddedBrowserSession) {
        windows.removeAll { $0.value == nil }
        guard !windows.contains(where: { $0.value === session }) else { return }
        windows.append(WeakBrowserWindow(session))
        controller.didOpenWindow(session)
        controller.didFocusWindow(session)
    }

    func webExtensionController(_ controller: WKWebExtensionController, openWindowsFor context: WKWebExtensionContext) -> [any WKWebExtensionWindow] {
        windows.compactMap(\.value)
    }
    func webExtensionController(_ controller: WKWebExtensionController, focusedWindowFor context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? {
        windows.compactMap(\.value).last
    }

    /// Runtime requests never silently widen the websites or capabilities that
    /// the installation review granted. Optional permissions are not supported.
    func webExtensionController(_ controller: WKWebExtensionController, promptForPermissions permissions: Set<WKWebExtension.Permission>, in tab: (any WKWebExtensionTab)?, for context: WKWebExtensionContext, completionHandler: @escaping (Set<WKWebExtension.Permission>, Date?) -> Void) {
        completionHandler([], nil)
    }
    func webExtensionController(_ controller: WKWebExtensionController, promptForPermissionMatchPatterns patterns: Set<WKWebExtension.MatchPattern>, in tab: (any WKWebExtensionTab)?, for context: WKWebExtensionContext, completionHandler: @escaping (Set<WKWebExtension.MatchPattern>, Date?) -> Void) {
        completionHandler([], nil)
    }
    func webExtensionController(_ controller: WKWebExtensionController, promptForPermissionToAccess urls: Set<URL>, in tab: (any WKWebExtensionTab)?, for context: WKWebExtensionContext, completionHandler: @escaping (Set<URL>, Date?) -> Void) {
        completionHandler([], nil)
    }

    func prepare(folder: URL) async throws -> BrowserExtensionCandidate {
        guard !busy else { throw BrowserExtensionFailure.invalid(String(localized: "扩展正在加载，请稍后重试。")) }
        busy = true; defer { busy = false }
        let accessing = folder.startAccessingSecurityScopedResource()
        defer { if accessing { folder.stopAccessingSecurityScopedResource() } }
        let id = UUID(), destination = directory(UUID())
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        do {
            try Self.copyReviewedFolder(folder, to: destination)
            let ext = try await WKWebExtension(resourceBaseURL: destination)
            guard ext.errors.isEmpty else { throw BrowserExtensionFailure.invalid(ext.errors.map(\.localizedDescription).joined(separator: "\n")) }
            let sites = ext.allRequestedMatchPatterns.map(\.string).sorted()
            guard !sites.isEmpty else { throw BrowserExtensionFailure.invalid(String(localized: "此扩展没有可授权的网站范围。")) }
            let record = BrowserExtensionRecord(id: id, name: ext.displayName ?? "Web Extension", version: ext.version ?? "", enabled: true,
                permissions: ext.requestedPermissions.map(\.rawValue).sorted(), websites: sites, allowedWebsites: [])
            return BrowserExtensionCandidate(id: id, directory: destination, webExtension: ext, record: record)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }

    func discard(_ candidate: BrowserExtensionCandidate) { try? FileManager.default.removeItem(at: candidate.directory) }

    func install(_ candidate: BrowserExtensionCandidate, allowing sites: Set<String>) async throws {
        guard !busy else { return }
        busy = true; defer { busy = false }
        var record = candidate.record
        record.allowedWebsites = record.websites.filter(sites.contains)
        let destination = directory(record.id)
        try FileManager.default.moveItem(at: candidate.directory, to: destination)
        do {
            let ext = try await WKWebExtension(resourceBaseURL: destination)
            try load(record, extension: ext)
            records.append(record)
            do { try save() } catch { records.removeAll { $0.id == record.id }; throw error }
            reloadPages()
        } catch {
            if let context = contexts.removeValue(forKey: record.id) { try? controller.unload(context) }
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }

    func setEnabled(_ enabled: Bool, id: UUID) async {
        guard !busy, let index = records.firstIndex(where: { $0.id == id }) else { return }
        busy = true; defer { busy = false }
        do {
            if enabled {
                let ext = try await WKWebExtension(resourceBaseURL: directory(id))
                try load(records[index], extension: ext)
            } else if let context = contexts[id] {
                try controller.unload(context); contexts.removeValue(forKey: id)
            }
            records[index].enabled = enabled
            try save(); errors[id] = nil; status = nil
        } catch {
            records[index].enabled = contexts[id]?.isLoaded == true
            errors[id] = error.localizedDescription; status = error.localizedDescription
        }
        reloadPages()
    }

    func setWebsite(_ website: String, allowed: Bool, id: UUID) {
        guard !busy, let index = records.firstIndex(where: { $0.id == id }), records[index].websites.contains(website) else { return }
        let previous = records[index].allowedWebsites
        records[index].allowedWebsites.removeAll { $0 == website }
        if allowed { records[index].allowedWebsites.append(website) }
        do {
            try save()
            if let context = contexts[id] { applyPermissions(records[index], context: context) }
            reloadPages()
        } catch { records[index].allowedWebsites = previous; status = error.localizedDescription }
    }

    func remove(_ id: UUID) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let context = contexts[id]
            if let context { try controller.unload(context); contexts.removeValue(forKey: id) }
            // Use a context even for a disabled extension so its local storage is deleted.
            let cleanupContext: WKWebExtensionContext?
            if let context { cleanupContext = context }
            else if let ext = try? await WKWebExtension(resourceBaseURL: directory(id)) {
                let context = WKWebExtensionContext(for: ext); context.uniqueIdentifier = id.uuidString
                cleanupContext = context
            } else { cleanupContext = nil }
            if let context = cleanupContext, let data = await controller.dataRecord(ofTypes: [.local, .session, .synchronized], for: context) {
                await controller.removeData(ofTypes: [.local, .session, .synchronized], from: [data])
            }
            try FileManager.default.removeItem(at: directory(id))
            records.removeAll { $0.id == id }; try save(); errors[id] = nil; status = nil
        } catch { status = error.localizedDescription }
        reloadPages()
    }

    func error(for id: UUID) -> String? {
        errors[id] ?? contexts[id]?.errors.first?.localizedDescription
    }

    private func restore() async {
        defer { busy = false }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: indexURL.path) {
                records = try JSONDecoder().decode([BrowserExtensionRecord].self, from: Data(contentsOf: indexURL))
            }
            for record in records where record.enabled {
                do { try load(record, extension: await WKWebExtension(resourceBaseURL: directory(record.id))) }
                catch { errors[record.id] = error.localizedDescription }
            }
        } catch { status = error.localizedDescription }
    }

    private func load(_ record: BrowserExtensionRecord, extension ext: WKWebExtension) throws {
        guard ext.errors.isEmpty else { throw BrowserExtensionFailure.invalid(ext.errors.map(\.localizedDescription).joined(separator: "\n")) }
        let context = WKWebExtensionContext(for: ext)
        context.uniqueIdentifier = record.id.uuidString
        context.hasAccessToPrivateData = false
        applyPermissions(record, context: context)
        try controller.load(context)
        contexts[record.id] = context
    }
    private func applyPermissions(_ record: BrowserExtensionRecord, context: WKWebExtensionContext) {
        context.grantedPermissions = Dictionary(uniqueKeysWithValues: record.permissions.map { (WKWebExtension.Permission(rawValue: $0), Date.distantFuture) })
        context.grantedPermissionMatchPatterns = Dictionary(uniqueKeysWithValues: record.allowedWebsites.compactMap { raw in
            (try? WKWebExtension.MatchPattern(string: raw)).map { ($0, Date.distantFuture) }
        })
    }
    private func save() throws { try JSONEncoder().encode(records).write(to: indexURL, options: .atomic) }
    private func reloadPages() { windows.compactMap(\.value).flatMap(\.tabs).forEach { $0.reload() } }

    /// Deliberately supports the actual host surface: MV3 static content scripts,
    /// stylesheets, and optional local storage. Unsupported manifests fail before
    /// anything is loaded, instead of presenting a misleading installed state.
    static func copyReviewedFolder(_ source: URL, to destination: URL) throws {
        let fm = FileManager.default
        let values = try source.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw BrowserExtensionFailure.invalid(String(localized: "请选择已解压且包含 manifest.json 的扩展文件夹。"))
        }
        let manifestURL = source.appendingPathComponent("manifest.json")
        guard (try manifestURL.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey])).isSymbolicLink != true,
              (try manifestURL.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0 < 1_000_000,
              let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any],
              manifest["manifest_version"] as? Int == 3,
              let scripts = manifest["content_scripts"] as? [[String: Any]], !scripts.isEmpty else {
            throw BrowserExtensionFailure.invalid(String(localized: "目前支持 Manifest V3 的网页内容脚本和样式扩展；未找到有效的 content_scripts。"))
        }
        let unsupported = ["background", "action", "browser_action", "page_action", "options_ui", "options_page", "devtools_page", "chrome_url_overrides", "declarative_net_request", "commands", "optional_permissions", "optional_host_permissions"]
        if let key = unsupported.first(where: { manifest[$0] != nil }) {
            throw BrowserExtensionFailure.invalid(String(localized: "此扩展使用暂不支持的功能：\(key)。请选择仅包含网页脚本或样式的扩展。"))
        }
        let permissions = manifest["permissions"] as? [String] ?? []
        guard permissions.allSatisfy({ $0 == "storage" }) else {
            throw BrowserExtensionFailure.invalid(String(localized: "此扩展请求暂不支持的权限：\(permissions.filter { $0 != "storage" }.joined(separator: ", "))。"))
        }
        for script in scripts {
            for path in (script["js"] as? [String] ?? []) + (script["css"] as? [String] ?? []) {
                guard !path.hasPrefix("/"), !path.split(separator: "/").contains(".."), !path.contains(":") else {
                    throw BrowserExtensionFailure.invalid(String(localized: "扩展包含不安全的资源路径。"))
                }
            }
        }
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        guard let enumerator = fm.enumerator(at: source, includingPropertiesForKeys: keys) else { throw CocoaError(.fileReadUnknown) }
        var total = 0, count = 0
        for case let file as URL in enumerator {
            let value = try file.resourceValues(forKeys: Set(keys)); count += 1; total += value.fileSize ?? 0
            guard value.isSymbolicLink != true, value.isDirectory == true || value.isRegularFile == true, count <= 500, total <= 30_000_000 else {
                throw BrowserExtensionFailure.invalid(String(localized: "扩展含符号链接、特殊文件，或超过 500 个文件 / 30 MB 限制。"))
            }
        }
        try fm.copyItem(at: source, to: destination)
    }
}

@MainActor private final class WeakBrowserWindow {
    weak var value: EmbeddedBrowserSession?
    init(_ value: EmbeddedBrowserSession) { self.value = value }
}

@available(iOS 18.4, *)
extension EmbeddedBrowserSession: WKWebExtensionWindow {
    func tabs(for context: WKWebExtensionContext) -> [any WKWebExtensionTab] { tabs }
    func activeTab(for context: WKWebExtensionContext) -> (any WKWebExtensionTab)? { selectedTab }
}

@available(iOS 18.4, *)
extension EmbeddedBrowserTab: WKWebExtensionTab {
    func window(for context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { session }
    func webView(for context: WKWebExtensionContext) -> WKWebView? { view() }
}

import Foundation
import CryptoKit

struct ManagedVaultEntry: Identifiable, Hashable, Sendable {
    var path: String
    var isDirectory: Bool
    var modifiedAt: Date? = nil
    var id: String { path }
    var title: String { (path as NSString).lastPathComponent }
}
struct VaultManagedMove: Codable, Sendable { var from: String; var to: String }
struct VaultManagementResult: Sendable {
    var moves: [VaultManagedMove] = []
    var removed: [String] = []
    var changedBoards: [String] = []
    var trashID: String?
    func mapped(_ path: String) -> String { VaultFileManagement.mapped(path, by: moves) }
    func removes(_ path: String) -> Bool { removed.contains { path == $0 || path.hasPrefix($0 + "/") } }
}
struct VaultTrashManifest: Codable, Identifiable, Sendable {
    struct Entry: Codable, Sendable { var originalPath: String; var storedName: String }
    var schemaVersion = 1
    var id: String
    var createdAt: String
    var entries: [Entry]
    var state: String
    struct InventoryItem: Codable, Sendable {
        var storedPath: String; var type: String; var size: UInt64; var sha256: String?
    }
    var inventory: [InventoryItem]? = nil
}
enum VaultFileManagementError: LocalizedError {
    case unsafe, collision, limit, changed, invalidReference, reviewsBlockMove, incompleteTrash, recoveryRequired, emptyShare
    var errorDescription: String? {
        switch self {
        case .unsafe: String(localized: "只能管理资料根文件夹内的普通文件和文件夹，不能操作根目录、隐藏系统目录或符号链接。")
        case .collision: String(localized: "目标位置已有同名文件，整批操作已停止，不会覆盖。")
        case .limit: String(localized: "本次文件过多或引用检查超出处理范围，请减少选择后重试。")
        case .changed: String(localized: "文件在操作期间发生变化，已停止处理，请刷新后重试。")
        case .invalidReference: String(localized: "有白板或批注暂不可完整读取，无法安全核对引用；请等待下载完成后重试。")
        case .reviewsBlockMove: String(localized: "这些文件还有待修改批注，请先处理批注后再移动。")
        case .incompleteTrash: String(localized: "这份回收记录尚未完整同步或处于恢复过程中，暂不能恢复。")
        case .recoveryRequired: String(localized: "操作遇到外部文件冲突，恢复记录已保留。请暂勿继续移动，先检查文件和本机备份。")
        case .emptyShare: String(localized: "所选内容没有可分享的文件；空文件夹请在系统“文件”中分享。")
        }
    }
}

/// File management is confined to a single already-authorized vault. All work runs
/// on this actor, under a coordinated directory read/write. Source binary files are
/// moved, never decoded or edited. Board JSON is patched as raw JSON, not Codable.
actor VaultFileManagement {
    nonisolated let rootURL: URL
    private let fm = FileManager.default
    static let maximumSelection = 100
    private static let maximumEntries = 20_000
    private static let maximumMetadataBytes = 128 * 1024 * 1024
    private static let journalFolder = ".inkspace-file-operations"
    private let faultAfterMoves: Int?
    init(rootURL: URL, faultAfterMoves: Int? = nil) {
        self.rootURL = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        self.faultAfterMoves = faultAfterMoves
    }

    nonisolated static func mapped(_ path: String, by moves: [VaultManagedMove]) -> String {
        for move in moves {
            if path == move.from { return move.to }
            if path.hasPrefix(move.from + "/") { return move.to + path.dropFirst(move.from.count) }
        }
        return path
    }
    nonisolated static func safePath(_ path: String, allowRoot: Bool = false) -> Bool {
        if path.isEmpty { return allowRoot }
        return VaultPath.isSafeRelative(path) && !path.split(separator: "/").contains { $0.hasPrefix(".") }
    }
    /// Only internally paired video subtitle files may accompany public selections.
    nonisolated static func subtitleVideoPath(_ path: String) -> String? {
        let file = (path as NSString).lastPathComponent, suffix = ".inkspace-subtitles.json"
        guard file.hasPrefix("."), file.hasSuffix(suffix) else { return nil }
        let name = String(file.dropFirst().dropLast(suffix.count))
        guard ["mp4", "mov", "m4v"].contains((name as NSString).pathExtension.lowercased()) else { return nil }
        let parent = (path as NSString).deletingLastPathComponent
        let video = parent.isEmpty ? name : parent + "/" + name
        return Self.safePath(video) ? video : nil
    }
    nonisolated static func pdfCompanionSource(_ path: String) -> String? {
        let file = (path as NSString).lastPathComponent
        guard let suffix = [".inkspace-pdf", ".inkspace-extend"].first(where: { file.hasSuffix($0) }), file.hasPrefix(".") else { return nil }
        let name = String(file.dropFirst().dropLast(suffix.count))
        let parent = (path as NSString).deletingLastPathComponent
        let source = parent.isEmpty ? name : parent + "/" + name
        return Self.safePath(source) && (name as NSString).pathExtension.lowercased() == "pdf" ? source : nil
    }
    nonisolated private static func companionSource(_ path: String) -> String? {
        Self.subtitleVideoPath(path) ?? Self.pdfCompanionSource(path)
    }
    nonisolated private static func managedPath(_ path: String) -> Bool {
        Self.safePath(path) || Self.companionSource(path) != nil
    }
    private func hasVideoCompanion(_ child: URL) throws -> Bool {
        // A restored directory can live below the app's internal trash root.
        guard let name = Self.subtitleVideoPath(child.lastPathComponent) else { return false }
        let video = child.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath().appendingPathComponent(name)
        guard video.path.hasPrefix(rootURL.path + "/") else { return false }
        let relative = String(video.path.dropFirst(rootURL.path.count + 1))
        guard fm.fileExists(atPath: video.path) else { return false }
        return try stamp(url(relative, internalPath: true), path: relative).type == FileAttributeType.typeRegular.rawValue
    }
    /// Only a source-adjacent directory of validated immutable PDF layer events
    /// may accompany its containing public folder. This does not authorize a
    /// caller to select hidden records or arbitrary hidden directories directly.
    private func hasPDFLayerCompanion(_ child: URL) throws -> Bool {
        let name = child.lastPathComponent, suffix = ".inkspace-pdf"
        guard name.hasPrefix("."), name.hasSuffix(suffix) else { return false }
        let pdfName = String(name.dropFirst().dropLast(suffix.count))
        guard Self.safePath(pdfName), (pdfName as NSString).lastPathComponent == pdfName,
              (pdfName as NSString).pathExtension.lowercased() == "pdf" else { return false }
        let sidecar = child.standardizedFileURL
        guard sidecar.path.hasPrefix(rootURL.path + "/") else { return false }
        let sidecarPath = String(sidecar.path.dropFirst(rootURL.path.count + 1))
        let directory = try url(sidecarPath, internalPath: true)
        guard try stamp(directory, path: sidecarPath).type == FileAttributeType.typeDirectory.rawValue else { return false }
        let source = directory.deletingLastPathComponent().appendingPathComponent(pdfName)
        guard fm.fileExists(atPath: source.path) else { return false }
        let sourcePath = String(source.path.dropFirst(rootURL.path.count + 1))
        let sourceURL = try url(sourcePath, internalPath: true)
        guard try stamp(sourceURL, path: sourcePath).type == FileAttributeType.typeRegular.rawValue else { return false }
        let handle = try FileHandle(forReadingFrom: sourceURL)
        let header: Data
        do { header = try handle.read(upToCount: 1024) ?? Data(); try handle.close() }
        catch { try? handle.close(); throw error }
        guard header.range(of: Data("%PDF-".utf8)) != nil else { return false }
        let entries = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        guard entries.count <= 20_000 else { throw VaultFileManagementError.limit }
        var total = 0
        for file in entries {
            try Task.checkCancellation()
            let filename = file.lastPathComponent
            guard filename == filename.lowercased(), filename.hasSuffix(".json"),
                  let id = UUID(uuidString: String(filename.dropLast(5))) else { throw VaultFileManagementError.invalidReference }
            let checked = try url(sidecarPath + "/" + filename, internalPath: true)
            let data = try metadata(checked, limit: 256 * 1024)
            total += data.count
            guard total <= 64 * 1024 * 1024 else { throw VaultFileManagementError.limit }
            let event: PDFWorkspaceEvent
            do { event = try PDFWorkspaceEvent.decodeValidated(data) }
            catch { throw VaultFileManagementError.invalidReference }
            guard event.id == id else { throw VaultFileManagementError.invalidReference }
        }
        return true
    }

    /// The extension sidecar is copied verbatim, including all immutable history.
    /// Unknown files, links, or incomplete referenced assets block the whole move.
    private func hasPDFExtensionCompanion(_ child: URL) throws -> Bool {
        guard child.lastPathComponent.hasSuffix(".inkspace-extend"), let pdfName = Self.pdfCompanionSource(child.lastPathComponent) else { return false }
        let sidecar = child.standardizedFileURL
        guard sidecar.path.hasPrefix(rootURL.path + "/") else { return false }
        let relative = String(sidecar.path.dropFirst(rootURL.path.count + 1))
        let directory = try url(relative, internalPath: true)
        guard try stamp(directory, path: relative).type == FileAttributeType.typeDirectory.rawValue else { return false }
        let source = directory.deletingLastPathComponent().appendingPathComponent(pdfName)
        guard source.path.hasPrefix(rootURL.path + "/"), fm.fileExists(atPath: source.path) else { return false }
        let sourcePath = String(source.path.dropFirst(rootURL.path.count + 1))
        let checkedSource = try url(sourcePath, internalPath: true)
        guard try stamp(checkedSource, path: sourcePath).type == FileAttributeType.typeRegular.rawValue else { return false }
        let handle = try FileHandle(forReadingFrom: checkedSource)
        defer { try? handle.close() }
        guard (try handle.read(upToCount: 1024) ?? Data()).range(of: Data("%PDF-".utf8)) != nil else { return false }
        let children = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        guard children.allSatisfy({ ["events", "assets"].contains($0.lastPathComponent) }), children.contains(where: { $0.lastPathComponent == "events" }) else { throw VaultFileManagementError.invalidReference }
        var total = 0, count = 0, references = Set<String>(), assets = Set<String>()
        for folder in children {
            let folderPath = relative + "/" + folder.lastPathComponent
            guard try stamp(url(folderPath, internalPath: true), path: folderPath).type == FileAttributeType.typeDirectory.rawValue else { throw VaultFileManagementError.unsafe }
            for file in try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
                try Task.checkCancellation(); count += 1
                guard count <= Self.maximumEntries else { throw VaultFileManagementError.limit }
                let name = file.lastPathComponent, filePath = folderPath + "/" + name
                let checked = try url(filePath, internalPath: true)
                guard try stamp(checked, path: filePath).type == FileAttributeType.typeRegular.rawValue else { throw VaultFileManagementError.unsafe }
                if folder.lastPathComponent == "events" {
                    let bytes = try metadata(checked, limit: PDFExtensionEvent.maximumBytes); total += bytes.count
                    let event: PDFExtensionEvent
                    do { event = try PDFExtensionEvent.decodeValidated(bytes) } catch { throw VaultFileManagementError.invalidReference }
                    guard name == event.id + ".json" else { throw VaultFileManagementError.invalidReference }
                    for image in event.block?.images ?? [] { references.insert(image.resource) }
                } else {
                    let ext = (name as NSString).pathExtension, hash = (name as NSString).deletingPathExtension
                    guard ["png", "jpg"].contains(ext), PDFExtensionEvent.hashValid(hash) else { throw VaultFileManagementError.invalidReference }
                    let bytes = try metadata(checked, limit: 16 * 1024 * 1024); total += bytes.count
                    guard SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == hash else { throw VaultFileManagementError.invalidReference }
                    assets.insert("assets/" + name)
                }
                guard total <= Self.maximumMetadataBytes else { throw VaultFileManagementError.limit }
            }
        }
        guard references.isSubset(of: assets) else { throw VaultFileManagementError.invalidReference }
        return true
    }

    private func url(_ path: String, exists: Bool = true, internalPath: Bool = false) throws -> URL {
        guard path.isEmpty || (internalPath ? VaultPath.isSafeRelative(path) : Self.managedPath(path)) else { throw VaultFileManagementError.unsafe }
        guard rootURL.isFileURL, (try rootURL.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true else { throw VaultFileManagementError.unsafe }
        var current = rootURL
        for part in path.split(separator: "/") {
            current.appendPathComponent(String(part))
            if fm.fileExists(atPath: current.path) {
                let values = try current.resourceValues(forKeys: [.isSymbolicLinkKey, .isPackageKey])
                guard values.isSymbolicLink != true, values.isPackage != true,
                      current.resolvingSymlinksInPath().standardizedFileURL.path == current.path else { throw VaultFileManagementError.unsafe }
            } else if exists { throw VaultFileManagementError.changed }
        }
        return current
    }
    private func coordinated<T>(write: Bool, _ action: () throws -> T) throws -> T {
        let access = rootURL.startAccessingSecurityScopedResource()
        defer { if access { rootURL.stopAccessingSecurityScopedResource() } }
        var error: NSError?
        var output: Result<T, Error>?
        let block: (URL) -> Void = { _ in output = Result { try Task.checkCancellation(); return try action() } }
        let coordinator = NSFileCoordinator()
        if write { coordinator.coordinate(writingItemAt: rootURL, options: .forMerging, error: &error, byAccessor: block) }
        else { coordinator.coordinate(readingItemAt: rootURL, options: .withoutChanges, error: &error, byAccessor: block) }
        if let error { throw error }
        guard let output else { throw VaultFileManagementError.changed }
        return try output.get()
    }
    func listDirectory(_ path: String = "") throws -> [ManagedVaultEntry] {
        try coordinated(write: false) {
            guard Self.safePath(path, allowRoot: true) else { throw VaultFileManagementError.unsafe }
            let directory = try url(path)
            guard try directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw VaultFileManagementError.unsafe }
            let children = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey,.isRegularFileKey,.isSymbolicLinkKey,.isPackageKey], options: [.skipsHiddenFiles])
            guard children.count <= 5_000 else { throw VaultFileManagementError.limit }
            var entries: [ManagedVaultEntry] = []
            for child in children {
                try Task.checkCancellation()
                let relative = path.isEmpty ? child.lastPathComponent : path + "/" + child.lastPathComponent
                guard Self.safePath(relative) else { continue }
                let values = try child.resourceValues(forKeys: [.isDirectoryKey,.isRegularFileKey,.isSymbolicLinkKey,.isPackageKey])
                guard values.isSymbolicLink != true, values.isPackage != true,
                      values.isDirectory == true || values.isRegularFile == true else { continue }
                _ = try url(relative)
                let modified = try child.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
                entries.append(ManagedVaultEntry(path: relative, isDirectory: values.isDirectory == true, modifiedAt: modified))
            }
            return entries.sorted { $0.isDirectory != $1.isDirectory ? $0.isDirectory : $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        }
    }
    private func orderDocument() throws -> (URL, Data?, [String: Any], [String: [String]]) {
        let file = try url(".inkspace-folder-order.json", exists: false, internalPath: true)
        guard fm.fileExists(atPath: file.path) else { return (file, nil, ["version": 1, "orders": [:]], [:]) }
        let raw = try metadata(file, limit: 4*1024*1024)
        guard let json = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
              (json["version"] as? NSNumber)?.intValue == 1,
              let orders = json["orders"] as? [String: [String]], orders.count <= 5000,
              orders.allSatisfy({ parent, children in
                  Self.safePath(parent, allowRoot: true) && children.count <= 5000 && Set(children).count == children.count
                    && children.allSatisfy { Self.safePath($0) && ($0 as NSString).deletingLastPathComponent == parent }
              }) else { throw VaultFileManagementError.invalidReference }
        return (file, raw, json, orders)
    }
    func folderOrder(_ path: String) throws -> [String] {
        try coordinated(write: false) {
            guard Self.safePath(path, allowRoot: true) else { throw VaultFileManagementError.unsafe }
            let (_, _, _, orders) = try orderDocument()
            return (orders[path] ?? []).filter { (try? url($0)) != nil }
        }
    }
    func setFolderOrder(_ path: String, children: [String]) throws {
        try coordinated(write: true) {
            guard Self.safePath(path, allowRoot: true), children.count <= 5000, Set(children).count == children.count,
                  children.allSatisfy({ Self.safePath($0) && ($0 as NSString).deletingLastPathComponent == path }) else { throw VaultFileManagementError.unsafe }
            _ = try url(path)
            for child in children { _ = try url(child) }
            let (file, raw, original, previous) = try orderDocument()
            var json = original, orders = previous; orders[path] = children; json["orders"] = orders
            let data = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys,.withoutEscapingSlashes])
            if let raw { try writeReplacing(data, at: file, expected: raw) } else { try writeNew(data, to: file) }
        }
    }

    private func selected(_ paths: [String], companions: Bool = false) throws -> [String] {
        guard !paths.isEmpty, paths.count <= Self.maximumSelection, Set(paths).count == paths.count,
              paths.allSatisfy({ value in Self.safePath(value) || (companions && Self.companionSource(value).map { paths.contains($0) } == true) }) else { throw VaultFileManagementError.unsafe }
        let sorted = paths.sorted()
        // Parent selection subsumes a selected descendant, without moving it twice.
        return sorted.filter { value in !sorted.contains { $0 != value && value.hasPrefix($0 + "/") } }
    }
    private struct Stamp: Equatable {
        var path: String; var type: String; var size: UInt64; var date: Date; var inode: UInt64
    }
    private func stamp(_ target: URL, path: String) throws -> Stamp {
        let attributes = try fm.attributesOfItem(atPath: target.path)
        let type = attributes[.type] as? FileAttributeType
        guard type == .typeRegular || type == .typeDirectory,
              type != .typeRegular || (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else { throw VaultFileManagementError.unsafe }
        return Stamp(path: path, type: type!.rawValue, size: (attributes[.size] as? NSNumber)?.uint64Value ?? 0,
                     date: attributes[.modificationDate] as? Date ?? .distantPast,
                     inode: (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0)
    }
    private func tree(_ paths: [String], allowHidden: Bool = false) throws -> [Stamp] {
        var result: [Stamp] = []
        var pending = paths
        while let path = pending.popLast() {
            try Task.checkCancellation()
            guard result.count < Self.maximumEntries else { throw VaultFileManagementError.limit }
            let target = try url(path, internalPath: true)
            let entry = try stamp(target, path: path); result.append(entry)
            if entry.type == FileAttributeType.typeDirectory.rawValue {
                let children = try fm.contentsOfDirectory(at: target, includingPropertiesForKeys: nil)
                for child in children {
                    let name = child.lastPathComponent
                    // A selected folder may contain Finder metadata, but never app,
                    // repository or synchronization state. Preserve .DS_Store bytes.
                    if name.hasPrefix(".") && name != ".DS_Store" {
                        guard try hasVideoCompanion(child) || hasPDFLayerCompanion(child) || hasPDFExtensionCompanion(child) else { throw VaultFileManagementError.unsafe }
                    }
                    pending.append(path + "/" + name)
                }
            }
        }
        return result.sorted { $0.path < $1.path }
    }
    private func metadata(_ target: URL, limit: Int) throws -> Data {
        // URL resource values cache size across atomic replacements. A journal
        // changes length on every state transition, so use fresh filesystem stat.
        let attributes = try fm.attributesOfItem(atPath: target.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else { throw VaultFileManagementError.unsafe }
        guard let number = attributes[.size] as? NSNumber, number.int64Value >= 0,
              number.uint64Value <= UInt64(limit) else { throw VaultFileManagementError.limit }
        let bytes = try Data(contentsOf: target)
        guard bytes.count == number.intValue else { throw VaultFileManagementError.changed }
        return bytes
    }
    private struct Patch { var path: String; var before: Data; var after: Data; var isBoard: Bool }
    private func patches(for moves: [VaultManagedMove]) throws -> [Patch] {
        var pending = [""], visited = 0, total = 0, patches: [Patch] = []
        while let path = pending.popLast() {
            try Task.checkCancellation()
            let children = try fm.contentsOfDirectory(at: url(path), includingPropertiesForKeys: [.isDirectoryKey,.isRegularFileKey,.isSymbolicLinkKey], options: [.skipsHiddenFiles])
            for child in children {
                visited += 1; guard visited <= Self.maximumEntries else { throw VaultFileManagementError.limit }
                let relative = path.isEmpty ? child.lastPathComponent : path + "/" + child.lastPathComponent
                let values = try child.resourceValues(forKeys: [.isDirectoryKey,.isRegularFileKey,.isSymbolicLinkKey,.isPackageKey])
                guard values.isSymbolicLink != true, values.isPackage != true else { continue }
                if values.isDirectory == true { pending.append(relative); continue }
                let board = relative.lowercased().hasSuffix(".inkspace.json")
                guard board || (relative.lowercased().hasSuffix(".md") && !relative.lowercased().hasSuffix(".notes.md")) else { continue }
                let before = try metadata(child, limit: board ? 64*1024*1024 : 4*1024*1024)
                total += before.count; guard total <= Self.maximumMetadataBytes else { throw VaultFileManagementError.limit }
                let after = try board ? patchedBoard(before, moves: moves) : patchedMarkdown(before, moves: moves)
                if after != before { patches.append(Patch(path: relative, before: before, after: after, isBoard: board)) }
            }
        }
        let (_, orderRaw, orderJSON, orders) = try orderDocument()
        if let before = orderRaw {
            var mappedOrders: [String: [String]] = [:]
            for (parent, children) in orders {
                let targetParent = Self.mapped(parent, by: moves)
                guard mappedOrders[targetParent] == nil else { throw VaultFileManagementError.invalidReference }
                mappedOrders[targetParent] = children.map { Self.mapped($0, by: moves) }
                    .filter { ($0 as NSString).deletingLastPathComponent == targetParent }
            }
            if mappedOrders != orders {
                var json = orderJSON; json["orders"] = mappedOrders
                let after = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys,.withoutEscapingSlashes])
                patches.append(Patch(path: ".inkspace-folder-order.json", before: before, after: after, isBoard: false))
            }
        }
        return patches
    }
    private func patchedBoard(_ data: Data, moves: [VaultManagedMove]) throws -> Data {
        guard var json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (json["schemaVersion"] as? NSNumber)?.intValue == 1,
              var items = json["items"] as? [[String: Any]] else { throw VaultFileManagementError.invalidReference }
        var changed = false
        func patch(_ value: Any?) -> Any? {
            guard let path = value as? String else { return value }
            let mapped = Self.mapped(path, by: moves); if mapped != path { changed = true }
            return mapped
        }
        for index in items.indices {
            for key in ["sourcePath","originalSourcePath"] { if items[index][key] != nil { items[index][key] = patch(items[index][key]) } }
            if var reference = items[index]["sourceReference"] as? [String: Any] {
                reference["path"] = patch(reference["path"])
                items[index]["sourceReference"] = reference
            }
            if var children = items[index]["childBoards"] as? [[String: Any]] {
                for child in children.indices { children[child]["path"] = patch(children[child]["path"]) }
                items[index]["childBoards"] = children
            }
        }
        json["items"] = items
        if var sources = json["pdfAnnotationSources"] as? [[String: Any]] {
            for index in sources.indices { sources[index]["sourcePath"] = patch(sources[index]["sourcePath"]) }
            json["pdfAnnotationSources"] = sources
        }
        if let sources = json["pdfOwnedSourcePaths"] as? [String] { json["pdfOwnedSourcePaths"] = sources.map { patch($0) as! String } }
        guard changed else { return data }
        // Structural mutation retains every unrecognized field and all native ink.
        // Validate the resulting known schema before any filesystem mutation.
        if let revision = json["revision"] as? NSNumber { json["revision"] = revision.intValue + 1 }
        json["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        json["writerID"] = UUID().uuidString
        let result = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys,.withoutEscapingSlashes])
        _ = try BoardDocument.decode(result)
        return result
    }
    private func patchedMarkdown(_ data: Data, moves: [VaultManagedMove]) throws -> Data {
        guard var text = String(data: data, encoding: .utf8) else { return data }
        let regex = try NSRegularExpression(pattern: "(?m)^```inkspace[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$")
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard matches.count <= 1000 else { throw VaultFileManagementError.limit }
        for match in matches.reversed() {
            guard let range = Range(match.range(at: 1), in: text),
                  let bytes = text[range].data(using: .utf8),
                  var json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let file = json["file"] as? String else { continue }
            let mapped = Self.mapped(file, by: moves); guard file != mapped else { continue }
            json["file"] = mapped
            let replacement = String(data: try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys,.withoutEscapingSlashes]), encoding: .utf8)!
            text.replaceSubrange(range, with: replacement)
        }
        return Data(text.utf8)
    }
    private func checkReviews(_ moves: [VaultManagedMove]) throws {
        let dir = rootURL.appendingPathComponent(".inkspace-reviews")
        guard fm.fileExists(atPath: dir.path) else { return }
        _ = try url(".inkspace-reviews", internalPath: true)
        let files = try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])
        guard files.count <= 20_000 else { throw VaultFileManagementError.limit }
        var tombstones = Set<String>(), total = 0
        for file in files where file.lastPathComponent.lowercased().hasSuffix(".deleted.json") {
            let stem = String(file.lastPathComponent.dropLast(".deleted.json".count)).lowercased()
            guard UUID(uuidString: stem) != nil else { throw VaultFileManagementError.invalidReference }
            tombstones.insert(stem) // Even invalid marker content hides its record.
        }
        for file in files where file.pathExtension.lowercased() == "json" && !file.lastPathComponent.lowercased().hasSuffix(".deleted.json") {
            let id = file.deletingPathExtension().lastPathComponent.lowercased()
            guard !tombstones.contains(id) else { continue }
            let data = try metadata(file, limit: 128*1024); total += data.count
            guard total <= 32*1024*1024 else { throw VaultFileManagementError.limit }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (json["schemaVersion"] as? NSNumber)?.intValue == 1,
                  let payloadID = json["id"] as? String, payloadID.lowercased() == id,
                  let boardPath = json["boardPath"] as? String else { throw VaultFileManagementError.invalidReference }
            var paths = [boardPath]
            if let anchor = json["anchor"] as? [String: Any] {
                paths += [anchor["sourcePath"] as? String, anchor["originalSourcePath"] as? String].compactMap { $0 }
            }
            if paths.contains(where: { Self.mapped($0, by: moves) != $0 }) { throw VaultFileManagementError.reviewsBlockMove }
        }
    }

    private func ensureInternalDirectory(_ name: String) throws -> URL {
        let target = try url(name, exists: false, internalPath: true)
        if !fm.fileExists(atPath: target.path) { try fm.createDirectory(at: target, withIntermediateDirectories: false) }
        guard try target.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw VaultFileManagementError.unsafe }
        return target
    }
    private func writeNew(_ data: Data, to target: URL) throws {
        guard !fm.fileExists(atPath: target.path) else { throw VaultFileManagementError.collision }
        try data.write(to: target, options: .withoutOverwriting)
        let handle = try FileHandle(forWritingTo: target); try handle.synchronize(); try handle.close()
    }
    private func writeReplacing(_ data: Data, at target: URL, expected: Data) throws {
        guard try metadata(target, limit: Self.maximumMetadataBytes) == expected else { throw VaultFileManagementError.changed }
        try data.write(to: target, options: .atomic)
    }
    private func jsonData<T: Encodable>(_ value: T) throws -> Data { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value) }
    private struct Journal: Codable {
        var schemaVersion = 1; var id: String; var createdAt: String; var state: String
        var moves: [VaultManagedMove]; var patchedPaths: [String]
    }
    private func selectionWithNotes(_ paths: [String]) throws -> [String] {
        var paths = try selected(paths)
        // A side note belongs to its exact original file, even though its content is
        // user-owned. Moving it never regenerates or rewrites its Markdown body.
        for path in paths {
            let source = try url(path)
            if try source.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                let note = path + ".notes.md"
                if fm.fileExists(atPath: rootURL.appendingPathComponent(note).path), !paths.contains(note) {
                    guard try url(note).resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw VaultFileManagementError.unsafe }
                    paths.append(note)
                }
                let parent = (path as NSString).deletingLastPathComponent
                let sidecarName = "." + (path as NSString).lastPathComponent + ".inkspace-subtitles.json"
                let sidecar = parent.isEmpty ? sidecarName : parent + "/" + sidecarName
                if Self.subtitleVideoPath(sidecar) == path,
                   fm.fileExists(atPath: rootURL.appendingPathComponent(sidecar).path), !paths.contains(sidecar) {
                    guard try stamp(url(sidecar), path: sidecar).type == FileAttributeType.typeRegular.rawValue else { throw VaultFileManagementError.unsafe }
                    paths.append(sidecar)
                }
                if (path as NSString).pathExtension.lowercased() == "pdf" {
                    for suffix in [".inkspace-pdf", ".inkspace-extend"] {
                        let name = "." + (path as NSString).lastPathComponent + suffix
                        let companion = parent.isEmpty ? name : parent + "/" + name
                        if fm.fileExists(atPath: rootURL.appendingPathComponent(companion).path), !paths.contains(companion) {
                            let child = try url(companion)
                            let valid = try suffix == ".inkspace-pdf" ? hasPDFLayerCompanion(child) : hasPDFExtensionCompanion(child)
                            guard valid else { throw VaultFileManagementError.invalidReference }
                            paths.append(companion)
                        }
                    }
                }
            }
        }
        guard paths.count <= Self.maximumSelection else { throw VaultFileManagementError.limit }
        return try selected(paths, companions: true)
    }
    private func movePairs(_ paths: [String], destination: String) throws -> [VaultManagedMove] {
        guard Self.safePath(destination, allowRoot: true),
              try url(destination).resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw VaultFileManagementError.unsafe }
        let paths = try selectionWithNotes(paths)
        var targets = Set<String>()
        return try paths.map { source in
            let name = (source as NSString).lastPathComponent
            let target = destination.isEmpty ? name : destination + "/" + name
            guard target != source, !destination.hasPrefix(source + "/"), destination != source else { throw VaultFileManagementError.unsafe }
            let normalized = target.precomposedStringWithCanonicalMapping.lowercased()
            guard targets.insert(normalized).inserted, !fm.fileExists(atPath: (try url(target, exists: false)).path) else { throw VaultFileManagementError.collision }
            return VaultManagedMove(from: source, to: target)
        }
    }
    func move(paths: [String], to destination: String) throws -> VaultManagementResult {
        try coordinated(write: true) { try executeMoves(movePairs(paths, destination: destination)) }
    }
    /// Shared transaction for a future/native rename entry point. Paired files
    /// retain the exact new source basename and rollback together on failure.
    func rename(path: String, to name: String) throws -> VaultManagementResult {
        try coordinated(write: true) {
            guard Self.safePath(path), Self.safePath(name), (name as NSString).lastPathComponent == name,
                  (path as NSString).lastPathComponent != name else { throw VaultFileManagementError.unsafe }
            let parent = (path as NSString).deletingLastPathComponent
            let target = parent.isEmpty ? name : parent + "/" + name
            let chosen = try selectionWithNotes([path])
            if chosen.contains(where: { Self.pdfCompanionSource($0) != nil }), (name as NSString).pathExtension.lowercased() != "pdf" { throw VaultFileManagementError.unsafe }
            var targets = Set<String>()
            let moves = try chosen.map { source -> VaultManagedMove in
                let destination: String
                if source == path { destination = target }
                else if source == path + ".notes.md" { destination = target + ".notes.md" }
                else {
                    let oldName = "." + (path as NSString).lastPathComponent
                    let suffix = String((source as NSString).lastPathComponent.dropFirst(oldName.count))
                    destination = (parent.isEmpty ? "" : parent + "/") + "." + name + suffix
                }
                guard Self.managedPath(destination), targets.insert(destination.precomposedStringWithCanonicalMapping.lowercased()).inserted,
                      !fm.fileExists(atPath: (try url(destination, exists: false)).path) else { throw VaultFileManagementError.collision }
                return VaultManagedMove(from: source, to: destination)
            }
            return try executeMoves(moves)
        }
    }
    private func executeMoves(_ moves: [VaultManagedMove]) throws -> VaultManagementResult {
            let beforeTree = try tree(moves.map(\.from))
            try checkReviews(moves)
            let changes = try patches(for: moves)
            guard beforeTree == (try tree(moves.map(\.from))) else { throw VaultFileManagementError.changed }
            for patch in changes { guard try metadata(url(patch.path, internalPath: patch.path == ".inkspace-folder-order.json"), limit: Self.maximumMetadataBytes) == patch.before else { throw VaultFileManagementError.changed } }
            try Task.checkCancellation()
            let journalRoot = try ensureInternalDirectory(Self.journalFolder)
            let id = UUID().uuidString.lowercased(), journalURL = journalRoot.appendingPathComponent(id)
            try fm.createDirectory(at: journalURL, withIntermediateDirectories: false)
            let before = journalURL.appendingPathComponent("before"); try fm.createDirectory(at: before, withIntermediateDirectories: false)
            for (index, patch) in changes.enumerated() { try writeNew(patch.before, to: before.appendingPathComponent(String(index))) }
            var journal = Journal(id: id, createdAt: ISO8601DateFormatter().string(from: Date()), state: "prepared", moves: moves, patchedPaths: changes.map(\.path))
            let recordURL = journalURL.appendingPathComponent("manifest.json")
            var record = try jsonData(journal); try writeNew(record, to: recordURL)
            var completedMoves: [VaultManagedMove] = [], completedPatches: [Patch] = []
            // Once a move starts, finish or roll back the batch even if its caller is
            // cancelled. Returning midway would expose stale board paths to autosave.
            do {
                for move in moves {
                    try fm.moveItem(at: url(move.from), to: url(move.to, exists: false))
                    completedMoves.append(move)
                    if let faultAfterMoves, completedMoves.count == faultAfterMoves { throw VaultFileManagementError.changed }
                }
                for patch in changes {
                    try writeReplacing(patch.after, at: url(Self.mapped(patch.path, by: moves), internalPath: patch.path == ".inkspace-folder-order.json"), expected: patch.before)
                    completedPatches.append(patch)
                }
                journal.state = "complete"; let next = try jsonData(journal)
                try writeReplacing(next, at: recordURL, expected: record); record = next
                return VaultManagementResult(moves: moves, changedBoards: changes.filter(\.isBoard).map { Self.mapped($0.path, by: moves) })
            } catch {
                var rollbackFailed = false
                for patch in completedPatches.reversed() {
                    do { try writeReplacing(patch.before, at: url(Self.mapped(patch.path, by: moves), internalPath: patch.path == ".inkspace-folder-order.json"), expected: patch.after) }
                    catch { rollbackFailed = true }
                }
                for move in completedMoves.reversed() {
                    do {
                        guard !fm.fileExists(atPath: rootURL.appendingPathComponent(move.from).path) else { throw VaultFileManagementError.collision }
                        try fm.moveItem(at: url(move.to), to: url(move.from, exists: false))
                    } catch { rollbackFailed = true }
                }
                journal.state = rollbackFailed ? "needs-recovery" : "rolled-back"
                try? writeReplacing(jsonData(journal), at: recordURL, expected: record)
                if rollbackFailed { throw VaultFileManagementError.recoveryRequired }
                throw error
            }
    }

    func trash(paths: [String]) throws -> VaultManagementResult {
        try coordinated(write: true) {
            let chosen = try selectionWithNotes(paths), beforeTree = try tree(chosen)
            let id = UUID().uuidString.lowercased()
            var manifest = VaultTrashManifest(id: id, createdAt: ISO8601DateFormatter().string(from: Date()),
                entries: chosen.enumerated().map { .init(originalPath: $0.element, storedName: "items/\($0.offset)") }, state: "prepared")
            manifest.inventory = try inventory(for: beforeTree, entries: manifest.entries)
            let trash = try ensureInternalDirectory(".inkspace-trash"), directory = trash.appendingPathComponent(id)
            try fm.createDirectory(at: directory, withIntermediateDirectories: false)
            let items = directory.appendingPathComponent("items"); try fm.createDirectory(at: items, withIntermediateDirectories: false)
            let target = directory.appendingPathComponent("manifest.json")
            var record = try jsonData(manifest); try writeNew(record, to: target)
            guard beforeTree == (try tree(chosen)) else { throw VaultFileManagementError.changed }
            try Task.checkCancellation()
            var moved: [VaultTrashManifest.Entry] = []
            do {
                for entry in manifest.entries {
                    try fm.moveItem(at: url(entry.originalPath), to: directory.appendingPathComponent(entry.storedName)); moved.append(entry)
                    if let faultAfterMoves, moved.count == faultAfterMoves { throw VaultFileManagementError.changed }
                }
                manifest.state = "complete"; let next = try jsonData(manifest)
                try writeReplacing(next, at: target, expected: record); record = next
                return VaultManagementResult(removed: chosen, trashID: id)
            } catch {
                var failed = false
                for entry in moved.reversed() {
                    do {
                        let original = try url(entry.originalPath, exists: false)
                        guard !fm.fileExists(atPath: original.path) else { throw VaultFileManagementError.collision }
                        try fm.moveItem(at: directory.appendingPathComponent(entry.storedName), to: original)
                    } catch { failed = true }
                }
                manifest.state = failed ? "needs-recovery" : "restored"
                try? writeReplacing(jsonData(manifest), at: target, expected: record)
                if failed { throw VaultFileManagementError.recoveryRequired }; throw error
            }
        }
    }
    private func validatedTrash(_ id: String) throws -> (URL, VaultTrashManifest, Data) {
        guard let uuid = UUID(uuidString: id) else { throw VaultFileManagementError.unsafe }
        let directory = try url(".inkspace-trash/" + uuid.uuidString.lowercased(), internalPath: true)
        let raw = try metadata(directory.appendingPathComponent("manifest.json"), limit: 4*1024*1024)
        let manifest = try JSONDecoder().decode(VaultTrashManifest.self, from: raw)
        guard manifest.schemaVersion == 1, manifest.id.lowercased() == uuid.uuidString.lowercased(),
              !manifest.entries.isEmpty, manifest.entries.count <= Self.maximumSelection,
              manifest.entries.enumerated().allSatisfy({ index, entry in entry.storedName == "items/\(index)" && (Self.safePath(entry.originalPath) || Self.companionSource(entry.originalPath).map { source in manifest.entries.contains { $0.originalPath == source } } == true) }),
              Set(manifest.entries.map(\.originalPath)).count == manifest.entries.count else { throw VaultFileManagementError.incompleteTrash }
        return (directory, manifest, raw)
    }
    func listTrash() throws -> [VaultTrashManifest] {
        try coordinated(write: false) {
            let target = rootURL.appendingPathComponent(".inkspace-trash")
            guard fm.fileExists(atPath: target.path) else { return [] }
            _ = try url(".inkspace-trash", internalPath: true)
            let files = try fm.contentsOfDirectory(at: target, includingPropertiesForKeys: nil)
            guard files.count <= 5_000 else { throw VaultFileManagementError.limit }
            var manifests: [VaultTrashManifest] = []
            for file in files where UUID(uuidString: file.lastPathComponent) != nil {
                let (_, manifest, _) = try validatedTrash(file.lastPathComponent)
                if manifest.state != "restored" { manifests.append(manifest) }
            }
            return manifests.sorted { $0.createdAt > $1.createdAt }
        }
    }
    func restore(id: String) throws -> VaultManagementResult {
        try coordinated(write: true) {
            let (directory, loaded, raw) = try validatedTrash(id)
            var manifest = loaded, record = raw
            guard manifest.state == "complete" else { throw VaultFileManagementError.incompleteTrash }
            try verifyInventory(manifest)
            for entry in manifest.entries {
                _ = try tree([".inkspace-trash/" + manifest.id.lowercased() + "/" + entry.storedName], allowHidden: true)
                let destination = try url(entry.originalPath, exists: false)
                guard !fm.fileExists(atPath: destination.path) else { throw VaultFileManagementError.collision }
                // Restore never fabricates a missing parent; it may itself still be in
                // another trash batch or await iCloud. Restore that parent first.
                guard fm.fileExists(atPath: destination.deletingLastPathComponent().path) else { throw VaultFileManagementError.incompleteTrash }
            }
            try Task.checkCancellation()
            let target = directory.appendingPathComponent("manifest.json")
            manifest.state = "restoring"; let next = try jsonData(manifest); try writeReplacing(next, at: target, expected: record); record = next
            var restored: [VaultTrashManifest.Entry] = []
            do {
                for entry in manifest.entries {
                    try fm.moveItem(at: directory.appendingPathComponent(entry.storedName), to: url(entry.originalPath, exists: false)); restored.append(entry)
                    if let faultAfterMoves, restored.count == faultAfterMoves { throw VaultFileManagementError.changed }
                }
                manifest.state = "restored"; try writeReplacing(jsonData(manifest), at: target, expected: record)
                return VaultManagementResult()
            } catch {
                var failed = false
                for entry in restored.reversed() {
                    do {
                        let destination = directory.appendingPathComponent(entry.storedName)
                        guard !fm.fileExists(atPath: destination.path) else { throw VaultFileManagementError.collision }
                        try fm.moveItem(at: url(entry.originalPath), to: destination)
                    } catch { failed = true }
                }
                manifest.state = failed ? "needs-recovery" : "complete"
                try? writeReplacing(jsonData(manifest), at: target, expected: record)
                if failed { throw VaultFileManagementError.recoveryRequired }; throw error
            }
        }
    }
    private func digest(_ file: URL, expectedSize: UInt64) throws -> String {
        guard expectedSize <= 128 * 1024 * 1024 else { throw VaultFileManagementError.limit }
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var hash = SHA256(), count: UInt64 = 0
        while let data = try handle.read(upToCount: 1_024 * 1_024), !data.isEmpty {
            try Task.checkCancellation(); count += UInt64(data.count)
            guard count <= expectedSize else { throw VaultFileManagementError.changed }
            hash.update(data: data)
        }
        guard count == expectedSize else { throw VaultFileManagementError.changed }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func inventory(for tree: [Stamp], entries: [VaultTrashManifest.Entry]) throws -> [VaultTrashManifest.InventoryItem] {
        var total: UInt64 = 0
        return try tree.map { file in
            guard let entry = entries.first(where: { file.path == $0.originalPath || file.path.hasPrefix($0.originalPath + "/") }) else { throw VaultFileManagementError.unsafe }
            let directory = file.type == FileAttributeType.typeDirectory.rawValue
            total += directory ? 0 : file.size; guard total <= 1024*1024*1024 else { throw VaultFileManagementError.limit }
            return VaultTrashManifest.InventoryItem(storedPath: entry.storedName + file.path.dropFirst(entry.originalPath.count),
                type: directory ? "directory" : "file", size: directory ? 0 : file.size,
                sha256: directory ? nil : try digest(url(file.path, internalPath: true), expectedSize: file.size))
        }
    }
    private func verifyInventory(_ manifest: VaultTrashManifest) throws {
        guard let inventory = manifest.inventory, !inventory.isEmpty, inventory.count <= Self.maximumEntries,
              Set(inventory.map(\.storedPath)).count == inventory.count else { throw VaultFileManagementError.incompleteTrash }
        let prefix = ".inkspace-trash/" + manifest.id.lowercased() + "/"
        let actual = try tree(manifest.entries.map { prefix + $0.storedName }, allowHidden: true)
        guard Set(actual.map { String($0.path.dropFirst(prefix.count)) }) == Set(inventory.map(\.storedPath)) else { throw VaultFileManagementError.incompleteTrash }
        var total: UInt64 = 0
        for item in inventory {
            guard VaultPath.isSafeRelative(item.storedPath),
                  manifest.entries.contains(where: { item.storedPath == $0.storedName || item.storedPath.hasPrefix($0.storedName + "/") }),
                  let file = actual.first(where: { $0.path == prefix + item.storedPath }) else { throw VaultFileManagementError.incompleteTrash }
            if item.type == "directory" {
                guard file.type == FileAttributeType.typeDirectory.rawValue, item.size == 0 else { throw VaultFileManagementError.incompleteTrash }
            } else {
                guard item.type == "file", file.type == FileAttributeType.typeRegular.rawValue,
                      file.size == item.size, let sha = item.sha256,
                      sha.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil else { throw VaultFileManagementError.incompleteTrash }
                total += item.size; guard total <= 1024*1024*1024 else { throw VaultFileManagementError.limit }
                guard try digest(url(file.path, internalPath: true), expectedSize: item.size) == sha.lowercased() else { throw VaultFileManagementError.incompleteTrash }
            }
        }
    }
    func prepareShare(paths: [String]) throws -> URL {
        try coordinated(write: false) {
            let chosen = try selected(paths), before = try tree(chosen)
            let files = before.filter { $0.type == FileAttributeType.typeRegular.rawValue }
            guard !files.isEmpty else { throw VaultFileManagementError.emptyShare }
            let directory = fm.temporaryDirectory.appendingPathComponent("InkSpace-Shared-\(UUID().uuidString)", isDirectory: true)
            try fm.createDirectory(at: directory, withIntermediateDirectories: false)
            let archive = directory.appendingPathComponent("Files.zip")
            do {
                try BackupArchive.write(entries: files.map { (name: $0.path, url: try url($0.path, internalPath: true)) }, to: archive)
                guard before == (try tree(chosen)) else { throw VaultFileManagementError.changed }
                return archive
            } catch { try? fm.removeItem(at: directory); throw error }
        }
    }
}

import Foundation
import ImageIO
import CryptoKit
import zlib
import Darwin

/// Read-only XLSX picture references. Package entries remain in memory; no paths
/// are extracted, no relationships are fetched, and no workbook code is run.
struct ExcelPictureBook: Sendable {
    struct Asset: Identifiable, Sendable {
        let id: String
        let data: Data
        let width: Int
        let height: Int
        let frameCount: Int
    }
    struct Picture: Identifiable, Sendable {
        let id: String
        let name: String
        let location: Location
        let assetID: String?
        let issue: Issue?
        let hasDisplayTransforms: Bool
    }
    enum Location: Sendable {
        case cells(from: String, to: String?)
        case absolute(x: Double, y: Double)
        case unspecified
    }
    enum Issue: String, Sendable { case external, missing, unsupported, tooLarge, unreadable }
    struct Sheet: Identifiable, Sendable {
        let id: String
        let name: String
        let pictures: [Picture]
        let warnings: Int
    }
    let sheets: [Sheet]
    let assets: [String: Asset]
    let omittedObjects: Int
    let hiddenSheets: Int
}

enum ExcelPictureError: Error { case unsupported, invalid, capacity }

enum ExcelEmbeddedPictures {
    static let maximumSourceBytes = 64 * 1_024 * 1_024
    private static let maximumPictureBytes = 16 * 1_024 * 1_024
    private static let maximumAssetBytes = 64 * 1_024 * 1_024

    static func read(url: URL) throws -> ExcelPictureBook {
        guard url.isFileURL, url.pathExtension.lowercased() == "xlsx" else { throw ExcelPictureError.unsupported }
        let before = try FileManager.default.attributesOfItem(atPath: url.path)
        guard before[.type] as? FileAttributeType == .typeRegular,
              let count = before[.size] as? NSNumber, count.int64Value > 0,
              count.int64Value <= Int64(maximumSourceBytes) else { throw ExcelPictureError.capacity }
        try Task.checkCancellation()
        // Own the bytes rather than mapping an iCloud-backed file that another
        // writer can truncate. Never read beyond the bounded package budget.
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var opened = stat()
        guard fstat(handle.fileDescriptor, &opened) == 0,
              opened.st_size == count.int64Value,
              (before[.systemFileNumber] as? NSNumber)?.uint64Value == UInt64(opened.st_ino),
              (before[.systemNumber] as? NSNumber)?.int64Value == Int64(opened.st_dev) else { throw ExcelPictureError.invalid }
        var data = Data()
        while data.count <= maximumSourceBytes {
            try Task.checkCancellation()
            let chunk = try handle.read(upToCount: min(262_144, maximumSourceBytes + 1 - data.count)) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk)
        }
        var completed = stat()
        guard fstat(handle.fileDescriptor, &completed) == 0,
              completed.st_ino == opened.st_ino, completed.st_dev == opened.st_dev,
              completed.st_size == opened.st_size,
              completed.st_mtimespec.tv_sec == opened.st_mtimespec.tv_sec,
              completed.st_mtimespec.tv_nsec == opened.st_mtimespec.tv_nsec else { throw ExcelPictureError.invalid }
        let after = try FileManager.default.attributesOfItem(atPath: url.path)
        guard data.count == count.intValue, data.count <= maximumSourceBytes,
              before[.size] as? NSNumber == after[.size] as? NSNumber,
              before[.modificationDate] as? Date == after[.modificationDate] as? Date,
              before[.systemFileNumber] as? NSNumber == after[.systemFileNumber] as? NSNumber,
              before[.systemNumber] as? NSNumber == after[.systemNumber] as? NSNumber else { throw ExcelPictureError.invalid }
        return try read(data: data)
    }

    static func read(data: Data) throws -> ExcelPictureBook {
        let zip = try PictureZIP(data: data, maximumBytes: maximumSourceBytes)
        let rootRelations = try relationships(in: zip, part: "")
        let workbookRelationships = rootRelations.values.filter { $0.type.hasSuffix("/officeDocument") }
        guard workbookRelationships.count == 1, let workbookRelationship = workbookRelationships.first,
              !workbookRelationship.external,
              let workbookPath = resolve(workbookRelationship.target, from: "") else { throw ExcelPictureError.invalid }
        let workbook = try PictureXML.parse(zip.read(workbookPath, maximum: 4 * 1_024 * 1_024))
        let workbookRelations = try relationships(in: zip, part: workbookPath)
        var sheets: [ExcelPictureBook.Sheet] = [], assets: [String: ExcelPictureBook.Asset] = [:]
        var assetBytes = 0, placementCount = 0, drawingCount = 0, omitted = 0, hidden = 0
        for (sheetIndex, sheet) in workbook.descendants("sheet").enumerated() {
            try Task.checkCancellation()
            guard sheetIndex < 128 else { throw ExcelPictureError.capacity }
            if let state = sheet.attributes["state"], state != "visible" { hidden += 1; continue }
            guard let name = sheet.attributes["name"], !name.isEmpty, name.count <= 256,
                  let relationID = sheet.attributes["id"], let relation = workbookRelations[relationID],
                  relation.type.hasSuffix("/worksheet"), !relation.external,
                  let sheetPath = resolve(relation.target, from: workbookPath) else { omitted += 1; continue }
            let sheetID = "sheet-\(sheetIndex)"
            var pictures: [ExcelPictureBook.Picture] = []
            var warnings = 0
            do {
                let drawingReferences = try PictureXML.parse(zip.read(sheetPath, maximum: 16 * 1_024 * 1_024), collecting: ["drawing"]).descendants("drawing")
                // Missing/unused media are never treated as worksheet pictures.
                let sheetRelations = drawingReferences.isEmpty ? [:] : try relationships(in: zip, part: sheetPath, optional: true)
                guard drawingReferences.count <= 128, drawingReferences.count <= 256 - drawingCount else { throw ExcelPictureError.capacity }
                drawingCount += drawingReferences.count
                for (drawingIndex, reference) in drawingReferences.enumerated() {
                    try Task.checkCancellation()
                    do {
                        guard let relationID = reference.attributes["id"], let relation = sheetRelations[relationID],
                              relation.type.hasSuffix("/drawing"), !relation.external,
                              let drawingPath = resolve(relation.target, from: sheetPath), zip.contains(drawingPath) else { throw ExcelPictureError.invalid }
                        let drawing = try PictureXML.parse(zip.read(drawingPath, maximum: 4 * 1_024 * 1_024))
                        let imageRelations = try relationships(in: zip, part: drawingPath, optional: true)
                        let anchors = drawing.children.first?.children ?? []
                        for (anchorIndex, anchor) in anchors.enumerated() {
                            try Task.checkCancellation()
                            guard ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor"].contains(anchor.name) else { omitted += 1; continue }
                            // Group transformations and chart/shape rendering are outside
                            // this original-picture reader; do not flatten them silently.
                            guard let picture = anchor.children.first(where: { $0.name == "pic" }) else { omitted += 1; continue }
                            placementCount += 1
                            guard placementCount <= 256 else { throw ExcelPictureError.capacity }
                            let id = "\(sheetID)-drawing-\(drawingIndex)-anchor-\(anchorIndex)"
                            let label = String((picture.descendants("cNvPr").first?.attributes["name"] ?? "").prefix(200))
                            let position = location(anchor)
                            let changed = picture.descendants("srcRect").contains { node in
                                node.attributes.values.contains { (Int($0) ?? 0) != 0 }
                            } || picture.descendants("xfrm").contains { node in
                                (Int(node.attributes["rot"] ?? "0") ?? 0) != 0 ||
                                ["1", "true"].contains(node.attributes["flipH"] ?? "") || ["1", "true"].contains(node.attributes["flipV"] ?? "")
                            }
                            var assetID: String?, issue: ExcelPictureBook.Issue?
                            if let blip = picture.descendants("blip").first {
                                if blip.attributes["link"] != nil { issue = .external }
                                else if let embedded = blip.attributes["embed"], let imageRelation = imageRelations[embedded] {
                                    if imageRelation.external { issue = .external }
                                    else if !imageRelation.type.hasSuffix("/image") { issue = .unsupported }
                                    else if let imagePath = resolve(imageRelation.target, from: drawingPath), zip.contains(imagePath) {
                                        do {
                                            let bytes = try zip.read(imagePath, maximum: maximumPictureBytes)
                                            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                                            if assets[digest] == nil {
                                                let properties = try pictureProperties(bytes)
                                                guard bytes.count <= maximumAssetBytes - assetBytes else { throw ExcelPictureError.capacity }
                                                assets[digest] = ExcelPictureBook.Asset(id: digest, data: bytes,
                                                    width: properties.width, height: properties.height, frameCount: properties.frames)
                                                assetBytes += bytes.count
                                            }
                                            assetID = digest
                                        } catch is CancellationError { throw CancellationError() }
                                        catch ExcelPictureError.capacity { issue = .tooLarge }
                                        catch ExcelPictureError.unsupported { issue = .unsupported }
                                        catch { issue = .unreadable }
                                    } else { issue = .missing }
                                } else { issue = .missing }
                            } else { issue = .unsupported }
                            pictures.append(.init(id: id, name: label, location: position, assetID: assetID,
                                issue: issue, hasDisplayTransforms: changed))
                        }
                    } catch is CancellationError { throw CancellationError() }
                    catch { warnings += 1 }
                }
            } catch is CancellationError { throw CancellationError() }
            catch { warnings += 1 }
            sheets.append(.init(id: sheetID, name: name, pictures: pictures, warnings: warnings))
        }
        return ExcelPictureBook(sheets: sheets, assets: assets, omittedObjects: omitted, hiddenSheets: hidden)
    }

    static func decode(_ asset: ExcelPictureBook.Asset, maximumDimension: Int = 2400) throws -> CGImage {
        try Task.checkCancellation()
        _ = try pictureProperties(asset.data)
        guard let source = CGImageSourceCreateWithData(asset.data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: min(2400, max(64, maximumDimension)),
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary), image.width * image.height <= 5_760_000 else { throw ExcelPictureError.invalid }
        try Task.checkCancellation()
        return image
    }

    private static func pictureProperties(_ data: Data) throws -> (width: Int, height: Int, frames: Int) {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String?,
              ["public.png", "public.jpeg", "com.compuserve.gif", "public.tiff", "com.microsoft.bmp"].contains(type) else { throw ExcelPictureError.unsupported }
        guard CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0 else { throw ExcelPictureError.invalid }
        guard width <= 20_000, height <= 20_000, width <= 40_000_000 / height else { throw ExcelPictureError.capacity }
        // A valid header is not a readable picture. Force a small pixel decode
        // now so a truncated/corrupt asset receives an explicit unavailable row.
        guard let probe = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 64,
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary), probe.width > 0, probe.height > 0,
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete else { throw ExcelPictureError.invalid }
        return (width, height, CGImageSourceGetCount(source))
    }
    private struct Relationship { let type: String; let target: String; let external: Bool }
    private static func relationships(in zip: PictureZIP, part: String, optional: Bool = false) throws -> [String: Relationship] {
        let path = part.isEmpty ? "_rels/.rels" : (part as NSString).deletingLastPathComponent + "/_rels/" + (part as NSString).lastPathComponent + ".rels"
        let normalized = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if optional, !zip.contains(normalized) { return [:] }
        let root = try PictureXML.parse(zip.read(normalized, maximum: 2 * 1_024 * 1_024))
        var result: [String: Relationship] = [:]
        for node in root.descendants("Relationship") {
            guard let id = node.attributes["Id"], let type = node.attributes["Type"], let target = node.attributes["Target"],
                  id.count <= 512, target.count <= 2048, result[id] == nil else { throw ExcelPictureError.invalid }
            result[id] = .init(type: type, target: target, external: node.attributes["TargetMode"] == "External")
        }
        return result
    }
    private static func resolve(_ target: String, from part: String) -> String? {
        guard let decoded = target.removingPercentEncoding, !decoded.contains("\\"), !decoded.contains(":"),
              !decoded.contains("?"), !decoded.contains("#"), !decoded.contains("\0") else { return nil }
        var components = decoded.hasPrefix("/") ? [] : part.split(separator: "/").dropLast().map(String.init)
        for piece in decoded.split(separator: "/") {
            if piece == "." { continue }
            if piece == ".." { guard !components.isEmpty else { return nil }; components.removeLast() }
            else { components.append(String(piece)) }
        }
        return components.isEmpty ? nil : components.joined(separator: "/")
    }
    private static func location(_ anchor: PictureXML.Node) -> ExcelPictureBook.Location {
        func cell(_ name: String) -> String? {
            guard let node = anchor.children.first(where: { $0.name == name }),
                  let row = Int(node.children.first(where: { $0.name == "row" })?.text ?? ""),
                  let column = Int(node.children.first(where: { $0.name == "col" })?.text ?? ""),
                  (0..<1_048_576).contains(row), (0..<16_384).contains(column) else { return nil }
            var value = column + 1, letters = ""
            while value > 0 { value -= 1; letters = String(UnicodeScalar(65 + value % 26)!) + letters; value /= 26 }
            return "\(letters)\(row + 1)"
        }
        if let from = cell("from") { return .cells(from: from, to: cell("to")) }
        if anchor.name == "absoluteAnchor", let position = anchor.children.first(where: { $0.name == "pos" }),
           let x = Double(position.attributes["x"] ?? ""), let y = Double(position.attributes["y"] ?? ""),
           x.isFinite, y.isFinite, abs(x) <= 1e12, abs(y) <= 1e12 { return .absolute(x: x / 12700, y: y / 12700) }
        return .unspecified
    }
}

private enum PictureXML {
    final class Node {
        let name: String
        let attributes: [String: String]
        var text = ""
        var children: [Node] = []
        init(_ name: String, _ attributes: [String: String] = [:]) { self.name = name; self.attributes = attributes }
        func descendants(_ name: String) -> [Node] {
            children.flatMap { ($0.name == name ? [$0] : []) + $0.descendants(name) }
        }
    }
    static func parse(_ bytes: Data, collecting: Set<String>? = nil) throws -> Node {
        guard let xml = String(data: bytes, encoding: .utf8), !xml.contains("\0"),
              !xml.contains("<!DOCTYPE"), !xml.contains("<!ENTITY") else { throw ExcelPictureError.invalid }
        let delegate = Reader(collecting: collecting)
        let parser = XMLParser(data: bytes); parser.shouldResolveExternalEntities = false; parser.delegate = delegate
        guard parser.parse(), !delegate.failed else {
            try Task.checkCancellation(); throw ExcelPictureError.invalid
        }
        return delegate.root
    }
    private final class Reader: NSObject, XMLParserDelegate {
        let root = Node("root")
        let collecting: Set<String>?
        var stack: [Node] = []
        var depth = 0, elements = 0, textBytes = 0
        var failed = false
        init(collecting: Set<String>?) { self.collecting = collecting; super.init(); stack = [root] }
        func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes: [String: String]) {
            depth += 1; elements += 1
            guard depth <= 128, elements <= (collecting == nil ? 30_000 : 500_000), !Task.isCancelled else { failed = true; parser.abortParsing(); return }
            let name = elementName.split(separator: ":").last.map(String.init) ?? elementName
            if let collecting, !collecting.contains(name) { return }
            var local: [String: String] = [:]
            for (key, value) in attributes {
                guard value.utf8.count <= 8192 else { failed = true; parser.abortParsing(); return }
                let localName = key.split(separator: ":").last.map(String.init) ?? key
                guard local[localName] == nil else { failed = true; parser.abortParsing(); return }
                local[localName] = value
            }
            let node = Node(name, local)
            if collecting != nil { root.children.append(node) }
            else { stack.last?.children.append(node); stack.append(node) }
        }
        func parser(_ parser: XMLParser, foundCharacters string: String) {
            guard collecting == nil else { return }
            textBytes += string.utf8.count
            guard textBytes <= 1_024 * 1_024 else { failed = true; parser.abortParsing(); return }
            stack.last?.text += string
        }
        func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
            depth -= 1
            if collecting == nil, stack.count > 1 { stack.removeLast() }
        }
    }
}

private struct PictureZIP {
    private struct Entry { let method: Int; let flags: Int; let crc: UInt32; let compressed: Int; let expanded: Int; let offset: Int }
    private let data: Data
    private let centralStart: Int
    private let entries: [String: Entry]
    init(data: Data, maximumBytes: Int) throws {
        guard data.count >= 22, data.count <= maximumBytes else { throw ExcelPictureError.capacity }
        self.data = data
        func u16(_ n: Int) -> Int { Int(data[n]) | Int(data[n+1]) << 8 }
        func u32(_ n: Int) -> Int { u16(n) | u16(n+2) << 16 }
        var end: Int?
        for p in stride(from: data.count - 22, through: max(0, data.count - 65557), by: -1) {
            if u32(p) == 0x06054b50, p + 22 + u16(p+20) == data.count { end = p; break }
        }
        guard let end, u16(end+4) == 0, u16(end+6) == 0, u16(end+8) == u16(end+10) else { throw ExcelPictureError.invalid }
        let count = u16(end+10), length = u32(end+12), start = u32(end+16)
        guard count > 0, count < 10000, start > 0, length <= 8 * 1_024 * 1_024, start <= end,
              length == end - start else { throw ExcelPictureError.capacity }
        centralStart = start
        var cursor = start, expandedTotal = 0, result: [String: Entry] = [:]
        for _ in 0..<count {
            try Task.checkCancellation()
            guard cursor <= end - 46, u32(cursor) == 0x02014b50 else { throw ExcelPictureError.invalid }
            let flags = u16(cursor+8), method = u16(cursor+10), compressed = u32(cursor+20), expanded = u32(cursor+24)
            let nameCount = u16(cursor+28), extra = u16(cursor+30), comment = u16(cursor+32), offset = u32(cursor+42)
            guard flags & 1 == 0, [0,8].contains(method), u16(cursor+34) == 0,
                  nameCount > 0, nameCount <= 1024, cursor + 46 + nameCount + extra + comment <= end,
                  expanded <= 32 * 1_024 * 1_024, expanded <= 128 * 1_024 * 1_024 - expandedTotal,
                  offset <= start - 30, compressed <= start - offset - 30 else { throw ExcelPictureError.capacity }
            let bytes = data.subdata(in: (cursor+46)..<(cursor+46+nameCount))
            guard let name = String(data: bytes, encoding: .utf8), !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0"),
                  !name.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }), result[name] == nil else { throw ExcelPictureError.invalid }
            result[name] = Entry(method: method, flags: flags, crc: UInt32(u32(cursor+16)), compressed: compressed, expanded: expanded, offset: offset)
            expandedTotal += expanded; cursor += 46 + nameCount + extra + comment
        }
        guard cursor == end else { throw ExcelPictureError.invalid }
        entries = result
    }
    func contains(_ name: String) -> Bool { entries[name] != nil }
    func read(_ name: String, maximum: Int) throws -> Data {
        try Task.checkCancellation()
        guard let entry = entries[name] else { throw ExcelPictureError.invalid }
        guard entry.expanded <= maximum else { throw ExcelPictureError.capacity }
        func u16(_ n: Int) -> Int { Int(data[n]) | Int(data[n+1]) << 8 }
        func u32(_ n: Int) -> Int { u16(n) | u16(n+2) << 16 }
        let p = entry.offset
        guard u32(p) == 0x04034b50, u16(p+6) == entry.flags, u16(p+8) == entry.method else { throw ExcelPictureError.invalid }
        let nameCount = u16(p+26), extra = u16(p+28), start = p + 30 + nameCount + extra
        guard start <= centralStart, entry.compressed <= centralStart - start,
              String(data: data.subdata(in: (p+30)..<(p+30+nameCount)), encoding: .utf8) == name else { throw ExcelPictureError.invalid }
        if entry.flags & 8 == 0 {
            guard u32(p+14) == Int(entry.crc), u32(p+18) == entry.compressed, u32(p+22) == entry.expanded else { throw ExcelPictureError.invalid }
        }
        let compressed = data.subdata(in: start..<(start+entry.compressed))
        let result: Data
        if entry.method == 0 {
            guard compressed.count == entry.expanded else { throw ExcelPictureError.invalid }; result = compressed
        } else {
            var stream = z_stream()
            guard inflateInit2_(&stream, -MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw ExcelPictureError.invalid }
            defer { inflateEnd(&stream) }
            var output = Data(count: max(1, entry.expanded))
            let status: Int32 = compressed.withUnsafeBytes { input in
                output.withUnsafeMutableBytes { destination in
                    stream.next_in = UnsafeMutablePointer(mutating: input.bindMemory(to: Bytef.self).baseAddress)
                    stream.avail_in = uInt(compressed.count)
                    stream.next_out = destination.bindMemory(to: Bytef.self).baseAddress
                    stream.avail_out = uInt(destination.count)
                    return inflate(&stream, Z_FINISH)
                }
            }
            guard status == Z_STREAM_END, stream.total_out == entry.expanded, stream.total_in == compressed.count else { throw ExcelPictureError.invalid }
            output.count = entry.expanded; result = output
        }
        let crc = result.withUnsafeBytes { bytes in crc32(0, bytes.bindMemory(to: Bytef.self).baseAddress, uInt(bytes.count)) }
        guard UInt32(crc) == entry.crc else { throw ExcelPictureError.invalid }
        try Task.checkCancellation()
        return result
    }
}

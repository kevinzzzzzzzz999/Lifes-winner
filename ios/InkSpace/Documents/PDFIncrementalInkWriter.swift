import Foundation
import PDFKit

/// Only unsupported formats may use the existing, fully checked PDFKit fallback.
/// Malformed or over-budget input must never be repaired implicitly while saving.
enum PDFIncrementalWriteError: LocalizedError {
    case unsupportedFormat(String)
    case protectedDocument
    case malformed(String)
    case tooComplex

    var errorDescription: String? {
        switch self {
        case .unsupportedFormat(let reason): String(localized: "此 PDF 暂不支持增量写入：\(reason)")
        case .protectedDocument: String(localized: "PDF 已加密或含签名保护，原文件保持不变。")
        case .malformed(let reason): String(localized: "PDF 结构无法安全核对，原文件保持不变：\(reason)")
        case .tooComplex: String(localized: "PDF 结构或笔迹量超过本次安全处理范围，原文件保持不变。")
        }
    }
}

/// Classic-xref incremental updates retain the original byte prefix and all
/// unrelated objects. Only affected /Page dictionaries and this board's Ink
/// annotations are appended. Streams, foreign annotations and their /AP are
/// never reserialized. Xref streams/hybrid references, encryption and signatures
/// are deliberately unsupported. The caller must still reopen and verify output
/// before coordinating an atomic replacement of the original file.
/// PDF 1.7 §§3.4.5–3.4.7 and Table 8.33: InkList is in default user space;
/// appearance paths below are local to the annotation rectangle.
/// https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.7old.pdf
nonisolated enum PDFIncrementalInkWriter {
    static func update(original: Data, pdf: PDFDocument, boardID: UUID,
                       projected: [Int: [PDFInkSpecification]], affectedPages: Set<Int>) throws -> Data {
        guard !pdf.isEncrypted, !pdf.isLocked else {
            throw PDFIncrementalWriteError.protectedDocument
        }
        guard original.count <= 256 * 1024 * 1024 else { throw PDFIncrementalWriteError.tooComplex }
        // This must precede format detection: a signed xref-stream PDF must not
        // reach the fallback before its inherited signature fields are checked.
        try rejectProtectedDocument(pdf)
        let reader = try Reader(original)
        let pages = try reader.pageReferences()
        guard pages.count == pdf.pageCount,
              affectedPages.allSatisfy({ pages.indices.contains($0) }),
              Set(projected.keys).isSubset(of: affectedPages) else {
            throw PDFIncrementalWriteError.malformed(String(localized: "页码不一致"))
        }
        let owner = PDFAnnotationWritebackService.ownerPrefix(boardID: boardID)
        var output = original
        output.append(Data("\n".utf8))
        var offsets: [(Ref, Int)] = []
        var nextID = reader.size
        var totalPoints = 0
        var totalAnnotations = 0
        func appendObject(_ reference: Ref, _ body: Data) throws {
            guard output.count + body.count <= original.count + 128 * 1024 * 1024,
                  output.count < 10_000_000_000 else { throw PDFIncrementalWriteError.tooComplex }
            offsets.append((reference, output.count))
            output.append(Data("\(reference.id) \(reference.generation) obj\n".utf8))
            output.append(body)
            output.append(Data("\nendobj\n".utf8))
        }
        func reserve() throws -> Ref {
            guard nextID < 2_000_000 else { throw PDFIncrementalWriteError.tooComplex }
            defer { nextID += 1 }
            return Ref(id: nextID, generation: 0)
        }
        for pageIndex in affectedPages.sorted() {
            guard let publicPage = pdf.page(at: pageIndex) else { throw PDFIncrementalWriteError.malformed(String(localized: "缺失页面")) }
            let reference = pages[pageIndex]
            let page = try reader.object(reference)
            let annotationNodes = try reader.annotationReferences(page)
            var foreign: [String] = []
            var own: [String: Ref] = [:]
            for node in annotationNodes {
                guard case .reference(let ref) = node.kind else {
                    throw PDFIncrementalWriteError.unsupportedFormat(String(localized: "非间接引用的注释"))
                }
                let value = try reader.object(ref)
                guard case .dictionary = value.kind else { throw PDFIncrementalWriteError.malformed(String(localized: "注释不是字典")) }
                if value["FT"]?.name == "Sig" {
                    throw PDFIncrementalWriteError.protectedDocument
                }
                if let name = identifier(value), name.hasPrefix(owner) {
                    guard own.updateValue(ref, forKey: name) == nil else {
                        throw PDFIncrementalWriteError.malformed(String(localized: "重复的本板批注标识"))
                    }
                } else { foreign.append(reader.raw(node)) }
            }
            var publicOwned: [String: PDFAnnotation] = [:]
            for annotation in publicPage.annotations where PDFAnnotationWritebackService.isOwnedAnnotation(annotation, boardID: boardID) {
                guard let name = PDFAnnotationWritebackService.annotationIdentifier(annotation),
                      publicOwned.updateValue(annotation, forKey: name) == nil else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "批注识别不一致"))
                }
            }
            guard Set(publicOwned.keys) == Set(own.keys) else {
                throw PDFIncrementalWriteError.malformed(String(localized: "原始批注与阅读器识别不一致"))
            }
            var newRefs = foreign
            var names = Set<String>()
            for spec in (projected[pageIndex] ?? []) {
                totalAnnotations += 1
                guard totalAnnotations <= 100_000 else { throw PDFIncrementalWriteError.tooComplex }
                guard spec.name.hasPrefix(owner), names.insert(spec.name).inserted else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "新增批注标识无效"))
                }
                if let old = own[spec.name], let annotation = publicOwned[spec.name],
                   PDFInkProjection.matches([annotation], specifications: [spec]) {
                    newRefs.append(old.description)
                    continue
                }
                let inkRef = try reserve(), appearanceRef = try reserve()
                let encoded = try encode(spec, page: reference, appearance: appearanceRef, pointCount: &totalPoints)
                try appendObject(inkRef, encoded.annotation)
                try appendObject(appearanceRef, encoded.appearance)
                newRefs.append(inkRef.description)
            }
            let annots = "[" + newRefs.joined(separator: " ") + "]"
            var pageData = reader.bytes(in: page.range)
            if let old = page["Annots"] {
                pageData.replaceSubrange((old.range.lowerBound - page.range.lowerBound)..<(old.range.upperBound - page.range.lowerBound),
                                         with: Data(annots.utf8))
            } else {
                guard pageData.count >= 2 else { throw PDFIncrementalWriteError.malformed(String(localized: "页面字典不完整")) }
                pageData.insert(contentsOf: Data((" /Annots " + annots + " ").utf8), at: pageData.count - 2)
            }
            try appendObject(reference, pageData)
        }
        guard !offsets.isEmpty else { return original }
        let xrefOffset = output.count
        output.append(Data("xref\n".utf8))
        let sorted = offsets.sorted { $0.0.id < $1.0.id }
        var start = 0
        while start < sorted.count {
            var end = start + 1
            while end < sorted.count && sorted[end].0.id == sorted[end - 1].0.id + 1 { end += 1 }
            output.append(Data("\(sorted[start].0.id) \(end - start)\n".utf8))
            for (ref, offset) in sorted[start..<end] {
                output.append(Data(String(format: "%010lld %05d n \n", Int64(offset), ref.generation).utf8))
            }
            start = end
        }
        var trailer = Data("trailer\n<< /Size \(nextID) /Prev \(reader.startXref)".utf8)
        for (key, value) in reader.trailerFields.sorted(by: { $0.key < $1.key }) {
            // Ignore stale xref-stream-only fields in otherwise classic trailers.
            if ["Size", "Prev", "Type", "DecodeParms", "Filter", "W", "Index", "Length"].contains(key) { continue }
            trailer.append(Data(" /\(encodeName(key)) ".utf8))
            trailer.append(reader.bytes(in: value.range))
        }
        trailer.append(Data(" >>\nstartxref\n\(xrefOffset)\n%%EOF\n".utf8))
        output.append(trailer)
        return output
    }

    private static func rejectProtectedDocument(_ pdf: PDFDocument) throws {
        guard let document = pdf.documentRef, let catalog = document.catalog else {
            throw PDFIncrementalWriteError.malformed(String(localized: "无法核对文档保护信息"))
        }
        func has(_ dictionary: CGPDFDictionaryRef, _ key: String) -> Bool {
            var value: CGPDFObjectRef?
            return CGPDFDictionaryGetObject(dictionary, key, &value)
        }
        func name(_ dictionary: CGPDFDictionaryRef, _ key: String) -> String? {
            var value: UnsafePointer<CChar>?
            guard CGPDFDictionaryGetName(dictionary, key, &value), let value else { return nil }
            return String(cString: value)
        }
        if has(catalog, "Perms") { throw PDFIncrementalWriteError.protectedDocument }
        guard has(catalog, "AcroForm") else { return }
        var formRef: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(catalog, "AcroForm", &formRef), let form = formRef else {
            throw PDFIncrementalWriteError.malformed(String(localized: "无法核对表单保护信息"))
        }
        if has(form, "SigFlags") {
            var flags: CGPDFInteger = 0
            guard CGPDFDictionaryGetInteger(form, "SigFlags", &flags) else {
                throw PDFIncrementalWriteError.malformed(String(localized: "签名标志无效"))
            }
            if flags != 0 { throw PDFIncrementalWriteError.protectedDocument }
        }
        var seen = Set<UInt>()
        func inspect(_ field: CGPDFDictionaryRef, depth: Int) throws {
            guard depth < 128, seen.count < 100_000 else { throw PDFIncrementalWriteError.tooComplex }
            guard seen.insert(UInt(bitPattern: field.rawValue)).inserted else {
                throw PDFIncrementalWriteError.malformed(String(localized: "表单字段循环或重复"))
            }
            // Inspect every ancestor, so inherited /FT /Sig cannot be missed.
            if name(field, "FT") == "Sig" { throw PDFIncrementalWriteError.protectedDocument }
            var value: CGPDFDictionaryRef?
            if CGPDFDictionaryGetDictionary(field, "V", &value), let value,
               name(value, "Type") == "Sig" || has(value, "ByteRange") {
                throw PDFIncrementalWriteError.protectedDocument
            }
            if has(field, "Kids") {
                var kidsRef: CGPDFArrayRef?
                guard CGPDFDictionaryGetArray(field, "Kids", &kidsRef), let kids = kidsRef else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "表单子字段无法核对"))
                }
                guard CGPDFArrayGetCount(kids) <= 100_000 else { throw PDFIncrementalWriteError.tooComplex }
                for index in 0..<CGPDFArrayGetCount(kids) {
                    var childRef: CGPDFDictionaryRef?
                    guard CGPDFArrayGetDictionary(kids, index, &childRef), let child = childRef else {
                        throw PDFIncrementalWriteError.malformed(String(localized: "表单子字段无效"))
                    }
                    try inspect(child, depth: depth + 1)
                }
            }
        }
        if has(form, "Fields") {
            var fieldsRef: CGPDFArrayRef?
            guard CGPDFDictionaryGetArray(form, "Fields", &fieldsRef), let fields = fieldsRef else {
                throw PDFIncrementalWriteError.malformed(String(localized: "表单字段列表无法核对"))
            }
            guard CGPDFArrayGetCount(fields) <= 100_000 else { throw PDFIncrementalWriteError.tooComplex }
            for index in 0..<CGPDFArrayGetCount(fields) {
                var fieldRef: CGPDFDictionaryRef?
                guard CGPDFArrayGetDictionary(fields, index, &fieldRef), let field = fieldRef else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "表单字段无法核对"))
                }
                try inspect(field, depth: 0)
            }
        }
    }

    private static func encode(_ spec: PDFInkSpecification, page: Ref, appearance: Ref,
                               pointCount: inout Int) throws -> (annotation: Data, appearance: Data) {
        let values = [spec.bounds.minX, spec.bounds.minY, spec.bounds.maxX, spec.bounds.maxY, spec.bounds.width, spec.bounds.height,
                      spec.width, spec.red, spec.green, spec.blue, spec.alpha]
        guard values.allSatisfy(\.isFinite), spec.bounds.width > 0, spec.bounds.height > 0,
              spec.width > 0, [spec.red, spec.green, spec.blue, spec.alpha].allSatisfy({ (0...1).contains($0) }),
              !spec.paths.isEmpty else { throw PDFIncrementalWriteError.malformed(String(localized: "笔迹尺寸或颜色无效")) }
        var inkList = "["
        var drawing = "q\n0 0 \(number(spec.bounds.width)) \(number(spec.bounds.height)) re W n\n/GSInk gs\n"
        drawing += "\(number(spec.red)) \(number(spec.green)) \(number(spec.blue)) RG\n\(number(spec.width)) w\n1 J 1 j\n"
        for points in spec.paths {
            guard points.count >= 2 else { throw PDFIncrementalWriteError.malformed(String(localized: "笔迹路径过短")) }
            pointCount += points.count
            guard pointCount <= 2_000_000 else { throw PDFIncrementalWriteError.tooComplex }
            inkList += "["
            for (index, point) in points.enumerated() {
                guard [point.x, point.y, point.x + spec.bounds.minX, point.y + spec.bounds.minY].allSatisfy(\.isFinite) else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "笔迹坐标无效"))
                }
                inkList += "\(number(point.x + spec.bounds.minX)) \(number(point.y + spec.bounds.minY)) "
                drawing += "\(number(point.x)) \(number(point.y)) \(index == 0 ? "m" : "l")\n"
            }
            inkList += "]"
            drawing += "S\n"
        }
        inkList += "]"; drawing += "Q\n"
        let stream = Data(drawing.utf8)
        let appearanceHeader = "<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 \(number(spec.bounds.width)) \(number(spec.bounds.height))] /Matrix [1 0 0 1 0 0] /Resources << /ExtGState << /GSInk << /Type /ExtGState /CA \(number(spec.alpha)) /ca \(number(spec.alpha)) /BM /Normal >> >> >> /Length \(stream.count) >>\nstream\n"
        var appearanceData = Data(appearanceHeader.utf8)
        appearanceData.append(stream); appearanceData.append(Data("endstream".utf8))
        let rect = "[\(number(spec.bounds.minX)) \(number(spec.bounds.minY)) \(number(spec.bounds.maxX)) \(number(spec.bounds.maxY))]"
        let contents = PDFAnnotationWritebackService.annotationContents(identifier: spec.name)
        let annotation = "<< /Type /Annot /Subtype /Ink /Rect \(rect) /P \(page) /F 4 /NM \(pdfString(spec.name)) /T (InkSpace) /Contents \(pdfString(contents)) /C [\(number(spec.red)) \(number(spec.green)) \(number(spec.blue))] /CA \(number(spec.alpha)) /Border [0 0 \(number(spec.width))] /BS << /W \(number(spec.width)) /S /S >> /InkList \(inkList) /AP << /N \(appearance) >> >>"
        return (Data(annotation.utf8), appearanceData)
    }

    private static func number(_ value: CGFloat) -> String {
        var result = String(format: "%.8f", locale: Locale(identifier: "en_US_POSIX"), Double(value))
        while result.last == "0" { result.removeLast() }
        if result.last == "." { result.removeLast() }
        return result == "-0" ? "0" : result
    }
    private static func pdfString(_ value: String) -> String {
        var data = Data([0xfe, 0xff]); data.append(value.data(using: .utf16BigEndian)!)
        return "<" + data.map { String(format: "%02X", $0) }.joined() + ">"
    }
    private static func encodeName(_ value: String) -> String {
        value.utf8.map { byte in
            (33...126).contains(byte) && ![UInt8]("#%()/<>[]{}".utf8).contains(byte)
                ? String(UnicodeScalar(byte)) : String(format: "#%02X", byte)
        }.joined()
    }
    private static func identifier(_ dictionary: Node) -> String? {
        if let name = dictionary["NM"]?.string, name.hasPrefix("InkSpace.v1.") { return name }
        let prefix = "InkSpace 手写\n[InkSpace annotation: "
        guard let contents = dictionary["Contents"]?.string,
              contents.hasPrefix(prefix), contents.hasSuffix("]") else { return nil }
        let identifier = String(contents.dropFirst(prefix.count).dropLast())
        return identifier.hasPrefix("InkSpace.v1.") ? identifier : nil
    }

    private struct Ref: Hashable, CustomStringConvertible {
        let id: Int, generation: Int
        var description: String { "\(id) \(generation) R" }
    }
    private struct Node {
        let kind: Kind
        let range: Range<Int>
        indirect enum Kind {
            case dictionary([(String, Node)]), array([Node]), reference(Ref)
            case number(String), name(String), string(Data), keyword(String)
        }
        subscript(_ key: String) -> Node? {
            guard case .dictionary(let fields) = kind else { return nil }
            return fields.first(where: { $0.0 == key })?.1
        }
        var integer: Int? {
            guard case .number(let value) = kind, !value.contains("."), let integer = Int(value) else { return nil }
            return integer
        }
        var name: String? { if case .name(let value) = kind { return value }; return nil }
        var reference: Ref? { if case .reference(let value) = kind { return value }; return nil }
        var string: String? {
            guard case .string(let data) = kind else { return nil }
            if data.starts(with: [0xfe, 0xff]) { return String(data: data.dropFirst(2), encoding: .utf16BigEndian) }
            return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1)
        }
    }

    private final class Reader {
        let bytes: [UInt8]
        let startXref: Int
        private(set) var size = 0
        private(set) var trailerFields: [String: Node] = [:]
        private var xref: [Int: (offset: Int, generation: Int, inUse: Bool)] = [:]
        private var objectCache: [Ref: Node] = [:]
        private var tokenCount = 0
        private var xrefEntriesRead = 0

        init(_ original: Data) throws {
            bytes = Array(original)
            guard original.starts(with: Data("%PDF-".utf8)),
                  let eof = original.range(of: Data("%%EOF".utf8), options: .backwards),
                  original[eof.upperBound...].allSatisfy(Self.whitespace),
                  let marker = original.range(of: Data("startxref".utf8), options: .backwards, in: 0..<eof.lowerBound) else {
                throw PDFIncrementalWriteError.malformed(String(localized: "缺失 PDF 结束索引"))
            }
            var cursor = marker.upperBound
            // Stored before calling methods that consult this fully initialized instance.
            while cursor < bytes.count && Self.whitespace(bytes[cursor]) { cursor += 1 }
            let begin = cursor
            while cursor < bytes.count && (48...57).contains(bytes[cursor]) { cursor += 1 }
            guard cursor > begin, let offset = Int(String(decoding: bytes[begin..<cursor], as: UTF8.self)),
                  offset >= 0, offset < marker.lowerBound else { throw PDFIncrementalWriteError.malformed(String(localized: "索引偏移无效")) }
            startXref = offset
            var next: Int? = offset
            var visited = Set<Int>()
            while let value = next {
                guard visited.insert(value).inserted, visited.count <= 8192 else { throw PDFIncrementalWriteError.tooComplex }
                next = try readXref(at: value)
            }
            guard let declaredSize = trailerFields["Size"]?.integer, declaredSize > 0,
                  declaredSize <= 2_000_000, declaredSize > (xref.keys.max() ?? 0),
                  trailerFields["Root"]?.reference != nil else {
                throw PDFIncrementalWriteError.malformed(String(localized: "PDF trailer 不完整"))
            }
            size = declaredSize
            if let encrypt = trailerFields["Encrypt"], !isNull(encrypt) {
                throw PDFIncrementalWriteError.protectedDocument
            }
        }
        func raw(_ node: Node) -> String { String(decoding: bytes[node.range], as: UTF8.self) }
        func bytes(in range: Range<Int>) -> Data { Data(bytes[range]) }

        private func readXref(at offset: Int) throws -> Int? {
            var p = offset
            skip(&p)
            guard try word(&p) == "xref" else {
                var header = offset
                let id = try integer(&header), generation = try integer(&header)
                guard id > 0, generation >= 0, generation <= 65535,
                      try word(&header) == "obj" else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "索引位置没有有效对象头"))
                }
                let dictionary = try parse(&header)
                guard dictionary["Type"]?.name == "XRef", try word(&header) == "stream" else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "索引位置不是交叉引用表或流"))
                }
                throw PDFIncrementalWriteError.unsupportedFormat(String(localized: "交叉引用流"))
            }
            var sectionIDs = Set<Int>()
            while true {
                skip(&p)
                let saved = p
                if try word(&p) == "trailer" { break }
                p = saved
                let first = try integer(&p), count = try integer(&p)
                guard first >= 0, count >= 0, first <= 2_000_000, count <= 2_000_000 - first,
                      xref.count + count <= 2_000_000,
                      count <= 4_000_000 - xrefEntriesRead else { throw PDFIncrementalWriteError.tooComplex }
                xrefEntriesRead += count
                for id in first..<(first + count) {
                    guard sectionIDs.insert(id).inserted else { throw PDFIncrementalWriteError.malformed(String(localized: "同一索引重复对象")) }
                    let objectOffset = try integer(&p), generation = try integer(&p), flag = try word(&p)
                    guard objectOffset >= 0, generation >= 0, generation <= 65535,
                          flag == "n" || flag == "f" else { throw PDFIncrementalWriteError.malformed(String(localized: "交叉引用条目无效")) }
                    // Some old PDFs contain unused live entries at offset zero.
                    // Only a referenced entry must point to a valid object header.
                    if xref[id] == nil { xref[id] = (objectOffset, generation, flag == "n") }
                }
            }
            let trailer = try parse(&p)
            guard case .dictionary(let fields) = trailer.kind else { throw PDFIncrementalWriteError.malformed(String(localized: "trailer 不是字典")) }
            if trailer["XRefStm"] != nil { throw PDFIncrementalWriteError.unsupportedFormat(String(localized: "混合交叉引用")) }
            for (key, value) in fields where trailerFields[key] == nil { trailerFields[key] = value }
            if let prev = trailer["Prev"] {
                guard let value = prev.integer, value >= 0, value < offset else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "旧索引链无效"))
                }
                return value
            }
            return nil
        }
        func object(_ reference: Ref) throws -> Node {
            if let cached = objectCache[reference] { return cached }
            guard let entry = xref[reference.id], entry.inUse, entry.generation == reference.generation,
                  entry.offset > 0, entry.offset < bytes.count else {
                throw PDFIncrementalWriteError.malformed(String(localized: "对象引用无效"))
            }
            var p = entry.offset
            guard try integer(&p) == reference.id, try integer(&p) == reference.generation,
                  try word(&p) == "obj" else { throw PDFIncrementalWriteError.malformed(String(localized: "对象编号不匹配")) }
            let value = try parse(&p)
            let ending = try word(&p)
            if ending == "stream", case .dictionary = value.kind {
                throw PDFIncrementalWriteError.unsupportedFormat(String(localized: "需要解释的对象是数据流"))
            }
            guard ending == "endobj" else { throw PDFIncrementalWriteError.malformed(String(localized: "对象未正确结束")) }
            guard objectCache.count < 100_000 else { throw PDFIncrementalWriteError.tooComplex }
            objectCache[reference] = value
            return value
        }
        func pageReferences() throws -> [Ref] {
            let catalog = try object(trailerFields["Root"]!.reference!)
            guard catalog["Type"]?.name == "Catalog", let root = catalog["Pages"]?.reference else {
                throw PDFIncrementalWriteError.malformed(String(localized: "缺失页面树"))
            }
            // Preserve signed documents rather than invalidating signatures. The
            // existing service separately checks all page widgets before calling.
            if catalog["Perms"] != nil { throw PDFIncrementalWriteError.protectedDocument }
            if let form = catalog["AcroForm"] {
                let resolved = try dereference(form)
                if (resolved["SigFlags"]?.integer ?? 0) != 0 {
                    throw PDFIncrementalWriteError.protectedDocument
                }
                var fieldRefs = Set<Ref>()
                var fieldCount = 0
                func inspectField(_ entry: Node, depth: Int) throws {
                    fieldCount += 1
                    guard depth < 128, fieldCount <= 100_000 else { throw PDFIncrementalWriteError.tooComplex }
                    if let ref = entry.reference, !fieldRefs.insert(ref).inserted {
                        throw PDFIncrementalWriteError.malformed(String(localized: "表单字段循环或重复引用"))
                    }
                    let field = try dereference(entry)
                    guard case .dictionary = field.kind else { throw PDFIncrementalWriteError.malformed(String(localized: "表单字段无效")) }
                    if field["FT"]?.name == "Sig" { throw PDFIncrementalWriteError.protectedDocument }
                    if let value = field["V"] {
                        let content = try dereference(value)
                        if content["Type"]?.name == "Sig" || content["ByteRange"] != nil {
                            throw PDFIncrementalWriteError.protectedDocument
                        }
                    }
                    if let kids = field["Kids"] {
                        guard case .array(let children) = try dereference(kids).kind else {
                            throw PDFIncrementalWriteError.malformed(String(localized: "表单子字段无效"))
                        }
                        for child in children { try inspectField(child, depth: depth + 1) }
                    }
                }
                if let fields = resolved["Fields"] {
                    guard case .array(let entries) = try dereference(fields).kind else {
                        throw PDFIncrementalWriteError.malformed(String(localized: "表单字段列表无效"))
                    }
                    for entry in entries { try inspectField(entry, depth: 0) }
                }
            }
            var visited = Set<Ref>()
            func walk(_ reference: Ref, depth: Int) throws -> [Ref] {
                guard depth < 128, visited.count < 100_000 else { throw PDFIncrementalWriteError.tooComplex }
                guard visited.insert(reference).inserted else { throw PDFIncrementalWriteError.malformed(String(localized: "页面树循环或重复引用")) }
                let node = try object(reference)
                if node["Type"]?.name == "Page" { return [reference] }
                guard node["Type"]?.name == "Pages", let kidsNode = node["Kids"],
                      case .array(let kids) = try dereference(kidsNode).kind else {
                    throw PDFIncrementalWriteError.malformed(String(localized: "页面树子节点无效"))
                }
                var result: [Ref] = []
                for kid in kids {
                    guard let ref = kid.reference else { throw PDFIncrementalWriteError.unsupportedFormat(String(localized: "内嵌页面节点")) }
                    result += try walk(ref, depth: depth + 1)
                }
                guard node["Count"]?.integer == result.count else { throw PDFIncrementalWriteError.malformed(String(localized: "页面树数量不一致")) }
                return result
            }
            return try walk(root, depth: 0)
        }
        func annotationReferences(_ page: Node) throws -> [Node] {
            guard let value = page["Annots"], !isNull(value) else { return [] }
            let resolved = try dereference(value)
            if isNull(resolved) { return [] }
            guard case .array(let entries) = resolved.kind else { throw PDFIncrementalWriteError.malformed(String(localized: "注释列表无效")) }
            return entries
        }
        private func dereference(_ value: Node) throws -> Node {
            guard let ref = value.reference else { return value }
            return try object(ref)
        }
        private func isNull(_ node: Node) -> Bool { if case .keyword("null") = node.kind { return true }; return false }
        private static func whitespace(_ value: UInt8) -> Bool { [0, 9, 10, 12, 13, 32].contains(value) }
        private static func delimiter(_ value: UInt8) -> Bool {
            whitespace(value) || [UInt8]("()<>[]{}/%".utf8).contains(value)
        }
        private func skip(_ p: inout Int) {
            while p < bytes.count {
                if Self.whitespace(bytes[p]) { p += 1 }
                else if bytes[p] == 37 {
                    while p < bytes.count && bytes[p] != 10 && bytes[p] != 13 { p += 1 }
                } else { break }
            }
        }
        private func word(_ p: inout Int) throws -> String {
            skip(&p); let start = p
            while p < bytes.count && !Self.delimiter(bytes[p]) { p += 1 }
            guard p > start, p - start < 1024 else { throw PDFIncrementalWriteError.malformed(String(localized: "无效 PDF 标记")) }
            return String(decoding: bytes[start..<p], as: UTF8.self)
        }
        private func integer(_ p: inout Int) throws -> Int {
            let text = try word(&p)
            guard text.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == "+" || $0 == "-") }),
                  let value = Int(text) else { throw PDFIncrementalWriteError.malformed(String(localized: "无效 PDF 整数")) }
            return value
        }
        private func parse(_ p: inout Int, depth: Int = 0) throws -> Node {
            tokenCount += 1
            guard depth < 128, tokenCount <= 2_000_000 else { throw PDFIncrementalWriteError.tooComplex }
            skip(&p); let start = p
            guard p < bytes.count else { throw PDFIncrementalWriteError.malformed(String(localized: "PDF 对象未结束")) }
            let kind: Node.Kind
            switch bytes[p] {
            case 47:
                p += 1; var name: [UInt8] = []
                while p < bytes.count && !Self.delimiter(bytes[p]) {
                    if bytes[p] == 35 {
                        guard p + 2 < bytes.count, let a = Self.hex(bytes[p + 1]), let b = Self.hex(bytes[p + 2]) else {
                            throw PDFIncrementalWriteError.malformed(String(localized: "PDF 名称转义无效"))
                        }
                        name.append(a * 16 + b); p += 3
                    } else { name.append(bytes[p]); p += 1 }
                }
                guard name.count <= 1024, let string = String(bytes: name, encoding: .utf8) else {
                    throw PDFIncrementalWriteError.unsupportedFormat(String(localized: "非 UTF-8 字典键"))
                }
                kind = .name(string)
            case 40:
                p += 1; var nesting = 1; var string: [UInt8] = []
                while p < bytes.count && nesting > 0 {
                    var value = bytes[p]; p += 1
                    if value == 92 {
                        guard p < bytes.count else { throw PDFIncrementalWriteError.malformed(String(localized: "字符串转义未结束")) }
                        value = bytes[p]; p += 1
                        if value == 10 { continue }
                        if value == 13 { if p < bytes.count && bytes[p] == 10 { p += 1 }; continue }
                        if (48...55).contains(value) {
                            var octal = Int(value - 48); var count = 1
                            while count < 3 && p < bytes.count && (48...55).contains(bytes[p]) { octal = octal * 8 + Int(bytes[p] - 48); p += 1; count += 1 }
                            string.append(UInt8(octal & 255)); continue
                        }
                        value = [110: 10, 114: 13, 116: 9, 98: 8, 102: 12][value] ?? value
                        string.append(value)
                    } else if value == 40 { nesting += 1; string.append(value) }
                    else if value == 41 { nesting -= 1; if nesting > 0 { string.append(value) } }
                    else if value == 13 { if p < bytes.count && bytes[p] == 10 { p += 1 }; string.append(10) }
                    else { string.append(value) }
                    guard string.count <= 8 * 1024 * 1024, nesting <= 128 else { throw PDFIncrementalWriteError.tooComplex }
                }
                guard nesting == 0 else { throw PDFIncrementalWriteError.malformed(String(localized: "字符串未结束")) }
                kind = .string(Data(string))
            case 60 where p + 1 < bytes.count && bytes[p + 1] == 60:
                p += 2; var fields: [(String, Node)] = []; var keys = Set<String>()
                while true {
                    skip(&p)
                    if p + 1 < bytes.count && bytes[p] == 62 && bytes[p + 1] == 62 { p += 2; break }
                    let key = try parse(&p, depth: depth + 1)
                    guard let name = key.name, keys.insert(name).inserted else { throw PDFIncrementalWriteError.malformed(String(localized: "重复或无效字典键")) }
                    let value = try parse(&p, depth: depth + 1); fields.append((name, value))
                }
                kind = .dictionary(fields)
            case 60:
                p += 1; var value: [UInt8] = []; var high: UInt8?
                while p < bytes.count && bytes[p] != 62 {
                    let byte = bytes[p]; p += 1
                    if Self.whitespace(byte) { continue }
                    guard let digit = Self.hex(byte) else { throw PDFIncrementalWriteError.malformed(String(localized: "十六进制字符串无效")) }
                    if let first = high { value.append(first * 16 + digit); high = nil } else { high = digit }
                    guard value.count <= 8 * 1024 * 1024 else { throw PDFIncrementalWriteError.tooComplex }
                }
                guard p < bytes.count else { throw PDFIncrementalWriteError.malformed(String(localized: "十六进制字符串未结束")) }
                p += 1; if let high { value.append(high * 16) }; kind = .string(Data(value))
            case 91:
                p += 1; var values: [Node] = []
                while true {
                    skip(&p)
                    guard p < bytes.count else { throw PDFIncrementalWriteError.malformed(String(localized: "数组未结束")) }
                    if bytes[p] == 93 { p += 1; break }
                    values.append(try parse(&p, depth: depth + 1))
                }
                kind = .array(values)
            default:
                let token = try word(&p)
                if let number = Double(token), number.isFinite,
                   token.utf8.allSatisfy({ (48...57).contains($0) || [43, 45, 46].contains($0) }) {
                    let saved = p
                    if let id = Int(token), id >= 0 {
                        var look = p
                        if let generation = try? integer(&look), generation >= 0, generation <= 65535,
                           let suffix = try? word(&look), suffix == "R" {
                            p = look; kind = .reference(Ref(id: id, generation: generation))
                        } else { p = saved; kind = .number(token) }
                    } else { kind = .number(token) }
                } else if ["null", "true", "false"].contains(token) { kind = .keyword(token) }
                else { throw PDFIncrementalWriteError.malformed(String(localized: "未知 PDF 对象类型")) }
            }
            return Node(kind: kind, range: start..<p)
        }
        private static func hex(_ byte: UInt8) -> UInt8? {
            switch byte { case 48...57: byte - 48; case 65...70: byte - 55; case 97...102: byte - 87; default: nil }
        }
    }
}

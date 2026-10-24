import Foundation

/// A deliberately small, portable ZIP subset: UTF-8 names, STORE entries, CRC-32.
/// No shell, compression library, symlinks, encryption, ZIP64 or archive extraction APIs.
enum BackupArchive {
    enum Failure: LocalizedError {
        case unsafe, invalid, limit, exists
        var errorDescription: String? {
            switch self {
            case .unsafe: String(localized: "备份包包含不安全的路径或不支持的文件类型。")
            case .invalid: String(localized: "备份包不完整、校验不符，或不是本应用导出的 ZIP。")
            case .limit: String(localized: "备份包超过安全处理范围。")
            case .exists: String(localized: "导出或恢复位置已经存在文件，请选择新位置。")
            }
        }
    }
    private struct Entry { let name: String; let bytes: UInt32; let crc: UInt32; let offset: UInt32 }
    private static let chunk = 1024 * 1024
    static func write(entries: [(name: String, url: URL)], to destination: URL,
                      maximumBytes: UInt64 = 2 * 1024 * 1024 * 1024) throws {
        guard entries.count <= 10020, !FileManager.default.fileExists(atPath: destination.path) else { throw Failure.exists }
        var names = Set<String>(), list: [Entry] = [], total: UInt64 = 0
        let staging = destination.deletingLastPathComponent().appendingPathComponent(".archive-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: staging.path, contents: nil)
        let out = try FileHandle(forWritingTo: staging)
        defer { try? out.close(); try? FileManager.default.removeItem(at: staging) }
        for entry in entries {
            try Task.checkCancellation()
            try checkName(entry.name, names: &names)
            let values = try entry.url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size >= 0, UInt64(size) <= min(maximumBytes, UInt64(UInt32.max)) else { throw Failure.limit }
            total += UInt64(size)
            guard total <= maximumBytes else { throw Failure.limit }
            let offset = try out.offset()
            guard offset < UInt64(UInt32.max) else { throw Failure.limit }
            let name = Data(entry.name.utf8)
            let input = try FileHandle(forReadingFrom: entry.url)
            defer { try? input.close() }
            // Patch CRC/size after streaming; data descriptors are unnecessary.
            var header = Data(); header.le32(0x04034b50); header.le16(20); header.le16(0x800)
            header.le16(0); header.le16(0); header.le16(0); header.le32(0)
            header.le32(UInt32(size)); header.le32(UInt32(size)); header.le16(UInt16(name.count)); header.le16(0)
            header.append(name); try out.write(contentsOf: header)
            var crc: UInt32 = 0xffffffff, copied = 0
            while let bytes = try input.read(upToCount: chunk), !bytes.isEmpty {
                try Task.checkCancellation(); copied += bytes.count
                guard copied <= size else { throw Failure.invalid }
                crc = updateCRC(crc, bytes); try out.write(contentsOf: bytes)
            }
            guard copied == size else { throw Failure.invalid }
            crc ^= 0xffffffff
            let end = try out.offset(); try out.seek(toOffset: offset + 14)
            var patch = Data(); patch.le32(crc); try out.write(contentsOf: patch); try out.seek(toOffset: end)
            list.append(Entry(name: entry.name, bytes: UInt32(size), crc: crc, offset: UInt32(offset)))
        }
        let centralStart = try out.offset()
        for entry in list {
            var record = Data(); let name = Data(entry.name.utf8)
            record.le32(0x02014b50); record.le16(20); record.le16(20); record.le16(0x800)
            record.le16(0); record.le16(0); record.le16(0); record.le32(entry.crc)
            record.le32(entry.bytes); record.le32(entry.bytes); record.le16(UInt16(name.count))
            record.le16(0); record.le16(0); record.le16(0); record.le16(0); record.le32(0); record.le32(entry.offset)
            record.append(name); try out.write(contentsOf: record)
        }
        let end = try out.offset()
        guard end < UInt64(UInt32.max), centralStart < UInt64(UInt32.max) else { throw Failure.limit }
        var footer = Data(); footer.le32(0x06054b50); footer.le16(0); footer.le16(0)
        footer.le16(UInt16(list.count)); footer.le16(UInt16(list.count)); footer.le32(UInt32(end - centralStart))
        footer.le32(UInt32(centralStart)); footer.le16(0); try out.write(contentsOf: footer)
        try out.synchronize(); try out.close(); try Task.checkCancellation()
        try FileManager.default.moveItem(at: staging, to: destination)
    }

    @discardableResult static func extract(_ archive: URL, to directory: URL,
                maximumBytes: UInt64 = 2 * 1024 * 1024 * 1024, maximumEntries: Int = 10020) throws -> [String] {
        guard !FileManager.default.fileExists(atPath: directory.path) else { throw Failure.exists }
        let input = try FileHandle(forReadingFrom: archive); defer { try? input.close() }
        let size = try input.seekToEnd()
        guard size >= 22, size <= maximumBytes + 16 * 1024 * 1024 else { throw Failure.limit }
        try input.seek(toOffset: size - 22); let footer = try read(input, 22)
        guard footer.u32(0) == 0x06054b50, footer.u16(4) == 0, footer.u16(6) == 0,
              footer.u16(8) == footer.u16(10), footer.u16(20) == 0 else { throw Failure.invalid }
        let count = Int(footer.u16(10)), length = UInt64(footer.u32(12)), start = UInt64(footer.u32(16))
        guard count <= maximumEntries, start + length == size - 22, length <= 8 * 1024 * 1024 else { throw Failure.limit }
        try input.seek(toOffset: start); let central = try read(input, Int(length))
        var cursor = 0, entries: [Entry] = [], names = Set<String>(), total: UInt64 = 0
        for _ in 0..<count {
            try Task.checkCancellation()
            guard cursor + 46 <= central.count else { throw Failure.invalid }
            let row = central.subdata(in: cursor..<(cursor + 46))
            let nameLength = Int(row.u16(28)), extra = Int(row.u16(30)), comment = Int(row.u16(32))
            guard row.u32(0) == 0x02014b50, row.u16(8) == 0x800, row.u16(10) == 0,
                  row.u32(20) == row.u32(24), row.u16(34) == 0,
                  row.u32(38) == 0, extra == 0, comment == 0, cursor + 46 + nameLength <= central.count,
                  let name = String(data: central.subdata(in: (cursor + 46)..<(cursor + 46 + nameLength)), encoding: .utf8) else { throw Failure.invalid }
            try checkName(name, names: &names)
            total += UInt64(row.u32(24)); guard total <= maximumBytes else { throw Failure.limit }
            entries.append(Entry(name: name, bytes: row.u32(24), crc: row.u32(16), offset: row.u32(42)))
            cursor += 46 + nameLength
        }
        guard cursor == central.count else { throw Failure.invalid }
        let stage = directory.deletingLastPathComponent().appendingPathComponent(".unzip-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: stage) }
        var previousEnd: UInt64 = 0
        for entry in entries {
            try Task.checkCancellation()
            guard UInt64(entry.offset) == previousEnd else { throw Failure.invalid }
            try input.seek(toOffset: UInt64(entry.offset)); let header = try read(input, 30)
            let nameCount = Int(header.u16(26))
            guard header.u32(0) == 0x04034b50, header.u16(6) == 0x800, header.u16(8) == 0,
                  header.u32(14) == entry.crc, header.u32(18) == entry.bytes, header.u32(22) == entry.bytes,
                  header.u16(28) == 0, nameCount == entry.name.utf8.count,
                  try read(input, nameCount) == Data(entry.name.utf8) else { throw Failure.invalid }
            previousEnd = UInt64(entry.offset) + 30 + UInt64(nameCount) + UInt64(entry.bytes)
            guard previousEnd <= start else { throw Failure.invalid }
            let target = stage.appendingPathComponent(entry.name)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: target.path, contents: nil)
            let output = try FileHandle(forWritingTo: target); defer { try? output.close() }
            var remaining = Int(entry.bytes), crc: UInt32 = 0xffffffff
            while remaining > 0 {
                try Task.checkCancellation(); let bytes = try read(input, min(chunk, remaining))
                remaining -= bytes.count; crc = updateCRC(crc, bytes); try output.write(contentsOf: bytes)
            }
            guard crc ^ 0xffffffff == entry.crc else { throw Failure.invalid }
            try output.synchronize(); try output.close()
        }
        guard previousEnd == start else { throw Failure.invalid }
        try Task.checkCancellation(); try FileManager.default.moveItem(at: stage, to: directory)
        return entries.map(\.name)
    }
    private static func checkName(_ name: String, names: inout Set<String>) throws {
        guard VaultPath.isSafeRelative(name), name.utf8.count <= 1024,
              names.insert(name.precomposedStringWithCanonicalMapping.lowercased()).inserted else { throw Failure.unsafe }
    }
    private static func read(_ file: FileHandle, _ count: Int) throws -> Data {
        let data = try file.read(upToCount: count) ?? Data()
        guard data.count == count else { throw Failure.invalid }; return data
    }
    private static let crcTable: [UInt32] = (0..<256).map { value in
        var c = UInt32(value); for _ in 0..<8 { c = c & 1 == 0 ? c >> 1 : 0xedb88320 ^ (c >> 1) }; return c
    }
    private static func updateCRC(_ initial: UInt32, _ data: Data) -> UInt32 {
        var c = initial; for byte in data { c = crcTable[Int((c ^ UInt32(byte)) & 255)] ^ (c >> 8) }; return c
    }
}
private extension Data {
    mutating func le16(_ n: UInt16) { append(UInt8(truncatingIfNeeded: n)); append(UInt8(truncatingIfNeeded: n >> 8)) }
    mutating func le32(_ n: UInt32) { le16(UInt16(truncatingIfNeeded: n)); le16(UInt16(truncatingIfNeeded: n >> 16)) }
    func u16(_ n: Int) -> UInt16 { UInt16(self[n]) | UInt16(self[n+1]) << 8 }
    func u32(_ n: Int) -> UInt32 { UInt32(u16(n)) | UInt32(u16(n+2)) << 16 }
}

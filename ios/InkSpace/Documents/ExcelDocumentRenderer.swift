import Foundation
import UIKit
import WebKit
import PDFKit

struct ExcelReadingResult: Sendable {
    let data: Data
    let warnings: [String]
}

/// Offline cell reading, deliberately independent of Excel's print area. Wide
/// tables are split into labelled column bands; no worksheet is a screen capture.
@MainActor enum ExcelDocumentRenderer {
    static let maximumSourceBytes = 16 * 1_024 * 1_024
    static var rendererVersion: String { DocumentReadingLanguage.version("excel-cell-reading-2-sheetjs-0.20.3") }
    static func render(data: Data, fileExtension: String) async throws -> ExcelReadingResult {
        let job = ExcelReadJob()
        let model = try await withTaskCancellationHandler {
            try await job.read(data: data, fileExtension: fileExtension)
        } onCancel: { Task { @MainActor in job.cancel() } }
        let work = Task.detached(priority: .userInitiated) { try autoreleasepool { try ExcelTablePDF.render(model) } }
        let pdf = try await withTaskCancellationHandler { try Task.checkCancellation(); return try await work.value } onCancel: { work.cancel() }
        var warnings = [String(localized: "Excel 使用单元格阅读排版，宽表按列分段；不采用原打印区域或合并单元格版式。")]
        if model.formulas > 0 { warnings.append(String(localized: "公式显示文件中已保存的结果，不重新计算。")) }
        if model.skippedSheets > 0 { warnings.append(String(localized: "隐藏工作表及独立图表页未包含在单元格阅读版中。")) }
        if model.omittedVisuals { warnings.append(String(localized: "此阅读版显示单元格；图表、图片和浮动图形请在原 Excel 中查看。")) }
        if model.missingFormulaResults > 0 { warnings.append(String(localized: "标记 [=] 的单元格没有已保存结果，显示公式原文；不会重新计算或执行宏。")) }
        return ExcelReadingResult(data: pdf, warnings: warnings)
    }
}

private struct ExcelCell: Decodable, Sendable { let row: Int; let column: Int; let text: String }
private struct ExcelSheet: Decodable, Sendable {
    let name: String
    let minRow: Int; let lastRow: Int; let minCol: Int; let lastCol: Int
    let cells: [ExcelCell]; let hiddenRows: [Int]; let hiddenColumns: [Int]
}
private struct ExcelReadingModel: Decodable, Sendable {
    let sheets: [ExcelSheet]; let totalCells: Int; let formulas: Int; let merges: Int; let skippedSheets: Int
    let missingFormulaResults: Int; let omittedVisuals: Bool
}

enum ExcelDocumentError: LocalizedError {
    case unreadable, tooLarge, noWindow, timeout, drawings, formulaCache, tallCell, noVisibleSheets
    var errorDescription: String? {
        switch self {
        case .unreadable: String(localized: "未能完整读取 Excel 工作表，尚未展开；请在 Excel 中导出 PDF 后重试。")
        case .tooLarge: String(localized: "Excel 超过本次单元格阅读容量；请缩小选区或在 Excel 中导出 PDF，原表保持不变。")
        case .noWindow: String(localized: "请保持应用在前台，再展开 Excel。")
        case .timeout: String(localized: "Excel 读取超时，尚未添加；请在 Excel 中导出 PDF 后重试。")
        case .drawings: String(localized: "此 Excel 含图表、图片或浮动图形，单元格阅读版无法完整保留；请在 Excel 中导出 PDF 后展开。")
        case .formulaCache: String(localized: "此 Excel 有公式尚未保存计算结果；请先在 Excel 中计算并保存，或导出 PDF。")
        case .tallCell: String(localized: "此 Excel 的某个单元格文字过长，无法完整放入阅读页；请在 Excel 中导出 PDF。")
        case .noVisibleSheets: String(localized: "此 Excel 没有可见工作表，尚未添加页面。")
        }
    }
    static func from(_ error: Error) -> Error {
        let message = String(describing: error) + error.localizedDescription
        if message.contains("DRAWINGS") { return Self.drawings }
        if message.contains("FORMULA_CACHE") { return Self.formulaCache }
        if message.contains("CELL_TOO_TALL") { return Self.tallCell }
        if message.contains("NO_VISIBLE_SHEETS") { return Self.noVisibleSheets }
        if message.contains("CAPACITY") { return Self.tooLarge }
        return Self.unreadable
    }
}

@MainActor private final class ExcelReadJob: NSObject, WKNavigationDelegate {
    private var web: WKWebView?
    private var navigation: CheckedContinuation<Void, Error>?
    private var evaluation: CheckedContinuation<String, Error>?
    private var timer: Task<Void, Never>?
    private var cancelled = false
    private var resourceRoot: URL?
    func cancel() { cancelled = true; finish(error: CancellationError()) }
    private func finish(error: Error) {
        web?.stopLoading()
        navigation?.resume(throwing: error); navigation = nil
        evaluation?.resume(throwing: error); evaluation = nil
    }
    func read(data: Data, fileExtension: String) async throws -> ExcelReadingModel {
        defer { timer?.cancel(); web?.navigationDelegate = nil; web?.stopLoading(); web?.removeFromSuperview(); web = nil }
        try Task.checkCancellation(); if cancelled { throw CancellationError() }
        let ext = fileExtension.lowercased()
        guard ["xls", "xlsx", "xlsm"].contains(ext), !data.isEmpty else { throw ExcelDocumentError.unreadable }
        guard data.count <= ExcelDocumentRenderer.maximumSourceBytes else { throw ExcelDocumentError.tooLarge }
        if ext == "xlsx" || ext == "xlsm" { try ExcelZIPBudget.validate(data) }
        else if !data.starts(with: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) { throw ExcelDocumentError.unreadable }
        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Excel")
                ?? Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Resources/Excel"),
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .filter({ $0.activationState == .foregroundActive }).flatMap(\.windows).first(where: { $0.isKeyWindow })
        else { throw ExcelDocumentError.noWindow }
        resourceRoot = index.deletingLastPathComponent().standardizedFileURL
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 240), configuration: configuration)
        view.isUserInteractionEnabled = false; view.navigationDelegate = self
        window.insertSubview(view, at: 0); web = view
        timer = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(90)) } catch { return }
            self?.finish(error: ExcelDocumentError.timeout)
        }
        try await withCheckedThrowingContinuation { navigation = $0; view.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent()) }
        try Task.checkCancellation(); if cancelled { throw CancellationError() }
        let json: String = try await withCheckedThrowingContinuation { continuation in
            evaluation = continuation
            view.callAsyncJavaScript("return window.inkReadExcel(bytes, extension);", arguments: ["bytes": data.base64EncodedString(), "extension": ext], in: nil, in: .page) { [weak self] result in
                guard let self, let continuation = self.evaluation else { return }; self.evaluation = nil
                switch result {
                case .success(let value):
                    guard let value = value as? String else { continuation.resume(throwing: ExcelDocumentError.unreadable); return }
                    continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: ExcelDocumentError.from(error))
                }
            }
        }
        try Task.checkCancellation()
        guard let bytes = json.data(using: .utf8), bytes.count <= 32 * 1_024 * 1_024 else { throw ExcelDocumentError.tooLarge }
        let model = try JSONDecoder().decode(ExcelReadingModel.self, from: bytes)
        guard !model.sheets.isEmpty, model.sheets.count <= 128, model.totalCells <= 100_000 else { throw ExcelDocumentError.tooLarge }
        return model
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { self.navigation?.resume(); self.navigation = nil }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error: ExcelDocumentError.unreadable) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error: ExcelDocumentError.unreadable) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(error: ExcelDocumentError.tooLarge) }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.isFileURL, let root = resourceRoot,
              url.standardizedFileURL.deletingLastPathComponent() == root else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
}

/// Reject encrypted/ZIP64 packages and decompression bombs before sending them
/// to the isolated WebKit parser. We never extract package paths to disk.
private enum ExcelZIPBudget {
    static func validate(_ data: Data) throws {
        let bytes = [UInt8](data)
        func u16(_ p: Int) -> Int { Int(bytes[p]) | Int(bytes[p + 1]) << 8 }
        func u32(_ p: Int) -> Int { u16(p) | u16(p + 2) << 16 }
        guard bytes.count >= 22, bytes.starts(with: [0x50, 0x4b, 0x03, 0x04]) else { throw ExcelDocumentError.unreadable }
        var end: Int?
        for p in stride(from: bytes.count - 22, through: max(0, bytes.count - 65_557), by: -1) {
            if u32(p) == 0x06054b50, p + 22 + u16(p + 20) == bytes.count { end = p; break }
        }
        guard let end, u16(end + 4) == 0, u16(end + 6) == 0, u16(end + 8) == u16(end + 10) else { throw ExcelDocumentError.unreadable }
        let count = u16(end + 10), size = u32(end + 12), start = u32(end + 16)
        guard count > 0, count <= 10_000, start > 0, size <= end, start <= end - size else { throw ExcelDocumentError.tooLarge }
        var p = start, inflated = 0
        for _ in 0..<count {
            guard p + 46 <= start + size, u32(p) == 0x02014b50 else { throw ExcelDocumentError.unreadable }
            let compressed = u32(p + 20), expanded = u32(p + 24), name = u16(p + 28), extra = u16(p + 30), comment = u16(p + 32), offset = u32(p + 42)
            guard u16(p + 8) & 1 == 0, [0, 8].contains(u16(p + 10)), expanded <= 32 * 1_024 * 1_024,
                  expanded <= 64 * 1_024 * 1_024 - inflated, offset >= 0, offset + 30 <= start, u32(offset) == 0x04034b50,
                  compressed <= start - offset - 30, name > 0, name <= 1024,
                  p + 46 + name + extra + comment <= start + size else { throw ExcelDocumentError.tooLarge }
            inflated += expanded; p += 46 + name + extra + comment
        }
        guard p == start + size else { throw ExcelDocumentError.unreadable }
    }
}

private enum ExcelTablePDF {
    static func columnName(_ value: Int) -> String {
        var n = value + 1, result = ""
        while n > 0 { n -= 1; result = String(UnicodeScalar(65 + n % 26)!) + result; n /= 26 }; return result
    }
    static func render(_ model: ExcelReadingModel) throws -> Data {
        try Task.checkCancellation()
        let paper = CGRect(x: 0, y: 0, width: 841.89, height: 595.28), margin: CGFloat = 24, rowLabel: CGFloat = 38
        let font = UIFont.systemFont(ofSize: 10), headerFont = UIFont.boldSystemFont(ofSize: 10)
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byWordWrapping
        let textStyle: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.black, .paragraphStyle: paragraph]
        var notices: [String] = []
        if model.omittedVisuals { notices.append(String(localized: "图表、图片和浮动图形未包含；请查看原 Excel。")) }
        if model.missingFormulaResults > 0 { notices.append(String(localized: "[=] 表示未保存计算结果，此处显示原公式且不计算。")) }
        let extraHeader = CGFloat(notices.count) * 12
        let output = NSMutableData(); var box = paper
        guard let consumer = CGDataConsumer(data: output as CFMutableData), let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { throw ExcelDocumentError.unreadable }
        var open = false, closed = false, pageCount = 0
        func endPage() {
            if open { UIGraphicsPopContext(); context.restoreGState(); context.endPDFPage(); open = false }
        }
        defer { endPage(); if !closed { context.closePDF() } }
        for sheet in model.sheets {
            let hiddenRows = Set(sheet.hiddenRows), hiddenCols = Set(sheet.hiddenColumns)
            guard sheet.minRow >= 0, sheet.lastRow >= sheet.minRow, sheet.lastRow <= 1_048_575,
                  sheet.minCol >= 0, sheet.lastCol >= sheet.minCol, sheet.lastCol <= 16_383,
                  sheet.lastRow - sheet.minRow <= 100_000, sheet.lastCol - sheet.minCol <= 511 else { throw ExcelDocumentError.tooLarge }
            var rows = (sheet.minRow...sheet.lastRow).filter { !hiddenRows.contains($0) }
            var columns = (sheet.minCol...sheet.lastCol).filter { !hiddenCols.contains($0) }
            if rows.isEmpty { rows = [sheet.minRow] }; if columns.isEmpty { columns = [sheet.minCol] }
            let cells = Dictionary(uniqueKeysWithValues: sheet.cells.map { ($0.row * 16384 + $0.column, $0.text) })
            for start in stride(from: 0, to: columns.count, by: 6) {
                let band = Array(columns[start..<min(columns.count, start + 6)])
                let width = (paper.width - 2 * margin - rowLabel) / CGFloat(band.count)
                var y: CGFloat = 0
                func begin() throws {
                    endPage(); pageCount += 1
                    guard pageCount <= 2000 else { throw ExcelDocumentError.tooLarge }
                    context.beginPDFPage(nil); context.saveGState(); context.translateBy(x: 0, y: paper.height); context.scaleBy(x: 1, y: -1)
                    UIGraphicsPushContext(context); open = true
                    UIColor.white.setFill(); UIRectFill(paper)
                    (sheet.name as NSString).draw(in: CGRect(x: margin, y: margin, width: paper.width - 2 * margin, height: 22), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 16), .foregroundColor: UIColor.black])
                    (String(localized: "单元格阅读版 · \(columnName(band.first!))–\(columnName(band.last!)) 列 · 第 \(pageCount) 页") as NSString).draw(at: CGPoint(x: margin, y: margin + 25), withAttributes: [.font: UIFont.systemFont(ofSize: 9), .foregroundColor: UIColor.darkGray])
                    for (index, notice) in notices.enumerated() {
                        (notice as NSString).draw(at: CGPoint(x: margin, y: margin + 38 + CGFloat(index) * 12), withAttributes: [.font: UIFont.systemFont(ofSize: 8), .foregroundColor: UIColor.darkGray])
                    }
                    y = margin + 48 + extraHeader
                    UIColor(white: 0.92, alpha: 1).setFill(); UIRectFill(CGRect(x: margin, y: y, width: paper.width - 2 * margin, height: 23))
                    for (index, column) in band.enumerated() { (columnName(column) as NSString).draw(at: CGPoint(x: margin + rowLabel + CGFloat(index) * width + 4, y: y + 5), withAttributes: [.font: headerFont, .foregroundColor: UIColor.black]) }
                    y += 23
                }
                try begin()
                for row in rows {
                    try Task.checkCancellation()
                    let values = band.map { cells[row * 16384 + $0] ?? "" }
                    let heights = values.map { ($0 as NSString).boundingRect(with: CGSize(width: width - 8, height: 100_000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: textStyle, context: nil).height }
                    let height = max(22, ceil(heights.max() ?? 0) + 12)
                    guard height <= paper.height - 2 * margin - 71 - extraHeader else { throw ExcelDocumentError.tallCell }
                    if y + height > paper.height - margin { try begin() }
                    context.setStrokeColor(UIColor(white: 0.72, alpha: 1).cgColor); context.setLineWidth(0.35)
                    context.stroke(CGRect(x: margin, y: y, width: rowLabel, height: height))
                    (String(row + 1) as NSString).draw(at: CGPoint(x: margin + 3, y: y + 6), withAttributes: [.font: UIFont.systemFont(ofSize: 8), .foregroundColor: UIColor.darkGray])
                    for (index, value) in values.enumerated() {
                        let x = margin + rowLabel + CGFloat(index) * width
                        context.stroke(CGRect(x: x, y: y, width: width, height: height))
                        (value as NSString).draw(in: CGRect(x: x + 4, y: y + 6, width: width - 8, height: height - 10), withAttributes: textStyle)
                    }
                    y += height
                }
                endPage()
            }
        }
        context.closePDF(); closed = true; try Task.checkCancellation()
        guard output.length > 0, output.length <= 128 * 1_024 * 1_024,
              let pdf = PDFDocument(data: output as Data), pdf.pageCount == pageCount else { throw ExcelDocumentError.unreadable }
        return output as Data
    }
}

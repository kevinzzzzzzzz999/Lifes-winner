import SwiftUI
import UniformTypeIdentifiers

private struct StudyTextDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText,.tabSeparatedText] }
    var data: Data
    init(data: Data) { self.data=data }
    init(configuration: ReadConfiguration) throws { data=configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents:data) }
}
struct StudyTransferView: View {
    let store: BoardStore
    let study: StudySession
    @Environment(\.dismiss) private var dismiss
    @State private var model = StudyImportSession()
    @State private var source: Data?
    @State private var sourceName = ""
    @State private var pasted = ""
    @State private var delimiter = ","
    @State private var exportDelimiter = ","
    @State private var header = false
    @State private var loading = false
    @State private var importer = false
    @State private var exporter = false
    @State private var exportDocument: StudyTextDocument?
    @State private var error: String?
    @State private var exportNotice = ""
    @State private var formulaProtection = false
    private var locked: Bool { loading || model.busy }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(String(localized:"接收白板：\(store.document.title)")).font(.headline)
                    Text(String(localized:"问答卡使用独立复习记录；导入不会覆盖已有评分。文本导出不包含笔迹、挖空、来源定位或复习进度。")) .font(.footnote).foregroundStyle(.secondary)
                }
                if !store.usesPhoneInterface { sourceSection; previewSection }
                exportSection
                if let message=error ?? model.error { Section { Text(message).foregroundStyle(.red).accessibilityIdentifier("study.transfer.error") } }
            }
            .navigationTitle(store.usesPhoneInterface ? String(localized:"导出问答卡") : String(localized:"问答卡导入与导出"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement:.cancellationAction) {
                Button(String(localized:"完成")) { dismiss() }.frame(minHeight:44).disabled(locked).accessibilityIdentifier("study.transfer.close")
            } }
            .interactiveDismissDisabled(locked || model.attempted && model.remainingSelected > 0)
            .onChange(of:delimiter) { _,_ in if !model.attempted {model.entries=[]} }
            .onChange(of:header) { _,_ in if !model.attempted {model.entries=[]} }
            .fileImporter(isPresented:$importer,allowedContentTypes:[.commaSeparatedText,.tabSeparatedText,.plainText],allowsMultipleSelection:false) { result in
                switch result {case .success(let urls):if let url=urls.first {read(url)};case .failure(let failure):error=failure.localizedDescription}
            }
            .fileExporter(isPresented:$exporter,document:exportDocument,contentType:exportDelimiter == "\t" ? .tabSeparatedText:.commaSeparatedText,defaultFilename:"Study-"+store.document.title) { result in
                if case .failure(let failure)=result {error=failure.localizedDescription}
            }
        }
    }
    private var sourceSection: some View {
        Section(String(localized:"选择两列表格")) {
            Button(String(localized:"选择 CSV / TSV 文件")) { importer=true }.frame(minHeight:44).accessibilityIdentifier("study.transfer.chooseFile")
            if !sourceName.isEmpty { Text(sourceName).font(.caption).textSelection(.enabled) }
            Picker(String(localized:"分隔符"),selection:$delimiter) {Text("CSV (,)").tag(",");Text("TSV (Tab)").tag("\t")}.accessibilityIdentifier("study.transfer.delimiter")
            Toggle(String(localized:"首行是表头（跳过第一条）"),isOn:$header).accessibilityIdentifier("study.transfer.header")
            Text(String(localized:"默认无表头，恰好两列：问题、答案。最多 500 条、2 MiB；支持双引号内的换行。")) .font(.footnote).foregroundStyle(.secondary)
            DisclosureGroup(String(localized:"或粘贴两列表格文本")) {
                TextEditor(text:$pasted).frame(minHeight:120).accessibilityLabel(String(localized:"表格文本")).accessibilityIdentifier("study.transfer.text")
                Button(String(localized:"预览粘贴内容")) { source=Data(pasted.utf8);sourceName=String(localized:"粘贴内容");preview() }.frame(minHeight:44).disabled(pasted.isEmpty).accessibilityIdentifier("study.transfer.previewPaste")
            }.accessibilityIdentifier("study.transfer.pasteGroup")
            if source != nil { Button(String(localized:"重新生成预览"),action:preview).frame(minHeight:44).accessibilityIdentifier("study.transfer.refreshPreview") }
            if loading {ProgressView()}
        }.disabled(locked || model.attempted)
    }
    @ViewBuilder private var previewSection: some View {
        if !model.entries.isEmpty {
            Section(String(localized:"导入预览")) {
                Text(String(localized:"有效 \(model.entries.filter{$0.status == "ready"}.count) · 重复 \(model.entries.filter{$0.status == "duplicate"}.count) · 错误 \(model.entries.filter{$0.status == "invalid"}.count) · 已完成 \(model.completed)")) .font(.footnote).accessibilityIdentifier("study.transfer.counts")
                Text(String(localized:"重复比较区分大小写，忽略两端空白并统一换行和 Unicode。错误条目不会入选。")) .font(.footnote).foregroundStyle(.secondary)
                ForEach(model.entries) { entry in StudyTransferRow(entry:entry,selected:Binding(get:{model.selected.contains(entry.id)},set:{if $0 {model.selected.insert(entry.id)}else{model.selected.remove(entry.id)}})).disabled(locked || model.attempted) }
                if model.busy {
                    ProgressView(String(localized:"正在保存节点与卡片…"))
                    Button(String(localized:"停止后续条目")) { model.stopRequested=true }.frame(minHeight:44).accessibilityIdentifier("study.transfer.stop")
                } else {
                    Button(String(localized:"导入已选 \(model.remainingSelected) 条"),action:commit).frame(minHeight:44).disabled(model.remainingSelected == 0 || loading).accessibilityIdentifier("study.transfer.commit")
                }
                if model.attempted { Text(String(localized:"已完成的卡片和节点保留。若未全部完成，可直接重试；关闭后重新选择同一文件也不会重复创建。")) .font(.footnote).accessibilityIdentifier("study.transfer.result") }
            }
        }
    }
    private var exportSection: some View {
        Section(String(localized:"导出问答文本")) {
            Picker(String(localized:"导出格式"),selection:$exportDelimiter) {
                Text("CSV (,)").tag(",")
                Text("TSV (Tab)").tag("\t")
            }.disabled(locked).accessibilityIdentifier("study.transfer.exportFormat")
            Toggle(String(localized:"为表格软件转义公式开头（会改变文本）"),isOn:$formulaProtection).disabled(locked)
            Button(String(localized:"导出当前白板问答卡"),action:makeExport).frame(minHeight:44).disabled(locked || study.pending != nil).accessibilityIdentifier("study.transfer.export")
            if !exportNotice.isEmpty { Text(exportNotice).font(.footnote).accessibilityIdentifier("study.transfer.exportNotice") }
        }
    }
    private func read(_ url: URL) {
        guard !locked else{return};loading=true;error=nil;model.entries=[];source=nil
        Task {
            do {
                let data=try await Task.detached(priority:.userInitiated) {
                    let scope=url.startAccessingSecurityScopedResource();defer{if scope{url.stopAccessingSecurityScopedResource()}}
                    let values=try url.resourceValues(forKeys:[.fileSizeKey,.isRegularFileKey])
                    guard values.isRegularFile == true,(values.fileSize ?? Int.max)<=StudyCSV.maximumBytes else{throw StudyCSVError.limit}
                    let file=try FileHandle(forReadingFrom:url);defer{try? file.close()}
                    let data=try file.read(upToCount:StudyCSV.maximumBytes+1) ?? Data();guard data.count<=StudyCSV.maximumBytes else{throw StudyCSVError.limit};return data
                }.value
                source=data;sourceName=url.lastPathComponent;delimiter=url.pathExtension.lowercased()=="tsv" ? "\t":",";loading=false;preview()
            } catch {self.error=error.localizedDescription;loading=false}
        }
    }
    private func preview() {
        guard !locked,let source,let root=store.vaultURL,let url=store.boardURL,!store.usesPhoneInterface else{return}
        loading=true;error=nil
        let board=store.document,separator=delimiter,skip=header
        Task {
            defer{loading=false}
            do {
                let rows=try await Task.detached(priority:.userInitiated) {try StudyCSV.parse(source,delimiter:separator,header:skip)}.value
                let snapshot=try await StudyRepository.load(root:root,boardID:board.id)
                guard store.document.id==board.id,store.boardURL==url else{throw StudyCSVError.target}
                try model.prepare(rows:rows,board:board,boardURL:url,root:root,snapshot:snapshot)
                if rows.isEmpty {error=String(localized:"没有可预览的问答条目。")}
            } catch {self.error=error.localizedDescription;model.entries=[]}
        }
    }
    private func commit() {
        guard !locked,!store.usesPhoneInterface,let id=model.boardID,let url=model.boardURL else{return}
        Task {await model.commit(current:{(store.document.id,store.boardURL,store.document.items)},saveNodes:{items in try await store.saveStudyImportNodes(items,boardID:id,targetURL:url)});await study.load(root:store.vaultURL,boardID:store.document.id)}
    }
    private func makeExport() {
        guard !locked else{return};loading=true;error=nil
        Task {
            defer{loading=false}
            do {
                guard let root=store.vaultURL else{throw StudyError.unavailable}
                let id=store.document.id,snapshot=try await StudyRepository.load(root:root,boardID:id)
                guard snapshot.warnings.isEmpty else{throw StudyError.incomplete};guard id==store.document.id else{throw StudyCSVError.target}
                let byID=Dictionary(store.document.items.map{($0.id.uuidString.lowercased(),$0)},uniquingKeysWith:{a,_ in a})
                let imageCount=snapshot.cards.filter { $0.card.hasRichContent || $0.card.answerMode == "node" && StudyNodes.isImage(byID[$0.itemID]) }.count
                let pairs=snapshot.cards.compactMap { card -> StudyCSVPair? in
                    guard card.card.mode=="qa", !card.card.hasRichContent, let item=byID[card.itemID], !(card.card.answerMode == "node" && StudyNodes.isImage(item)) else{return nil}
                    let answer=card.card.answerMode=="node" ? StudyNodes.answer(item):card.card.answer
                    guard !StudyCSV.normalized(answer).isEmpty else{return nil}
                    return .init(question:card.card.question,answer:answer)
                }
                guard !pairs.isEmpty else{ error=String(localized:"没有可导出的文字问答；图片或图文/遮盖卡 \(imageCount) 条不能写入 CSV/TSV。原卡片保留。"); return }
                let output=try StudyCSV.export(pairs,delimiter:exportDelimiter,formulaProtection:formulaProtection)
                exportNotice=String(localized:"已准备 \(pairs.count) 条；跳过 \(snapshot.cards.count-pairs.count) 条（其中图片或图文/遮盖卡 \(imageCount) 条）；CSV/TSV 不包含图片、图文混排、遮盖、挖空或不可用答案。为表格软件安全转义 \(output.escapedCells) 个单元格。")
                exportDocument=StudyTextDocument(data:output.data);exporter=true
            } catch {self.error=error.localizedDescription}
        }
    }
}
private struct StudyTransferRow: View {
    let entry: StudyImportEntry
    @Binding var selected: Bool
    var body: some View {
        VStack(alignment:.leading,spacing:6) {
            if entry.status == "ready" {Toggle(String(localized:"第 \(entry.row.line) 行"),isOn:$selected)}
            else {Text(String(localized:"第 \(entry.row.line) 行")+" · "+status).font(.headline)}
            Text(entry.row.pair?.question ?? entry.row.cells.first ?? "").font(.headline).fixedSize(horizontal:false,vertical:true)
            Text(entry.row.pair?.answer ?? "").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            if let message=entry.message {Text(message).font(.caption).foregroundStyle(.red)}
        }.accessibilityElement(children:.contain).accessibilityIdentifier("study.transfer.row.\(entry.id)")
    }
    private var status:String {switch entry.status {case "duplicate":String(localized:"重复，跳过");case "imported":String(localized:"已导入");default:String(localized:"需修正")}}
}

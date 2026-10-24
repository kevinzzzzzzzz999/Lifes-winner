import SwiftUI
import UIKit

struct PDFWorkspaceLayers: View {
    @Bindable var pane: PDFWorkspacePane
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var deleting: PDFWorkspaceLayer?
    @State private var renaming: PDFWorkspaceLayer?
    @State private var renamed = ""
    private let colors = [("红色","#C53732"),("蓝色","#1768AC"),("绿色","#16834B"),("琥珀色","#D68A00"),("黑色","#202020")]
    var body: some View {
        NavigationStack {
            List {
                if pane.rootURL == nil { Text("请先授权 PDF 所在的资料文件夹，才能保存独立图层。").foregroundStyle(.secondary) }
                Section(String(localized:"新建图层")) {
                    TextField(String(localized:"图层名称"),text:$name).accessibilityIdentifier("pdfWorkspace.layerName")
                    Button(String(localized:"添加图层")) { let value=name; Task { await pane.addLayer(name:value); if !pane.hasPendingWrite { name="" } } }
                        .disabled(name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || busy || pane.rootURL == nil).accessibilityIdentifier("pdfWorkspace.addLayer")
                    HStack {
                        preset("中文翻译"); preset("重点内容"); preset("演算笔记")
                    }.buttonStyle(.bordered).disabled(busy || pane.rootURL == nil)
                }
                Section(String(localized:"图层")) {
                    ForEach(pane.projection.layers) { layer in
                        VStack(alignment:.leading,spacing:8) {
                            HStack {
                                Button { pane.selectedLayerID=layer.id } label: { Label(layer.name, systemImage:pane.selectedLayerID == layer.id ? "checkmark.circle.fill":"circle") }.buttonStyle(.plain)
                                    .accessibilityIdentifier("pdfWorkspace.layer."+layer.id.uuidString.lowercased())
                                Spacer()
                                Button { renaming=layer;renamed=layer.name } label:{Image(systemName:"pencil")}.buttonStyle(.borderless).disabled(busy).accessibilityLabel(String(localized:"重命名图层"))
                                Button(role:.destructive) { deleting=layer } label: { Image(systemName:"trash") }.buttonStyle(.borderless).disabled(layer.locked || busy).accessibilityLabel(String(localized:"删除图层"))
                            }
                            HStack {
                                Toggle(String(localized:"显示"),isOn:Binding(get:{ layer.visible },set:{ var copy=layer; copy.visible=$0; Task { await pane.setLayer(copy) } }))
                                Toggle(String(localized:"锁定"),isOn:Binding(get:{ layer.locked },set:{ var copy=layer; copy.locked=$0; Task { await pane.setLayer(copy) } }))
                            }.disabled(busy)
                        }.padding(.vertical,4)
                    }
                }
                Section(String(localized:"新批注样式")) {
                    Picker(String(localized:"颜色"),selection:$pane.color) { ForEach(colors,id:\.1) { entry in Text(localizedColor(entry.0)).tag(entry.1) } }
                    HStack { Text("线宽"); Slider(value:$pane.lineWidth,in:0.001...0.012); Text(String(format:"%.1f",pane.lineWidth*1000)).monospacedDigit() }
                    Text("笔迹用 Apple Pencil；重点框选和文字批注可用手指。阅读模式不会写入图层。").font(.caption).foregroundStyle(.secondary)
                }
                if let selected=pane.selectedLayer {
                    Section(selected.name) {
                        ForEach(pane.projection.annotations.filter { $0.layerID == selected.id }) { mark in
                            HStack {
                                Button { pane.navigate(to:mark.page); dismiss() } label: {
                                    VStack(alignment:.leading) {
                                        Text(String(localized:"原文第 \(mark.page) 页"))
                                        Text(mark.text.isEmpty ? mark.kind == .ink ? String(localized:"笔迹图层") : String(localized:"重点框选") : mark.text).font(.caption).lineLimit(2)
                                    }
                                }
                                Spacer()
                                Button(role:.destructive) { Task { await pane.deleteAnnotation(mark) } } label: { Image(systemName:"trash") }.disabled(busy || selected.locked || !selected.visible).accessibilityLabel(String(localized:"删除批注"))
                            }
                        }
                    }
                }
                if !pane.error.isEmpty { Text(pane.error).foregroundStyle(.red).font(.caption) }
            }
            .navigationTitle(String(localized:"PDF 图层"))
            .toolbar { ToolbarItem(placement:.confirmationAction) { Button(String(localized:"完成")) { dismiss() }.accessibilityIdentifier("pdfWorkspace.layersDone") } }
            .alert(String(localized:"重命名图层"),isPresented:Binding(get:{renaming != nil},set:{if !$0 {renaming=nil}})) {
                TextField(String(localized:"图层名称"),text:$renamed)
                Button(String(localized:"取消"),role:.cancel){renaming=nil}
                Button(String(localized:"保存")) { if var layer=renaming {layer.name=renamed;Task{await pane.setLayer(layer)}};renaming=nil }
            }
            .confirmationDialog(String(localized:"删除图层及其批注？"),isPresented:Binding(get:{deleting != nil},set:{if !$0 {deleting=nil}}),titleVisibility:.visible) {
                Button(String(localized:"删除图层"),role:.destructive) { if let layer=deleting { Task { await pane.deleteLayer(layer) } }; deleting=nil }
            } message: { Text("删除会同步到其他设备，可在本次阅读工作区撤销；原 PDF 不受影响。") }
        }
    }
    private var busy:Bool { pane.isLoading || pane.isSaving || pane.hasPendingWrite || pane.interactionActive }
    private func preset(_ text:String) -> some View { Button(localizedPreset(text)) { Task { await pane.addLayer(name:localizedPreset(text)) } } }
    private func localizedPreset(_ text:String)->String { switch text { case "中文翻译":String(localized:"中文翻译");case "重点内容":String(localized:"重点内容");default:String(localized:"演算笔记") } }
    private func localizedColor(_ text:String)->String { switch text { case "红色":String(localized:"红色");case "蓝色":String(localized:"蓝色");case "绿色":String(localized:"绿色");case "琥珀色":String(localized:"琥珀色");default:String(localized:"黑色") } }
}

struct PDFWorkspaceTextEntry: View {
    @Bindable var pane:PDFWorkspacePane
    let mark:PDFWorkspaceAnnotation
    @Environment(\.dismiss) private var dismiss
    var body:some View {
        NavigationStack {
            TextEditor(text:$pane.draftText).padding().accessibilityIdentifier("pdfWorkspace.annotationText")
                .navigationTitle(String(localized:"文字批注"))
                .toolbar {
                    ToolbarItem(placement:.cancellationAction) { Button(String(localized:"取消")) { pane.draftText=""; dismiss() } }
                    ToolbarItem(placement:.confirmationAction) { Button(String(localized:"添加")) {
                        var copy=mark; copy.text=pane.draftText
                        Task { if await pane.addAnnotation(copy) { pane.draftText=""; dismiss() } }
                    }.disabled(pane.draftText.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || pane.draftText.unicodeScalars.count>10000 || pane.isSaving || pane.hasPendingWrite).accessibilityIdentifier("pdfWorkspace.annotationAdd") }
                }
                .safeAreaInset(edge:.bottom) { if !pane.error.isEmpty { Text(pane.error).foregroundStyle(.red).padding() } }
        }.interactiveDismissDisabled(pane.isSaving)
    }
}

struct PDFWorkspaceTranslationSetup: View {
    @Bindable var pane:PDFWorkspacePane
    let onStart:()->Void
    @Environment(\.dismiss) private var dismiss
    @State private var from="1"
    @State private var through="1"
    @State private var replaceWarning=false
    var body:some View {
        NavigationStack {
            Form {
                Section(String(localized:"翻译范围")) {
                    TextField(String(localized:"起始页"),text:$from).keyboardType(.numberPad)
                    TextField(String(localized:"结束页"),text:$through).keyboardType(.numberPad)
                    Button(String(localized:"仅当前页")) { from=String(pane.page);through=from }
                    Button(String(localized:"整份 PDF")) { from="1";through=String(pane.pageCount) }
                }
                Section {
                    Text(pane.temporaryTranslation.provider.title+" · "+pane.temporaryTranslation.model)
                    Text(String(localized:"目标语言：\(pane.temporaryTranslation.language)"))
                    Text("仅所选页的页面图像逐页发送至选定 API。API 可能收费；每次最多 2000 页、200 万字符，达到容量会停止并保留已完成部分。").font(.caption)
                    Text("译文会重新排版，不是原 PDF 的逐像素中文替换；请核对专业术语和公式。").font(.caption).foregroundStyle(.secondary)
                    Button(String(localized:"开始范围翻译")) {
                        if !pane.translationJob.pages.isEmpty { replaceWarning=true } else { start() }
                    }.disabled(validRange == nil || pane.translationJob.isRunning || pane.sourceSHA256.isEmpty).accessibilityIdentifier("pdfWorkspace.startRange")
                }
            }.navigationTitle(String(localized:"范围翻译"))
                .toolbar { ToolbarItem(placement:.cancellationAction) { Button(String(localized:"取消")) { dismiss() } } }
                .onAppear { from=String(pane.page);through=from }
                .confirmationDialog(String(localized:"开始新翻译并替换本次已有译文？"),isPresented:$replaceWarning,titleVisibility:.visible) {
                    Button(String(localized:"开始新翻译"),role:.destructive) { start() }
                } message: { Text("请先导出需要保留的已有译文；开始后当前工作区的上一批译文将被替换。") }
        }
    }
    private var validRange:ClosedRange<Int>? {
        guard let first=Int(from),let last=Int(through),first>=1,last>=first,last<=pane.pageCount,last-first<2000 else { return nil };return first...last
    }
    private func start() {
        guard let range=validRange else { return }
        pane.translationJob.start(repository:pane.repository,sourceSHA256:pane.sourceSHA256,range:range,pageCount:pane.pageCount,provider:pane.temporaryTranslation.provider,model:pane.temporaryTranslation.model,language:pane.temporaryTranslation.language)
        onStart();dismiss()
    }
}

private struct PDFWorkspaceExportItem:Identifiable { let id=UUID();let url:URL }
struct PDFWorkspaceTranslationResult:View {
    @Bindable var pane:PDFWorkspacePane
    let onReturn:()->Void
    let onLocate:(Int)->Void
    @State private var export:PDFWorkspaceExportItem?
    @State private var exporting=false
    @State private var exportError=""
    @State private var exportedFile: URL?
    @State private var saveRequest: NativeFileSaveRequest?
    @State private var saveStatus = ""
    var body:some View {
        VStack(alignment:.leading,spacing:8) {
            HStack {
                Text("译文对照").font(.headline)
                Spacer()
                Button(String(localized:"返回 PDF")) { onReturn() }
            }
            Text(pane.title).font(.caption).lineLimit(1)
            Text(pane.translationJob.provider.title+" · "+pane.translationJob.model).font(.caption2).foregroundStyle(.secondary)
            HStack {
                Text(String(localized:"已完成 \(pane.translationJob.pages.count) / \(pane.translationJob.range.count) 页")).font(.caption)
                if pane.translationJob.isRunning { ProgressView();Button(String(localized:"取消翻译")) { pane.translationJob.cancel() } }
                Spacer()
                Button(String(localized:"导出译文 PDF")) { exportPDF() }.disabled(pane.translationJob.pages.isEmpty || pane.translationJob.isRunning || exporting).accessibilityIdentifier("pdfWorkspace.exportTranslation")
            }
            if !pane.translationJob.isRunning && pane.translationJob.status != "complete" {
                Text(pane.translationJob.status == "capacity" ? String(localized:"已到本次容量，已完成页仍可导出。") : String(localized:"未全部完成，已取得的译文保留在此。")) .font(.caption).foregroundStyle(.secondary)
            }
            if isPreviousVersion { Text("这份译文来自此前的 PDF 版本；可以导出，但不能定位到当前新版原文。旧 PDF 文件不在此保留。").font(.caption).foregroundStyle(.orange) }
            if !pane.translationJob.error.isEmpty { Text(pane.translationJob.error).font(.caption).foregroundStyle(.red) }
            if !exportError.isEmpty { Text(exportError).font(.caption).foregroundStyle(.red) }
            if let exportedFile {
                Button(String(localized: "存储译文到文件"), systemImage: "folder.badge.plus") {
                    saveRequest = .init(files: [exportedFile])
                }.disabled(exporting).accessibilityIdentifier("pdfWorkspace.saveTranslation")
            }
            if !saveStatus.isEmpty { Text(saveStatus).font(.caption).foregroundStyle(.secondary) }
            ScrollView {
                LazyVStack(alignment:.leading,spacing:20) {
                    ForEach(pane.translationJob.pages) { section in
                        VStack(alignment:.leading,spacing:8) {
                            Button(String(localized:"原文第 \(section.page) 页")) { onLocate(section.page) }.disabled(isPreviousVersion)
                            Text(section.text).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)
                        }.padding(10).background(.secondary.opacity(0.06),in:RoundedRectangle(cornerRadius:8))
                    }
                }
            }
        }.padding(10).background(.background)
            .sheet(item:$export) { item in PDFWorkspaceFileShare(url:item.url) }
            .sheet(item: $saveRequest) { request in
                NativeFileSavePicker(files: request.files) { saved in
                    saveStatus = saved ? String(localized: "文件已存储到所选位置。iCloud 传输由系统继续完成。")
                                       : String(localized: "未保存文件。已生成的副本保留，可再次选择存储位置。")
                }
            }
    }
    private var isPreviousVersion:Bool { !pane.translationJob.pages.isEmpty && pane.translationJob.sourceSHA256 != pane.sourceSHA256 }
    private func exportPDF() {
        guard !exporting else{return};exporting=true;exportError=""
        let job=pane.translationJob
        Task {
            defer{exporting=false}
            do { let url=try await PDFWorkspaceTranslationExport.export(title:pane.title,provider:job.provider.title,model:job.model,language:job.language,range:job.range,pages:job.pages,status:job.status);exportedFile=url;saveStatus="";export=PDFWorkspaceExportItem(url:url) }
            catch { exportError=error.localizedDescription }
        }
    }
}
private struct PDFWorkspaceFileShare:UIViewControllerRepresentable {
    let url:URL
    func makeUIViewController(context:Context)->UIActivityViewController { UIActivityViewController(activityItems:[url],applicationActivities:nil) }
    func updateUIViewController(_ controller:UIActivityViewController,context:Context){}
}

struct PDFWorkspaceFilePicker:View {
    let root:URL
    let initialURL:URL
    let onChoose:(URL)->Void
    @Environment(\.dismiss) private var dismiss
    @State private var library:DocumentLibrary?
    @State private var path=""
    @State private var search=""
    @State private var listing=VaultDirectoryListing(folders:[],documents:[],warning:nil)
    @State private var loading=false
    var body:some View {
        NavigationStack {
            List {
                if !path.isEmpty { Button(String(localized:"返回上层"),systemImage:"arrow.up") { path=(path as NSString).deletingLastPathComponent } }
                if let warning=listing.warning { Text(warning).font(.caption).foregroundStyle(.secondary) }
                ForEach(listing.folders.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }) { folder in
                    Button { path=folder.relativePath } label:{Label(folder.title,systemImage:"folder")}
                }
                ForEach(listing.documents.filter { $0.isPDF && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.relativePath.localizedCaseInsensitiveContains(search)) }) { file in
                    Button { onChoose(root.appendingPathComponent(file.relativePath)) } label:{Label(file.title,systemImage:"doc.richtext")}.accessibilityIdentifier("pdfWorkspace.choose."+file.relativePath)
                }
                if loading { ProgressView() }
            }.searchable(text:$search,prompt:String(localized:"搜索当前文件夹"))
                .navigationTitle(path.isEmpty ? String(localized:"选择对照 PDF") : (path as NSString).lastPathComponent)
                .toolbar { ToolbarItem(placement:.cancellationAction){Button(String(localized:"取消")){dismiss()}} }
                .task {
                    library=DocumentLibrary(rootURL:root)
                    let parent=initialURL.deletingLastPathComponent().standardizedFileURL,base=root.standardizedFileURL
                    if parent.pathComponents.starts(with:base.pathComponents){path=parent.pathComponents.dropFirst(base.pathComponents.count).joined(separator:"/")}
                    await load()
                }
                .task(id:path) { await load() }
        }
    }
    private func load()async {
        guard let library else{return};let requested=path;loading=true
        let result=await library.listDirectory(relativePath:requested)
        guard !Task.isCancelled,path==requested else{return};listing=result;loading=false
    }
}

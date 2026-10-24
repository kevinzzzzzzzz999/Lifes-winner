import SwiftUI
import PDFKit
import UniformTypeIdentifiers
import ImageIO

struct PDFExtensionReader:View {
    @Bindable var pane:PDFWorkspacePane
    @Bindable var store:PDFExtensionStore
    let onExcerpt:((PDFSourceReference) async -> Bool)?
    @State private var inserting=false
    @State private var selectedID:String?
    @State private var movingID:String?
    @State private var resizing:PDFExtensionBlock?
    @State private var resizeOrigin:PDFExtensionBlock?
    @GestureState private var resizeGestureActive=false
    @State private var expanded=Set<String>()
    @State private var collapsed=Set<String>()
    @State private var editing:PDFExtensionBlock?
    @State private var deleting:PDFExtensionBlock?
    @State private var history=false
    @State private var scale=1.0
    @State private var initialScale=1.0
    @State private var color="#203E35"
    @State private var erases=false
    @State private var exported:URL?
    @State private var sharing=false
    @State private var saveRequest: NativeFileSaveRequest?
    @State private var previewRequest: NativeFileSaveRequest?
    @State private var exportMessage = ""
    @State private var exporting=false
    @State private var exportTask:Task<Void,Never>?
    @State private var exportProgress:PDFExtensionExportProgress?
    @State private var excerptBusy=false
    @State private var selectionImageRevision=0
    private var editable:Bool {store.sourceSHA256==pane.sourceSHA256 && pane.access == .full && pane.rootURL != nil && !store.busy && store.pending == nil && !pane.layerReplayActive && !excerptBusy && !exporting}
    private var allowsTextSelection:Bool {!inserting && movingID == nil && resizing == nil && editing == nil && !exporting && !pane.interactionActive && !pane.layerReplayActive && !pane.isLoading && !pane.isSaving && !pane.hasPendingWrite && !store.busy && store.pending == nil && !history && !sharing && deleting == nil}
    private var unifiedTextSelection:Bool {pane.extendedInkTextSelectionEnabled && allowsTextSelection}
    var body:some View {
        VStack(spacing:0) {
            controls
            if exporting {
                HStack {
                    if let progress=exportProgress {
                        ProgressView(value:Double(progress.completedPages),total:Double(max(1,progress.totalPages)))
                        Text(String(localized:"正在导出 \(progress.completedPages) / \(progress.totalPages) 页")).font(.caption).monospacedDigit()
                    } else {ProgressView();Text(String(localized:"正在准备 PDF 副本…")).font(.caption)}
                    Button(String(localized:"取消导出")){exportTask?.cancel()}.accessibilityIdentifier("pdfExtend.cancelExport")
                }.padding(8).accessibilityIdentifier("pdfExtend.exportProgress")
            }
            if let exported, !exporting {
                HStack(spacing: 10) {
                    Text(exported.lastPathComponent).font(.caption).lineLimit(1)
                    Spacer(minLength: 0)
                    Button(String(localized: "预览")) { previewRequest = .init(files: [exported]) }
                        .accessibilityIdentifier("pdfExtend.previewExport")
                    Button(String(localized: "存储到文件")) { saveRequest = .init(files: [exported]) }
                        .accessibilityIdentifier("pdfExtend.saveExport")
                    Button(String(localized: "分享")) { sharing = true }
                }.buttonStyle(.bordered).padding(8)
                if !exportMessage.isEmpty { Text(exportMessage).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 8).accessibilityIdentifier("pdfExtend.saveStatus") }
            }
            if movingID != nil {
                HStack {
                    Text(String(localized:"点正文的新位置，整块留白与内容一起移动。")).font(.caption)
                    Spacer(minLength:8)
                    Button(String(localized:"取消移动")){movingID=nil;updateInteraction()}.frame(minHeight:44)
                }.padding(.horizontal,12).background(Color.accentColor.opacity(0.08)).accessibilityIdentifier("pdfExtend.moveHint")
            }
            if !store.error.isEmpty {HStack {Text(store.error).font(.caption).foregroundStyle(.red);if store.pending != nil {Button(String(localized:"重试保存")){Task{_ = await store.retry()}}.disabled(store.busy)}}.padding(8).accessibilityIdentifier("pdfExtend.error")}
            if store.oldVersionCount>0 {Text(String(localized:"另有 \(store.oldVersionCount) 个其他原文件版本的留白，保留在历史中，当前不叠加。")).font(.caption).padding(6)}
            if !store.projection.warnings.isEmpty {Text(store.projection.warnings.joined(separator:"\n")).font(.caption).foregroundStyle(.orange).padding(6)}
            GeometryReader { geometry in
                let width=max(260,geometry.size.width-24)*scale
                if let page=pane.document?.page(at:pane.page-1) {
                    let box=page.bounds(for:.cropBox).applying(page.transform(for:.cropBox)).standardized
                    let aspect=box.height/max(1,box.width)
                    ScrollViewReader { scroll in
                    ScrollView([.horizontal,.vertical]) {
                        HStack(alignment:.top,spacing:12) {
                            LazyVStack(spacing:0) {
                                ForEach(PDFExtensionGeometry.slices(pageAspect:aspect,blocks:pageBlocks,expanded:expanded)) { slice in
                                    switch slice.kind {
                                    case let .original(start,end):
                                        PDFExtensionFragment(page:page,start:start,end:end,marks:pane.displayedAnnotations.filter{$0.page==pane.page},futureIDs:pane.futureReplayIDs,allowsTextSelection:allowsTextSelection && !unifiedTextSelection,onInsert:(inserting || movingID != nil) && editable ? { y in place(at:y) } : nil)
                                            .frame(width:width,height:max(1,(end-start)*aspect*width))
                                    case let .note(id):
                                        if let block=pageBlocks.first(where:{$0.id==id}) {note(block,width:width,bodyVisible:!collapsed.contains(id) && (block.mode == .inline || expanded.contains(id))).id("extend-anchor-"+id)}
                                    }
                                }
                            }.frame(width:width).background(.white)
                            if pageBlocks.contains(where:{$0.mode == .margin && !expanded.contains($0.id)}) {
                                LazyVStack(spacing:12) {
                                    ForEach(pageBlocks.filter{$0.mode == .margin && !expanded.contains($0.id)}) {block in
                                        note(block,width:width*0.7,bodyVisible:true)
                                    }
                                }.frame(width:width*0.7)
                            }
                        }.overlayPreferenceValue(PDFExtensionSelectionExclusions.self) { anchors in
                            GeometryReader { selectionGeometry in
                                PDFExtensionContinuousSelection(
                                    active:unifiedTextSelection,
                                    request:pane.extendedTextSelectionRequest,
                                    revision:.init(page:pane.page,source:pane.sourceSHA256,blocks:pageBlocks,marks:pane.displayedAnnotations,futureIDs:pane.futureReplayIDs,expanded:expanded,collapsed:collapsed,imageRevision:selectionImageRevision),
                                    excluded:anchors.map{selectionGeometry[$0]},
                                    onStatus:{value in if unifiedTextSelection {pane.textSelectionStatus=value}},
                                    onPencil:{pane.extendedInkTextSelectionEnabled=false})
                                    .allowsHitTesting(unifiedTextSelection)
                            }
                        }.padding(12)
                    }.background(Color(uiColor:.secondarySystemBackground))
                    .scrollDisabled(resizing != nil)
                    .simultaneousGesture(MagnifyGesture().onChanged{value in scale=min(5,max(0.5,initialScale*value.magnification))}.onEnded{_ in initialScale=scale})
                    .accessibilityIdentifier("pdfExtend.reader")
                    .task(id:pane.pendingExtensionBlockID) {
                        guard let id=pane.pendingExtensionBlockID,pageBlocks.contains(where:{$0.id==id}) else{return}
                        collapsed.remove(id);expanded.insert(id)
                        // Let the lazy page lay out the expanded target before locating it.
                        do{try await Task.sleep(for:.milliseconds(100))}catch{return}
                        guard pane.pendingExtensionBlockID==id else{return}
                        scroll.scrollTo("extend-anchor-"+id,anchor:.top)
                        pane.pendingExtensionBlockID=nil
                    }
                    }
                } else {ContentUnavailableView(String(localized:"请先下载并打开原 PDF"),systemImage:"doc")}
            }
        }
        .task {if store.sourceSHA256.isEmpty {await store.refresh()}}
        .sheet(item:$editing) {block in PDFExtensionEditor(block:block,store:store,onClose:{editing=nil})}
        .sheet(isPresented:$sharing){if let exported{PDFExtensionShare(url:exported)}}
        .sheet(item: $saveRequest) { save in
            NativeFileSavePicker(files: save.files) { saved in
                exportMessage = saved ? String(localized: "文件已存储到所选位置。iCloud 传输由系统继续完成。")
                                    : String(localized: "未保存文件。已生成的副本保留，可再次选择存储位置。")
            }
        }
        .sheet(item: $previewRequest) { NativeFilePreview(files: $0.files) }
        .sheet(isPresented:$history) {PDFExtensionHistory(store:store,editable:editable)}
        .confirmationDialog(String(localized:"删除这块留白？"),isPresented:Binding(get:{deleting != nil},set:{if !$0{deleting=nil}}),titleVisibility:.visible) {
            Button(String(localized:"删除留白"),role:.destructive) {if let block=deleting {Task{_ = await store.delete(block)}};deleting=nil}
        } message:{Text("原 PDF 不变，留白可从历史中恢复。")}
        .onChange(of:pane.extendedInkTextSelectionEnabled){_,enabled in if !enabled {pane.textSelectionStatus=""}}
        .onChange(of:editing != nil){_,_ in updateInteraction()}
        .onChange(of:resizeGestureActive){_,active in
            if !active, resizing != nil { resizing=nil;resizeOrigin=nil;updateInteraction() }
        }
        .onChange(of:pane.page){_,_ in movingID=nil;inserting=false;pane.extendedInkTextSelectionEnabled=false;updateInteraction()}
        .onDisappear{exportTask?.cancel();resizing=nil;resizeOrigin=nil;movingID=nil;pane.interactionActive=false;pane.extendedInkTextSelectionEnabled=false}
    }
    private var pageBlocks:[PDFExtensionBlock] {
        guard store.sourceSHA256==pane.sourceSHA256 else{return []}
        return store.blocks.filter{$0.page==pane.page}.map {block in resizing?.id==block.id ? resizing! : block}
    }
    private func updateInteraction(){pane.interactionActive=editing != nil || resizing != nil || movingID != nil || exporting}
    private var controls:some View {
        ScrollView(.horizontal,showsIndicators:false) {
            HStack(spacing:8) {
                if pane.extendedInkTextSelectionEnabled {
                    Button(String(localized:"结束选字"),systemImage:"checkmark"){pane.extendedInkTextSelectionEnabled=false}
                        .accessibilityIdentifier("pdfExtend.finishTextSelection")
                }
                if pane.access == .full {
                    Button(inserting ? String(localized:"取消选位置") : String(localized:"在页内留白"),systemImage:"rectangle.badge.plus") {movingID=nil;inserting.toggle();pane.chooseTool(.read);updateInteraction()}.disabled(!editable).accessibilityIdentifier("pdfExtend.insert")
                    Button {Task{await store.undo()}} label:{Image(systemName:"arrow.uturn.backward")}.disabled(!editable || !store.canUndo).accessibilityLabel(String(localized:"撤销留白更改"))
                    Button {Task{await store.redo()}} label:{Image(systemName:"arrow.uturn.forward")}.disabled(!editable || !store.canRedo).accessibilityLabel(String(localized:"重做留白更改"))
                    if selectedID != nil {
                        PDFInkPenMenu(pane:pane,onSelect:{erases=false})
                        Menu {ForEach(["#203E35","#C53732","#1F5DA8","#000000"],id:\.self){value in Button(value){color=value;pane.inkPenSettings.selectedID=nil;erases=false}}} label:{Label(String(localized:"笔颜色"),systemImage:"pencil.tip")}
                        Toggle(String(localized:"橡皮"),isOn:$erases).toggleStyle(.button)
                    }
                }
                if movingID != nil {
                    Button(String(localized:"取消移动")){movingID=nil;updateInteraction()}.accessibilityIdentifier("pdfExtend.cancelMove")
                }
                Button(String(localized:"留白历史"),systemImage:"clock.arrow.circlepath"){pane.extendedInkTextSelectionEnabled=false;history=true}.accessibilityIdentifier("pdfExtend.history")
                Button(String(localized:"刷新留白"),systemImage:"arrow.clockwise"){Task{await store.refresh()}}.disabled(store.busy || store.pending != nil || pane.interactionActive)
                Button(String(localized:"导出整本（含留白与笔记）"),systemImage:"square.and.arrow.up"){startExport(allPages:true)}.disabled(!canExport).accessibilityIdentifier("pdfExtend.exportBook")
                Button(String(localized:"导出当前页（含留白）"),systemImage:"doc.badge.arrow.up"){startExport(allPages:false)}.disabled(!canExport).accessibilityIdentifier("pdfExtend.export")
                Button("100%"){scale=1;initialScale=1}
                Text(movingID != nil ? String(localized:"点正文的新位置，整块留白与内容一起移动。") : inserting ? String(localized:"点正文任意高度，正文和原批注一起让位。") : String(localized:"拖动留白底边调整高度；点移动可重新选择位置。")) .font(.caption).foregroundStyle(.secondary)
            }.buttonStyle(.bordered).frame(minHeight:44).padding(6)
        }
    }
    private var canExport:Bool {!exporting && store.pending == nil && !store.busy && !pane.interactionActive && !pane.isSaving && !pane.hasPendingWrite && !pane.isLoading && !pane.layerReplayActive && pane.document != nil}
    private func startExport(allPages:Bool) {
        guard canExport,store.sourceSHA256==pane.sourceSHA256 else{store.error=PDFWorkspaceError.staleSource.localizedDescription;return}
        guard pane.projection.warnings.isEmpty,store.projection.warnings.isEmpty else{store.error=PDFWorkspaceError.invalidRecord.localizedDescription;return}
        let hash=pane.sourceSHA256,range=allPages ? nil : pane.page...pane.page
        let order=Dictionary(uniqueKeysWithValues:pane.projection.layers.enumerated().map{($0.element.id,$0.offset)})
        let marks=pane.displayedAnnotations.sorted{order[$0.layerID,default:0]<order[$1.layerID,default:0]}
        exportMessage="";store.error="";exporting=true;exportProgress=nil;inserting=false;updateInteraction()
        exportTask=Task {
            defer{exporting=false;exportTask=nil;exportProgress=nil;updateInteraction()}
            do {
                let snapshot=try await store.repository.load()
                try Task.checkCancellation()
                guard snapshot.sourceSHA256==hash else{throw PDFWorkspaceError.staleSource}
                guard snapshot.projection.warnings.isEmpty else{throw PDFWorkspaceError.invalidRecord}
                let blocks=snapshot.projection.current(source:hash).compactMap(\.block)
                let url=try await PDFExtensionExporter.export(sourceSHA256:hash,blocks:blocks,marks:marks,repository:store.repository,pages:range,progress:{exportProgress=$0})
                if Task.isCancelled {PDFExtensionExporter.removeTemporaryExport(url);return}
                clearExport();exported=url;sharing=true
            } catch is CancellationError { }
            catch {store.error=error.localizedDescription}
        }
    }
    private func clearExport() {
        if let exported{PDFExtensionExporter.removeTemporaryExport(exported)}
        exported=nil
        exportMessage=""
    }
    private func place(at y:Double) {
        guard editable,inserting || movingID != nil else{return}
        let block=PDFExtensionBlock.placement(page:pane.page,anchorY:y,movingID:movingID,blocks:store.blocks)
        movingID=nil;inserting=false;updateInteraction()
        guard let block else{return}
        Task{if await store.save(block){selectedID=block.id;pane.pendingExtensionBlockID=block.id}}
    }
    private func beginMoving(_ block:PDFExtensionBlock) {
        selectedID=block.id;inserting=false;movingID=block.id;updateInteraction()
    }
    @ViewBuilder private func note(_ block:PDFExtensionBlock,width:CGFloat,bodyVisible:Bool)->some View {
        VStack(spacing:0) {
            HStack(spacing:6) {
                Button {if bodyVisible {collapsed.insert(block.id);expanded.remove(block.id)} else {collapsed.remove(block.id);expanded.insert(block.id)}} label:{Image(systemName:bodyVisible ? "chevron.up" : "chevron.down").frame(width:44,height:44)}
                    .accessibilityLabel(String(localized:"展开或折叠留白")).accessibilityIdentifier("pdfExtend.toggle."+block.id)
                Text(block.title.isEmpty ? String(localized:"留白笔记") : block.title).font(.headline).lineLimit(2)
                Spacer(minLength:4)
                if pane.access == .full {
                    Button {selectedID=selectedID==block.id ? nil:block.id} label:{Image(systemName:selectedID==block.id ? "pencil.tip.crop.circle.fill":"pencil.tip.crop.circle").frame(width:44,height:44)}.disabled(!editable).accessibilityLabel(String(localized:"在这块留白书写"))
                    Button {beginMoving(block)} label:{Image(systemName:"arrow.up.and.down.and.arrow.left.and.right").frame(width:44,height:44)}
                        .disabled(!editable || resizing != nil).accessibilityLabel(String(localized:"移动留白"))
                        .accessibilityIdentifier("pdfExtend.move."+block.id)
                    Button {movingID=nil;editing=block;updateInteraction()} label:{Image(systemName:"slider.horizontal.3").frame(width:44,height:44)}
                        .disabled(!editable || resizing != nil).accessibilityLabel(String(localized:"调整留白位置与大小"))
                        .accessibilityIdentifier("pdfExtend.adjust."+block.id)
                    Menu {
                        Button(String(localized:"文字、图片与位置")){editing=block}.accessibilityIdentifier("pdfExtend.editor")
                        ForEach(PDFExtensionBlock.Mode.allCases,id:\.self){mode in Button(mode.title){var copy=block;copy.mode=mode;Task{_ = await store.save(copy)}}}
                        if onExcerpt != nil {Button(String(localized:"添加留白摘录节点")){excerpt(block)}.accessibilityIdentifier("pdfExtend.excerpt")}
                        Button(String(localized:"删除留白"),role:.destructive){deleting=block}
                    } label:{Image(systemName:"ellipsis.circle").frame(width:44,height:44)}.disabled(!editable).accessibilityIdentifier("pdfExtend.edit."+block.id)
                }
            }.buttonStyle(.plain).padding(.horizontal,4).frame(minHeight:44).background(Color(uiColor:.secondarySystemBackground))
            .anchorPreference(key:PDFExtensionSelectionExclusions.self,value:.bounds){[$0]}
            .simultaneousGesture(TapGesture().onEnded{pane.extendedInkTextSelectionEnabled=false})
            if bodyVisible {
                ZStack(alignment:.topLeading) {
                    Color(uiColor:.systemBackground)
                    Text(block.text).font(.system(size:max(12,width*0.025))).foregroundStyle(Color.primary).textSelection(.enabled).allowsHitTesting(allowsTextSelection && !unifiedTextSelection).padding(width*0.025).frame(maxWidth:.infinity,alignment:.topLeading)
                    ForEach(block.images){item in PDFExtensionAssetView(image:item,repository:store.repository,allowsTextSelection:allowsTextSelection && !unifiedTextSelection,onContentChange:{selectionImageRevision &+= 1}).frame(width:item.width*width,height:item.height*width).offset(x:item.x*width,y:item.y*width)}
                    PDFExtensionInk(block:block,editable:editable && selectedID==block.id && movingID == nil && resizing == nil,color:color,erases:erases,pen:pane.selectedInkPen,textSelectionRequest:0,allowsTextSelection:allowsTextSelection && !unifiedTextSelection,onSelectionStatus:{pane.textSelectionStatus=$0},onCommit:{strokes in var copy=block;copy.strokes=strokes;Task{_ = await store.save(copy)}},onActive:{active in pane.interactionActive=active;if active {pane.extendedInkTextSelectionEnabled=false}})
                }.frame(width:width,height:block.height*width).clipped()
                .overlay(Rectangle().stroke(selectedID==block.id ? Color.accentColor:Color.secondary.opacity(0.2),lineWidth:selectedID==block.id ? 2:1))
                if pane.access == .full {resizeHandle(block,width:width).anchorPreference(key:PDFExtensionSelectionExclusions.self,value:.bounds){[$0]}}
            }
        }.frame(width:width).accessibilityElement(children:.contain).accessibilityIdentifier("pdfExtend.block."+block.id)
    }
    private func resizeHandle(_ block:PDFExtensionBlock,width:CGFloat)->some View {
        HStack(spacing:8) {
            Image(systemName:"arrow.up.and.down")
            Text(String(localized:"拖动调整高度")).font(.caption)
            Spacer()
            Text(String(format:"%.0f%%",block.height*100)).font(.caption.monospacedDigit())
        }.padding(.horizontal,12).frame(height:44).background(Color.accentColor.opacity(0.09))
        .contentShape(Rectangle())
        .highPriorityGesture(DragGesture(minimumDistance:3,coordinateSpace:.global)
            .updating($resizeGestureActive){_,state,_ in state=true}
            .onChanged{value in
                guard editable,movingID == nil else{return}
                if resizeOrigin == nil {resizeOrigin=block;selectedID=block.id}
                guard let origin=resizeOrigin,origin.id==block.id else{return}
                resizing=origin.resized(to:origin.height+value.translation.height/max(1,width),textMinimum:PDFExtensionTextLayout.minimumHeight(origin.text,width:width))
                updateInteraction()
            }
            .onEnded{value in
                guard editable,movingID == nil else{resizing=nil;resizeOrigin=nil;updateInteraction();return}
                // GestureState can reset before the final callback. Resolve the
                // saved original as a fallback so the final drag is still saved.
                guard let origin=resizeOrigin ?? store.blocks.first(where:{$0.id==block.id}),origin.id==block.id else{return}
                let result=origin.resized(to:origin.height+value.translation.height/max(1,width),textMinimum:PDFExtensionTextLayout.minimumHeight(origin.text,width:width))
                resizing=nil;resizeOrigin=nil;updateInteraction()
                if result != origin {Task{_ = await store.save(result)}}
            })
        .accessibilityElement(children:.ignore)
        .accessibilityLabel(String(localized:"留白高度"))
        .accessibilityValue(String(format:"%.0f%%",block.height*100))
        .accessibilityHint(String(localized:"上下拖动调整；也可打开位置与大小精确调整。"))
        .accessibilityAdjustableAction{direction in
            guard editable else{return}
            let amount:Double=direction == .increment ? 0.05 : -0.05
            let result=block.resized(to:block.height+amount,textMinimum:PDFExtensionTextLayout.minimumHeight(block.text,width:width))
            if result != block {Task{_ = await store.save(result)}}
        }
        .accessibilityIdentifier("pdfExtend.resize."+block.id)
        .opacity(editable ? 1:0.5)
    }
    private func excerpt(_ block:PDFExtensionBlock) {
        guard let root=pane.rootURL else{return};let prefix=root.standardizedFileURL.path+"/",path=pane.sourceURL.standardizedFileURL.path
        guard path.hasPrefix(prefix) else{return}
        let reference=PDFSourceReference(path:String(path.dropFirst(prefix.count)),sourceSHA256:pane.sourceSHA256,page:block.page,rect:.init(x:0,y:min(0.999,block.anchorY),width:1,height:min(0.001,1-block.anchorY == 0 ? 0.001:1-block.anchorY)),quote:block.title+"\n"+block.text,extendBlockID:block.id)
        if reference.isValid,let onExcerpt {excerptBusy=true;Task {let saved=await onExcerpt(reference);excerptBusy=false;if !saved {store.error=String(localized:"摘录未能保存。白板草稿已保留，请回白板重试保存；再点不会重复添加同一摘录。")}}}
    }
}
extension PDFExtensionBlock.Mode {var title:String{switch self{case .inline:String(localized:"嵌入正文");case .margin:String(localized:"放在页边");case .collapsed:String(localized:"收成标题")}}}

private struct PDFExtensionEditor:View {
    @State var block:PDFExtensionBlock
    let store:PDFExtensionStore
    let onClose:()->Void
    @State private var importing=false
    @State private var importError=""
    @State private var working=false
    var body:some View {
        NavigationStack {
            Form {
                Section(String(localized:"留白内容")) {
                    TextField(String(localized:"标题"),text:$block.title).accessibilityIdentifier("pdfExtend.title")
                    TextEditor(text:$block.text).frame(minHeight:160).accessibilityIdentifier("pdfExtend.text")
                    Text("在阅读页点铅笔图标，直接用 Apple Pencil 写在留白上。手指用来浏览。可导出整本或当前页；页边与折叠留白均在锚点展开，并包含可见图层的笔迹。导出生成独立 PDF 副本，原文件不变。").font(.caption).foregroundStyle(.secondary)
                }
                Section(String(localized:"位置与大小")) {
                    Picker(String(localized:"展示方式"),selection:$block.mode){ForEach(PDFExtensionBlock.Mode.allCases,id:\.self){Text($0.title).tag($0)}}
                    LabeledContent(String(localized:"原页高度位置"),value:String(format:"%.1f%%",block.anchorY*100))
                    Slider(value:$block.anchorY,in:0...1).accessibilityIdentifier("pdfExtend.anchor")
                    LabeledContent(String(localized:"留白高度 / 页宽"),value:String(format:"%.2f",block.height))
                    Slider(value:Binding(get:{block.height},set:{block=block.resized(to:$0,textMinimum:PDFExtensionTextLayout.minimumHeight(block.text,width:1000))}),in:min(8,max(block.minimumContentHeight,PDFExtensionTextLayout.minimumHeight(block.text,width:1000)))...8).accessibilityIdentifier("pdfExtend.height")
                    Text("改变高度不会拉伸已有笔迹；不能缩到笔迹或图片范围以内。").font(.caption).foregroundStyle(.secondary)
                }
                Section(String(localized:"图片")) {
                    Button(String(localized:"添加 PNG / JPG 图片"),systemImage:"photo.badge.plus"){importing=true}.disabled(working || block.images.count>=16)
                    ForEach($block.images){$item in
                        VStack(alignment:.leading) {
                            PDFExtensionAssetView(image:item,repository:store.repository).frame(height:100)
                            Text(String(localized:"水平位置"));Slider(value:$item.x,in:0...max(0,1-item.width))
                            Text(String(localized:"垂直位置"));Slider(value:$item.y,in:0...max(0,block.height-item.height))
                            Button(String(localized:"移除图片"),role:.destructive){block.images.removeAll{$0.id==item.id}}
                        }
                    }
                    if !importError.isEmpty {Text(importError).foregroundStyle(.red)}
                }
                if !store.error.isEmpty {Text(store.error).foregroundStyle(.red)}
            }.navigationTitle(String(localized:"编辑留白")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement:.cancellationAction){Button(String(localized:"取消")){onClose()}.disabled(store.pending != nil || working || store.busy)}
                ToolbarItem(placement:.confirmationAction){Button(String(localized:"保存")){Task{working=true;defer{working=false};let textHeight=PDFExtensionTextLayout.minimumHeight(block.text,width:1000)
                    guard textHeight<=8 else{importError=String(localized:"文字超过一块留白的高度，请分成多块保存。");return}
                    block.height=max(block.height,textHeight)
                    let success=store.pending != nil ? await store.retry():await store.save(block);if success{onClose()}}}.disabled(working || store.busy).accessibilityIdentifier("pdfExtend.save")}
            }
            .fileImporter(isPresented:$importing,allowedContentTypes:[.png,.jpeg]) {result in
                guard case let .success(url)=result else{return};Task{await importImage(url)}
            }
        }.interactiveDismissDisabled(store.busy || store.pending != nil || working)
    }
    private func importImage(_ url:URL) async {
        working=true;defer{working=false}
        let scoped=url.startAccessingSecurityScopedResource();defer{if scoped{url.stopAccessingSecurityScopedResource()}}
        do {
            let size=(try url.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? Int.max
            guard size>0,size<=10*1024*1024 else{throw PDFWorkspaceError.tooLarge}
            let data=try Data(contentsOf:url,options:.mappedIfSafe)
            guard let source=CGImageSourceCreateWithData(data as CFData,nil),let p=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],let w=p[kCGImagePropertyPixelWidth] as? Double,let h=p[kCGImagePropertyPixelHeight] as? Double,w>0,h>0,w*h<=16000000 else{throw PDFWorkspaceError.invalidRecord}
            let ext=url.pathExtension.lowercased()=="png" ? "png":"jpg",saved=try await store.repository.saveAsset(data,fileExtension:ext,expectedSHA256:store.sourceSHA256)
            let width=min(0.8,7.5/max(0.001,h/w)),height=width*h/w
            block.height=max(block.height,height+0.05)
            block.images.append(.init(id:UUID().uuidString.lowercased(),resource:saved.0,sha256:saved.1,x:0.025,y:0.025,width:width,height:height));importError=""
        }catch{importError=error.localizedDescription}
    }
}
private struct PDFExtensionHistory:View {
    let store:PDFExtensionStore
    let editable:Bool
    @Environment(\.dismiss) private var dismiss
    var body:some View {
        NavigationStack {
            List {
                Text("历史与并发版本均保留。恢复会新建一条记录，不会覆盖其他设备的原记录。其他 PDF 版本的内容不会自动套用到当前文件。").font(.caption)
                if store.projection.conflictCount>0 {Text(String(localized:"有 \(store.projection.conflictCount) 组并发版本，请逐项核对。"))}
                ForEach(store.events.reversed()) {event in
                    VStack(alignment:.leading,spacing:6) {
                        Text(event.block?.title.isEmpty == false ? event.block!.title : event.kind == .delete ? String(localized:"删除记录"):String(localized:"留白笔记")).font(.headline)
                        Text(event.createdAt).font(.caption.monospaced())
                        if let block=event.block {
                            Text(block.text).lineLimit(6)
                            Text(String(localized:"第 \(block.page) 页 · \(block.strokes.count) 笔 · \(block.images.count) 张图片")).font(.caption)
                            Button(String(localized:"恢复这个版本")){Task{_ = await store.restore(event)}}.buttonStyle(.borderless).disabled(!editable || store.busy || store.pending != nil || event.sourceSHA256 != store.sourceSHA256)
                        }
                    }
                }
            }.navigationTitle(String(localized:"留白历史")).toolbar{Button(String(localized:"关闭")){dismiss()}}
        }
    }
}

private enum PDFExtensionTextLayout {
    static func minimumHeight(_ text:String,width:CGFloat)->Double {
        guard !text.isEmpty else{return 0.12}
        let width=max(1,width)
        let bounds=(text as NSString).boundingRect(with:CGSize(width:width*0.95,height:100000),options:[.usesLineFragmentOrigin,.usesFontLeading],attributes:[.font:UIFont.systemFont(ofSize:max(12,width*0.025))],context:nil)
        return max(0.12,Double(ceil(bounds.height)/width+0.05))
    }
}

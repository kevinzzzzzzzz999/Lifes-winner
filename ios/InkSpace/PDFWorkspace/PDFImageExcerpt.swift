import SwiftUI
import PDFKit

struct PDFImageExcerpt: Identifiable, Sendable {
    let id:UUID
    let reference:PDFSourceReference
    let png:Data
    let pixelWidth:Int
    let pixelHeight:Int
}

@MainActor enum PDFImageExcerptRenderer {
    /// Render the selected region of the rotated crop box directly from PDFKit,
    /// then the same visible overlay projection as the reader. No screen chrome,
    /// hidden layers, previous versions, or unrelated pages are captured.
    static func render(page:PDFPage, reference:PDFSourceReference, marks:[PDFWorkspaceAnnotation], id:UUID = UUID()) throws -> PDFImageExcerpt {
        guard reference.isValid else{throw VisualNoteAssetError.invalid}
        let display=page.bounds(for:.cropBox).applying(page.transform(for:.cropBox)).standardized
        let r=reference.rect,pointSize=CGSize(width:display.width*r.width,height:display.height*r.height)
        guard display.width.isFinite,display.height.isFinite,pointSize.width>=1,pointSize.height>=1 else{throw VisualNoteAssetError.invalid}
        let scale=min(4,2400/max(pointSize.width,pointSize.height),sqrt(4_000_000/(pointSize.width*pointSize.height)))
        let pixels=CGSize(width:max(1,ceil(pointSize.width*scale)),height:max(1,ceil(pointSize.height*scale)))
        let format=UIGraphicsImageRendererFormat();format.scale=1;format.opaque=true
        let image=UIGraphicsImageRenderer(size:pixels,format:format).image { output in
            let context=output.cgContext
            context.setFillColor(UIColor.white.cgColor);context.fill(CGRect(origin:.zero,size:pixels))
            context.scaleBy(x:pixels.width/pointSize.width,y:pixels.height/pointSize.height)
            context.translateBy(x:-r.x*display.width,y:-r.y*display.height)
            context.saveGState();context.translateBy(x:0,y:display.height);context.scaleBy(x:1,y:-1);context.translateBy(x:-display.minX,y:-display.minY)
            page.draw(with:.cropBox,to:context);context.restoreGState()
            let box=CGRect(origin:.zero,size:display.size)
            for mark in marks where mark.page==reference.page && mark.sourceSHA256==reference.sourceSHA256 {
                PDFWorkspacePaintView.drawAnnotation(mark,in:box,context:context)
            }
        }
        guard let png=image.pngData(),png.count<=VisualNoteAssets.maximumImageBytes else{throw VisualNoteAssetError.invalid}
        return PDFImageExcerpt(id:id,reference:reference,png:png,pixelWidth:Int(pixels.width),pixelHeight:Int(pixels.height))
    }
    static func capture(pane:PDFWorkspacePane, rectangle:CGRect) throws -> PDFImageExcerpt {
        guard let view=pane.pdfView,let document=pane.document,view.document === document,let root=pane.rootURL,
              !pane.layerReplayActive,!pane.isLoading,!pane.isSaving,!pane.hasPendingWrite else{throw VisualNoteAssetError.changed}
        let rect=rectangle.standardized.intersection(view.bounds)
        guard rect.width>=8,rect.height>=8,let page=view.page(for:CGPoint(x:rect.midX,y:rect.midY),nearest:false) else{throw VisualNoteAssetError.invalid}
        let pageRect=view.convert(page.bounds(for:.cropBox),from:page).standardized
        guard pageRect.width>0,pageRect.height>0,pageRect.insetBy(dx:-0.5,dy:-0.5).contains(rect) else{throw VisualNoteAssetError.invalid}
        let prefix=root.standardizedFileURL.path+"/",source=pane.sourceURL.standardizedFileURL.path
        guard source.hasPrefix(prefix) else{throw VisualNoteAssetError.invalid}
        let ref=PDFSourceReference(path:String(source.dropFirst(prefix.count)),sourceSHA256:pane.sourceSHA256,page:document.index(for:page)+1,
            rect:.init(x:max(0,(rect.minX-pageRect.minX)/pageRect.width),y:max(0,(rect.minY-pageRect.minY)/pageRect.height),width:min(1,rect.width/pageRect.width),height:min(1,rect.height/pageRect.height)),quote:"")
        let order=Dictionary(uniqueKeysWithValues:pane.projection.layers.enumerated().map{($0.element.id,$0.offset)})
        return try render(page:page,reference:ref,marks:pane.displayedAnnotations.sorted{order[$0.layerID,default:0]<order[$1.layerID,default:0]})
    }
}

@MainActor extension BoardStore {
    func addPDFImageExcerpt(_ excerpt:PDFImageExcerpt) async -> Bool {
        guard !usesPhoneInterface,!isBusy,!reviewModeEnabled,!externalInteractionActive,let root=vaultURL,let target=boardURL,
              let path=relativePath(for:target),excerpt.reference.isValid else {status=String(localized:"请先打开已保存的目标白板，再添加图片摘录。");return false}
        guard !isSaving, !childSessionsHavePendingEdits, !isDirty || document.items.contains(where:{$0.id==excerpt.id && $0.sourceReference==excerpt.reference}) else {
            status=String(localized:"接收白板有未保存的修改，请先回白板保存，再重试图片摘录。");return false
        }
        let boardID=document.id,session=canvasSessionID,reading=isPadReading
        isBusy=true
        defer{isBusy=false;if reading{restoreReadingAfterStudyImport(session:session)}}
        var publication: VisualNoteAssets.PublishedAsset?
        var mayBeReferenced=false
        do {
            let paths=try VisualNoteAssets.excerptPaths(boardPath:path,id:excerpt.id)
            let previous=document.items.first(where:{$0.id==excerpt.id})
            if let previous {
                guard previous.kind == .document,[paths.current,paths.legacy].contains(previous.sourcePath ?? ""),
                      previous.sourceReference==excerpt.reference else{throw VisualNoteAssetError.conflict}
                mayBeReferenced=true
            }
            let published=try await VisualNoteAssets.publish(root:root,boardPath:path,excerpt:excerpt,reusingPath:previous?.sourcePath)
            publication=published
            try Task.checkCancellation()
            let asset=published.path
            guard document.id==boardID,boardURL==target,canvasSessionID==session else{throw VisualNoteAssetError.changed}
            if let existing=document.items.first(where:{$0.id==excerpt.id}) {
                guard existing.kind == .document,existing.sourcePath==asset,existing.sourceReference==excerpt.reference else{throw VisualNoteAssetError.conflict}
                mayBeReferenced=true
            } else {
                isBusy=false;if reading{beginPadEditing()};guard canEditBoardContents else{throw VisualNoteAssetError.changed};isBusy=true
                let width=420.0,height=min(900,max(120,width*Double(excerpt.pixelHeight)/Double(excerpt.pixelWidth)))
                let x=min(max(0,viewportCenter.x),max(0,document.canvasWidth-width)),y=min(max(0,viewportCenter.y),max(0,document.canvasHeight-height))
                // From this point a draft or saved conflict copy may own the
                // image. A failed/uncertain save must retain it for retry.
                mayBeReferenced=true
                addItem(BoardItem(id:excerpt.id,kind:.document,x:x,y:y,width:width,height:height,title:String(localized:"PDF 图片 · 第 \(excerpt.reference.page) 页"),sourcePath:asset,originalSourcePath:excerpt.reference.path,originalSourceSHA256:excerpt.reference.sourceSHA256,page:excerpt.reference.page,sourceReference:excerpt.reference))
            }
            let saved=await save(preservingSourcePDFs:true)
            guard saved else{status=String(localized:"图片与白板草稿已保留，尚未完成保存。请重试；不会重复添加图片节点。");return false}
            if document.id != boardID || boardURL != target {
                status=String(localized:"接收白板已被其他设备修改，图片已保留到冲突副本。请打开保留的白板查看，重新打开 PDF 后再继续摘录。")
            } else {status=String(localized:"图片摘录已保存。打开接收白板，在学习大纲中选择该图片制作卡片。")}
            return true
        } catch{
            // Keep this operation's gate while cleanup awaits file IO. Another
            // import must not acquire and reference the just-published image.
            isBusy=true
            var retainedResource=false
            if let publication,publication.created {
                if !mayBeReferenced,document.id==boardID,boardURL==target,canvasSessionID==session,
                   !document.items.contains(where:{$0.sourcePath==publication.path}) {
                    retainedResource = !(await VisualNoteAssets.discardUnreferenced(publication,root:root))
                } else {retainedResource=true}
            }
            status=error.localizedDescription
            if retainedResource {status += String(localized:" 新图片已保留供重试；没有删除旧资料或覆盖其他文件。")}
            return false
        }
    }
}

/// A focused selection surface above the reader, with a separate item-driven preview.
struct PDFImageExcerptSelection: View {
    @Bindable var pane:PDFWorkspacePane
    let onSave:(PDFImageExcerpt) async -> Bool
    @State private var start:CGPoint?
    @State private var end:CGPoint?
    @State private var preview:PDFImageExcerpt?
    @State private var failure:String?
    private var rectangle:CGRect? {
        guard let start,let end else{return nil}
        return CGRect(x:min(start.x,end.x),y:min(start.y,end.y),width:abs(start.x-end.x),height:abs(start.y-end.y))
    }
    var body:some View {
        GeometryReader { _ in
            Color.clear.contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance:2).onChanged{value in start=value.startLocation;end=value.location;failure=nil}.onEnded{_ in
                    guard let rectangle else{return}
                    do{preview=try PDFImageExcerptRenderer.capture(pane:pane,rectangle:rectangle)}catch{failure=error.localizedDescription}
                }).accessibilityIdentifier("pdfWorkspace.imageExcerpt.selection")
            if let rectangle {Rectangle().stroke(.tint,style:StrokeStyle(lineWidth:2,dash:[6,3])).background(.tint.opacity(0.08)).frame(width:rectangle.width,height:rectangle.height).position(x:rectangle.midX,y:rectangle.midY).allowsHitTesting(false)}
            VStack {
                HStack(alignment:.top) {
                    Text(failure ?? String(localized:"在单个原页内拖出方框，截取图片和当前可见批注。请先调整缩放，再开始框选。"))
                        .font(.callout).fixedSize(horizontal:false,vertical:true)
                    Spacer(minLength:8)
                    Button(String(localized:"取消")){pane.imageExcerptActive=false}.frame(minHeight:44).accessibilityIdentifier("pdfWorkspace.imageExcerpt.cancel")
                }.padding(10).background(.regularMaterial)
                Spacer()
            }
        }.sheet(item:$preview,onDismiss:{start=nil;end=nil}) { excerpt in
            PDFImageExcerptPreview(excerpt:excerpt,onSave:onSave,onClose:{preview=nil},onSaved:{preview=nil;pane.imageExcerptActive=false})
        }
    }
}
private struct PDFImageExcerptPreview:View {
    let excerpt:PDFImageExcerpt
    let onSave:(PDFImageExcerpt) async -> Bool
    let onClose:()->Void
    let onSaved:()->Void
    @State private var busy=false
    @State private var failed=false
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:16) {
                    if let image=UIImage(data:excerpt.png){Image(uiImage:image).resizable().scaledToFit().background(.white).accessibilityIdentifier("pdfWorkspace.imageExcerpt.preview")}
                    Text(String(localized:"包含原 PDF 和当前显示的笔迹、高亮、文字批注；隐藏图层不包含在内。原 PDF 保持不变。"))
                    if failed {Text(String(localized:"未完成保存。已有图片与白板草稿保留；重试使用同一节点，不会重复添加。")) .foregroundStyle(.orange).accessibilityIdentifier("pdfWorkspace.imageExcerpt.error")}
                    Button(failed ? String(localized:"重试保存"):String(localized:"保存图片节点")) {
                        busy=true
                        Task{let saved=await onSave(excerpt);busy=false;failed = !saved;if saved{onSaved()}}
                    }.buttonStyle(.borderedProminent).frame(minHeight:44).disabled(busy).accessibilityIdentifier("pdfWorkspace.imageExcerpt.save")
                    if busy{ProgressView()}
                }.padding()
            }.navigationTitle(String(localized:"图片摘录预览")).navigationBarTitleDisplayMode(.inline)
                .toolbar{ToolbarItem(placement:.cancellationAction){Button(String(localized:"返回框选"),action:onClose).frame(minHeight:44).disabled(busy)}}
        }.interactiveDismissDisabled(busy)
    }
}

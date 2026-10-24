import SwiftUI
import PDFKit
import PencilKit
import ImageIO

/// Each fragment remains vector-backed. CATiledLayer asks only for visible tiles
/// at the active scale; an expanded page is never allocated as one giant bitmap.
struct PDFExtensionFragment: UIViewRepresentable {
    let page:PDFPage
    let start:Double
    let end:Double
    let marks:[PDFWorkspaceAnnotation]
    var futureIDs: Set<UUID> = []
    var allowsTextSelection = true
    let onInsert:((Double)->Void)?
    func makeUIView(context:Context)->PDFExtensionFragmentView { PDFExtensionFragmentView() }
    func updateUIView(_ view:PDFExtensionFragmentView,context:Context) {view.configure(page:page,start:start,end:end,marks:marks,futureIDs:futureIDs,allowsTextSelection:allowsTextSelection,onInsert:onInsert)}
    static func dismantleUIView(_ view:PDFExtensionFragmentView,coordinator:()) {view.stopSelection()}
}
final class PDFExtensionFragmentView:UIView {
    override class var layerClass:AnyClass {CATiledLayer.self}
    private var page:PDFPage?
    private var start=0.0,end=1.0
    private var marks:[PDFWorkspaceAnnotation]=[]
    private var futureIDs: Set<UUID> = []
    private var onInsert:((Double)->Void)?
    private let drawLock=NSRecursiveLock()
    private let selectionID=UUID()
    private var selectionRevision=0
    private var allowsTextSelection=true
    private var textSelection:BoardInlineTextSelection!
    private let selectionScrollLease=InlineTextSelectionScrollLease()
    override init(frame:CGRect) {
        super.init(frame:frame);backgroundColor = .white;isOpaque=true
        let tiles=layer as! CATiledLayer;tiles.tileSize=CGSize(width:512,height:512);tiles.levelsOfDetail=1;tiles.levelsOfDetailBias=4
        let tap=UITapGestureRecognizer(target:self,action:#selector(tapped(_:)));tap.cancelsTouchesInView=false;addGestureRecognizer(tap)
        accessibilityIdentifier="pdfExtend.sourceFragment"
        textSelection=BoardInlineTextSelection(content:self)
        textSelection.capture={ [weak self] key in
            guard let self,self.selectionKey==key,self.selectionVisible,!self.scrollActive(includingTracking:true),!self.textSelection.hasSelection else{return nil}
            let format=UIGraphicsImageRendererFormat();format.scale=key.renderScale;format.opaque=true
            guard format.scale>0 else{return nil}
            return UIGraphicsImageRenderer(size:self.bounds.size,format:format).image{_ in self.draw(self.bounds)}
        }
        textSelection.canInteract={ [weak self] _ in
            guard let self else{return false}
            return self.selectionKey != nil && !self.scrollActive(includingTracking:false)
        }
        textSelection.onSelectionChanged={ [weak self] _ in
            DispatchQueue.main.async { [weak self] in self?.synchronizeSelectionNavigation() }
        }
        textSelection.onStatus={ [weak self] value in self?.accessibilityValue=value.replacingOccurrences(of:"白板",with:"页面") }
    }
    required init?(coder:NSCoder){fatalError()}
    func configure(page:PDFPage,start:Double,end:Double,marks:[PDFWorkspaceAnnotation],futureIDs:Set<UUID>,allowsTextSelection:Bool,onInsert:((Double)->Void)?) {
        drawLock.lock();defer{drawLock.unlock()}
        let changed=self.page !== page || self.start != start || self.end != end || self.marks != marks || self.futureIDs != futureIDs
        self.page=page;self.start=start;self.end=end;self.marks=marks;self.futureIDs=futureIDs;self.onInsert=onInsert
        self.allowsTextSelection=allowsTextSelection
        if changed {selectionRevision &+= 1;layer.setNeedsDisplay()}
        synchronizeSelection()
    }
    override func layoutSubviews(){super.layoutSubviews();synchronizeSelection()}
    override func didMoveToWindow(){super.didMoveToWindow();synchronizeSelection()}
    private var selectionKey:BoardTextSelectionSnapshotKey? {
        guard allowsTextSelection,onInsert==nil,page != nil,window != nil else{return nil}
        return BoardTextSelectionSnapshotKey(sessionID:selectionID,boardID:selectionID,size:bounds.size,offset:.zero,zoom:1,
            documentRevision:selectionRevision,updatedAt:Date(timeIntervalSinceReferenceDate:0),previewEpoch:0,imageRevision:0,renderedRevision:0)
    }
    private var selectionVisible:Bool {
        guard let window else{return false}
        var visible=convert(bounds,to:window).intersection(window.bounds)
        var ancestor=superview
        while let view=ancestor {if view.clipsToBounds {visible=visible.intersection(view.convert(view.bounds,to:window))};ancestor=view.superview}
        return !visible.isNull && !visible.isEmpty
    }
    private func scrollActive(includingTracking:Bool)->Bool {
        var ancestor=superview
        while let view=ancestor {
            if let scroll=view as? UIScrollView,scroll.isDragging || scroll.isDecelerating || scroll.isZooming || (includingTracking && scroll.isTracking){return true}
            if (view.gestureRecognizers ?? []).contains(where:{$0 is UIPinchGestureRecognizer && ($0.state == .began || $0.state == .changed)}) {return true}
            ancestor=view.superview
        }
        return false
    }
    private func synchronizeSelection(){textSelection?.update(selectionKey);synchronizeSelectionNavigation()}
    private func synchronizeSelectionNavigation() {selectionScrollLease.update(selected:textSelection?.hasSelection == true,ancestorsOf:self)}
    func stopSelection(){textSelection.tearDown();selectionScrollLease.release()}
    @objc private func tapped(_ recognizer:UITapGestureRecognizer) {guard bounds.height>0 else{return};onInsert?(start+(end-start)*min(1,max(0,recognizer.location(in:self).y/bounds.height)))}
    override func draw(_ rect:CGRect) {
        drawLock.lock();defer{drawLock.unlock()}
        guard let page,let ctx=UIGraphicsGetCurrentContext(),bounds.width>0,end>start else{return}
        let crop=page.bounds(for:.cropBox),display=crop.applying(page.transform(for:.cropBox)).standardized
        guard display.width>0,display.height>0 else{return}
        let width=bounds.width,height=width*display.height/display.width,offset=start*height
        ctx.setFillColor(UIColor.white.cgColor);ctx.fill(rect)
        ctx.saveGState();ctx.translateBy(x:0,y:height-offset);ctx.scaleBy(x:width/display.width,y:-height/display.height);ctx.translateBy(x:-display.minX,y:-display.minY)
        page.draw(with:.cropBox,to:ctx);ctx.restoreGState()
        ctx.saveGState();ctx.translateBy(x:0,y:-offset)
        PDFExtensionPaint.draw(marks,context:ctx,size:CGSize(width:width,height:height),futureIDs:futureIDs);ctx.restoreGState()
    }
}
enum PDFExtensionPaint {
    static func color(_ value:String)->UIColor {var hex:UInt64=0;Scanner(string:value.replacingOccurrences(of:"#",with:"")).scanHexInt64(&hex);return UIColor(red:CGFloat((hex>>16)&255)/255,green:CGFloat((hex>>8)&255)/255,blue:CGFloat(hex&255)/255,alpha:1)}
    static func draw(_ marks:[PDFWorkspaceAnnotation],context:CGContext,size:CGSize,futureIDs:Set<UUID> = []) {
        for mark in marks {
            let color=color(mark.color),r=mark.rect,rect=CGRect(x:r.x*size.width,y:r.y*size.height,width:r.width*size.width,height:r.height*size.height)
            context.saveGState()
            if futureIDs.contains(mark.id) { context.setAlpha(0.18) }
            switch mark.kind {
            case .ink:
                if PDFNativeInk.paint(mark.nativeInk,width:size.width,context:context) {break}
                context.setStrokeColor(color.cgColor);context.setLineWidth(max(0.5,mark.width*size.width));context.setLineCap(.round);context.setLineJoin(.round)
                for (index,p) in mark.points.enumerated() where p.count==2 {let point=CGPoint(x:p[0]*size.width,y:p[1]*size.height);if index==0 {context.move(to:point)}else{context.addLine(to:point)}};context.strokePath()
            case .highlight: context.setFillColor(color.withAlphaComponent(0.25).cgColor);context.fill(rect)
            case .text:
                context.setFillColor(color.withAlphaComponent(0.1).cgColor);context.fill(rect)
                (mark.text as NSString).draw(in:rect.insetBy(dx:3,dy:3),withAttributes:[.font:UIFont.systemFont(ofSize:max(7,min(30,size.width*0.025))),.foregroundColor:color])
            };context.restoreGState()
        }
    }
}
struct PDFExtensionInk: UIViewRepresentable {
    let block:PDFExtensionBlock
    let editable:Bool
    let color:String
    let erases:Bool
    var pen:SavedPen? = nil
    var textSelectionRequest=0
    var allowsTextSelection=true
    var onSelectionStatus:((String)->Void)?
    let onCommit:([PDFExtensionStroke])->Void
    let onActive:(Bool)->Void
    func makeCoordinator()->Coordinator {Coordinator(self)}
    func makeUIView(context:Context)->PDFExtensionInkHost {
        let host=PDFExtensionInkHost(),view=host.canvas
        // The inserted writing area is light paper regardless of the app chrome.
        view.overrideUserInterfaceStyle = .light
        view.backgroundColor = .clear;view.isOpaque=false;view.isScrollEnabled=false;view.drawingPolicy = .pencilOnly;view.delegate=context.coordinator;view.onLayout={ [weak coordinator=context.coordinator] view in coordinator?.synchronize(view) };return host
    }
    func updateUIView(_ host:PDFExtensionInkHost,context:Context) {
        let view=host.canvas
        context.coordinator.owner=self
        if !context.coordinator.active {
            if erases {view.tool=PKEraserTool(.vector)}
            else if let pen {
                view.tool=PKInkingTool(pen.kind.inkType,color:UIColor(red:pen.red,green:pen.green,blue:pen.blue,alpha:pen.alpha),
                    width:min(pen.kind.maximumWidth,max(pen.kind.minimumWidth,pen.width)))
            } else {view.tool=PKInkingTool(.pen,color:PDFExtensionPaint.color(color),width:2.5)}
        }
        context.coordinator.synchronize(view)
        view.configureTextSelection(request:textSelectionRequest,allowed:allowsTextSelection,editable:editable,onStatus:onSelectionStatus)
    }
    static func dismantleUIView(_ host:PDFExtensionInkHost,coordinator:Coordinator){host.canvas.stopTextSelection()}
    static func drawing(_ strokes:[PDFExtensionStroke],width:CGFloat)->PKDrawing {
        PKDrawing(strokes:strokes.map { stroke in
            if let native=stroke.nativeInk,let restored=PDFNativeInk.drawing(native,width:width),restored.strokes.count==1 {
                return restored.strokes[0]
            }
            let points=stroke.points.enumerated().map { index,p in PKStrokePoint(location:CGPoint(x:p[0]*width,y:p[1]*width),timeOffset:Double(index)*0.01,size:CGSize(width:stroke.width*width,height:stroke.width*width),opacity:1,force:1,azimuth:0,altitude:.pi/2) }
            return PKStroke(ink:PKInk(.pen,color:PDFExtensionPaint.color(stroke.color)),path:PKStrokePath(controlPoints:points,creationDate:Date(timeIntervalSince1970:0)))
        })
    }
    final class Coordinator:NSObject,PKCanvasViewDelegate {
        var owner:PDFExtensionInk;var active=false;var width:CGFloat=0;var last:[PDFExtensionStroke]=[]
        private var awaiting:[PDFExtensionStroke]?
        init(_ owner:PDFExtensionInk){self.owner=owner}
        func synchronize(_ view:PKCanvasView) {
            let next=max(1,view.bounds.width)
            if let awaiting {
                if owner.block.strokes==awaiting {self.awaiting=nil}
                else {return}
            }
            if !active && (last != owner.block.strokes || abs(width-next)>0.5) {
                (view as? PDFExtensionPKCanvas)?.endInkTextSelection()
                width=next;last=owner.block.strokes;view.drawing=PDFExtensionInk.drawing(last,width:next)
            }
        }
        func canvasViewDidBeginUsingTool(_ canvasView:PKCanvasView){active=true;(canvasView as? PDFExtensionPKCanvas)?.endInkTextSelection();owner.onActive(true)}
        func canvasViewDidEndUsingTool(_ canvasView:PKCanvasView) {
            let width=max(1,canvasView.bounds.width),height=owner.block.height
            var failed=false
            let strokes=canvasView.drawing.strokes.map {stroke -> PDFExtensionStroke in
                var r:CGFloat=0,g:CGFloat=0,b:CGFloat=0,a:CGFloat=0;stroke.ink.color.getRed(&r,green:&g,blue:&b,alpha:&a)
                let color=String(format:"#%02X%02X%02X",Int(r*255),Int(g*255),Int(b*255))
                let points=stroke.path.map {point in let p=point.location.applying(stroke.transform);return [min(1,max(0,p.x/width)),min(height,max(0,p.y/width))]}
                let native=PDFNativeInk.archive(PKDrawing(strokes:[stroke]),referenceWidth:width)
                if native==nil {failed=true}
                return PDFExtensionStroke(id:UUID().uuidString.lowercased(),color:color,width:min(0.08,max(0.0001,(stroke.path.first?.size.width ?? 2.5)/width)),points:points,nativeInk:native)
            }
            guard !failed else {
                active=false;owner.onActive(false)
                owner.onSelectionStatus?(String(localized:"这段笔迹过大，暂未保存。请撤销或分成较短的笔画后重试。"));return
            }
            active=false;last=strokes;awaiting=strokes;owner.onActive(false);owner.onCommit(strokes)
        }
    }
}
struct PDFExtensionAssetView:View {
    let image:PDFExtensionImage
    let repository:PDFExtensionRepository
    var allowsTextSelection=true
    var onContentChange:(()->Void)?
    @State private var uiImage:UIImage?
    @State private var failed=false
    var body:some View {
        Group { if let uiImage {PDFExtensionSelectableImage(image:uiImage,allowsTextSelection:allowsTextSelection).id(ObjectIdentifier(uiImage))}
            else if failed {Label(String(localized:"图片尚未下载，刷新重试"),systemImage:"photo.badge.exclamationmark").font(.caption)}
            else {ProgressView()}
        }.task(id:image.sha256) {
            uiImage=nil;failed=false
            do {
                let data=try await repository.readAsset(image)
                let thumbnail=await Task.detached(priority:.userInitiated) { ()->UIImage? in
                    guard let source=CGImageSourceCreateWithData(data as CFData,nil),let cg=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:2048,kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary) else{return nil}
                    return UIImage(cgImage:cg)
                }.value
                try Task.checkCancellation()
                uiImage=thumbnail;failed=thumbnail == nil;onContentChange?()
            }catch is CancellationError {}catch{if !Task.isCancelled {failed=true}}
        }
    }
}

private struct PDFExtensionSelectableImage:View {
    let image:UIImage
    let allowsTextSelection:Bool
    @State private var model=ImageReadingSelectionModel()
    var body:some View {ImageReadingSurface(image:image,model:model,embedded:true,allowsTextSelection:allowsTextSelection)}
}

final class PDFExtensionInkHost:UIView {
    let canvas=PDFExtensionPKCanvas()
    override init(frame:CGRect){super.init(frame:frame);isOpaque=false;addSubview(canvas)}
    required init?(coder:NSCoder){fatalError("init(coder:) has not been implemented")}
    override func layoutSubviews(){super.layoutSubviews();canvas.frame=bounds}
    override func hitTest(_ point:CGPoint,with event:UIEvent?)->UIView? {
        let hit=super.hitTest(point,with:event)
        // The transparent host must preserve the note's existing Text/image hits.
        return hit === self ? nil:hit
    }
}

final class PDFExtensionPKCanvas:PKCanvasView {
    var onLayout:((PKCanvasView)->Void)?
    private let selectionID=UUID()
    private let selectionScrollLease=InlineTextSelectionScrollLease()
    private var inkSelection:BoardInlineTextSelection?
    private let selectionSurface:PDFExtensionInkSelectionSurface = {
        let view=PDFExtensionInkSelectionSurface(frame:.zero)
        view.isOpaque=false;view.isHidden=true;return view
    }()
    private var selectionRect=CGRect.zero
    private var selectionBounds=CGRect.zero
    private var selectionEpoch=0
    private var lastSelectionRequest=0
    private var selectionArmed=false
    private var drawingAllowed=false
    private var selectionAllowed=false
    private var onSelectionStatus:((String)->Void)?

    override func layoutSubviews(){
        super.layoutSubviews();onLayout?(self)
        if selectionArmed && bounds != selectionBounds {endInkTextSelection()}
        selectionSurface.frame=frame
        if selectionArmed {superview?.bringSubviewToFront(selectionSurface)}
    }
    override func didMoveToWindow(){super.didMoveToWindow();if window==nil {endInkTextSelection()}}
    func configureTextSelection(request:Int,allowed:Bool,editable:Bool,onStatus:((String)->Void)?) {
        drawingAllowed=editable;selectionAllowed=allowed;onSelectionStatus=onStatus
        if !allowed {endInkTextSelection()}
        if request != lastSelectionRequest {
            lastSelectionRequest=request
            if request>0 && allowed {beginInkTextSelection()}
            else {endInkTextSelection()}
        }
        synchronizeInput()
    }
    private func synchronizeInput(){
        isUserInteractionEnabled=drawingAllowed
        isDrawingEnabled=drawingAllowed
        drawingGestureRecognizer.isEnabled=drawingAllowed
        selectionSurface.isHidden = !selectionArmed
    }
    private func beginInkTextSelection(){
        guard let superview,let crop=visibleSelectionRect,!drawing.strokes.isEmpty else{return}
        // A sibling keeps PencilKit's private view/gesture hierarchy out of
        // Live Text hits. It exists only over this note's drawing area.
        if selectionSurface.superview !== superview {superview.addSubview(selectionSurface)}
        selectionSurface.frame=frame;superview.bringSubviewToFront(selectionSurface)
        if inkSelection==nil {
            let selection=BoardInlineTextSelection(content:selectionSurface);inkSelection=selection
            selection.analysisContentsRect={ [weak self] in
                guard let self,self.bounds.width>0,self.bounds.height>0 else{return .zero}
                return CGRect(x:(self.selectionRect.minX-self.bounds.minX)/self.bounds.width,y:(self.selectionRect.minY-self.bounds.minY)/self.bounds.height,
                    width:self.selectionRect.width/self.bounds.width,height:self.selectionRect.height/self.bounds.height)
            }
            selection.capture={ [weak self] key in
                guard let self,self.selectionKey==key,!self.navigationActive(includingTracking:true),self.inkSelection?.hasSelection != true else{return nil}
                // This OCR image is composited onto white note paper. Keep the
                // original ink colors when the surrounding interface is dark.
                var paperInk:UIImage?
                UITraitCollection(userInterfaceStyle:.light).performAsCurrent {
                    paperInk=self.drawing.image(from:self.selectionRect,scale:key.renderScale)
                }
                guard let ink=paperInk else{return nil}
                let format=UIGraphicsImageRendererFormat();format.scale=key.renderScale;format.opaque=true
                return UIGraphicsImageRenderer(size:key.size,format:format).image{ context in
                    UIColor.white.setFill();context.fill(CGRect(origin:.zero,size:key.size))
                    ink.draw(in:CGRect(origin:.zero,size:key.size))
                }
            }
            selection.canInteract={ [weak self] point in
                guard let self else{return false}
                let canvasPoint=self.convert(point,from:self.selectionSurface)
                return self.selectionKey != nil && self.selectionRect.contains(canvasPoint) && !self.navigationActive(includingTracking:false)
            }
            selection.onSelectionChanged={ [weak self] _ in
                DispatchQueue.main.async { [weak self] in
                    guard let self else{return}
                    let selected=self.inkSelection?.hasSelection == true
                    self.selectionScrollLease.update(selected:selected,ancestorsOf:self)
                    // UIKit may briefly clear a range while presenting its menu.
                    // Keep the explicit OCR mode armed so the user can reselect.
                }
            }
            selection.onStatus={ [weak self] status in
                DispatchQueue.main.async { [weak self] in
                    guard let self,self.selectionArmed,self.inkSelection?.currentStatus==status else{return}
                    self.onSelectionStatus?(status.replacingOccurrences(of:"白板",with:"留白"))
                }
            }
        }
        selectionEpoch &+= 1;selectionRect=crop;selectionBounds=bounds;selectionArmed=true
        inkSelection?.update(selectionKey);_ = inkSelection?.revealText();synchronizeInput()
    }
    private var selectionKey:BoardTextSelectionSnapshotKey? {
        guard selectionArmed,selectionAllowed,window != nil,
              drawingGestureRecognizer.state != .began,drawingGestureRecognizer.state != .changed else{return nil}
        return BoardTextSelectionSnapshotKey(sessionID:selectionID,boardID:selectionID,size:selectionRect.size,
            offset:selectionRect.origin,zoom:1,documentRevision:selectionEpoch,updatedAt:Date(timeIntervalSinceReferenceDate:0),
            previewEpoch:0,imageRevision:0,renderedRevision:0)
    }
    private var visibleSelectionRect:CGRect? {
        guard let window else{return nil}
        var visible=bounds.intersection(convert(window.bounds,from:window))
        var ancestor=superview
        while let view=ancestor {
            if view.isHidden || view.alpha<=0 {return nil}
            if view.clipsToBounds {visible=visible.intersection(convert(view.bounds,from:view))}
            ancestor=view.superview
        }
        return !visible.isNull && visible.width>=8 && visible.height>=8 ? visible:nil
    }
    private func navigationActive(includingTracking:Bool)->Bool {
        if drawingGestureRecognizer.state == .began || drawingGestureRecognizer.state == .changed {return true}
        var ancestor: UIView?=self
        while let view=ancestor {
            if let scroll=view as? UIScrollView,scroll.isDragging || scroll.isDecelerating || scroll.isZooming || (includingTracking && scroll.isTracking) {return true}
            if (view.gestureRecognizers ?? []).contains(where:{$0 is UIPinchGestureRecognizer && ($0.state == .began || $0.state == .changed)}) {return true}
            ancestor=view.superview
        }
        return false
    }
    func endInkTextSelection(){
        selectionArmed=false;inkSelection?.update(nil);selectionScrollLease.release();synchronizeInput()
    }
    func stopTextSelection(){endInkTextSelection();inkSelection?.tearDown();inkSelection=nil;selectionSurface.removeFromSuperview();onSelectionStatus=nil}
    override func hitTest(_ point:CGPoint,with event:UIEvent?)->UIView? {
        // The separate Live Text surface handles fingers during selection.
        // Otherwise the canvas passes them through to note text/images.
        if !selectionArmed,let touches=event?.allTouches,!touches.isEmpty,touches.allSatisfy({$0.type != .pencil}) {return nil}
        return super.hitTest(point,with:event)
    }
}

private final class PDFExtensionInkSelectionSurface:UIView {
    override func hitTest(_ point:CGPoint,with event:UIEvent?)->UIView? {
        // A Pencil still reaches the original drawing view; beginning a stroke
        // ends selection through its existing PKCanvasViewDelegate callback.
        if event?.allTouches?.contains(where:{$0.type == .pencil}) == true {return nil}
        return super.hitTest(point,with:event)
    }
}

/// Toolbar labels are excluded using actual laid-out frames, never the export
/// geometry: on-screen headers and resize controls have fixed point heights.
struct PDFExtensionSelectionExclusions: PreferenceKey {
    static var defaultValue: [Anchor<CGRect>] { [] }
    static func reduce(value: inout [Anchor<CGRect>], nextValue: () -> [Anchor<CGRect>]) { value += nextValue() }
}
struct PDFExtensionSelectionRevision: Equatable {
    let page: Int
    let source: String
    let blocks: [PDFExtensionBlock]
    let marks: [PDFWorkspaceAnnotation]
    let futureIDs: Set<UUID>
    let expanded: Set<String>
    let collapsed: Set<String>
    let imageRevision: Int
}
struct PDFExtensionContinuousSelection: UIViewRepresentable {
    let active: Bool
    let request: Int
    let revision: PDFExtensionSelectionRevision
    let excluded: [CGRect]
    let onStatus: (String) -> Void
    let onPencil: () -> Void
    func makeUIView(context: Context) -> PDFExtensionContinuousSelectionView { PDFExtensionContinuousSelectionView() }
    func updateUIView(_ view: PDFExtensionContinuousSelectionView, context: Context) {
        view.onStatus = onStatus; view.onPencil = onPencil
        view.configure(active: active, request: request, revision: revision, excluded: excluded)
    }
    static func dismantleUIView(_ view: PDFExtensionContinuousSelectionView, coordinator: ()) { view.tearDown() }
}

/// A single, transparent Live Text interaction spans the *visible* reading
/// composition. The existing tiled PDF, ink and images still provide the display.
/// Only a bounded viewport is analyzed after settling; no whole-book bitmap exists.
@MainActor final class PDFExtensionContinuousSelectionView: UIView {
    private let identity = UUID()
    private var selection: BoardInlineTextSelection!
    private let scrollLease = InlineTextSelectionScrollLease()
    private var timer: Timer?
    private var active = false
    private var suspended = false
    private var request = 0
    private var revision: PDFExtensionSelectionRevision?
    private var revisionNumber = 0
    private var excluded: [CGRect] = []
    private var key: BoardTextSelectionSnapshotKey?
    private var crop = CGRect.zero
    private var layoutSize = CGSize.zero
    private var snapshotFailures = 0
    private var snapshotFailedKey: BoardTextSelectionSnapshotKey?
    private var stopped = false
    var onStatus: ((String) -> Void)?
    var onPencil: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear; isOpaque = false
        accessibilityIdentifier = "pdfExtend.continuousTextSelection"
        selection = BoardInlineTextSelection(content: self)
        selection.analysisContentsRect = { [weak self] in
            guard let self, self.bounds.width > 0, self.bounds.height > 0 else { return .zero }
            return CGRect(x:self.crop.minX/self.bounds.width,y:self.crop.minY/self.bounds.height,
                          width:self.crop.width/self.bounds.width,height:self.crop.height/self.bounds.height)
        }
        selection.capture = { [weak self] candidate in self?.snapshot(for: candidate) }
        selection.canInteract = { [weak self] point in
            guard let self else { return false }
            return self.active && !self.suspended && self.key != nil && self.crop.contains(point)
                && !self.excluded.contains(where:{$0.contains(point)}) && !self.navigationActive(includingTracking:false)
        }
        selection.onSelectionChanged = { [weak self] selected in
            guard let self else { return }
            self.scrollLease.update(selected:selected,ancestorsOf:self)
        }
        selection.onStatus = { [weak self] value in
            // UIKit callbacks must not mutate the SwiftUI reader during its update.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active, !self.stopped, self.snapshotFailedKey == nil, value == self.selection.currentStatus else { return }
                let status=value.replacingOccurrences(of:"白板",with:"页面")
                self.accessibilityValue=status; self.onStatus?(status)
            }
        }
        NotificationCenter.default.addObserver(self,selector:#selector(backgrounded),name:UIApplication.willResignActiveNotification,object:nil)
        NotificationCenter.default.addObserver(self,selector:#selector(foregrounded),name:UIApplication.didBecomeActiveNotification,object:nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func configure(active: Bool, request: Int, revision: PDFExtensionSelectionRevision, excluded: [CGRect]) {
        guard !stopped else { return }
        if self.revision != revision || self.excluded != excluded || self.request != request {
            self.revision=revision;self.excluded=excluded;self.request=request;revisionNumber &+= 1
        }
        self.active=active
        synchronizeTimer(); refreshGeometry()
    }
    override func didMoveToWindow() { super.didMoveToWindow(); synchronizeTimer(); refreshGeometry() }
    override func layoutSubviews() { super.layoutSubviews(); refreshGeometry() }
    private var readingScroll: UIScrollView? {
        var ancestor=superview
        while let view=ancestor { if let scroll=view as? UIScrollView {return scroll};ancestor=view.superview }
        return nil
    }
    private func synchronizeTimer() {
        guard active, window != nil, !suspended, !stopped else {timer?.invalidate();timer=nil;return}
        guard timer == nil else {return}
        // Geometry changes while scrolling do not necessarily lay out the overlay.
        // The timer performs no OCR or rendering and exists only in selection mode.
        let next=Timer(timeInterval:0.2,repeats:true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshGeometry() }
        }
        RunLoop.main.add(next,forMode:.common);timer=next
    }
    private func visibleCrop() -> CGRect {
        guard let window else {return .zero}
        var visible=convert(bounds,to:window).intersection(window.bounds)
        var ancestor=superview
        while let view=ancestor {
            if view.clipsToBounds {visible=visible.intersection(view.convert(view.bounds,to:window))}
            ancestor=view.superview
        }
        guard !visible.isNull,!visible.isEmpty else{return .zero}
        // Whole point boundaries prevent subpixel layout noise from restarting OCR.
        let local=convert(visible,from:window).intersection(bounds)
        return CGRect(x:ceil(local.minX),y:ceil(local.minY),width:max(0,floor(local.maxX)-ceil(local.minX)),height:max(0,floor(local.maxY)-ceil(local.minY)))
    }
    private func navigationActive(includingTracking: Bool) -> Bool {
        var ancestor=superview
        while let view=ancestor {
            if let scroll=view as? UIScrollView,scroll.isDragging || scroll.isDecelerating || scroll.isZooming || (includingTracking && scroll.isTracking) {return true}
            if (view.gestureRecognizers ?? []).contains(where:{$0 is UIPinchGestureRecognizer && ($0.state == .began || $0.state == .changed)}) {return true}
            ancestor=view.superview
        }
        return false
    }
    private func refreshGeometry() {
        guard !stopped else {return}
        if layoutSize != bounds.size {layoutSize=bounds.size;revisionNumber &+= 1}
        let visible=visibleCrop()
        let next:BoardTextSelectionSnapshotKey?
        if active,!suspended,window?.windowScene?.activationState == .foregroundActive,readingScroll != nil,!navigationActive(includingTracking:false) {
            let candidate=BoardTextSelectionSnapshotKey(sessionID:identity,boardID:identity,size:visible.size,offset:visible.origin,zoom:1,
                documentRevision:revisionNumber,updatedAt:Date(timeIntervalSinceReferenceDate:0),previewEpoch:0,imageRevision:0,renderedRevision:0)
            next=candidate.isValid ? candidate:nil
        } else {next=nil}
        crop=visible
        guard next != key else {return}
        key=next;snapshotFailures=0;snapshotFailedKey=nil;selection.update(next);scrollLease.release()
        if next != nil {_ = selection.revealText()}
    }
    private func snapshot(for candidate: BoardTextSelectionSnapshotKey) -> UIImage? {
        guard active,!suspended,key == candidate,snapshotFailedKey != candidate,!selection.hasSelection,!navigationActive(includingTracking:true),
              let scroll=readingScroll,visibleCrop() == crop,crop.size == candidate.size else {return nil}
        // Capture only this reader's scroll subtree; dialogs, AI panels and other
        // windows can never enter the recognition image. The crop stays in the
        // overlay's coordinate system when supplied back to VisionKit.
        let visibleInScroll=convert(crop,to:scroll)
        let format=UIGraphicsImageRendererFormat();format.scale=candidate.renderScale;format.opaque=true
        guard format.scale>0 else {return nil}
        var drew=false
        let image=UIGraphicsImageRenderer(size:crop.size,format:format).image { renderer in
            UIColor.white.setFill();renderer.fill(CGRect(origin:.zero,size:crop.size))
            renderer.cgContext.saveGState()
            renderer.cgContext.translateBy(x:-visibleInScroll.minX,y:-visibleInScroll.minY)
            drew=scroll.drawHierarchy(in:scroll.bounds,afterScreenUpdates:false)
            renderer.cgContext.restoreGState()
            UIColor.white.setFill()
            for rect in excluded {
                let hidden=rect.intersection(crop)
                if !hidden.isNull {renderer.fill(hidden.offsetBy(dx:-crop.minX,dy:-crop.minY))}
            }
        }
        if drew {snapshotFailures=0;return image}
        snapshotFailures += 1
        if snapshotFailures >= 4 {
            snapshotFailedKey=candidate;selection.update(nil);scrollLease.release()
            let failure=String(localized:"当前页面暂时无法选字，请点“选择文字”重试。")
            accessibilityValue=failure
            DispatchQueue.main.async { [weak self] in
                guard let self,self.active,self.snapshotFailedKey == candidate else{return}
                self.onStatus?(failure)
            }
        }
        return nil
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard active,!suspended,!stopped,!excluded.contains(where:{$0.contains(point)}) else {return nil}
        if event?.allTouches?.contains(where:{$0.type == .pencil}) == true {
            // Pencil always reaches the actual canvas. Also end the selection if
            // the user touches an unselected blank note or original PDF fragment.
            active=false;refreshGeometry();synchronizeTimer()
            DispatchQueue.main.async { [weak self] in self?.onPencil?() }
            return nil
        }
        return super.hitTest(point,with:event)
    }
    @objc private func backgrounded() {suspended=true;synchronizeTimer();refreshGeometry()}
    @objc private func foregrounded() {suspended=false;synchronizeTimer();refreshGeometry()}
    func tearDown() {
        stopped=true;timer?.invalidate();timer=nil;selection.tearDown();scrollLease.release()
        NotificationCenter.default.removeObserver(self);onStatus=nil;onPencil=nil
    }
    deinit { timer?.invalidate();NotificationCenter.default.removeObserver(self) }
}

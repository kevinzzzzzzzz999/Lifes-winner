import Foundation
import PDFKit

@MainActor extension PDFWorkspacePane {
    func selectedSourceReference() -> PDFSourceReference? {
        guard let rootURL,let view=pdfView,let selection=view.currentSelection,let selectedPage=selection.pages.first,
              let document,!sourceSHA256.isEmpty else { error=String(localized:"请先在原页长按选择文字，再添加摘录节点。");return nil }
        guard selection.pages.count==1 else { error=String(localized:"请按页创建摘录，跨页文字可分别关联到对应原页。");return nil }
        let root=rootURL.standardizedFileURL.path+"/",source=sourceURL.standardizedFileURL.path
        guard source.hasPrefix(root) else{return nil}
        let box=selectedPage.bounds(for:.cropBox),transform=selectedPage.transform(for:.cropBox)
        let display=box.applying(transform).standardized,bounds=selection.bounds(for:selectedPage).applying(transform).standardized.intersection(display)
        guard !bounds.isNull,display.width>0,display.height>0 else{return nil}
        let rect=PDFSourceReference.Rect(x:(bounds.minX-display.minX)/display.width,y:(display.maxY-bounds.maxY)/display.height,width:bounds.width/display.width,height:bounds.height/display.height)
        let value=PDFSourceReference(path:String(source.dropFirst(root.count)),sourceSHA256:sourceSHA256,page:document.index(for:selectedPage)+1,rect:rect,quote:selection.string ?? "")
        guard value.isValid else {error=String(localized:"所选内容过大或位置不可用，请缩小摘录范围。");return nil};return value
    }
    func locateSourceReference(_ reference:PDFSourceReference) {
        guard reference.isValid,reference.sourceSHA256==sourceSHA256 else {error=String(localized:"原文件版本已更改，保留摘录但不自动定位旧范围。");return}
        navigate(to:reference.page)
        if let blockID=reference.extendBlockID {
            guard extensionStore.sourceSHA256==sourceSHA256,
                  extensionStore.blocks.contains(where:{$0.id==blockID && $0.page==reference.page}) else {
                error=String(localized:"对应留白当前不可用，可在留白历史中查看；原文页仍可阅读。")
                return
            }
            pendingSourceReference=nil
            pendingExtensionBlockID=blockID
            extensionMode=true
            return
        }
        pendingExtensionBlockID=nil
        extensionMode=false
        guard let page=document?.page(at:reference.page-1),let view=pdfView,view.document === document else{pendingSourceReference=reference;return}
        pendingSourceReference=nil
        let display=page.bounds(for:.cropBox).applying(page.transform(for:.cropBox)).standardized,r=reference.rect
        let box=CGRect(x:display.minX+r.x*display.width,y:display.maxY-(r.y+r.height)*display.height,width:r.width*display.width,height:r.height*display.height).applying(page.transform(for:.cropBox).inverted())
        view.go(to:box,on:page)
    }
}

@MainActor extension BoardStore {
    @discardableResult func addPDFExcerpt(_ reference:PDFSourceReference) async -> Bool {
        guard reference.isValid,boardURL != nil,vaultURL != nil,!usesPhoneInterface,!isBusy,!reviewModeEnabled,!externalInteractionActive else {status=String(localized:"请先结束当前操作，再添加摘录节点。");return false}
        let wasReading=isPadReading
        if wasReading {beginPadEditing()}
        guard canEditBoardContents else {status=String(localized:"暂时不能添加摘录，请稍后重试。");return false}
        let quote=reference.quote.isEmpty ? String(localized:"PDF 摘录") : reference.quote
        let x=min(max(0,viewportCenter.x),max(0,document.canvasWidth-420)),y=min(max(0,viewportCenter.y),max(0,document.canvasHeight-240))
        let item=BoardItem(kind:.text,x:x,y:y,width:420,height:240,title:String(quote.prefix(80)),text:quote,sourcePath:reference.path,page:reference.page,sourceReference:reference)
        if !document.items.contains(where:{$0.sourceReference==reference}) {addItem(item)}
        let saved=await save()
        if wasReading,saved {_ = await beginPadReading()}
        if saved {status=String(localized:"摘录节点已添加，可从节点返回原文。")} 
        return saved
    }
}

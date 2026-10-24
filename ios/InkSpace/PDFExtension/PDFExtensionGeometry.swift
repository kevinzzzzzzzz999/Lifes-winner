import Foundation
import CoreGraphics

struct PDFExtensionSlice: Identifiable, Equatable {
    enum Kind:Equatable {case original(Double,Double), note(String)}
    var id:String;var y:Double;var height:Double;var kind:Kind
}
enum PDFExtensionGeometry {
    /// Heights and offsets are page-width units; origin is the displayed page top.
    static func slices(pageAspect:Double,blocks:[PDFExtensionBlock],expanded:Set<String>=[]) -> [PDFExtensionSlice] {
        guard pageAspect.isFinite,pageAspect>0,pageAspect<100 else{return []}
        let rows=blocks.sorted{a,b in a.anchorY != b.anchorY ? a.anchorY<b.anchorY : a.orderKey != b.orderKey ? a.orderKey<b.orderKey : a.id<b.id}
        var output:[PDFExtensionSlice]=[],source=0.0,y=0.0
        for block in rows {
            let anchor=min(1,max(0,block.anchorY))
            if anchor>source {let height=(anchor-source)*pageAspect;output.append(.init(id:"slice-\(source)-\(anchor)",y:y,height:height,kind:.original(source,anchor)));y+=height;source=anchor}
            let full=block.mode == .inline || expanded.contains(block.id)
            let height=full ? block.height+0.10 : 0.10
            output.append(.init(id:block.id,y:y,height:height,kind:.note(block.id)));y+=height
        }
        if source<1 {output.append(.init(id:"slice-\(source)-1",y:y,height:(1-source)*pageAspect,kind:.original(source,1)))}
        return output
    }
    static func originalY(displayY:Double,pageAspect:Double,slices:[PDFExtensionSlice])->Double? {
        for row in slices where displayY>=row.y && displayY<=row.y+row.height {
            if case let .original(start,_)=row.kind{return min(1,max(0,start+(displayY-row.y)/pageAspect))}
        };return nil
    }
}

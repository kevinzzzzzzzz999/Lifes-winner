import Foundation
import AppKit
import PencilKit

struct InkFailure: Error { let code: String; init(_ code: String = "INK_TRANSFORM_FAILED") { self.code = code } }
struct InkRect: Codable {
 var x: Double; var y: Double; var width: Double; var height: Double
 var cg: CGRect { CGRect(x:x,y:y,width:width,height:height) }
 init(_ r: CGRect) { x=r.minX;y=r.minY;width=r.width;height=r.height }
 func valid(in world: Double) -> Bool { [x,y,width,height].allSatisfy(\.isFinite) && x>=0 && y>=0 && width>0 && height>0 && x+width<=world && y+height<=world }
}
struct InkItem: Decodable {
 let id: String; let kind: String; var x: Double; var y: Double; var width: Double; var height: Double; let inkData: Data?
 var rect: CGRect { CGRect(x:x,y:y,width:width,height:height) }
}
struct InkBoard: Decodable { let canvasWidth: Double; let canvasHeight: Double; let drawing: Data?; let items: [InkItem]; let webInk: ExistingWebInk? }
struct ExistingWebInk: Decodable { let strokes: [IgnoredStroke] }
struct IgnoredStroke: Decodable {}
struct InkPatch: Codable { let id:String; var x:Double?; var y:Double?; var width:Double?; var height:Double?; var inkData:Data? }
struct InkOperation: Decodable { let kind:String; let ids:[String]?; let dx:Double?; let dy:Double?; let rect:InkRect?; let title:String?; let items:[InkPatch]?; let sourceBoard:InkBoard?; let portablePreview:Bool? }
struct InkRequest: Decodable { let board:InkBoard; let operation:InkOperation }
struct NewInkItem: Encodable { let id:String; let kind="inkGroup"; let x:Double;let y:Double;let width:Double;let height:Double;let title:String;let inkData:Data }
struct NativeWebStroke: Encodable { let points:[[Double]];let color:String;let opacity:Double;let startedAt:Double?;let duration:Double?;let clipPath:[[Double]]? }
struct NativeWebInk: Encodable { let version=1;var strokes:[NativeWebStroke]=[] }
struct InkOutput: Encodable {
 var drawing:Data?;var webInk:NativeWebInk?;var itemUpdates:[InkPatch]=[];var newItems:[NewInkItem]=[];var removedIDs:[String]=[];var selectedIDs:[String]=[];var warning:String?;var checked:Bool?;var lastInkLocation:InkRect?;var importedStrokeCount:Int?;var importedControlPointCount:Int?;var importedBounds:InkRect?;var importTranslation:[Double]?;var contentBounds:InkRect?;var nativeStrokeCount:Int?;var nativeControlPointCount:Int?
 enum CodingKeys:String,CodingKey {case drawing,webInk,itemUpdates,newItems,removedIDs,selectedIDs,warning,checked,lastInkLocation,importedStrokeCount,importedControlPointCount,importedBounds,importTranslation,contentBounds,nativeStrokeCount,nativeControlPointCount}
 func encode(to encoder:Encoder)throws{var c=encoder.container(keyedBy:CodingKeys.self);try c.encode(drawing,forKey:.drawing);try c.encode(webInk,forKey:.webInk);try c.encode(itemUpdates,forKey:.itemUpdates);try c.encode(newItems,forKey:.newItems);try c.encode(removedIDs,forKey:.removedIDs);try c.encode(selectedIDs,forKey:.selectedIDs);try c.encodeIfPresent(warning,forKey:.warning);try c.encodeIfPresent(checked,forKey:.checked);try c.encode(lastInkLocation,forKey:.lastInkLocation);try c.encodeIfPresent(importedStrokeCount,forKey:.importedStrokeCount);try c.encodeIfPresent(importedControlPointCount,forKey:.importedControlPointCount);try c.encodeIfPresent(importedBounds,forKey:.importedBounds);try c.encodeIfPresent(importTranslation,forKey:.importTranslation);try c.encodeIfPresent(contentBounds,forKey:.contentBounds);try c.encodeIfPresent(nativeStrokeCount,forKey:.nativeStrokeCount);try c.encodeIfPresent(nativeControlPointCount,forKey:.nativeControlPointCount)}
}

enum NativeInkCore {
 static let maximumDrawingBytes=40*1024*1024, maximumStrokes=50_000,maximumControlPoints=1_000_000
 static func decode(_ bytes:Data?)throws->PKDrawing {
  guard let bytes else {return PKDrawing()}
  guard bytes.count<=maximumDrawingBytes else {throw InkFailure("TOO_LARGE")}
  do {let drawing=try PKDrawing(data:bytes);try validate(drawing);return drawing}catch let error as InkFailure{throw error}catch{throw InkFailure()}
 }
 static func validate(_ drawing:PKDrawing)throws {
  guard drawing.strokes.count<=maximumStrokes else {throw InkFailure("TOO_LARGE")}
  var total=0
  for stroke in drawing.strokes {
   total+=stroke.path.count;guard total<=maximumControlPoints else {throw InkFailure("TOO_LARGE")}
   let b=stroke.renderBounds
   guard [b.minX,b.minY,b.width,b.height,stroke.transform.a,stroke.transform.b,stroke.transform.c,stroke.transform.d,stroke.transform.tx,stroke.transform.ty].allSatisfy(\.isFinite) else {throw InkFailure()}
  }
 }
 static func apply(_ request:InkRequest)throws->InkOutput {
  let board=request.board,op=request.operation,world=board.canvasWidth
  if op.kind=="mergeBounds" || op.kind=="mergeDrawing" {return try merge(request)}
  guard [1_000_000.0,8_000_000.0].contains(world),world==board.canvasHeight,board.items.count<=20_000,Set(board.items.map(\.id)).count==board.items.count else{throw InkFailure("INVALID_BOARD")}
  for item in board.items {guard UUID(uuidString:item.id) != nil,InkRect(item.rect).valid(in:world) else{throw InkFailure("INVALID_BOARD")}}
  // A browser-only preview is not sufficient to reconstruct editable PencilKit ink.
  guard board.drawing != nil || (board.webInk?.strokes.isEmpty ?? true) else{throw InkFailure()}
  var drawing=try decode(board.drawing),groups:[String:PKDrawing]=[:],items=board.items
  for item in items where item.kind=="inkGroup" {if let data=item.inkData {groups[item.id]=try decode(data)}}
  var output=InkOutput(drawing:board.drawing),changedDrawing=false
  let ids=Set(op.ids ?? [])
  if ["move","unpackInk","collapseCheck"].contains(op.kind) {guard !ids.isEmpty,ids.count==(op.ids?.count ?? 0),ids.allSatisfy({id in items.contains{$0.id==id}}) else{throw InkFailure("INVALID_REQUEST")}}
  switch op.kind {
  case "importDrawing":
   guard items.isEmpty,groups.isEmpty,board.drawing != nil else{throw InkFailure("INVALID_REQUEST")}
   // Imported attachment geometry must share the very same translation as ink.
   // No per-object fitting or scaling: that would detach notes from source pages.
   if let rect=op.rect {guard rect.valid(in:world) else{throw InkFailure("INVALID_REQUEST")}}
   let bounds=op.rect.map{drawing.strokes.isEmpty ? $0.cg : drawing.bounds.union($0.cg)} ?? drawing.bounds
   let empty=drawing.strokes.isEmpty && op.rect == nil
   let dx=empty ? 0 : 512-bounds.minX,dy=empty ? 0 : 512-bounds.minY
   guard dx.isFinite,dy.isFinite else{throw InkFailure()}
   drawing=drawing.transformed(using:CGAffineTransform(translationX:dx,y:dy));try validate(drawing)
   if !drawing.strokes.isEmpty {guard InkRect(drawing.bounds).valid(in:world) else{throw InkFailure("INK_CROSSES_BOUNDARY")}}
   output.drawing=drawing.dataRepresentation();output.webInk=makeWebInk(drawing.strokes)
   guard output.webInk != nil else{throw InkFailure("TOO_LARGE")}
   output.importedStrokeCount=drawing.strokes.count;output.importedControlPointCount=drawing.strokes.reduce(0){$0+$1.path.count}
   if !drawing.strokes.isEmpty {output.importedBounds=InkRect(drawing.bounds)}
   output.importTranslation=[dx,dy];output.lastInkLocation=latestInkLocation(drawing.strokes,world:world)
   return output
  case "lastInkLocation":
   output.drawing=nil
   let worldDrawing=try worldDrawing(drawing:drawing,items:items,groups:groups)
   output.lastInkLocation=latestInkLocation(worldDrawing.strokes,world:world)
   return output
  case "frameInk":
   guard let rect=op.rect,rect.valid(in:world),op.title.map({$0.utf16.count<=1000 && !$0.contains("\0")}) ?? true else{throw InkFailure("INVALID_REQUEST")}
   let selected=drawing.strokes.filter{rect.cg.contains($0.renderBounds)}
   guard !selected.isEmpty else{throw InkFailure("NO_INK_SELECTED")}
   let bounds=selected.reduce(CGRect.null){$0.union($1.renderBounds)}.insetBy(dx:-16,dy:-16)
   let nodeRect=CGRect(x:bounds.minX,y:bounds.minY,width:max(80,bounds.width),height:max(60,bounds.height))
   // Native clamps a near-zero padded origin; refusing this rare boundary avoids
   // silently shifting ink while keeping identical normal-region normalization.
   guard InkRect(nodeRect).valid(in:world) else{throw InkFailure("INK_CROSSES_BOUNDARY")}
   let normalized=PKDrawing(strokes:selected).transformed(using:CGAffineTransform(translationX:-bounds.minX,y:-bounds.minY))
   let id=UUID().uuidString,data=normalized.dataRepresentation()
   drawing=PKDrawing(strokes:drawing.strokes.filter{!rect.cg.contains($0.renderBounds)});changedDrawing=true
   output.newItems=[NewInkItem(id:id,x:nodeRect.minX,y:nodeRect.minY,width:nodeRect.width,height:nodeRect.height,title:op.title ?? "Handwriting Node",inkData:data)];output.selectedIDs=[id]
   items.append(InkItem(id:id,kind:"inkGroup",x:nodeRect.minX,y:nodeRect.minY,width:nodeRect.width,height:nodeRect.height,inkData:data));groups[id]=normalized
  case "unpackInk":
   var restored=drawing.strokes
   for item in items where ids.contains(item.id) {guard item.kind=="inkGroup",let group=groups[item.id] else{throw InkFailure()};restored += group.transformed(using:CGAffineTransform(translationX:item.x,y:item.y)).strokes}
   drawing=PKDrawing(strokes:restored);changedDrawing=true;output.removedIDs=items.filter{ids.contains($0.id)}.map(\.id)
   items.removeAll{ids.contains($0.id)};for id in ids{groups.removeValue(forKey:id)}
  case "move","patchItems":
   var patches:[InkPatch]
   if op.kind=="move" {guard let dx=op.dx,let dy=op.dy,dx.isFinite,dy.isFinite else{throw InkFailure("INVALID_REQUEST")};patches=items.filter{ids.contains($0.id)}.map{InkPatch(id:$0.id,x:$0.x+dx,y:$0.y+dy)}}
   else {guard let edits=op.items,!edits.isEmpty,edits.count<=20_000,Set(edits.map(\.id)).count==edits.count else{throw InkFailure("INVALID_REQUEST")};patches=edits}
   var next=items,changedIDs=Set<String>(),pageChanges:[(InkItem,InkItem)]=[]
   for patch in patches {
    guard patch.inkData==nil,let index=items.firstIndex(where:{$0.id==patch.id}) else{throw InkFailure("INVALID_REQUEST")}
    let old=items[index];var value=old
    value.x=patch.x ?? old.x;value.y=patch.y ?? old.y;value.width=patch.width ?? old.width;value.height=patch.height ?? old.height
    guard InkRect(value.rect).valid(in:world) else{throw InkFailure("INK_CROSSES_BOUNDARY")}
    if value.rect != old.rect {changedIDs.insert(old.id);if old.kind=="pdfPage"{pageChanges.append((old,value))}}
    next[index]=value
   }
   let unchangedPages=items.filter{$0.kind=="pdfPage" && !changedIDs.contains($0.id)}
   var strokes:[PKStroke]=[],movedStrokeIndexes=Set<Int>(),movedStrokeOwners:[Int:String]=[:]
   for (index,stroke) in drawing.strokes.enumerated() {
    let candidates=pageChanges.filter{$0.0.rect.intersects(stroke.renderBounds)}
    if candidates.isEmpty{strokes.append(stroke);continue}
    guard candidates.count==1,let candidate=candidates.first,candidate.0.rect.contains(stroke.renderBounds),!unchangedPages.contains(where:{$0.rect.intersects(stroke.renderBounds)}) else{throw InkFailure("INK_CROSSES_BOUNDARY")}
    let converted=PKDrawing(strokes:[stroke]).transformed(using:transform(from:candidate.0.rect,to:candidate.1.rect)).strokes
    guard converted.count==1,candidate.1.rect.insetBy(dx:-0.5,dy:-0.5).contains(converted[0].renderBounds) else{throw InkFailure("INK_CROSSES_BOUNDARY")}
    strokes.append(converted[0]);movedStrokeIndexes.insert(index);movedStrokeOwners[index]=candidate.0.id
   }
   // Destination overlap would give the transformed ink more than one PDF owner.
   for (index,owner) in movedStrokeOwners {
    if next.contains(where:{$0.kind=="pdfPage" && $0.id != owner && $0.rect.intersects(strokes[index].renderBounds)}) {throw InkFailure("INK_CROSSES_BOUNDARY")}
   }
   for (old,new) in pageChanges {
    for (index,stroke) in drawing.strokes.enumerated() where !movedStrokeIndexes.contains(index) {if new.rect.intersects(stroke.renderBounds){throw InkFailure("INK_CROSSES_BOUNDARY")}}
    for item in items where item.kind=="inkGroup" && !changedIDs.contains(item.id) {
     if let group=groups[item.id] {let bounds=group.transformed(using:CGAffineTransform(translationX:item.x,y:item.y)).bounds;if old.rect.intersects(bounds)||new.rect.intersects(bounds){throw InkFailure("INK_CROSSES_BOUNDARY")}}
    }
   }
   for (index,item) in items.enumerated() where changedIDs.contains(item.id) {
    let new=next[index];var patch=InkPatch(id:item.id,x:new.x,y:new.y,width:new.width,height:new.height)
    if item.kind=="inkGroup",let group=groups[item.id],new.width != item.width || new.height != item.height {
     let scaled=group.transformed(using:CGAffineTransform(scaleX:new.width/item.width,y:new.height/item.height));groups[item.id]=scaled;patch.inkData=scaled.dataRepresentation()
    }
    output.itemUpdates.append(patch)
   }
   if !movedStrokeIndexes.isEmpty {drawing=PKDrawing(strokes:strokes);changedDrawing=true}
   items=next;output.selectedIDs=patches.map(\.id)
  case "collapseCheck":
   let pages=items.filter{ids.contains($0.id)}
   guard pages.allSatisfy({$0.kind=="pdfPage"}) else{throw InkFailure("INVALID_REQUEST")}
   let all=try worldDrawing(drawing:drawing,items:items,groups:groups)
   if pages.contains(where:{page in all.strokes.contains{page.rect.intersects($0.renderBounds)}}){throw InkFailure("COLLAPSE_HAS_CONTENT")}
   output.checked=true
  default:throw InkFailure("INVALID_REQUEST")
  }
  try validate(drawing)
  if changedDrawing {output.drawing=drawing.dataRepresentation()}
  let worldDrawing=try worldDrawing(drawing:drawing,items:items,groups:groups)
  output.lastInkLocation=latestInkLocation(worldDrawing.strokes,world:world)
  output.webInk=makeWebInk(worldDrawing.strokes)
  if output.webInk==nil {output.warning="WEB_INK_PREVIEW_LIMIT"}
  return output
 }
 // Whole-board merging never reconstructs PKStroke paths or masks. Translate
 // complete drawings, retaining pressure, dates, erasures and fill masks.
 static func mergeParts(_ board:InkBoard)throws->(PKDrawing,PKDrawing) {
  let world=board.canvasWidth
  guard [1_000_000.0,8_000_000.0].contains(world),world==board.canvasHeight,board.items.count<=20_000,
   Set(board.items.map{$0.id.lowercased()}).count==board.items.count else{throw InkFailure("INVALID_BOARD")}
  for item in board.items {guard UUID(uuidString:item.id) != nil,InkRect(item.rect).valid(in:world) else{throw InkFailure("INVALID_BOARD")}}
  let drawing=try decode(board.drawing)
  var groups:[String:PKDrawing]=[:]
  for item in board.items where item.kind=="inkGroup" {if let bytes=item.inkData {groups[item.id]=try decode(bytes)}}
  let all=try worldDrawing(drawing:drawing,items:board.items,groups:groups)
  if !all.strokes.isEmpty {guard InkRect(all.bounds).valid(in:world) else{throw InkFailure("INK_CROSSES_BOUNDARY")}}
  return(drawing,all)
 }
 static func merge(_ request:InkRequest)throws->InkOutput {
  let (main,all)=try mergeParts(request.board)
  var result=InkOutput(drawing:nil)
  if request.operation.kind=="mergeBounds" {
   if !all.strokes.isEmpty {result.contentBounds=InkRect(all.bounds)}
   result.nativeStrokeCount=all.strokes.count;result.nativeControlPointCount=all.strokes.reduce(0){$0+$1.path.count}
   return result
  }
  guard let source=request.operation.sourceBoard,let dx=request.operation.dx,let dy=request.operation.dy,
   dx.isFinite,dy.isFinite else{throw InkFailure("INVALID_REQUEST")}
  let (sourceMain,sourceAll)=try mergeParts(source)
  let transform=CGAffineTransform(translationX:dx,y:dy)
  let moved=sourceAll.transformed(using:transform)
  if !moved.strokes.isEmpty {guard InkRect(moved.bounds).valid(in:request.board.canvasWidth) else{throw InkFailure("INK_CROSSES_BOUNDARY")}}
  let combined=PKDrawing(strokes:main.strokes+sourceMain.transformed(using:transform).strokes)
  let combinedAll=PKDrawing(strokes:all.strokes+moved.strokes)
  try validate(combined);try validate(combinedAll)
  let bytes=combined.dataRepresentation();guard bytes.count<=maximumDrawingBytes else{throw InkFailure("TOO_LARGE")}
  result.drawing=bytes
  if request.operation.portablePreview != false {
   result.webInk=makeWebInk(combinedAll.strokes)
   guard result.webInk != nil else{throw InkFailure("TOO_LARGE")}
  }
  if !combinedAll.strokes.isEmpty {result.contentBounds=InkRect(combinedAll.bounds)}
  result.nativeStrokeCount=combinedAll.strokes.count;result.nativeControlPointCount=combinedAll.strokes.reduce(0){$0+$1.path.count}
  result.lastInkLocation=latestInkLocation(combinedAll.strokes,world:request.board.canvasWidth)
  return result
 }
 // PKStroke.renderBounds already includes its transform; worldDrawing adds the
 // ink group's world translation. Masked-out and fully transparent strokes do
 // not supply a navigation target. Equal dates choose the later stable entry.
 static func latestInkLocation(_ strokes:[PKStroke],world:Double)->InkRect? {
  let canvas=CGRect(x:0,y:0,width:world,height:world)
  var newest:Date?,result:InkRect?
  for stroke in strokes {
   guard !stroke.path.isEmpty,stroke.path.creationDate.timeIntervalSince1970.isFinite,
    stroke.mask==nil || !stroke.maskedPathRanges.isEmpty,
    (stroke.ink.color.usingColorSpace(.sRGB)?.alphaComponent ?? 0)>0,
    stroke.path.contains(where:{$0.opacity>0}) else {continue}
   let bounds=stroke.renderBounds.intersection(canvas)
   guard !bounds.isNull,!bounds.isInfinite,bounds.width>0,bounds.height>0,
    [bounds.minX,bounds.minY,bounds.width,bounds.height].allSatisfy(\.isFinite),
    newest==nil || stroke.path.creationDate>=newest! else{continue}
   let width=max(1,bounds.width),height=max(1,bounds.height)
   let rect=CGRect(x:min(world-width,max(0,bounds.midX-width/2)),y:min(world-height,max(0,bounds.midY-height/2)),width:width,height:height)
   if InkRect(rect).valid(in:world){newest=stroke.path.creationDate;result=InkRect(rect)}
  }
  return result
 }
 static func transform(from old:CGRect,to new:CGRect)->CGAffineTransform {let sx=new.width/old.width,sy=new.height/old.height;return CGAffineTransform(a:sx,b:0,c:0,d:sy,tx:new.minX-old.minX*sx,ty:new.minY-old.minY*sy)}
 static func worldDrawing(drawing:PKDrawing,items:[InkItem],groups:[String:PKDrawing])throws->PKDrawing {
  var strokes=drawing.strokes
  for item in items where item.kind=="inkGroup" {if let group=groups[item.id]{strokes += group.transformed(using:CGAffineTransform(translationX:item.x,y:item.y)).strokes}}
  let world=PKDrawing(strokes:strokes);try validate(world);return world
 }
 static func makeWebInk(_ strokes:[PKStroke])->NativeWebInk? {
  for spacing in [2.0,4,8,16,32] {if let result=sample(strokes,spacing:spacing){return result}}
  return nil
 }
 static func needsPortableMask(_ stroke:PKStroke)->Bool {
  // The writing-aid fill factory emits exactly this native paint-strip shape.
  // Native serialization may normalize monoline to pen, so inkType alone does
  // not identify a saved fill. Preserve ordinary eraser sampling unless the
  // three equal-width collinear control points form the paint strip. Mask-only
  // moveto elements and erasures must not affect identification of that strip.
  guard stroke.mask != nil,stroke.path.count==3 else{return false}
  let p=Array(stroke.path),dx=p[2].location.x-p[0].location.x,dy=p[2].location.y-p[0].location.y
  let span=hypot(dx,dy),widths=p.map{($0.size.width+$0.size.height)/2}
  guard span.isFinite,span>0,widths.allSatisfy({$0.isFinite && $0>0}) else{return false}
  let tolerance=max(0.5,(widths.max() ?? 0)*0.001)
  let distance=abs(dx*(p[1].location.y-p[0].location.y)-dy*(p[1].location.x-p[0].location.x))/span
  return distance<=0.5 && (widths.max()! - widths.min()!)<=tolerance
 }
 // Portable, world-space nonzero clipping. Do not reduce a two-dimensional mask
 // to maskedPathRanges: wide paint strips and partially erased strokes require
 // the complete boundary. Empty paths intentionally hide the entire stroke.
 static func portableMask(_ mask:NSBezierPath,transform:CGAffineTransform)->[[Double]]? {
  guard mask.elementCount<=10_000 else{return nil}
  var commands:[[Double]]=[]
  for index in 0..<mask.elementCount {
   var points=[NSPoint](repeating:.zero,count:3)
   let element=mask.element(at:index,associatedPoints:&points)
   let opcode:Double,count:Int
   switch element.rawValue {
   case 0:opcode=0;count=1 // move
   case 1:opcode=1;count=1 // line
   case 2:opcode=3;count=3 // cubic; also named curveTo on macOS 13
   case 3:opcode=4;count=0 // close
   case 4:opcode=2;count=2 // quadratic (macOS 14+)
   default:return nil
   }
   if index==0 && opcode != 0{return nil}
   var command=[opcode]
   for point in points.prefix(count) {
    let world=point.applying(transform)
    guard world.x.isFinite,world.y.isFinite,abs(world.x)<=8_000_000,abs(world.y)<=8_000_000 else{return nil}
    command += [Double(world.x),Double(world.y)]
   }
   commands.append(command)
  }
  return commands
 }
 static func sample(_ strokes:[PKStroke],spacing:Double)->NativeWebInk? {
  var result=NativeWebInk(),total=0,totalClipCommands=0
  for stroke in strokes where !stroke.path.isEmpty {
   guard let color=stroke.ink.color.usingColorSpace(.sRGB) else{return nil}
   let hex=String(format:"#%02X%02X%02X",Int(min(1,max(0,color.redComponent))*255),Int(min(1,max(0,color.greenComponent))*255),Int(min(1,max(0,color.blueComponent))*255))
   let scale=sqrt(abs(stroke.transform.a*stroke.transform.d-stroke.transform.b*stroke.transform.c))
   let clip:[[Double]]?
   if needsPortableMask(stroke),let mask=stroke.mask {
    guard let value=portableMask(mask,transform:stroke.transform) else{return nil}
    totalClipCommands+=value.count;guard totalClipCommands<=100_000 else{return nil}
    clip=value
   }else{clip=nil}
   let ranges=clip != nil || stroke.mask==nil ? [0...CGFloat(stroke.path.count-1)] : stroke.maskedPathRanges
   for range in ranges {
    var points:[[Double]]=[],opacity:CGFloat=0,firstTime:Double?=nil,lastTime:Double?=nil
    for point in stroke.path.interpolatedPoints(in:range,by:.distance(spacing)) {
     let p=point.location.applying(stroke.transform),width=max(0.01,(point.size.width+point.size.height)*0.5*scale)
     guard [p.x,p.y,width,point.opacity].allSatisfy(\.isFinite),abs(p.x)<=8_000_000,abs(p.y)<=8_000_000,width<=10_000 else{return nil}
     points.append([p.x,p.y,width]);opacity+=point.opacity;total+=1
     if firstTime==nil {firstTime=point.timeOffset};lastTime=point.timeOffset
     guard total<=1_000_000,points.count<=50_000 else{return nil}
    }
    guard !points.isEmpty else{continue}
    let start=stroke.path.creationDate.timeIntervalSince1970+(firstTime ?? 0),duration=max(0,(lastTime ?? 0)-(firstTime ?? 0))
    let normalizedOpacity=Double(min(1,max(0,color.alphaComponent*opacity/CGFloat(points.count))))
    result.strokes.append(NativeWebStroke(points:points,color:hex,opacity:normalizedOpacity,startedAt:start.isFinite&&start>=0 ? start:nil,duration:duration.isFinite ? duration:nil,clipPath:clip))
    guard result.strokes.count<=50_000 else{return nil}
   }
  }
  return result
 }
}

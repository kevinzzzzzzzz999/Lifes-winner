import Foundation
import AppKit
import PencilKit

@main struct NativeInkMergeTests {
 static func stroke(_ index:Int,mask:NSBezierPath?=nil)->PKStroke {
  let x=1000+Double(index)*2
  let points=[PKStrokePoint(location:CGPoint(x:x,y:1000),timeOffset:0,size:CGSize(width:3,height:3),opacity:1,force:0.6,azimuth:0.3,altitude:1),PKStrokePoint(location:CGPoint(x:x+1,y:1003),timeOffset:0.2,size:CGSize(width:5,height:5),opacity:0.8,force:0.9,azimuth:0.4,altitude:1)]
  return PKStroke(ink:PKInk(.pen,color:.black),path:PKStrokePath(controlPoints:points,creationDate:Date(timeIntervalSince1970:1700000000+Double(index))),transform:.identity,mask:mask)
 }
 static func request(_ board:[String:Any],_ op:[String:Any])throws->InkRequest {try JSONDecoder().decode(InkRequest.self,from:JSONSerialization.data(withJSONObject:["board":board,"operation":op]))}
 static func board(_ drawing:PKDrawing,items:[[String:Any]]=[])->[String:Any] {["canvasWidth":8000000,"canvasHeight":8000000,"drawing":drawing.dataRepresentation().base64EncodedString(),"items":items]}
 static func main()throws {
  let mask=NSBezierPath(rect:CGRect(x:999,y:999,width:5,height:7))
  let target=PKDrawing(strokes:[stroke(0,mask:mask)]),source=PKDrawing(strokes:(1...2908).map{stroke($0)}),group=PKDrawing(strokes:[stroke(2)])
  let groupID=UUID().uuidString,groupData=group.dataRepresentation()
  let sourceBoard=board(source,items:[["id":groupID,"kind":"inkGroup","x":30000,"y":30000,"width":2000,"height":2000,"inkData":groupData.base64EncodedString()]])
  let originalSource=source.dataRepresentation(),stats=try NativeInkCore.apply(request(sourceBoard,["kind":"mergeBounds"]))
  precondition(stats.nativeStrokeCount==2909 && stats.contentBounds != nil)
  let output=try NativeInkCore.apply(request(board(target),["kind":"mergeDrawing","sourceBoard":sourceBoard,"dx":200,"dy":400]))
  let combined=try PKDrawing(data:output.drawing!)
  precondition(combined.strokes.count==2909 && output.nativeStrokeCount==2910)
  precondition(combined.strokes[0].mask != nil)
  precondition(combined.strokes[0].path.creationDate==target.strokes[0].path.creationDate)
  precondition(combined.strokes[1].path.creationDate==source.strokes[0].path.creationDate)
  let moved=combined.strokes[1].path[0].location.applying(combined.strokes[1].transform)
  precondition(abs(moved.x-1202)<0.01 && abs(moved.y-1400)<0.01)
  precondition(abs(combined.strokes[1].path[0].force-source.strokes[0].path[0].force)<0.001)
  precondition(output.webInk?.strokes.count==2910 && output.lastInkLocation != nil)
  let noPreview=try NativeInkCore.apply(request(board(target),["kind":"mergeDrawing","sourceBoard":sourceBoard,"dx":200,"dy":400,"portablePreview":false]))
  precondition(noPreview.webInk==nil && noPreview.nativeStrokeCount==2910)
  let noPreviewDrawing=try PKDrawing(data:noPreview.drawing!)
  precondition(noPreviewDrawing.strokes.count==2909)
  precondition(source.dataRepresentation()==originalSource && group.dataRepresentation()==groupData)
  do {_ = try NativeInkCore.apply(request(board(target),["kind":"mergeDrawing","sourceBoard":sourceBoard,"dx":8000000,"dy":0]));preconditionFailure("Out-of-canvas merge accepted")}catch let failure as InkFailure {precondition(failure.code=="INK_CROSSES_BOUNDARY")}
  print("NATIVE_MERGE_OK main=2909 total=2910 masks/pressure/dates/groups/translation preserved; invalid placement refused")
 }
}

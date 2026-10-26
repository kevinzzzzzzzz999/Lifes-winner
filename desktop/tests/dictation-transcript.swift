import Foundation
@main struct TranscriptChecks {
 static func main() throws {
  var count=0
  func check(_ condition:Bool,_ message:String){precondition(condition,message);count+=1}
  func part(_ a:Double,_ b:Double,_ t:String)->DictationTranscript.TimedText{.init(start:a,end:b,text:t)}
  var progressive=DictationTranscript();progressive.receive(start:0,end:2,text:"喂喂喂喂",final:false);progressive.receive(start:0,end:2,text:"喂喂喂，记一下",final:true);check(progressive.text=="喂喂喂，记一下","new final replaces old guess, no forced repeated word")
  var repeated=DictationTranscript();for n in 0..<3 {repeated.receive(start:Double(n),end:Double(n+1),text:"喂",final:true)};check(repeated.text=="喂喂喂","time-distinct equal words are never string-deduplicated")
  var partial=DictationTranscript();partial.receive(start:0,end:2,text:"喂喂",final:false,pieces:[part(0,1,"喂"),part(1,2,"喂")]);partial.receive(start:1,end:3,text:"喂，记一下",final:false,pieces:[part(1,2,"喂，"),part(2,3,"记一下")]);check(partial.text=="喂喂，记一下","partial replacement retains outside prefix")
  var finalized=DictationTranscript();finalized.receive(start:0,end:2,text:"前词旧猜测",final:false,finalizationTime:1,pieces:[part(0,1,"前词"),part(1,2,"旧猜测")]);finalized.receive(start:1,end:3,text:"新结果",final:true,finalizationTime:3,pieces:[part(1,3,"新结果")]);check(finalized.text=="前词新结果","finalization advances without repeated final prefix result")
  partial.receive(start:1,end:3,text:"",final:false);check(partial.text=="喂","empty volatile text legitimately retracts its own range")
  let before=finalized.text;check(!finalized.receive(start:0,end:1,text:"",final:false)&&finalized.text==before,"out-of-contract final overlap is reported without erasing final")
  var unknown=DictationTranscript();unknown.receive(start:0,end:2,text:"不能按时间比例切字",final:false);check(!unknown.receive(start:1,end:3,text:"新文本",final:false)&&unknown.text=="不能按时间比例切字","ambiguous missing word times never silently drops outside text")
  var mixed=DictationTranscript();mixed.receive(start:0,end:2,text:"喂喂喂，记",final:false);check(!mixed.receive(start:1,end:3,text:"记一下",final:true,pieces:[part(1,2,"记"),part(2,3,"一下")])&&mixed.text=="喂喂喂，记","new word times do not authorize deleting an unsplittable old prefix")
  var adjacent=DictationTranscript();adjacent.receive(start:0,end:0.00001,text:"A",final:true);adjacent.receive(start:0.00001,end:0.00002,text:"B",final:true);check(adjacent.text=="AB","valid tiny adjacent ranges do not collapse")
  var punctuation=DictationTranscript();punctuation.receive(start:0,end:2,text:"喂，记",final:true,pieces:[part(0,1,"喂"),part(1,1,"，"),part(1,2,"记")]);check(punctuation.text=="喂，记","zero-duration punctuation preserves ordering")
  check(!punctuation.receive(start:Double.nan,end:2,text:"bad",final:false),"invalid range rejected")
  let gate=DictationAudioReadiness(startedAt:0);check(!gate.timedOut(at:4.9)&&gate.timedOut(at:5),"no frames has a bounded deadline");check(gate.receivedFrame(at:1) && !gate.receivedFrame(at:2),"only the first real frame signals ready");check(!gate.timedOut(at:6)&&gate.timedOut(at:7),"frame stall watchdog follows last received frame");gate.invalidate();check(!gate.receivedFrame(at:8) && !gate.timedOut(at:99),"late cancelled frame cannot revive readiness")
  var narrower=DictationTranscript()
  check(narrower.receive(start:0,end:11.1,text:"喂喂喂，记一下",final:false,pieces:[part(0,11.1,"喂喂喂，记一下")]),"broad actual Apple provisional accepted")
  check(narrower.receive(start:0,end:8.16,text:"喂喂喂，记一下",final:true,finalizationTime:8.16,pieces:[part(0,0.18,"喂"),part(0.18,0.78,"喂喂"),part(0.87,1.74,"，记一下")])&&narrower.text=="喂喂喂，记一下","shorter final range retires same-left provisional silence tail")
  check(!mixed.receive(start:1,end:3,text:"记一下",final:false)&&mixed.rejectionReason=="volatile-boundary"&&mixed.text=="喂喂喂，记","ambiguous provisional stays safe and may defer")
  check(mixed.receive(start:0,end:3,text:"喂喂喂，记一下",final:true,pieces:[part(0,1,"喂喂喂，"),part(1,3,"记一下")])&&mixed.text=="喂喂喂，记一下","later complete final recovers deferred hypothesis without word guessing")
  check(!mixed.receive(start:0,end:1,text:"擦掉前文",final:true)&&mixed.rejectionReason=="final-overlap"&&mixed.text=="喂喂喂，记一下","conflicting final keeps all confirmed text for explicit review")
  if CommandLine.arguments.count>1 {
   let value=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
   var replay=DictationTranscript()
   for raw in value["rawSegments"] as! [[String:Any]] {let pieces=(raw["parts"] as! [[String:Any]]).map{part($0["start"] as! Double,$0["end"] as! Double,$0["text"] as! String)};check(replay.receive(start:raw["start"] as! Double,end:raw["end"] as! Double,text:raw["text"] as! String,final:raw["isFinal"] as! Bool,finalizationTime:raw["finalizationTime"] as? Double,pieces:pieces),"actual synthetic progressive trace is accepted")}
   check(replay.text==value["text"] as! String,"actual native progressive raw trace reproduces exactly without swallowed repeated words")
  }
  print("PASS \(count) transcript/readiness checks")
 }
}

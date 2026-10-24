import Foundation
import Observation

@MainActor @Observable final class PDFExtensionStore {
    let repository:PDFExtensionRepository
    private(set) var sourceSHA256=""
    private(set) var projection=PDFExtensionProjection(heads:[],warnings:[])
    private(set) var events:[PDFExtensionEvent]=[]
    private(set) var busy=false
    var error=""
    var pending:PDFExtensionEvent?
    private var pendingHistory:((PDFExtensionBlock?,String,String?),Int)?
    private var undoEvents:[(PDFExtensionBlock?,String,String?)]=[]
    private var redoEvents:[(PDFExtensionBlock?,String,String?)]=[]
    private let deviceID:String
    init(rootURL:URL?,sourceURL:URL) {
        repository=PDFExtensionRepository(rootURL:rootURL,sourceURL:sourceURL)
        let key="pdfExtension.deviceID54"
        if let id=UserDefaults.standard.string(forKey:key) {deviceID=id}
        else { let id=UUID().uuidString.lowercased();UserDefaults.standard.set(id,forKey:key);deviceID=id }
    }
    var canUndo:Bool { !undoEvents.isEmpty && !busy && pending == nil }
    var canRedo:Bool { !redoEvents.isEmpty && !busy && pending == nil }
    var current:[PDFExtensionEvent] { projection.current(source:sourceSHA256) }
    var blocks:[PDFExtensionBlock] { current.compactMap(\.block) }
    var oldVersionCount:Int { projection.heads.filter{$0.sourceSHA256 != sourceSHA256}.count }
    func refresh() async {
        guard !busy,pending == nil else{return};busy=true;defer{busy=false}
        do { apply(try await repository.load());error="" } catch { self.error=error.localizedDescription }
    }
    private func apply(_ snapshot:PDFExtensionSnapshot) { sourceSHA256=snapshot.sourceSHA256;events=snapshot.records;projection=snapshot.projection }
    @discardableResult func save(_ block:PDFExtensionBlock) async -> Bool { await change(block,target:block.id,route:0) }
    @discardableResult func delete(_ block:PDFExtensionBlock) async -> Bool { await change(nil,target:block.id,route:0) }
    @discardableResult func restore(_ event:PDFExtensionEvent) async -> Bool {
        guard let block=event.block,event.sourceSHA256==sourceSHA256 else{return false};return await change(block,target:block.id,route:0)
    }
    private func change(_ block:PDFExtensionBlock?,target:String,route:Int,expectedBase:String?=nil) async -> Bool {
        guard !busy,pending == nil,!sourceSHA256.isEmpty else{return false}
        let prior=current.first{$0.targetID==target}
        // Undo must not silently overwrite a remotely revised head.
        if route != 0, prior?.id != expectedBase { error=String(localized:"该留白已在其他设备更改，原撤销记录保留，请刷新后查看历史。");return false }
        let event=PDFExtensionEvent.make(block,target:target,source:sourceSHA256,base:prior?.id,device:deviceID)
        do { _=try PDFExtensionEvent.decodeValidated(event.encoded()) } catch {self.error=error.localizedDescription;return false}
        pending=event;pendingHistory=((prior?.block,target,Optional(event.id)),route)
        return await retry()
    }
    @discardableResult func retry() async -> Bool {
        guard let pending,!busy else{return false};busy=true;defer{busy=false}
        do {apply(try await repository.publish([pending],expectedSHA256:sourceSHA256));self.pending=nil
            if let (inverse,route)=pendingHistory {
                if route==0 {undoEvents.append(inverse);redoEvents=[]}
                else if route==1 {if !undoEvents.isEmpty {undoEvents.removeLast()};redoEvents.append(inverse)}
                else {if !redoEvents.isEmpty {redoEvents.removeLast()};undoEvents.append(inverse)}
            };pendingHistory=nil;error="";return true}
        catch {self.error=error.localizedDescription;return false}
    }
    func undo() async {if let value=undoEvents.last {_=await change(value.0,target:value.1,route:1,expectedBase:value.2)}}
    func redo() async {if let value=redoEvents.last {_=await change(value.0,target:value.1,route:2,expectedBase:value.2)}}
}

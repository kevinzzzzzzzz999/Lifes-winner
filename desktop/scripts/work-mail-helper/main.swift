import Foundation
import AppKit
import UserNotifications

private struct Command:Decodable,Sendable {
 let id:String;let operation:String
 var provider:String?;var address:String?;var password:String?;var accountID:String?;var beforeSequence:Int?;var uidValidity:String?;var uid:String?;var specs:[WorkNotificationSpec]?
}
private struct Reply<Value:Encodable>:Encodable {let id:String;let ok:Bool;let value:Value}
private struct Failure:Encodable {let code:String;let message:String}
private struct FailedReply:Encodable {let id:String;let ok:Bool;let error:Failure}
private struct Empty:Encodable,Sendable {let disconnected:Bool}
private actor Output {
 func value<T:Encodable&Sendable>(_ id:String,_ value:T) {do{let bytes=try JSONEncoder().encode(Reply(id:id,ok:true,value:value));FileHandle.standardOutput.write(bytes);FileHandle.standardOutput.write(Data([10]));}catch{self.error(id,"MAIL_FAILED","The mail operation did not finish.")}}
 func error(_ id:String,_ code:String,_ message:String) {if let bytes=try? JSONEncoder().encode(FailedReply(id:id,ok:false,error:.init(code:code,message:message))){FileHandle.standardOutput.write(bytes);FileHandle.standardOutput.write(Data([10]));}}
}
private actor Requests {
 let mail:WorkMailClient;let output=Output();private var jobs:[String:Task<Void,Never>]=[:]
 init(directory:URL){mail=WorkMailClient(directory:directory)}
 func receive(_ line:String) async {
  guard let data=line.data(using:.utf8),data.count<=2097152,let raw=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{return}
  if raw["operation"] as? String == "cancel",let target=raw["target"] as? String,UUID(uuidString:target) != nil {jobs[target]?.cancel();return}
  guard let id=raw["id"] as? String,UUID(uuidString:id) != nil else{return}
  guard Set(raw.keys).isSubset(of:["id","operation","provider","address","password","accountID","beforeSequence","uidValidity","uid","specs"]),let command=try? JSONDecoder().decode(Command.self,from:data),jobs[id]==nil else {await output.error(id,"MAIL_INVALID_REQUEST","The mail request is invalid.");return}
  jobs[id]=Task{await self.execute(command);self.finish(id)}
 }
 private func finish(_ id:String){jobs.removeValue(forKey:id)}
 private func execute(_ c:Command) async {
  do{try Task.checkCancellation()
   switch c.operation {
   case "accounts":await output.value(c.id,try await mail.accounts())
   case "connect":guard let provider=c.provider,let address=c.address,let password=c.password else{throw WorkMailFailure(code:"MAIL_INVALID_REQUEST")};await output.value(c.id,try await mail.connect(provider:provider,address:address,password:password))
   case "disconnect":guard let accountID=c.accountID else{throw WorkMailFailure(code:"MAIL_INVALID_REQUEST")};try await mail.disconnect(accountID:accountID);await output.value(c.id,Empty(disconnected:true))
   case "inbox":guard let accountID=c.accountID else{throw WorkMailFailure(code:"MAIL_INVALID_REQUEST")};await output.value(c.id,try await mail.inbox(accountID:accountID,beforeSequence:c.beforeSequence))
   case "message":guard let accountID=c.accountID,let validity=c.uidValidity,let uid=c.uid else{throw WorkMailFailure(code:"MAIL_INVALID_REQUEST")};await output.value(c.id,try await mail.message(accountID:accountID,uidValidity:validity,uid:uid))
   case "notificationStatus":await output.value(c.id,await WorkNotifications.shared.status())
   case "notificationRequest":await output.value(c.id,try await WorkNotifications.shared.request())
   case "notificationReplace":guard let specs=c.specs else{throw WorkMailFailure(code:"MAIL_INVALID_REQUEST")};await output.value(c.id,try await WorkNotifications.shared.replace(specs:specs))
   default:throw WorkMailFailure(code:"MAIL_INVALID_REQUEST")
   }
  }catch is CancellationError {await output.error(c.id,"MAIL_CANCELLED","The mail operation was cancelled.")}
  catch let error as WorkMailFailure {await output.error(c.id,error.code,error.message)}
  catch {await output.error(c.id,"MAIL_FAILED","The mail or notification operation did not finish.")}
 }
 func close(){for task in jobs.values{task.cancel()};jobs.removeAll()}
}
@MainActor private final class Delegate:NSObject,NSApplicationDelegate {
 private var observer:NSObjectProtocol?
 func applicationDidFinishLaunching(_ notification:Notification){
  WorkNotificationForegroundDelegate.installIfAbsent()
  observer=NotificationCenter.default.addObserver(forName:WorkNotificationOpenRouter.changed,object:nil,queue:.main){_ in Task{@MainActor in
   guard let id=WorkNotificationOpenRouter.shared.claim(),let url=URL(string:"lifeswinner-work://item/"+id.uuidString.lowercased()) else{return}
   // Fixed scheme and UUID only; no message body, script, path or command.
   _ = NSWorkspace.shared.open(url)
  }}
 }
}
@main private enum Main {
 @MainActor static func main(){
  let app=NSApplication.shared;app.setActivationPolicy(.accessory);let delegate=Delegate();app.delegate=delegate
  let args=CommandLine.arguments;let directory:URL?={guard let at=args.firstIndex(of:"--data-directory"),args.indices.contains(at+1),args[at+1].hasPrefix("/") else{return nil};return URL(fileURLWithPath:args[at+1],isDirectory:true)}()
  if let directory {
   let requests=Requests(directory:directory)
   DispatchQueue.global(qos:.userInitiated).async{while let line=readLine(){Task{await requests.receive(line)}};Task{await requests.close();await MainActor.run{NSApp.terminate(nil)}}}
  }else{
   // LaunchServices may start the helper for a delivered notification click.
   // Keep a short event loop; this mode never reads credentials or mail.
   DispatchQueue.main.asyncAfter(deadline:.now()+20){NSApp.terminate(nil)}
  }
  app.run();withExtendedLifetime(delegate){}
 }
}

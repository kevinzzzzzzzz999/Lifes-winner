import Foundation
@main struct InkSpaceInkHelper {
 static func main() {
  do {
   var input=Data();let maximum=64*1024*1024
   while let chunk=try FileHandle.standardInput.read(upToCount:65536),!chunk.isEmpty {input.append(chunk);guard input.count<=maximum else{throw InkFailure("TOO_LARGE")}}
   let request=try JSONDecoder().decode(InkRequest.self,from:input)
   let result=try autoreleasepool{try NativeInkCore.apply(request)}
   let body=try JSONEncoder().encode(result);guard body.count<=96*1024*1024 else{throw InkFailure("TOO_LARGE")}
   FileHandle.standardOutput.write(Data("{\"ok\":true,\"value\":".utf8));FileHandle.standardOutput.write(body);FileHandle.standardOutput.write(Data("}\n".utf8))
  } catch {
   let code=(error as? InkFailure)?.code ?? "INK_TRANSFORM_FAILED"
   FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":{\"code\":\"\(code)\"}}\n".utf8))
   exit(1)
  }
 }
}

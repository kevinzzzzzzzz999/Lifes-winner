import SwiftUI
import ImageIO
import CryptoKit
import Darwin

/// Bounded, coordinated file access shared by image review and excerpt publishing.
/// Source PDFs are read only; image publication is create-only and retries use the same ID.
enum VisualNoteAssetError: LocalizedError {
    case missing, changed, invalid, conflict
    var errorDescription: String? { switch self {
    case .missing: String(localized: "图片或原文尚未下载、已移动或无法读取，请等待同步后重试。")
    case .changed: String(localized: "原文或目标文件夹已变化，本次没有覆盖任何资料，请重新框选。")
    case .invalid: String(localized: "图片尺寸或文件内容不可用，请缩小框选范围后重试。")
    case .conflict: String(localized: "同名摘录与本次内容不同，已保留原文件，请重新框选。")
    } }
}
enum VisualNoteAssets {
    static let maximumImageBytes = 8 * 1024 * 1024
    static let generatedAssetFolder = "白板资源"
    /// A receipt only for this request's newly-created file. Existing images
    /// (including legacy beside-board images) are never eligible for cleanup.
    struct PublishedAsset: Sendable {
        let path: String
        let created: Bool
        fileprivate let folderDevice: dev_t
        fileprivate let folderInode: ino_t
        fileprivate let fileDevice: dev_t
        fileprivate let fileInode: ino_t
        fileprivate let sha256: String
        fileprivate let bytes: Int
    }
    static func excerptPaths(boardPath: String, id: UUID) throws -> (current: String, legacy: String) {
        guard VaultPath.isSafeRelative(boardPath), boardPath.lowercased().hasSuffix(".inkspace.json"),
              !boardPath.split(separator: "/").contains(where: { $0.hasPrefix(".") }) else { throw VisualNoteAssetError.invalid }
        let parent = (boardPath as NSString).deletingLastPathComponent
        let prefix = parent.isEmpty ? "" : parent + "/"
        let name = "Excerpt-" + id.uuidString.lowercased() + ".png"
        return (prefix + generatedAssetFolder + "/" + name, prefix + name)
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format:"%02x", $0) }.joined() }
    private static func descriptor(root: URL, path: String, directory: Bool = false) throws -> Int32 {
        guard path.isEmpty || VaultPath.isSafeRelative(path) else { throw VisualNoteAssetError.invalid }
        var fd = open(root.standardizedFileURL.resolvingSymlinksInPath().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw VisualNoteAssetError.missing }
        let parts = path.split(separator:"/")
        for (index, part) in parts.enumerated() {
            let next = openat(fd, String(part), O_RDONLY | O_NOFOLLOW | (index < parts.count-1 || directory ? O_DIRECTORY : 0))
            close(fd); guard next >= 0 else { throw VisualNoteAssetError.missing }; fd = next
        }
        return fd
    }
    private static func same(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size }
    private static func read(_ fd: Int32, maximum: Int, keep: Bool) throws -> (Data, String) {
        var before=stat(); guard fstat(fd,&before)==0, (before.st_mode & S_IFMT)==S_IFREG, before.st_size>0, before.st_size<=maximum else {throw VisualNoteAssetError.invalid}
        guard lseek(fd,0,SEEK_SET)>=0 else{throw VisualNoteAssetError.missing}
        var hash=SHA256(), data=Data(), total=0, buffer=[UInt8](repeating:0,count:64*1024)
        while true {
            try Task.checkCancellation()
            let count=Darwin.read(fd,&buffer,buffer.count)
            guard count>=0 else{throw VisualNoteAssetError.missing};if count==0 {break}
            total+=count;guard total<=maximum else{throw VisualNoteAssetError.invalid}
            let chunk=Data(buffer.prefix(count));hash.update(data:chunk);if keep {data.append(chunk)}
        }
        var after=stat();guard fstat(fd,&after)==0,same(before,after),total==before.st_size,
            before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec,before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec else{throw VisualNoteAssetError.changed}
        return (data,hash.finalize().map{String(format:"%02x",$0)}.joined())
    }
    static func image(root: URL, path: String, maximumPixelSize: Int = 3072) async throws -> UIImage {
        let task=Task.detached(priority:.userInitiated) { () throws -> UIImage in
            let access=root.startAccessingSecurityScopedResource();defer{if access{root.stopAccessingSecurityScopedResource()}}
            guard VaultPath.isSafeRelative(path) else{throw VisualNoteAssetError.invalid}
            let url=root.appendingPathComponent(path)
            var coordination:NSError?,result:Result<UIImage,Error> = .failure(VisualNoteAssetError.missing)
            NSFileCoordinator().coordinate(readingItemAt:url,options:[],error:&coordination) { _ in
                result=Result {
                    let fd=try descriptor(root:root,path:path);defer{close(fd)}
                    let(data,_)=try read(fd,maximum:maximumImageBytes,keep:true)
                    guard let source=CGImageSourceCreateWithData(data as CFData,nil),CGImageSourceGetCount(source)>0,
                          let properties=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
                          let width=properties[kCGImagePropertyPixelWidth] as? Int,let height=properties[kCGImagePropertyPixelHeight] as? Int,
                          width>0,height>0,width<=8192,height<=8192,Double(width)*Double(height)<=16*1024*1024,
                          let image=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:min(3072, max(256, maximumPixelSize)),kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary) else{throw VisualNoteAssetError.invalid}
                    return UIImage(cgImage:image)
                }
            }
            if let coordination{throw coordination};return try result.get()
        }
        return try await withTaskCancellationHandler(operation:{try await task.value},onCancel:{task.cancel()})
    }
    static func publish(root:URL, boardPath:String, excerpt:PDFImageExcerpt, reusingPath: String? = nil) async throws -> PublishedAsset {
        let task=Task.detached(priority:.userInitiated) { () throws -> PublishedAsset in
            let access=root.startAccessingSecurityScopedResource();defer{if access{root.stopAccessingSecurityScopedResource()}}
            guard VaultPath.isSafeRelative(boardPath),excerpt.reference.isValid,excerpt.png.count>0,excerpt.png.count<=maximumImageBytes else{throw VisualNoteAssetError.invalid}
            let paths = try excerptPaths(boardPath: boardPath, id: excerpt.id)
            if let reusingPath, reusingPath != paths.current && reusingPath != paths.legacy { throw VisualNoteAssetError.conflict }
            let parent=(boardPath as NSString).deletingLastPathComponent
            let name="Excerpt-"+excerpt.id.uuidString.lowercased()+".png"
            let assetDirectory = (paths.current as NSString).deletingLastPathComponent
            let source=root.appendingPathComponent(excerpt.reference.path),folder=root.appendingPathComponent(parent)
            var error:NSError?,result:Result<PublishedAsset,Error> = .failure(VisualNoteAssetError.missing)
            NSFileCoordinator().coordinate(readingItemAt:source,options:[],writingItemAt:folder,options:[],error:&error) { _,_ in
                result=Result {
                    func verifySource() throws {
                        let sourceFD=try descriptor(root:root,path:excerpt.reference.path);defer{close(sourceFD)}
                        guard try read(sourceFD,maximum:512*1024*1024,keep:false).1==excerpt.reference.sourceSHA256 else{throw VisualNoteAssetError.changed}
                    }
                    try verifySource()
                    let parentFD=try descriptor(root:root,path:parent,directory:true);defer{close(parentFD)}
                    var originalParent=stat();guard fstat(parentFD,&originalParent)==0 else{throw VisualNoteAssetError.missing}
                    func verifyParent() throws {
                        let check=try descriptor(root:root,path:parent,directory:true);defer{close(check)}
                        var now=stat();guard fstat(check,&now)==0,now.st_dev==originalParent.st_dev,now.st_ino==originalParent.st_ino else{throw VisualNoteAssetError.changed}
                    }
                    let expected=hash(excerpt.png)
                    func existing(in folderFD: Int32, path: String) throws -> PublishedAsset? {
                        let fd=openat(folderFD,name,O_RDONLY|O_NOFOLLOW)
                        if fd<0 {if errno==ENOENT{return nil};throw VisualNoteAssetError.conflict}
                        defer{close(fd)}
                        var file=stat(),directory=stat()
                        guard fstat(fd,&file)==0,fstat(folderFD,&directory)==0,
                              try read(fd,maximum:maximumImageBytes,keep:false).1==expected else{throw VisualNoteAssetError.conflict}
                        try verifyParent()
                        let check=try descriptor(root:root,path:(path as NSString).deletingLastPathComponent,directory:true);defer{close(check)}
                        var now=stat();guard fstat(check,&now)==0,now.st_dev==directory.st_dev,now.st_ino==directory.st_ino else{throw VisualNoteAssetError.changed}
                        var leaf=stat();guard fstatat(folderFD,name,&leaf,AT_SYMLINK_NOFOLLOW)==0,
                            leaf.st_dev==file.st_dev,leaf.st_ino==file.st_ino else{throw VisualNoteAssetError.changed}
                        return PublishedAsset(path:path,created:false,folderDevice:directory.st_dev,folderInode:directory.st_ino,fileDevice:file.st_dev,fileInode:file.st_ino,sha256:expected,bytes:excerpt.png.count)
                    }
                    var assetFD=openat(parentFD,generatedAssetFolder,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
                    defer{if assetFD>=0{close(assetFD)}}
                    if assetFD<0 && errno != ENOENT {throw VisualNoteAssetError.conflict}
                    // A saved node owns its original path. Never move it, switch
                    // it to another same-ID file, or recreate a missing source.
                    if let reusingPath {
                        let fd=reusingPath==paths.legacy ? parentFD : assetFD
                        guard fd>=0,let reused=try existing(in:fd,path:reusingPath) else{throw VisualNoteAssetError.missing}
                        return reused
                    }
                    if assetFD>=0,let reused=try existing(in:assetFD,path:paths.current){return reused}
                    if let reused=try existing(in:parentFD,path:paths.legacy){return reused}
                    try verifyParent();try Task.checkCancellation()
                    if assetFD<0 {
                        guard mkdirat(parentFD,generatedAssetFolder,0o700)==0 || errno==EEXIST else{throw VisualNoteAssetError.missing}
                        try verifyParent()
                        assetFD=openat(parentFD,generatedAssetFolder,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
                        guard assetFD>=0 else{throw VisualNoteAssetError.conflict}
                    }
                    var original=stat();guard fstat(assetFD,&original)==0 else{throw VisualNoteAssetError.missing}
                    func verifyFolder() throws {
                        try verifyParent()
                        let check=try descriptor(root:root,path:assetDirectory,directory:true);defer{close(check)}
                        var now=stat();guard fstat(check,&now)==0,now.st_dev==original.st_dev,now.st_ino==original.st_ino else{throw VisualNoteAssetError.changed}
                    }
                    try verifyFolder()
                    let temporary=".excerpt-"+UUID().uuidString.lowercased()+".tmp"
                    let fd=openat(assetFD,temporary,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW,0o600)
                    guard fd>=0 else{throw VisualNoteAssetError.missing}
                    var published=false,finished=false
                    // If final revalidation fails, remove only this operation's
                    // own inode. A racing writer's replacement is never removed.
                    defer{
                        if published && !finished {
                            var own=stat(),current=stat()
                            if fstat(fd,&own)==0,fstatat(assetFD,name,&current,AT_SYMLINK_NOFOLLOW)==0,
                               current.st_dev==own.st_dev,current.st_ino==own.st_ino,
                               (try? read(fd,maximum:maximumImageBytes,keep:false).1)==expected {unlinkat(assetFD,name,0)}
                        }
                        close(fd);unlinkat(assetFD,temporary,0)
                    }
                    try excerpt.png.withUnsafeBytes { raw in
                        var offset=0
                        while offset<raw.count {try Task.checkCancellation();let count=Darwin.write(fd,raw.baseAddress!.advanced(by:offset),raw.count-offset);guard count>0 else{throw VisualNoteAssetError.missing};offset+=count}
                    }
                    guard fsync(fd)==0 else{throw VisualNoteAssetError.missing}
                    try verifySource();try verifyFolder();try Task.checkCancellation()
                    if renameatx_np(assetFD,temporary,assetFD,name,UInt32(RENAME_EXCL)) != 0 {
                        guard errno==EEXIST,let reused=try existing(in:assetFD,path:paths.current) else{throw VisualNoteAssetError.conflict}
                        return reused
                    }
                    published=true
                    try verifyFolder();try Task.checkCancellation()
                    var file=stat();guard fstat(fd,&file)==0 else{throw VisualNoteAssetError.missing}
                    guard let verified=try existing(in:assetFD,path:paths.current),
                          verified.fileDevice==file.st_dev,verified.fileInode==file.st_ino else{throw VisualNoteAssetError.changed}
                    finished=true
                    return PublishedAsset(path:paths.current,created:true,folderDevice:original.st_dev,folderInode:original.st_ino,fileDevice:file.st_dev,fileInode:file.st_ino,sha256:expected,bytes:excerpt.png.count)
                }
            }
            if let error{throw error};return try result.get()
        }
        return try await withTaskCancellationHandler(operation:{try await task.value},onCancel:{task.cancel()})
    }
    /// The caller must first prove no draft/committed node can reference this
    /// receipt. Unknown commit outcomes retain the image for a fixed-ID retry.
    static func discardUnreferenced(_ asset: PublishedAsset, root: URL) async -> Bool {
        guard asset.created else{return true}
        return await Task.detached(priority:.utility) {
            let access=root.startAccessingSecurityScopedResource();defer{if access{root.stopAccessingSecurityScopedResource()}}
            do {
                let directory=(asset.path as NSString).deletingLastPathComponent,name=(asset.path as NSString).lastPathComponent
                let fd=try descriptor(root:root,path:directory,directory:true);defer{close(fd)}
                var folder=stat();guard fstat(fd,&folder)==0,folder.st_dev==asset.folderDevice,folder.st_ino==asset.folderInode else{return false}
                let image=openat(fd,name,O_RDONLY|O_NOFOLLOW)
                if image<0{return errno==ENOENT};defer{close(image)}
                var current=stat();guard fstat(image,&current)==0,current.st_dev==asset.fileDevice,current.st_ino==asset.fileInode,
                    current.st_size==asset.bytes,try read(image,maximum:maximumImageBytes,keep:false).1==asset.sha256 else{return false}
                var leaf=stat();guard fstatat(fd,name,&leaf,AT_SYMLINK_NOFOLLOW)==0,leaf.st_dev==current.st_dev,leaf.st_ino==current.st_ino else{return false}
                return unlinkat(fd,name,0)==0
            }catch{return false}
        }.value
    }
}

/// Instantiated only after reveal. No filename, thumbnail or image is loaded on the question side.
struct StudyImageAnswer: View {
    let rootURL:URL?
    let path:String
    let onReady:(Bool)->Void
    @State private var image:UIImage?
    @State private var failure:String?
    @State private var attempt=0
    @State private var enlarged=false
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            if let image {
                Image(uiImage:image).resizable().scaledToFit().background(.white).accessibilityLabel(String(localized:"节点图片答案")).accessibilityIdentifier("study.image.loaded")
                Button(String(localized:"放大查看图片")){enlarged=true}.frame(minHeight:44).buttonStyle(.bordered).accessibilityIdentifier("study.image.zoom")
            }
            else if let failure {
                Label(failure,systemImage:"photo.badge.exclamationmark").foregroundStyle(.secondary).accessibilityIdentifier("study.image.error")
                Button(String(localized:"重新加载图片")){attempt+=1}.frame(minHeight:44).buttonStyle(.bordered).accessibilityIdentifier("study.image.retry")
            } else {ProgressView(String(localized:"正在读取图片答案…"))}
        }.task(id:"\(path):\(attempt)") {
            image=nil;failure=nil;onReady(false)
            do {guard let rootURL else{throw VisualNoteAssetError.missing};let loaded=try await VisualNoteAssets.image(root:rootURL,path:path);try Task.checkCancellation();image=loaded;onReady(true)}
            catch is CancellationError{}catch{failure=error.localizedDescription;onReady(false)}
        }.onDisappear{onReady(false)}
        .sheet(isPresented:$enlarged){if let image{NavigationStack{StudyImageZoom(image:image).ignoresSafeArea(edges:.bottom).navigationTitle(String(localized:"图片答案")).navigationBarTitleDisplayMode(.inline).toolbar{ToolbarItem(placement:.cancellationAction){Button(String(localized:"关闭")){enlarged=false}.frame(minHeight:44)}}}}}
    }
}

private struct StudyImageZoom:UIViewRepresentable {
    let image:UIImage
    func makeCoordinator()->Coordinator{Coordinator()}
    func makeUIView(context:Context)->UIScrollView {
        let scroll=UIScrollView();scroll.backgroundColor = .secondarySystemBackground;scroll.minimumZoomScale=1;scroll.maximumZoomScale=6;scroll.delegate=context.coordinator
        let view=UIImageView(image:image);view.contentMode = .scaleAspectFit;view.backgroundColor = .white;scroll.addSubview(view);context.coordinator.image=view
        scroll.accessibilityIdentifier="study.image.zoomCanvas";return scroll
    }
    func updateUIView(_ scroll:UIScrollView,context:Context){DispatchQueue.main.async{guard scroll.bounds.width>0,let view=context.coordinator.image else{return};if scroll.zoomScale==1{let width=scroll.bounds.width,height=max(1,width*image.size.height/max(1,image.size.width));view.frame=CGRect(x:0,y:0,width:width,height:height);scroll.contentSize=view.bounds.size}}}
    final class Coordinator:NSObject,UIScrollViewDelegate {var image:UIImageView?;func viewForZooming(in scrollView:UIScrollView)->UIView?{image}}
}

import SwiftUI
import PDFKit

struct PDFOutlineEntry:Identifiable {let id:String;let title:String;let page:Int;let depth:Int}
enum PDFOutlineIndex {
    static func entries(_ document:PDFDocument)->[PDFOutlineEntry] {
        guard let root=document.outlineRoot else{return []}
        var rows:[PDFOutlineEntry]=[],seen=Set<ObjectIdentifier>()
        func visit(_ item:PDFOutline,depth:Int,path:String) {
            guard rows.count<5000,depth<=32,seen.insert(ObjectIdentifier(item)).inserted else{return}
            if let destination=item.destination ?? (item.action as? PDFActionGoTo)?.destination,let page=destination.page {
                let number=document.index(for:page)+1
                if number>0,number<=document.pageCount {rows.append(.init(id:path,title:item.label?.isEmpty == false ? item.label!:String(localized:"未命名章节"),page:number,depth:depth))}
            }
            for index in 0..<min(item.numberOfChildren,5000) {if let child=item.child(at:index){visit(child,depth:depth+1,path:path+"/\(index)")}}
        }
        for index in 0..<min(root.numberOfChildren,5000) {if let child=root.child(at:index){visit(child,depth:0,path:String(index))}}
        return rows
    }
}
struct PDFOutlineView:View {
    let pane:PDFWorkspacePane
    @Environment(\.dismiss) private var dismiss
    @State private var query=""
    @State private var pageEntry=""
    var body:some View {
        NavigationStack {
            List {
                Section {
                    HStack {TextField(String(localized:"页码"),text:$pageEntry).keyboardType(.numberPad);Button(String(localized:"前往")){if let number=Int(pageEntry),number>0,number<=pane.pageCount{pane.navigate(to:number);dismiss()}}.disabled(Int(pageEntry)==nil)}
                }
                if let document=pane.document {
                    let rows=PDFOutlineIndex.entries(document).filter{query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)}
                    if rows.isEmpty {Text(query.isEmpty ? String(localized:"该 PDF 没有内置目录，可输入页码跳转。") : String(localized:"没有匹配的章节")).foregroundStyle(.secondary)}
                    ForEach(rows){row in Button {pane.navigate(to:row.page);dismiss()} label:{HStack {Text(row.title).padding(.leading,CGFloat(min(6,row.depth))*12);Spacer();Text(String(row.page)).monospacedDigit().foregroundStyle(.secondary)}.frame(minHeight:44)}.accessibilityIdentifier("pdfOutline.entry."+row.id)}
                }
            }.searchable(text:$query,prompt:String(localized:"搜索目录"))
            .navigationTitle(String(localized:"PDF 目录")).toolbar{Button(String(localized:"关闭")){dismiss()}}
            .accessibilityIdentifier("pdfOutline.list")
        }
    }
}
struct PDFLayerReplayControls:View {
    @Bindable var pane:PDFWorkspacePane
    var body:some View {
        VStack(spacing:4) {
            Picker(String(localized: "笔迹显示"), selection: Binding(get: { pane.replayDisplayMode }, set: { pane.setReplayDisplayMode($0) })) {
                ForEach(InkReplayDisplayMode.allCases, id: \.rawValue) { mode in Text(mode.title).tag(mode) }
            }.pickerStyle(.menu).frame(minHeight:44).accessibilityIdentifier("pdfReplay.displayMode")
            HStack {
                Button(pane.layerReplayPlaying ? String(localized:"暂停"):String(localized:"播放"),systemImage:pane.layerReplayPlaying ? "pause.fill":"play.fill"){pane.layerReplayPlaying.toggle();if pane.layerReplayPosition>=pane.replayMarks.count{pane.setLayerReplayPosition(0)}}.frame(minHeight:44).disabled(pane.replayMarks.isEmpty).accessibilityIdentifier("pdfReplay.play")
                Slider(value:Binding(get:{Double(pane.layerReplayPosition)},set:{pane.layerReplayPlaying=false;pane.setLayerReplayPosition(Int($0))}),in:0...Double(max(1,pane.replayMarks.count)),step:1).disabled(pane.replayMarks.isEmpty).accessibilityIdentifier("pdfReplay.progress")
                Text("\(pane.layerReplayPosition) / \(pane.replayMarks.count)").monospacedDigit().font(.caption).accessibilityIdentifier("pdfReplay.count")
            }
            Text(pane.replayMarks.isEmpty ? String(localized:"当前没有可回放的独立图层笔迹。原 PDF 中的手写和留白历史不属于此时间轴。") : String(localized:"按现存笔迹创建顺序回看，原文和其他批注保留。不会还原已删除笔迹或录音时间。")) .font(.caption2).foregroundStyle(.secondary)
        }.padding(.horizontal,8)
        .task(id:pane.layerReplayPlaying) {
            guard pane.layerReplayPlaying else{return}
            while !Task.isCancelled,pane.layerReplayPlaying {
                do{try await Task.sleep(for:.milliseconds(700))}catch{return}
                guard pane.layerReplayPlaying else{return}
                if pane.layerReplayPosition>=pane.replayMarks.count {pane.layerReplayPlaying=false;return}
                pane.setLayerReplayPosition(pane.layerReplayPosition+1)
            }
        }
    }
}

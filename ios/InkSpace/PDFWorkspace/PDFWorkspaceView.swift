import SwiftUI
import PDFKit
import UIKit

@MainActor @Observable final class PDFWorkspaceSession {
    var panes: [PDFWorkspacePane]
    var primaryID: UUID
    var secondaryID: UUID?
    var translatedID: UUID?
    var ratio = 0.5
    var translationOnLeft = false
    init(rootURL: URL?, sourceURL: URL, page: Int) {
        let pane = PDFWorkspacePane(rootURL: rootURL, sourceURL: sourceURL, page: page)
        panes = [pane]; primaryID = pane.id
        wire(pane)
    }
    init(pane: PDFWorkspacePane) { panes=[pane];primaryID=pane.id;wire(pane) }
    var primary: PDFWorkspacePane { panes.first { $0.id == primaryID }! }
    var secondary: PDFWorkspacePane? { panes.first { $0.id == secondaryID } }
    var translated: PDFWorkspacePane? { panes.first { $0.id == translatedID } }
    var pending: Bool { panes.contains { $0.imageExcerptActive || $0.hasPendingWrite || $0.isSaving || $0.interactionActive || $0.textDraft != nil || $0.extensionStore.busy || $0.extensionStore.pending != nil } }
    func wire(_ pane: PDFWorkspacePane) {
        pane.temporaryTranslation.onSettingsChanged = { [weak self] in self?.panes.forEach { $0.cancelTranslations() } }
    }
    func openSecondary(_ url: URL) {
        if let present = panes.first(where: { $0.sourceURL.standardizedFileURL == url.standardizedFileURL && $0.id != primaryID }) { secondaryID = present.id }
        else { let pane = PDFWorkspacePane(rootURL: primary.rootURL, sourceURL: url); wire(pane); panes.append(pane); secondaryID = pane.id }
        translatedID = nil; updateVisibleReaders()
    }
    func showTranslation(_ pane: PDFWorkspacePane) {
        if pane.id != primaryID { secondaryID = primaryID; primaryID = pane.id }
        translatedID = pane.id; translationOnLeft = false; updateVisibleReaders()
    }
    func swap() {
        guard !pending else { return }
        if translatedID != nil { translationOnLeft.toggle() }
        else if let secondaryID { self.secondaryID = primaryID; primaryID = secondaryID }
        ratio = 1-ratio; updateVisibleReaders()
    }
    func updateVisibleReaders() {
        for pane in panes {
            if pane.id == primaryID || (translatedID == nil && pane.id == secondaryID) { pane.activateReader() }
            else { pane.suspendReader() }
        }
    }
    func returnToPDF() { translatedID = nil; updateVisibleReaders() }
    func closeSecondary() { secondary?.chooseTool(.read);translatedID = nil;secondaryID = nil;updateVisibleReaders() }
    func close() { panes.forEach { $0.endReading() } }
}

struct PDFWorkspaceView: View {
    @State private var session: PDFWorkspaceSession
    @State private var choosesPDF = false
    @State private var closeWarning = false
    @State private var dragOrigin: Double?
    @Environment(\.scenePhase) private var scenePhase
    let onClose: () -> Void
    var closeTitle: String = String(localized: "关闭")
    var excerptTargetTitle: String?
    var onOpenBoard: (() -> Void)?
    let onImageExcerpt:((PDFImageExcerpt) async -> Bool)?
    let onExcerpt:((PDFSourceReference) async -> Bool)?
    let sourceReference:PDFSourceReference?
    init(rootURL: URL?, sourceURL: URL, page: Int = 1, sourceReference:PDFSourceReference? = nil, closeTitle: String? = nil, excerptTargetTitle: String? = nil, onOpenBoard: (() -> Void)? = nil, onExcerpt:((PDFSourceReference) async -> Bool)? = nil, onImageExcerpt:((PDFImageExcerpt) async -> Bool)? = nil, onClose: @escaping () -> Void) {
        _session = State(initialValue: PDFWorkspaceSession(rootURL: rootURL, sourceURL: sourceURL, page: page)); self.onClose = onClose;self.onExcerpt=onExcerpt;self.onImageExcerpt=onImageExcerpt;self.sourceReference=sourceReference;self.closeTitle=closeTitle ?? String(localized: "关闭");self.excerptTargetTitle=excerptTargetTitle;self.onOpenBoard=onOpenBoard
    }
    init(session:PDFWorkspaceSession,onClose:@escaping()->Void) { _session=State(initialValue:session);self.onClose=onClose;self.onExcerpt=nil;self.onImageExcerpt=nil;self.sourceReference=nil }
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let divided = session.secondary != nil || session.translated != nil
                let available = max(0,geometry.size.width-16)
                let minimum = min(280,available*0.4)
                let width = min(max(minimum,available*session.ratio),max(minimum,available-minimum))
                HStack(spacing: 0) {
                    Group {
                        if let translated = session.translated, session.translationOnLeft {
                            translationResult(translated)
                        } else { primaryReader }
                    }.frame(width: divided ? width : geometry.size.width)
                    if divided {
                        divider(total: available)
                        Group {
                            if let translated = session.translated {
                                if session.translationOnLeft { primaryReader } else { translationResult(translated) }
                            } else if let secondary = session.secondary {
                                PDFWorkspacePaneView(pane: secondary, onImageExcerpt:onImageExcerpt, onExcerpt:onExcerpt, onTranslation: { session.showTranslation(secondary) }).id(secondary.id)
                            }
                        }.frame(maxWidth: .infinity)
                    }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if let excerptTargetTitle {
                    HStack(alignment: .center) {
                        Text(excerptTargetTitle).font(.caption).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        if let onOpenBoard {
                            Button(String(localized: "打开接收白板")) {
                                if session.pending { closeWarning = true } else { session.close(); onOpenBoard() }
                            }.frame(minHeight: 44).accessibilityIdentifier("pdfWorkspace.openTargetBoard")
                        }
                    }.padding(.horizontal, 12).background(.regularMaterial).accessibilityElement(children: .contain).accessibilityIdentifier("pdfWorkspace.targetBoard")
                }
            }
            .navigationTitle(String(localized: "PDF 阅读工作区")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(closeTitle) { if session.pending { closeWarning = true } else { session.close(); onClose() } }.accessibilityIdentifier("pdfWorkspace.close")
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button(String(localized: "添加对照 PDF"), systemImage: "rectangle.split.2x1") { choosesPDF = true }
                        .disabled(session.primary.rootURL == nil || session.pending).accessibilityIdentifier("pdfWorkspace.addPDF")
                    Button(String(localized: "交换左右"), systemImage: "arrow.left.arrow.right") { session.swap() }
                        .disabled((session.secondary == nil && session.translated == nil) || session.pending).accessibilityIdentifier("pdfWorkspace.swap")
                    Menu {
                        ForEach(session.panes.filter { !$0.translationJob.pages.isEmpty || $0.translationJob.isRunning }) { pane in
                            Button(pane.title) { session.showTranslation(pane) }
                        }
                    } label: { Label(String(localized: "查看已有译文"), systemImage: "character.book.closed") }
                        .disabled(!session.panes.contains { !$0.translationJob.pages.isEmpty || $0.translationJob.isRunning }).accessibilityIdentifier("pdfWorkspace.translations")
                    if session.secondary != nil || session.translated != nil {
                        Button(String(localized: "关闭对照栏"), systemImage: "rectangle.righthalf.inset.filled") {
                            session.closeSecondary()
                        }.disabled(session.pending).accessibilityIdentifier("pdfWorkspace.closeSecondary")
                    }
                }
            }
            .sheet(isPresented: $choosesPDF) {
                if let root = session.primary.rootURL { PDFWorkspaceFilePicker(root: root, initialURL: session.primary.sourceURL) { session.openSecondary($0); choosesPDF = false } }
            }
            .alert(String(localized: "请先处理尚未保存的图层更改"), isPresented: $closeWarning) {
                Button(String(localized: "继续阅读"), role: .cancel) {}
            } message: { Text("请在对应栏重试保存；若决定放弃待发布内容，请先在错误提示中明确放弃。") }
        }
        .opensExternalLinksInApp()
        .interactiveDismissDisabled(session.pending)
        .onDisappear { if scenePhase == .active { session.close() } }
        .task {if let sourceReference {await session.primary.refresh();session.primary.locateSourceReference(sourceReference)}}
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                for pane in session.panes where pane.id == session.primaryID || pane.id == session.secondaryID { await pane.refresh() }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }
    private var primaryReader: some View {
        PDFWorkspacePaneView(pane: session.primary, onImageExcerpt:onImageExcerpt, onExcerpt:onExcerpt, onTranslation: { session.showTranslation(session.primary) }).id(session.primary.id)
    }
    private func translationResult(_ pane: PDFWorkspacePane) -> some View {
        PDFWorkspaceTranslationResult(pane: pane, onReturn: { session.returnToPDF() }, onLocate: { pane.navigate(to: $0) })
    }
    private func divider(total: CGFloat) -> some View {
        Capsule().fill(.secondary.opacity(0.35)).frame(width: 4).padding(.horizontal,6)
            .contentShape(Rectangle()).accessibilityLabel(String(localized: "调整左右宽度")).accessibilityIdentifier("pdfWorkspace.divider")
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global).onChanged { value in
                guard !session.pending else { return }
                if dragOrigin == nil { dragOrigin = session.ratio }
                session.ratio = min(0.75,max(0.25,(dragOrigin ?? 0.5)+value.translation.width/max(1,total)))
            }.onEnded { _ in dragOrigin = nil })
    }
}

private struct PDFWorkspacePaneView: View {
    @Bindable var pane: PDFWorkspacePane
    let onImageExcerpt:((PDFImageExcerpt) async -> Bool)?
    let onExcerpt:((PDFSourceReference) async -> Bool)?
    let onTranslation: () -> Void
    @State private var discardWarning = false
    @State private var showsOCR = false
    @State private var showsOutline = false
    @State private var exportRequest: PDFFileExportRequest?
    @State private var excerptBusy=false
    @State private var excerptStatus=""
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(pane.title).font(.headline).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Button { Task { await pane.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel(String(localized: "刷新")) .disabled(pane.interactionActive || pane.isSaving || pane.hasPendingWrite)
            }.padding(8)
            PDFReadAloudControls(pane: pane)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(PDFWorkspaceTool.allCases) { tool in
                        Button(tool.title) { if tool != .read {pane.extensionMode=false};pane.chooseTool(tool) }.tint(pane.tool == tool ? .accentColor : .secondary)
                            .accessibilityIdentifier("pdfWorkspace.tool."+tool.rawValue)
                    }
                    if pane.tool == .ink { PDFInkPenMenu(pane:pane) }
                    Button(String(localized:"目录"),systemImage:"list.bullet.indent"){showsOutline=true}.accessibilityIdentifier("pdfWorkspace.outline")
                    Button(String(localized: "导出 PDF"), systemImage: "square.and.arrow.down") {
                        pane.chooseTool(.read); exportRequest = .init(pane: pane)
                    }.accessibilityIdentifier("pdfWorkspace.export")
                        .disabled(pane.document == nil || pane.isLoading || pane.isSaving || pane.hasPendingWrite || pane.interactionActive || pane.layerReplayActive || pane.extensionStore.busy || pane.extensionStore.pending != nil)
                    Button(pane.extensionMode ? String(localized:"原页选字"):String(localized:"页内留白"),systemImage:"rectangle.split.1x2"){pane.chooseTool(.read);pane.extensionMode.toggle()}.disabled(pane.interactionActive || pane.extensionStore.busy || pane.extensionStore.pending != nil).accessibilityIdentifier("pdfWorkspace.extend")
                    Button(pane.layerReplayActive ? String(localized:"退出回放"):String(localized:"回放"),systemImage:"clock.arrow.circlepath"){pane.toggleLayerReplay()}.accessibilityIdentifier("pdfWorkspace.replay")
                    if onImageExcerpt != nil {
                        Button(String(localized:"框选图片"),systemImage:"photo.badge.plus") {pane.chooseTool(.read);pane.imageExcerptActive=true}
                            .disabled(pane.access != .full || pane.extensionMode || pane.layerReplayActive || pane.isLoading || pane.isSaving || pane.interactionActive || pane.hasPendingWrite || pane.document == nil)
                            .frame(minHeight:44).accessibilityIdentifier("pdfWorkspace.imageExcerpt")
                    }
                    if let onExcerpt {Button(String(localized:"摘录为节点"),systemImage:"quote.bubble"){
                        guard let ref=pane.selectedSourceReference() else{return};excerptBusy=true
                        Task {let saved=await onExcerpt(ref);excerptBusy=false;excerptStatus=saved ? String(localized:"摘录节点已保存。"):String(localized:"摘录未能保存。白板草稿已保留，请回白板重试保存；再点不会重复添加同一摘录。")}
                    }.disabled(pane.extensionMode || pane.interactionActive || excerptBusy).accessibilityIdentifier("pdfWorkspace.excerpt")}
                    Button(String(localized: "图层"), systemImage: "square.3.layers.3d") { pane.showsLayers = true }.accessibilityIdentifier("pdfWorkspace.layers")
                    Button { Task { await pane.undo() } } label: { Image(systemName:"arrow.uturn.backward") }.accessibilityLabel(String(localized:"撤销")).disabled(!pane.canUndo || pane.isSaving || pane.hasPendingWrite)
                    Button { Task { await pane.redo() } } label: { Image(systemName:"arrow.uturn.forward") }.accessibilityLabel(String(localized:"重做")).disabled(!pane.canRedo || pane.isSaving || pane.hasPendingWrite)
                    Button(String(localized: "圈选翻译")) { pane.chooseTool(.read); pane.temporaryTranslation.begin(source: pane.captureSource) }.accessibilityIdentifier("pdfWorkspace.translateSelection").disabled(pane.extensionMode || pane.interactionActive || pane.isSaving)
                    Button(String(localized: "本机文字识别"), systemImage: "text.viewfinder") { pane.chooseTool(.read); showsOCR = true }
                        .disabled(pane.document == nil || pane.interactionActive || pane.isSaving || pane.hasPendingWrite)
                        .accessibilityIdentifier("pdfWorkspace.ocr")
                    Button(String(localized: "选择文字"), systemImage: "text.cursor") { pane.selectVisibleText() }
                        .frame(minHeight: 44).accessibilityIdentifier("pdfWorkspace.selectText")
                        .disabled(pane.document == nil || pane.interactionActive || pane.isLoading || pane.isSaving || pane.hasPendingWrite || pane.layerReplayActive)
                    Button(String(localized: "复制所选文字"), systemImage: "doc.on.doc") { pane.copyVisibleText() }
                        .frame(minHeight: 44).accessibilityIdentifier("pdfWorkspace.copySelectedText")
                        .disabled(pane.document == nil || pane.interactionActive || pane.isLoading || pane.isSaving || pane.hasPendingWrite || pane.layerReplayActive)
                    Button(String(localized: "范围翻译")) { pane.showsTranslationSetup = true }.accessibilityIdentifier("pdfWorkspace.translateRange")
                    Button(String(localized: "翻译设置")) { pane.temporaryTranslation.showsSettings = true }
                }.buttonStyle(.bordered).padding(.horizontal,8).padding(.bottom,6).disabled(pane.imageExcerptActive)
            }
            HStack {
                Button { pane.navigate(to:pane.page-1) } label: { Image(systemName:"chevron.left") }.disabled(pane.page<=1)
                Text(pane.pageCount > 0 ? String(localized:"第 \(pane.page) / \(pane.pageCount) 页") : "—").monospacedDigit().font(.caption).fixedSize()
                    .accessibilityIdentifier("pdfWorkspace.pageStatus")
                Button { pane.navigate(to:pane.page+1) } label: { Image(systemName:"chevron.right") }.disabled(pane.page>=pane.pageCount)
                Spacer()
                if pane.isSaving { ProgressView().controlSize(.small) }
                // Keep the PDF viewport stable as OCR progress changes line length.
                Text(!pane.textSelectionStatus.isEmpty ? pane.textSelectionStatus : pane.tool == .ink ? String(localized:"仅 Apple Pencil 书写，手指浏览") : String(localized:"图层独立保存，原 PDF 保持不变")).font(.caption2).foregroundStyle(.secondary).lineLimit(2,reservesSpace:true)
                    .accessibilityIdentifier("pdfWorkspace.textSelectionStatus")
            }.padding(.horizontal,8).padding(.bottom,4).disabled(pane.imageExcerptActive)
            if !pane.error.isEmpty {
                VStack(alignment:.leading,spacing:4) {
                    Text(pane.error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    HStack {
                        if pane.hasPendingWrite {
                            Button(String(localized:"重试保存")) { Task { await pane.retry() } }.disabled(pane.isSaving)
                            Button(String(localized:"放弃待发布更改"),role:.destructive) { discardWarning=true }.disabled(pane.isSaving)
                        }
                    }
                }.padding(8).frame(maxWidth:.infinity,alignment:.leading)
            }
            if pane.mismatchedVersionCount > 0 { Text(String(localized:"另有 \(pane.mismatchedVersionCount) 条属于其他 PDF 版本的批注，当前不叠加显示。")).font(.caption).foregroundStyle(.secondary).padding(4) }
            if !pane.projection.warnings.isEmpty { Text(pane.projection.warnings.joined(separator:"\n")).font(.caption2).foregroundStyle(.orange).padding(4) }
            if !excerptStatus.isEmpty {Text(excerptStatus).font(.caption).padding(6)}
            if excerptBusy {ProgressView()}
            if pane.layerReplayActive {PDFLayerReplayControls(pane:pane)}
            if pane.extensionMode {
                PDFExtensionReader(pane:pane,store:pane.extensionStore,onExcerpt:onExcerpt)
            } else {
                PDFWorkspaceReader(pane:pane).overlay { PDFTranslationOverlay(session:pane.temporaryTranslation) }
                    .overlay {if pane.imageExcerptActive,let onImageExcerpt {PDFImageExcerptSelection(pane:pane,onSave:onImageExcerpt)}}
                    .overlay { if pane.isLoading && pane.document == nil { ProgressView() } }
            }
        }
        .background(.background)
        .task { if pane.document == nil { await pane.refresh() } }
        .sheet(isPresented:$showsOutline){PDFOutlineView(pane:pane)}
        .sheet(item: $exportRequest) { PDFFileExportView(request: $0) }
        .sheet(isPresented: $showsOCR) { LocalOCRView(rootURL: pane.rootURL, sourceURL: pane.sourceURL, page: pane.page) }
        .sheet(isPresented:$pane.showsLayers) { PDFWorkspaceLayers(pane:pane) }
        .sheet(isPresented:$pane.showsTranslationSetup) { PDFWorkspaceTranslationSetup(pane:pane,onStart:onTranslation) }
        .sheet(item:$pane.textDraft) { mark in PDFWorkspaceTextEntry(pane:pane,mark:mark) }
        .confirmationDialog(String(localized:"放弃待发布更改？"),isPresented:$discardWarning,titleVisibility:.visible) {
            Button(String(localized:"放弃待发布更改"),role:.destructive) { Task { await pane.discardPending() } }
        } message: { Text("已发布的记录仍保留；本机恢复副本不会删除。尚未发布的部分将不再重试。") }
    }
}

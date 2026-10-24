import SwiftUI

struct StudyContentBlocksView: View {
    let rootURL: URL?
    let blocks: [StudyContentBlock]
    let revealed: Bool
    let onReady: (String, Bool) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(blocks) { block in
                if block.kind == "text" {
                    Text(block.text ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("study.block.text." + block.id)
                } else {
                    StudyContentImageView(rootURL: rootURL, block: block, revealed: revealed,
                        onRegions: nil, onReady: { onReady(block.id, $0) })
                }
            }
        }
    }
}

struct StudyContentBlockEditor: View {
    let rootURL: URL?
    let items: [BoardItem]
    let allowsRegions: Bool
    @Binding var blocks: [StudyContentBlock]
    var body: some View {
        ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(block.kind == "image" ? String(localized: "图片") : String(localized: "文字")).font(.headline)
                    Spacer()
                    Button(String(localized: "上移"), systemImage: "arrow.up") { blocks.swapAt(index, index - 1) }
                        .disabled(index == 0).accessibilityIdentifier("study.block.up." + block.id)
                    Button(String(localized: "下移"), systemImage: "arrow.down") { blocks.swapAt(index, index + 1) }
                        .disabled(index + 1 == blocks.count).accessibilityIdentifier("study.block.down." + block.id)
                    Button(String(localized: "删除"), systemImage: "trash", role: .destructive) { blocks.removeAll { $0.id == block.id } }
                        .accessibilityIdentifier("study.block.delete." + block.id)
                }.font(.caption).buttonStyle(.borderless)
                if block.kind == "text" {
                    TextEditor(text: Binding(get: { blocks.first { $0.id == block.id }?.text ?? "" }, set: { value in
                        if let i = blocks.firstIndex(where: { $0.id == block.id }) { blocks[i].text = value }
                    })).frame(minHeight: 100).accessibilityIdentifier("study.block.editor." + block.id)
                } else {
                    StudyContentImageView(rootURL: rootURL, block: block, revealed: false,
                        onRegions: allowsRegions ? { regions in
                            if let i = blocks.firstIndex(where: { $0.id == block.id }) { blocks[i].regions = regions.isEmpty ? nil : regions }
                        } : nil, onReady: { _ in })
                    if !allowsRegions, !(block.regions?.isEmpty ?? true) {
                        Button(String(localized: "清除遮盖区域")) {
                            if let i = blocks.firstIndex(where: { $0.id == block.id }) { blocks[i].regions = nil }
                        }.accessibilityIdentifier("study.masks.clear." + block.id)
                    }
                }
            }.padding(.vertical, 8)
        }
        HStack {
            Button(String(localized: "添加文字"), systemImage: "text.badge.plus") { blocks.append(.text()) }
                .accessibilityIdentifier("study.blocks.addText")
            Menu {
                ForEach(items.filter { StudyNodes.isImage($0) }) { item in
                    Button(item.title.isEmpty ? (item.sourcePath ?? "") : item.title) {
                        if let path = item.sourcePath { blocks.append(.image(path)) }
                    }.accessibilityIdentifier("study.blocks.image." + item.id.uuidString.lowercased())
                }
            } label: { Label(String(localized: "添加图片"), systemImage: "photo.badge.plus") }
                .disabled(!items.contains(where: { StudyNodes.isImage($0) })).accessibilityIdentifier("study.blocks.addImage")
        }.buttonStyle(.borderless).disabled(blocks.count >= 16)
        Text(String(localized: "每面最多 16 个内容块，可自由添加、排序与删除；图片选自当前白板。"))
            .font(.caption).foregroundStyle(.secondary)
    }
}

struct StudyContentImageView: View {
    let rootURL: URL?
    let block: StudyContentBlock
    let revealed: Bool
    let onRegions: (([StudyOcclusionRegion]) -> Void)?
    let onReady: (Bool) -> Void
    @State private var image: UIImage?
    @State private var error: String?
    @State private var attempt = 0
    @State private var showing: Set<String> = []
    @State private var forceHidden = false
    @State private var drag: CGRect?
    private var regions: [StudyOcclusionRegion] { block.regions ?? [] }
    private var editing: Bool { onRegions != nil }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let image {
                imageSurface(image)
                if editing {
                    Text(String(localized: "在图片上拖动添加遮盖矩形；可添加多个区域，保存后逐个揭晓。"))
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(regions.enumerated()), id: \.element.id) { index, region in
                        Button(String(localized: "删除遮盖 \(index + 1)"), systemImage: "trash", role: .destructive) {
                            onRegions?(regions.filter { $0.id != region.id })
                        }.accessibilityIdentifier("study.mask.delete." + region.id)
                    }
                } else if !regions.isEmpty {
                    HStack {
                        Button(String(localized: "全部揭晓")) { forceHidden = false; showing = Set(regions.map(\.id)) }
                            .accessibilityIdentifier("study.masks.revealAll." + block.id)
                        Button(String(localized: "全部重盖")) { forceHidden = true; showing = [] }
                            .accessibilityIdentifier("study.masks.coverAll." + block.id)
                    }.buttonStyle(.bordered)
                    Text(String(localized: "轻点遮盖逐个揭晓；轻点边框可重新遮盖。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if let error {
                Text(error).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("study.block.imageError." + block.id)
                Button(String(localized: "重新加载图片")) { attempt += 1 }
                    .accessibilityIdentifier("study.block.retry." + block.id)
            } else { ProgressView(String(localized: "正在读取图片答案…")) }
        }
        .task(id: "\(block.sourcePath ?? ""): \(attempt)") {
            image = nil; error = nil; onReady(false)
            do {
                guard let rootURL, let path = block.sourcePath else { throw VisualNoteAssetError.missing }
                let loaded = try await VisualNoteAssets.image(root: rootURL, path: path, maximumPixelSize: 1024)
                try Task.checkCancellation(); image = loaded; onReady(true)
            } catch is CancellationError {} catch { self.error = error.localizedDescription; onReady(false) }
        }
        .onChange(of: revealed) { _, value in showing = []; forceHidden = false; if value { showing = Set(regions.map(\.id)) } }
        .onDisappear { onReady(false) }
    }
    private func imageSurface(_ image: UIImage) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                Image(uiImage: image).resizable().scaledToFit().accessibilityHidden(!regions.isEmpty)
                ForEach(Array(regions.enumerated()), id: \.element.id) { index, region in
                    let open = !editing && (showing.contains(region.id) || (revealed && !forceHidden))
                    Button {
                        if open {
                            // Materialize the global reveal only once. Covering
                            // one region must preserve every other region's state.
                            if revealed && !forceHidden { showing = Set(regions.map(\.id)) }
                            showing.remove(region.id); forceHidden = true
                        }
                        else { showing.insert(region.id) }
                    } label: {
                        Rectangle().fill(open ? Color.clear : Color(red: 0.17, green: 0.32, blue: 0.27))
                            .overlay { Rectangle().stroke(.yellow, lineWidth: 2) }
                            .overlay { if !open { Text("\(index + 1)").font(.caption.bold()).foregroundStyle(.white) } }
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(editing)
                        .frame(width: region.width * geometry.size.width, height: region.height * geometry.size.height)
                        .position(x: (region.x + region.width / 2) * geometry.size.width, y: (region.y + region.height / 2) * geometry.size.height)
                        .accessibilityLabel(open ? String(localized: "重新遮盖区域 \(index + 1)") : String(localized: "揭晓区域 \(index + 1)"))
                        .accessibilityIdentifier("study.mask." + region.id)
                }
                if let drag { Rectangle().fill(.yellow.opacity(0.35)).overlay { Rectangle().stroke(.yellow, lineWidth: 2) }
                    .frame(width: drag.width, height: drag.height).position(x: drag.midX, y: drag.midY).allowsHitTesting(false) }
                if editing {
                    Color.clear.contentShape(Rectangle()).gesture(DragGesture(minimumDistance: 8)
                        .onChanged { value in drag = rectangle(value, size: geometry.size) }
                        .onEnded { value in
                            defer { drag = nil }
                            guard regions.count < 32, let rect = rectangle(value, size: geometry.size), rect.width >= 8, rect.height >= 8 else { return }
                            onRegions?(regions + [.init(x: rect.minX / geometry.size.width, y: rect.minY / geometry.size.height,
                                width: rect.width / geometry.size.width, height: rect.height / geometry.size.height)])
                        }).accessibilityIdentifier("study.masks.canvas." + block.id)
                }
            }
        }.aspectRatio(image.size.width / max(1, image.size.height), contentMode: .fit)
            .background(.white).accessibilityElement(children: .contain)
            .accessibilityIdentifier("study.block.image." + block.id)
    }
    private func rectangle(_ value: DragGesture.Value, size: CGSize) -> CGRect? {
        guard size.width > 0, size.height > 0 else { return nil }
        let a = CGPoint(x: min(max(0, value.startLocation.x), size.width), y: min(max(0, value.startLocation.y), size.height))
        let b = CGPoint(x: min(max(0, value.location.x), size.width), y: min(max(0, value.location.y), size.height))
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }
}

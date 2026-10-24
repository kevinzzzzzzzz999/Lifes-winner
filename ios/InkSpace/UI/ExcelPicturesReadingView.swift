import SwiftUI

/// A bounded, read-only picture index. The Office reader remains underneath so
/// closing this view returns to the original worksheet and scroll position.
struct ExcelPicturesReadingView: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var book: ExcelPictureBook?
    @State private var error: String?
    @State private var attempt = 0
    @State private var sheetID: String?
    @State private var pictureID: String?

    private var sheet: ExcelPictureBook.Sheet? {
        book?.sheets.first(where: { $0.id == sheetID }) ?? book?.sheets.first
    }
    private var pictureIndex: Int {
        sheet?.pictures.firstIndex(where: { $0.id == pictureID }) ?? 0
    }
    private var picture: ExcelPictureBook.Picture? {
        guard let sheet, sheet.pictures.indices.contains(pictureIndex) else { return nil }
        return sheet.pictures[pictureIndex]
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let book {
                    controls(book)
                    Divider()
                    if let picture {
                        if let id = picture.assetID, let asset = book.assets[id] {
                            ExcelPictureSurface(asset: asset).id(picture.id)
                        } else {
                            ContentUnavailableView(String(localized: "这张图片暂不能显示"), systemImage: "photo.badge.exclamationmark",
                                description: Text(Self.issueMessage(picture.issue)))
                                .accessibilityIdentifier("excelPictures.imageIssue")
                        }
                    } else {
                        ContentUnavailableView(String(localized: "本工作表没有可显示的嵌入图片"), systemImage: "photo.on.rectangle.angled",
                            description: Text("可切换工作表，或返回原表继续阅读。"))
                            .accessibilityIdentifier("excelPictures.empty")
                    }
                } else if let error {
                    VStack(spacing: 16) {
                        ContentUnavailableView(String(localized: "暂不能读取表内图片"), systemImage: "doc.badge.ellipsis", description: Text(error))
                        Button(String(localized: "重试")) { attempt += 1 }.buttonStyle(.bordered)
                    }.accessibilityIdentifier("excelPictures.error")
                } else {
                    ProgressView(String(localized: "正在读取表内图片…"))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(PadDesign.paper).foregroundStyle(PadDesign.ink).tint(PadDesign.accent)
            .navigationTitle(String(localized: "表内图片"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(String(localized: "返回原表"), systemImage: "chevron.left") { dismiss() }
                        .accessibilityIdentifier("excelPictures.close")
                }
            }
        }
        .task(id: "\(url.absoluteString)#\(attempt)") {
            book = nil; error = nil; sheetID = nil; pictureID = nil
            let source = url
            let worker = Task.detached(priority: .userInitiated) { try ExcelEmbeddedPictures.read(url: source) }
            do {
                let result = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
                try Task.checkCancellation()
                book = result
                sheetID = result.sheets.first?.id
            } catch is CancellationError { }
            catch {
                guard !Task.isCancelled else { return }
                if case ExcelPictureError.capacity = error {
                    self.error = String(localized: "文件或图片超过本机阅读用量上限，请用原应用查看；原表仍可继续阅读。")
                } else {
                    self.error = String(localized: "图片信息不完整，或文件暂不可读。可以重试，或返回原表；不会修改原文件。")
                }
            }
        }
    }

    private func controls(_ book: ExcelPictureBook) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(url.lastPathComponent).font(.caption).foregroundStyle(PadDesign.secondaryInk).lineLimit(1)
            HStack {
                Picker(String(localized: "工作表"), selection: Binding(get: { sheet?.id ?? "" }, set: { sheetID = $0; pictureID = nil })) {
                    ForEach(book.sheets) { sheet in Text(sheet.name).tag(sheet.id) }
                }.pickerStyle(.menu).disabled(book.sheets.isEmpty).accessibilityIdentifier("excelPictures.sheetPicker")
                Spacer(minLength: 4)
                if let sheet, !sheet.pictures.isEmpty {
                    Button { move(-1) } label: { Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44) }
                        .disabled(pictureIndex == 0).accessibilityLabel(String(localized: "上一张图片"))
                        .accessibilityIdentifier("excelPictures.previous")
                    Text("\(pictureIndex + 1) / \(sheet.pictures.count)").monospacedDigit().font(.subheadline)
                    Button { move(1) } label: { Image(systemName: "chevron.right").frame(minWidth: 44, minHeight: 44) }
                        .disabled(pictureIndex + 1 >= sheet.pictures.count).accessibilityLabel(String(localized: "下一张图片"))
                        .accessibilityIdentifier("excelPictures.next")
                }
            }
            if let picture, let sheet {
                Picker(String(localized: "图片"), selection: Binding(get: { picture.id }, set: { pictureID = $0 })) {
                    ForEach(Array(sheet.pictures.enumerated()), id: \.element.id) { index, item in
                        Text(item.name.isEmpty ? String(localized: "图片 \(index + 1)") : item.name).tag(item.id)
                    }
                }.pickerStyle(.menu).accessibilityIdentifier("excelPictures.picturePicker")
                Text(Self.location(picture.location)).font(.caption).foregroundStyle(PadDesign.secondaryInk)
                    .accessibilityIdentifier("excelPictures.location")
            }
            if (sheet?.warnings ?? 0) > 0 {
                Text("本工作表有部分图片无法读取，可继续查看其余图片。")
                    .font(.caption).foregroundStyle(.orange).accessibilityIdentifier("excelPictures.sheetWarning")
            }
            DisclosureGroup(String(localized: "显示范围")) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("按上方选定的工作表查看原图；这里的选择独立于原表。裁剪、旋转、图表和其他浮动对象请用原应用查看。")
                    if book.omittedObjects > 0 { Text("部分图片或其他对象未能显示，原表仍可继续阅读。") }
                    if book.hiddenSheets > 0 { Text("隐藏工作表未列入图片列表。") }
                }.font(.caption).foregroundStyle(PadDesign.secondaryInk)
            }.font(.caption).accessibilityIdentifier("excelPictures.scope")
        }.padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func move(_ delta: Int) {
        guard let sheet, sheet.pictures.indices.contains(pictureIndex + delta) else { return }
        pictureID = sheet.pictures[pictureIndex + delta].id
    }
    static func location(_ location: ExcelPictureBook.Location) -> String {
        switch location {
        case let .cells(from, to):
            return to.map { String(localized: "原表位置：\(from)–\($0)") } ?? String(localized: "原表位置：\(from)")
        case let .absolute(x, y):
            return String(localized: "原表绝对位置：\(Int(x.rounded()))、\(Int(y.rounded())) pt")
        case .unspecified: return String(localized: "原表位置未注明")
        }
    }
    static func issueMessage(_ issue: ExcelPictureBook.Issue?) -> String {
        switch issue {
        case .external: String(localized: "这是外部链接图片，未自动下载。请用原应用查看。")
        case .missing: String(localized: "文件中的图片引用缺失，原表内容保持不变。")
        case .tooLarge: String(localized: "这张图片过大，请用原应用查看。")
        case .unsupported: String(localized: "此图片格式暂不支持，请用原应用查看。")
        default: String(localized: "图片数据不完整，无法显示；可以继续阅读其他图片或返回原表。")
        }
    }
}

private struct ExcelPictureSurface: View {
    let asset: ExcelPictureBook.Asset
    @Environment(\.scenePhase) private var scenePhase
    @State private var image: UIImage?
    @State private var failed = false
    @State private var selectionEnabled = true
    @State private var model = ImageReadingSelectionModel()

    var body: some View {
        VStack(spacing: 0) {
            if let image {
                HStack(spacing: 12) {
                    Button(model.hasSelection ? String(localized: "结束选字") : String(localized: "选择文字"), systemImage: "text.cursor") {
                        if model.hasSelection { selectionEnabled = false }
                        else { selectionEnabled = true; model.reveal?() }
                    }.accessibilityIdentifier("excelPictures.selectText")
                    Button(String(localized: "复制所选"), systemImage: "doc.on.doc") { model.copy?() }
                        .disabled(!model.hasSelection).accessibilityIdentifier("excelPictures.copy")
                    Spacer(minLength: 0)
                }.buttonStyle(.bordered).padding(10)
                ImageReadingSurface(image: image, model: model, allowsTextSelection: selectionEnabled)
                    .accessibilityIdentifier("excelPictures.surface")
                if asset.frameCount > 1 {
                    Text("多帧图片仅显示第一帧。").font(.caption).foregroundStyle(.secondary)
                }
                Text(model.status).font(.caption).foregroundStyle(PadDesign.secondaryInk)
                    .lineLimit(2, reservesSpace: true)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                    .accessibilityIdentifier("excelPictures.status")
            } else if failed {
                ContentUnavailableView(String(localized: "这张图片暂不能显示"), systemImage: "photo.badge.exclamationmark",
                    description: Text(ExcelPicturesReadingView.issueMessage(.unreadable)))
                    .accessibilityIdentifier("excelPictures.decodeError")
            } else {
                ProgressView(String(localized: "正在读取图片…")).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: asset.id) {
            image = nil; failed = false
            let input = asset
            let worker = Task.detached(priority: .userInitiated) { try ExcelEmbeddedPictures.decode(input) }
            do {
                let decoded = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
                try Task.checkCancellation()
                image = UIImage(cgImage: decoded)
            } catch { if !Task.isCancelled { failed = true } }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { selectionEnabled = false } }
        .onDisappear { selectionEnabled = false }
    }
}

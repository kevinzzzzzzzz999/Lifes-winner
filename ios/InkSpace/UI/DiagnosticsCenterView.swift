import SwiftUI
import UniformTypeIdentifiers

@MainActor struct DiagnosticsCenterView: View {
    let center: DiagnosticsCenter
    @Environment(\.dismiss) private var dismiss
    @State private var confirmClear = false
    @State private var confirmRebuild = false
    @State private var report: DiagnosticReportPreview?
    @State private var reportFailed = false
    @State private var preparingReport = false

    init(center: DiagnosticsCenter? = nil) { self.center = center ?? .shared }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(String(localized: "问题会自动记录在此设备。报告不含笔记正文、文件名或路径、截图、密钥及服务器原始回复；不会自动上传。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(String(localized: "仅记录应用能够处理并已接入的问题，不保证记录所有崩溃。最多保留最近 200 类问题，同类问题合并次数。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let issue = center.storageIssue {
                    Section(String(localized: "记录存储提示")) {
                        Label(issue.message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        Button(String(localized: "重新读取")) { Task { await center.refresh() } }.accessibilityIdentifier("diagnostics.retry")
                        if issue == .invalidLog || issue == .changedOnDisk {
                            Button(String(localized: "保留损坏文件并新建记录")) { confirmRebuild = true }
                                .accessibilityIdentifier("diagnostics.rebuild")
                        }
                    }
                }
                Section {
                    Button(String(localized: "预览诊断报告"), systemImage: "doc.text.magnifyingglass") {
                        preparingReport = true
                        Task {
                            let data = await center.reportData()
                            preparingReport = false
                            if let data { report = .init(data: data) } else { reportFailed = true }
                        }
                    }.disabled(preparingReport).accessibilityIdentifier("diagnostics.previewReport")
                    Button(String(localized: "全部标为已读"), systemImage: "checkmark.circle") { Task { await center.markAllRead() } }
                        .disabled(center.unreadCount == 0).accessibilityIdentifier("diagnostics.markAllRead")
                    Button(String(localized: "清空问题记录"), role: .destructive) { confirmClear = true }
                        .disabled(center.events.isEmpty || center.storageIssue != nil).accessibilityIdentifier("diagnostics.clear")
                    if preparingReport { ProgressView(String(localized: "正在整理报告…")) }
                }
                Section(String(localized: "问题记录")) {
                    if !center.isLoaded { ProgressView(String(localized: "正在读取问题记录…")) }
                    else if center.events.isEmpty { Text(String(localized: "尚无已记录的问题。")) }
                    ForEach(center.events) { event in
                        NavigationLink {
                            DiagnosticEventDetail(event: event)
                                .task { await center.markRead(event.id) }
                        } label: { DiagnosticEventRow(event: event) }
                        .accessibilityIdentifier("diagnostics.event.\(event.code.rawValue)")
                    }
                }
            }
            .navigationTitle(String(localized: "问题中心")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("diagnostics.done") } }
            .task { await center.refresh() }
            .alert(String(localized: "清空问题记录？"), isPresented: $confirmClear) {
                Button(String(localized: "取消"), role: .cancel) { }.accessibilityIdentifier("diagnostics.clear.cancel")
                Button(String(localized: "清空"), role: .destructive) { Task { await center.clear() } }.accessibilityIdentifier("diagnostics.clear.confirm")
            } message: { Text(String(localized: "仅删除此设备的问题列表，不改变白板、资料或备份。已手动导出的报告不受影响。")) }
            .alert(String(localized: "新建问题记录？"), isPresented: $confirmRebuild) {
                Button(String(localized: "取消"), role: .cancel) { }
                Button(String(localized: "保留并新建")) { Task { await center.rebuildPreservingDamagedLog() } }
            } message: { Text(String(localized: "损坏文件会保留在本机，不会加入分享报告。最多保留三份，避免无限占用空间。")) }
            .alert(String(localized: "报告暂不可用"), isPresented: $reportFailed) { Button(String(localized: "完成"), role: .cancel) { } }
            .sheet(item: $report) { value in DiagnosticReportView(report: value) }
        }
    }
}

private struct DiagnosticEventRow: View {
    let event: DiagnosticEvent
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                if event.unread { Image(systemName: "circle.fill").font(.system(size: 7)).foregroundStyle(.blue).accessibilityLabel(String(localized: "未读")) }
                Text(event.code.title).font(.headline)
            }
            Text(event.operation.title + " · " + event.severity.title).font(.subheadline).foregroundStyle(.secondary)
            Text(String(localized: "已发生 \(event.occurrences) 次 · 最近 \(event.lastOccurredAt.formatted(date: .abbreviated, time: .shortened))"))
                .font(.caption).foregroundStyle(.secondary)
        }.padding(.vertical, 3)
    }
}

private struct DiagnosticEventDetail: View {
    let event: DiagnosticEvent
    var body: some View {
        List {
            Section {
                LabeledContent(String(localized: "操作"), value: event.operation.title)
                LabeledContent(String(localized: "严重级别"), value: event.severity.title)
                LabeledContent(String(localized: "重复次数")) { Text(String(event.occurrences)).accessibilityIdentifier("diagnostics.detail.occurrences") }
                LabeledContent(String(localized: "首次发生"), value: event.firstOccurredAt.formatted(date: .abbreviated, time: .standard))
                LabeledContent(String(localized: "最近发生"), value: event.lastOccurredAt.formatted(date: .abbreviated, time: .standard))
            }
            Section(String(localized: "维修参考信息")) {
                LabeledContent(String(localized: "事件代码"), value: event.code.rawValue)
                if let domain = event.errorDomain, let code = event.errorCode {
                    LabeledContent(String(localized: "错误域"), value: domain.rawValue)
                    LabeledContent(String(localized: "数字错误码"), value: String(code))
                }
                LabeledContent(String(localized: "应用版本"), value: event.environment.appVersion + " (" + event.environment.appBuild + ")")
                LabeledContent(String(localized: "系统版本"), value: event.environment.osVersion)
                LabeledContent(String(localized: "随机记录编号"), value: event.id.uuidString)
                Text(String(localized: "记录编号只用于区分这条问题，不是设备标识。原始错误文字没有保存。"))
                    .font(.footnote).foregroundStyle(.secondary)
            }.textSelection(.enabled)
        }.navigationTitle(event.code.title).navigationBarTitleDisplayMode(.inline)
    }
}

private struct DiagnosticReportPreview: Identifiable {
    let id = UUID()
    let data: Data
    var text: String { String(decoding: data, as: UTF8.self) }
}
private struct DiagnosticReportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
private struct DiagnosticReportView: View {
    let report: DiagnosticReportPreview
    @Environment(\.dismiss) private var dismiss
    @State private var exportPresented = false
    @State private var exportFailed = false
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(String(localized: "请先审阅下方内容。只有你选择系统分享或导出时，报告才会离开问题中心；应用没有自动接收服务。"))
                    .font(.footnote).foregroundStyle(.secondary)
                HStack {
                    ShareLink(item: report.text) { Label(String(localized: "分享报告"), systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("diagnostics.shareReport")
                    Button(String(localized: "导出报告"), systemImage: "square.and.arrow.down") { exportPresented = true }
                        .accessibilityIdentifier("diagnostics.exportReport")
                }.buttonStyle(.bordered)
                ScrollView([.vertical, .horizontal]) {
                    Text(report.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("diagnostics.reportJSON")
                }
            }.padding()
            .navigationTitle(String(localized: "诊断报告预览")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("diagnostics.report.done") } }
            .fileExporter(isPresented: $exportPresented, document: DiagnosticReportDocument(data: report.data), contentType: .json,
                          defaultFilename: "diagnostics-report") { result in
                if case .failure(let error) = result {
                    let ns = error as NSError
                    if !(error is CancellationError) && !(ns.domain == NSCocoaErrorDomain && ns.code == NSUserCancelledError) { exportFailed = true }
                }
            }
            .alert(String(localized: "报告导出未完成，请重试。"), isPresented: $exportFailed) { Button(String(localized: "完成"), role: .cancel) { } }
        }
    }
}

# 文档、PDF 批注和离线公式

本目录服务于原生 iPad App，并与 Obsidian 配套插件共享白板文件。Swift 源文件已纳入 Xcode 工程；`Resources/Math` 与 `Resources/Markdown` 均作为文件夹资源打包，保留页面、脚本、样式和 `Math/fonts/` 的目录结构；Markdown 共用 Math 字体，不复制第二套。

## 文件选择与异步导入

`DocumentLibrary(rootURL:)` 接收文件夹选择器或书签恢复所得的仓库 URL，并持有自己的安全作用域访问。文档预览期间应保留 library。它是主 actor 对象，但目录枚举、等待文件提供者交付内容、复制和 PDF 页信息读取在后台串行队列执行，使用 `NSFileCoordinator` 协调访问。

- `enumerateDocuments() async -> [VaultDocument]` 返回 PDF、DOC/DOCX、XLS/XLSX、PPT/PPTX 和 MD/MARKDOWN。目录或元数据读取、路径解析等失败通过 `enumerationWarning` 展示。跳过隐藏项、包内部和符号链接项。
- `VaultDocumentPicker(library:action:onSelect:onBrowseFiles:)` 支持常驻搜索、多选、全选当前搜索结果、刷新，以及明确的“添加所选 / 展开所选”确认；确认回调返回 `[VaultDocument]`。空列表也可以进入“从文件 App 选取”。选择以相对路径标识，返回顺序稳定。
- `SystemDocumentPicker(directoryURL:onSelect:onCancel:)` 使用系统文件选择器多选原文件，`asCopy: false`。这是打开文件的授权入口；是否需要复制由 library 根据仓库边界决定。
- `prepareDocuments(_:progress:) async throws` 准备库内文件；`importDocuments(from:progress:) async throws` 接受系统选取的 URL。两者等待云端文件可读后继续原操作，提供进度和取消，不要求用户下载后再返回重新添加。
- **同一授权仓库中的文件直接引用原件。** 仓库外文件复制到 `Attachments/InkSpace/<本次导入 UUID>/`；不移动源文件，不覆盖已有附件，同名文件分配不同名称。取消或失败时尽力清理本次新建目录。

取消会停止本次应用操作、取消协调等待，并在逐文件、逐页和复制分块之间检查取消状态；它不承诺撤销系统已经启动的全部 iCloud 下载。文件提供者未同步目录、授权失效或离线时仍可能无法列出或读取文件。模块不会猜测隐藏 `.icloud` 占位文件的真实路径，也不能仅凭空列表断言云端没有文件；可用系统文件选择器直接选取。

`VaultPathResolver.resolve(relativePath:within:)` 拒绝绝对路径、父级路径、空路径段和逃出授权目录的符号链接。协调后的根目录与子 URL 使用一致的标准化规则，处理 `/var` 与 `/private/var` 一类别名。路径检查不替代系统授权，也不保证抵挡其他进程恶意并发替换路径。

## PDF 展开、预览与 Office 边界

`makeReferenceItem(for:at:)` 创建收起的单个文档引用；添加文件不自动展开。`expandPDF(relativePath:at:)`、兼容入口 `expandOfficeViaSiblingPDF(relativePath:at:)` 和 `expandDocuments(_:at:options:canvasSize:progress:)` 为异步接口。展开在一次完整批次中按相对路径及页码稳定排列，并去重最终指向同一 PDF 的项。默认垂直、100%，支持水平 / 网格及 25%–200% 比例；首张页面左上角保持指定位置，空间不足明确拒绝，不自动总览。

展开保存 **从 1 开始的页码**、PDF 呈现文件相对路径和页面矩形。读取 cropBox，规范化旋转后以 90° / 270° 交换宽高。基础页宽 720，统一缩放保留页面比例；网格列数由用户选择。调用方传入当前白板的实际 canvasSize，避免旧范围白板越界。2,000 页保存为引用与几何记录，不拆分原 PDF，不提前生成 2,000 张图片；再次主动展开可创建新的页面卡片，不是全白板去重操作。

`thumbnail(item:completion:)` 只应对可见及邻近卡片调用，完成回调返回主 actor。PDF 文档缓存最多两个；图片缓存显式淘汰至最多 32 张、48 MiB。此限额不包含系统缓存或 UI 仍持有的图片。缓存键包含源文件修改时间、大小、页码及当前批注所属白板；`clearCache()` 可主动刷新。Office 缩略图使用 Quick Look；原文件预览使用 `VaultQuickLookPreview`，PDF 指定页阅读使用 `PDFSourceView`。

**0.4.0 新增 Word / PowerPoint 阅读版转换，不提供 Office 原件编辑器。** DOC/DOCX/PPT/PPTX 使用公开 WebKit/UIKit 打印能力；Word 按系统阅读排版重流，不保证原 Word 的页码、字体或浮动对象版式。PPT 检查系统提供的幻灯片完整性并按静态页打印；动画不保留，无法确认完整性时停止。需要精确保真时，应从 Office / Keynote 导出 PDF。Excel 仍使用同目录、同主文件名的 PDF 展开，不提供单元格编辑。

`SourceDocumentRenderStore.snapshot(relativePath:maximumBytes:)` 协调读取精确源快照并在读取前检查大小。Office 原件和最终发布的 PDF 上限各 128 MiB；Markdown 原文上限 2 MiB。生成的 PDF 保存在原文旁，文件名含来源、版本与依赖身份的摘要；PDF subject 记录出处。相同身份复用已有 PDF 且不重写已有批注；新原文 / 图片 / 排版版本发布新文件，旧版保留。发布前再次比对原文与图片摘要，拒绝不一致来源。同名无关文件不会覆盖，路径及符号链接受限。

`BoardItem.sourcePath` 始终指向可手写 PDF；`originalSourcePath` 与可选 `originalSourceSHA256` 保留原文关联。只有显式 Markdown 保存会编辑文本，Office 原文不会成为 PDF 写回目标。原文入口不携带 PDF 页码，批注版入口使用页面编号；旧 nil 字段保持旧 PDF 单路径行为。移动、重命名或更换原件后可能需要重新关联。

展开批次使用 operationID 记录真实新建的呈现 PDF；取消、转换或布局失败时，回滚只删除该批次新建、且当前字节仍等于初始摘要的文件。复用、提交或已被其他应用改动的 PDF 保留。成功后清除回滚记录；原有白板仅在整批完成并通过验证后接收新页面。切板会取消导入任务。系统同步调用与 iCloud 下载不保证立刻停止。

## Markdown 原文与 PDF 阅读页

`MarkdownDocumentService` 协调读取 / 保存 UTF-8 原文，保留 BOM、首选换行和未编辑时的完整字节。保存重新比对 SHA；冲突不覆盖，编辑器保留草稿。`MarkdownDocumentView` 提供“阅读 / 原文 / 保存原文”，修改原文不会重排已有手写页，需要重新添加原文并展开来产生新版。

排版在无持久状态的离线 WKWebView 中完成，使用随包 Marked 与 KaTeX。支持标题、列表、任务、表格、代码、数学公式、受限本地图片及链接；原始 HTML 按文本显示，不执行脚本、Obsidian 插件或递归嵌入笔记。远程图片不会下载，缺失 / 不支持的图片返回占位和 warning。

每次最多 128 个图片引用，单图 8 MiB，原图合计 32 MiB；原图最多 4000 万像素，缩至最长边 1600，网页 data URL 合计最多 32 MiB。Markdown 打印最多 2,000 页 / 128 MiB / 30 秒，页间退出 UIKit 绘图栈并让出线程以处理取消；单页打印和系统布局仍是同步调用。正文链接并非可点击注释，PDF 文末“文中链接”页提供标准 URL 注释入口。详细子集与资源许可证见 [Markdown 资源说明](../Resources/Markdown/README.md)。

## 白板保存、PDF 原件写回与 Obsidian

`BoardStore` 先保存原生白板 `.inkspace.json`，其中保留 PencilKit 笔迹、分组、位置、公式原文、链接和视口。`Core/BoardWebExporter` 将主笔迹与分组笔迹统一到世界坐标，生成有采样与容量上限的 Web 预览数据；原生笔迹仍是可编辑数据源。旧分组解码失败等派生导出问题不会阻止原生数据保存；此时跳过 PDF 写回并显示错误。

`PDFAnnotationWritebackService.synchronize(...) async` 把 PDF 页面卡片范围内的手写投影为源 PDF 的标准墨迹注释，处理页面位置、裁剪、旋转及笔迹遮罩。它不把文字卡片、公式卡片或整个白板转换成 PDF 内容，也不将 PDF 注释导回可编辑的 PencilKit 笔迹。PDF 墨迹是导出表达，复杂 PencilKit 纹理以原生白板为准。

写回按白板 UUID 标识并替换本板注释，保留其他来源的注释。归属标识使用 PDF 注释字段，并保留严格格式的 `Contents` 后备标记，以应对 PDFKit 丢弃新写入标识字段的情况。序列化后重新读取并核对自己的注释以及其他注释；验证失败、源文件并发变化、签名、加密、只读、无注释权限或无效页等情况拒绝覆盖，返回具体文件错误。写入使用文件协调、源内容摘要检查和原子文件替换。

当前 `BoardStore` 集成显式设置 `createBackupIfMissing: false`，不会为每次写回自动额外复制 PDF。服务保留可选备份参数供其他调用者使用。写回是对源 PDF 的实际修改，原生白板先行保存不等于自动保存一份原 PDF 历史版本。

`DocumentLibrary.annotationOwnerToHide` 设为当前白板 UUID 时，仅在缩略图的内存 PDF 页中隐藏本板注释，避免它们与可编辑笔迹重复显示；缓存键随归属变化。这个过滤后的 PDF 永不写盘。直接打开源 PDF 阅读时显示原文件上的全部注释。

`Core/VaultFileIO.ensureObsidianNote` 在白板旁创建普通 Markdown 入口，使用 Obsidian `%% ... %%` 隐藏标记和 `inkspace` 代码块引用白板 JSON。它保留现有用户笔记，必要时选用其他文件名；仅迁移内容完全匹配的旧生成模板。入口本身不复制附件。配套插件据此读取页面引用及 Web 笔迹预览。

保存顺序为原生 JSON、Markdown 入口、PDF 写回，再更新 JSON 中的 PDF 内容摘要。未完成的摘要有待同步标记，失败的联动可重试。切换白板等待正在进行的保存和后续阶段；检测到外部修改时停止覆盖并保留冲突副本。iCloud 对这些文件的传输不是跨文件事务，当前设备保存完成不代表其他设备已经同时收到全部文件。

## 离线公式

`FormulaRenderer(bundle:)` 提供 `render(latexText:fontSize:colorHex:completion:)` 和 `image(latexText:) async throws -> UIImage`。使用官方 KaTeX **0.18.7** 发布包；来源及摘要见 `Resources/Math/PROVENANCE.json`，许可见同目录的 `LICENSE-KaTeX.txt`。包含发布包脚本、样式和字体，未执行 npm 安装脚本。

公式不连接 CDN、不上传内容；原文作为 `callAsyncJavaScript` 参数传入，KaTeX 使用 `trust: false`，资源页 CSP 禁止网络连接和图片。排版结果通过内存 PDF 捕获为图片，不在仓库创建临时 PDF 或 PNG。图片缓存最多 64 张、16 MiB；单式最多 20,000 字符，并限制字号、输出尺寸和像素数。

离屏 WebKit 页面可能暂停动画帧。渲染桥已移除对双重 `requestAnimationFrame` 的依赖，改为触发布局、等待字体后读取实际尺寸。超时显示“刷新预览后重试”；`clearCache()` 在已有加载或渲染错误时创建新的非持久 WKWebView，清除失败页面及未完成脚本状态，再加载离线资源。加载中或失败时仍保留并显示 LaTeX 原文及错误。

KaTeX 支持数学排版子集，不是任意 TeX 文档编译器，不支持任意第三方宏包，也不提供手写识别。

## 历史版本已验证范围（0.2.x；当时组件记录）

本项目已使用 Xcode 26.6 完成 iOS 构建、签名和真实 iPad 安装运行。以下是针对实际生产组件进行的独立 Mac / Mac Catalyst 验证，不应作为所有 iPad 性能、文件提供者或网络条件的保证：

- 真实 PDFKit 读取 2,000 页合成 PDF 并生成引用布局；裁剪页包含 0° / 90° / 180° / 270° 及负角度规范化验证。
- 实际目录枚举覆盖路径别名、受支持格式、隐藏项和越界符号链接；协调等待期间主 actor 仍可响应。多选导入验证同仓库零复制、仓库外同名附件分别保存且源内容摘要不变，以及等待取消和本批次清理。
- 缩略图验证仅隐藏本板注释、保留其他注释，清除隐藏归属后恢复显示，源 PDF 内容摘要不变。PDF 写回另有序列化和注释保留检查；未声称任意第三方 PDF 都可安全写回。
- 实际 `BoardStore` 保存检查覆盖旧分组解码失败仍保留原生数据、切板等待后续 PDF 阶段、两次 JSON 写入之间发生外部修改后停止覆盖并保留冲突版本。该检查包含联动重试标记；其后 Markdown 标记从 HTML 注释改为 Obsidian 隐藏注释，属于单独的模板调整。
- 离屏公式修复前后对照：旧桥确实超时，修复后简单公式、积分和矩阵生成图片并经视觉检查；非法命令、缓存及真实超时后重建 WKWebView 的恢复流程通过。此项记录为 Mac Catalyst，不冒充最终 iPad 公式验收结果。

最终真机操作与同步验收以项目交付记录为准。2,000 页的实际交互表现仍取决于 PDF 复杂度、当前可见页、笔迹量、设备内存及 iCloud 状态。

## 官方参考

- [Apple：访问安全作用域 URL](https://developer.apple.com/documentation/foundation/url/startaccessingsecurityscopedresource())
- [Apple：NSFileCoordinator](https://developer.apple.com/documentation/foundation/nsfilecoordinator)
- [Apple：PDFKit](https://developer.apple.com/documentation/pdfkit)
- [Apple：Quick Look 预览](https://developer.apple.com/documentation/quicklook/qlpreviewcontroller)
- [Apple：WKWebView PDF 捕获](https://developer.apple.com/documentation/webkit/wkwebview/createpdf(configuration:completionhandler:))
- [WebKit：非活动页面与动画帧暂停](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/)
- [KaTeX API](https://katex.org/docs/api) 与 [配置选项](https://katex.org/docs/options)

## 0.2.1 目录浏览更新

添加文件现在直接呈现系统 UIDocumentPickerViewController，directoryURL 使用已授权的仓库目录，保留系统的 iCloud 位置、上层/下层导航与多选。文件选项中的自定义列表改为非递归目录浏览；DocumentLibrary.listDirectory(relativePath:) 返回本次目录的 folders、documents 与独立 warning，不扫描整库。根路径为空字符串，不能越过授权仓库；需要其他位置时转系统浏览器。

自定义选择以仓库相对路径为键跨文件夹保留，支持路径跳转、上一级和已选列表；同名不同目录是不同项。搜索与全选只影响当前目录。异步结果按路径和请求标识核验，取消或过期结果不更新界面；局部读取失败不清空其他目录的选项。进入系统浏览器后确认时，会合并此前库内勾选与系统所选文件，再统一去重和准备。

目录 API 已用生产 DocumentLibrary 在 Mac Catalyst 验证多层目录、自然排序、空目录、同名文件、非递归、路径/符号链接边界和取消。真机结果见根目录验证记录。

# 人生赢家 Obsidian Companion 0.6.0

此目录为可直接安装、可编辑的 JavaScript 插件源码；无需 TypeScript 编译或下载额外依赖。手动安装说明见下文，开发与验证步骤见 [伴侣构建说明](../../docs/obsidian-build.md)。项目代码按仓库根目录的 [MIT 开源许可证](../../LICENSE) 发布。Obsidian 主程序及其 API 由各自权利人提供，不包含在本仓库中。

This directory contains the editable JavaScript plugin and its installable files. No TypeScript build or extra runtime dependency is required. See the [development and verification guide](../../docs/obsidian-build.md). Project code is covered by the repository’s [MIT license](../../LICENSE); Obsidian itself is distributed separately by its owners.

## English

Browse 人生赢家 boards in the same Obsidian vault: pan and zoom through handwriting, PDF pages, text, LaTeX, connections, and pins. The companion reads board files; drawing and editing the board take place in the native iPad app. It does not upload your documents or translate their contents.

**Language and installation.** Obsidian **1.8.7 or later** is required. The plugin follows Obsidian’s configured language using the public [`getLanguage()` API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts). Simplified Chinese uses the Chinese interface; English and other languages use the English interface. Traditional Chinese is not translated in this release and falls back to English. The app name stays **人生赢家**. After changing Obsidian’s language, restart Obsidian or disable and re-enable the plugin to refresh existing controls and commands.

Place `main.js`, `manifest.json`, and `styles.css` in your vault’s plugin directory, normally `.obsidian/plugins/inkspace-companion/`, and enable **人生赢家** in Community plugins. Update those three files together. No additional runtime packages are needed.

**Open a board.** Give the native iPad app access to the same actual vault folder as Obsidian. Open the `.md` entry generated beside a board, use the ribbon’s **Open 人生赢家 board** action, run **Choose board**, or select **Preview in 人生赢家** from an `.inkspace.json` file’s menu. The companion does not take over ordinary `.json` files. **Write in 人生赢家** opens the native app; **Open full view** opens an embedded board in its own tab.

**Create a board on iPad.** Long-press a course folder and choose **New 人生赢家 board in this folder**. The native app creates the board in that directory, beside folders such as `Week 01`; no source PDF is required. The vault root is also a valid location. Alternatively, long-press a source file and choose **New 人生赢家 board** to start beside that file. This launches native only after your menu click. The native app checks the authorized vault name; two folders with the same name must still be the same actual vault. The companion never creates the board JSON itself. Desktop and Android show an iPad guidance message instead of launching native.

Supported source extensions are `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.md`, `.markdown`, `.png`, `.jpg`, and `.jpeg`. In the native app, PNG/JPG images become writable pages directly. Other documents start as cards and can be expanded manually, vertically by default, with direction and scale options. Use 人生赢家 0.5.0 or later for these formats; 0.6.0 adds the bilingual interface. Word, PowerPoint, Excel, Markdown, and images use associated reading PDFs for handwriting. Their original source files are retained. Excel uses a cell reading layout and saved formula results, not a faithful reproduction of charts, merged cells, or all formatting. Export a PDF from the original app when faithful layout is needed or content cannot be converted reliably.

**Navigate and open sources.** Drag to pan, pinch to zoom, or use **−**, **+**, **Overview**, and **Saved view**. On a desktop, scroll to pan or hold Control/Command while scrolling to zoom. A focused board also supports arrow keys and `+`/`−`. The directory supports **Search files, items, and pins**, **Locate on board**, **Open original source**, and **Open annotated PDF**. Original Markdown opens in Obsidian’s editor without a PDF page fragment. Clicking a PDF page opens the exact annotated PDF page. Filenames containing Unicode, `#`, `%`, `&`, or spaces are preserved.

Embed a board in another note using its vault-relative path:

````markdown
```inkspace
{"file":"InkSpace/My board.inkspace.json"}
```
````

**Sync and preview limits.** File changes trigger a short, combined refresh, with an additional check every minute while Obsidian is active. An incomplete board sync keeps the last complete board visible. iCloud transfer and background suspension remain under the operating system’s control. For a matching PDF digest, handwritten marks already displayed in PDF annotations are not drawn twice. When the PDF has changed, the preview shows its current base contents with the current board’s handwriting and asks you to open the source to see all PDF annotations. Save again in the native app to update the recorded digest.

The viewer renders nearby details instead of a bitmap of the whole board: at most 60 detail nodes, two concurrent PDF jobs, 64 cached thumbnails within about 12.6 million pixels, and two idle PDF documents. A board may contain 2,000 pages without all pages being rendered at once. Limits are 64 MB per board, 128 MB per previewed PDF, 50,000 strokes, and one million total handwriting samples. Dense visible strokes may be simplified for display without editing saved data. A directory page contains at most 60 entries. Older boards without `webInk` show an explicit partial-screenshot warning. Web handwriting approximates exported strokes rather than reproducing every PencilKit brush pixel. Formulas use Obsidian’s public math API, with readable TeX retained if rendering fails.

**Printing and backups.** Letter frames, ordering, and clipping metadata remain compatible, but the companion does not draw print frames or perform printing, PDF/PNG/JPEG export, or backup restoration. Use the native iPad app for these actions. Editable backups and ordinary exported PDFs/image ZIPs are different formats. Restoring a native backup creates a separate board and attachment folder.

**Compatibility and verification.** Brand and interface translations do not rename your titles, text, files, paths, IDs, or JSON fields. The plugin ID `inkspace-companion`, `.inkspace.json` files, `inkspace` code blocks, and existing `inkspace://open?file=…` links remain unchanged. Both the older 1,000,000 and newer 8,000,000 square world-coordinate formats are supported with the same bounded viewport caches. New routes remain `inkspace://new?source=…&vault=…` or `inkspace://new?folder=…&vault=…`; each value is encoded exactly once and the empty `folder=` value means vault root.

Run the synthetic regression suite with Node.js: `node --test tests/companion.test.cjs` from the directory above this plugin. All **35 tests pass**: the original 27 cases explicitly select Chinese without changing their expectations, and eight additional cases exercise English menus, commands, launch routes, error handling, canvas and accessibility labels, directory actions, language fallback, and unchanged non-ASCII user data. These use mocked public Obsidian APIs and are not a claim of a real-device 0.6.0 UI or performance test. No installed plugin or real vault was changed during this verification.

## 简体中文

0.6.0 新增英文界面，按 Obsidian 的语言设置自动选择：简体中文显示中文，英文及其他语言回退英文。最低 Obsidian 版本升为 1.8.7，以使用公开语言接口；切换语言后请重启 Obsidian 或重新启用插件。品牌“人生赢家”、用户标题、正文、文件路径、协议和 JSON 标识保持原样，应用不会翻译或改写笔记内容。本版本已通过下述 35 项模拟公开 API 回归，0.6.0 实际设备界面与性能仍待验收。

在 Obsidian 中平移、缩放浏览同仓库的人生赢家白板：网页手写、PDF 页面、文字、LaTeX、连线和定位点。插件只读 JSON，书写仍在 iPad 原生应用中完成，不发送文件到网络。

将 `main.js`、`manifest.json`、`styles.css` 放入仓库配置目录的 `plugins/inkspace-companion/`，默认是 `.obsidian/plugins/inkspace-companion/`，然后在第三方插件设置中启用「人生赢家」。更新后重新启用插件或重启 Obsidian。

iPad 与 Obsidian 选择同一仓库。打开人生赢家生成的同名 `.md` 文件即可浏览；也可使用侧边图标、命令「选择白板」或 JSON 右键「在人生赢家中预览」。不接管普通 `.json` 扩展；Obsidian 不能直接打开 JSON 时，用 Markdown 入口或上述命令。

在 iPad 的 Obsidian 文件列表中，长按课程主文件夹（例如 `COURSE101`），选择「在此文件夹新建人生赢家白板」。原生应用会把新白板保存在这个主目录，与 Week、讲义、作业等子文件夹并列；无需先选择或绑定任何 PDF。也可在新建白板时手动选择保存目录。

在 iPad 的 Obsidian 文件列表中，长按课程 PDF、Word、Excel、PowerPoint、Markdown 或图片文件，选择「新建人生赢家白板」。这会打开 iPad 上的人生赢家，由原生应用在源文件所在文件夹内创建白板。PNG / JPG 直接放为可书写页面；其他文档先放收起卡片，之后可在白板中手动展开，默认竖排，可选择方向和比例。支持 `.pdf`、`.doc`、`.docx`、`.xls`、`.xlsx`、`.ppt`、`.pptx`、`.md`、`.markdown`、`.png`、`.jpg`、`.jpeg`。原源文件保留：直接 PDF 仍引用同一 PDF，其他格式由原生生成关联阅读 PDF 承载笔迹，不改写原 Word / PPT / Excel / 图片。Office 不再一律要求事先准备同名 PDF；需要原版式保真或遇到不支持内容时，仍可从原应用导出 PDF。桌面和 Android 的同名菜单会提示改用 iPad，不会创建文件或打开原生应用。

请先安装 0.5.0 或更新的人生赢家，并在原生应用授权与 Obsidian 相同的仓库。仓库名称不符时原生应用会停止新建，请核对文件夹授权；同名仓库仍应确认实际为同一个文件夹。插件只在你点此菜单时发出新建请求；展示菜单、打开源文档或预览旧白板都不会创建文件。若点击后未切换应用，请确认 iPad 已安装新版人生赢家。

拖动画布平移，双指捏合缩放；桌面可滚动平移、Control/Command 滚动缩放，也可用工具条 `−`、`+`、`总览`、`原生视口`。聚焦画布后支持方向键及 `+` / `−`。首次总览随嵌入布局适配尺寸，手动导航后不会因刷新改变位置。点击 PDF 打开原件对应页；下方目录可搜索和定位对象。

普通笔记可嵌入以下内容，路径相对仓库根目录：

````markdown
```inkspace
{"file":"InkSpace/我的白板.inkspace.json"}
```
````

「完整打开」进入独立白板标签。关闭嵌入后会释放查看器与缓存。

`webInk` 是原生导出的世界坐标笔迹，已含手写分组变换。插件显示颜色、线宽和透明度，不是 PencilKit 的像素级笔刷复刻。公式使用 Obsidian 接口，不支持时保留 TeX。网页链接仅允许 HTTP/HTTPS。旧白板无 `webInk` 时会明确提示手写只见局部截图，请用新版原生应用打开并保存。

原生手写可以写入 PDF 标准注释。为避免重复高亮，插件核对 `pdfAnnotationSources` 的 SHA-256；只有同版 PDF 的指定页实际显示后，才隐藏该页区域的网页手写。JSON 与 PDF 不同版或其他白板更新了同一原件时，仍显示当前 PDF 原文，暂时关闭 PDF 内注释，叠加本白板笔迹，并明确提示“原件全部注释请点开查看”。因此原文不会一直空白；其他白板及外部软件的注释仍可在原件查看。回原生应用保存更新摘要后，恢复全部 PDF 注释显示。

文件变化约 350 毫秒合并刷新，相关 PDF 更新清理缓存。每分钟另用 `vault.read` 检查打开的白板和引用文件状态，不用 `cachedRead`，不读无关文件内容。iCloud 传输与后台暂停由系统控制，不能保证任意文件几分钟内必达。JSON 未完整同步时保留上次完整画面。

总览显示轻量轮廓，放大后加载附近页面；2,000 个框格不代表每页内容已渲染。最多 60 个附近细节、2 个并发 PDF 渲染任务、64 张缩略图且不超过约 1,258 万像素，空闲 PDF 文档最多保留 2 份。单 PDF 预览上限 128 MB，白板读取上限 64 MB；超出仍能打开原件。网页笔迹上限 5 万笔、100 万点、每笔 5 万点；可见区域超过 20 万点会简化显示并提示，不改变 JSON。目录每页最多 60 项。

使用 Obsidian 公开的 [PDF 与公式接口](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) 和 [PDF.js 公开渲染接口](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)，无额外运行时依赖。受控测试涵盖格式、路径、2,000 对象限制、PDF 并发、摘要、刷新竞争和嵌入清理；不能替代复杂课程资料的设备性能验收。

现有 `InkSpace/` 文件夹、`.inkspace.json` 文件、`inkspace` 代码块、`inkspace://` 链接和插件目录 `inkspace-companion` 保持兼容，无需移动或重命名笔记。

开发兼容：兼容旧版 1,000,000 × 1,000,000 与新版 8,000,000 × 8,000,000 世界坐标白板；网页笔迹采样总上限仍为一百万点，屏幕预览缓存上限不变。插件 ID、`inkspace` Markdown 代码块和已有 `inkspace://open?file=…` 保持不变。文档新建入口使用 `inkspace://new?source=…&vault=…`；文件夹入口使用 `inkspace://new?folder=…&vault=…`，仓库根目录明确使用空的 `folder=`。两种目标互斥，精确的仓库相对路径及仓库名称分别进行一次 URL 编码。插件不生成空的 PencilKit JSON；新文件由原生应用创建。


## 原文与批注版

新版原生应用导出的 Word、PowerPoint、Excel、Markdown 或图片页面可保留原文与呈现 PDF 的关联。在白板下方的“搜索文件、节点与定位点”目录中，点 **打开原文** 查看原文件，点 **打开批注版** 打开关联 PDF 的对应页。直接点白板 PDF 页面仍打开该页的批注版。Markdown 原文通过 Obsidian 自身编辑器打开，可以继续修改文本；伴侣不会把手写转成 Markdown 内容，也不会改写原文。

在 iPad 的 Obsidian 文件列表中，Markdown `.md` / `.markdown` 也支持 **新建人生赢家白板** 菜单。需配合支持该格式的新版原生应用；本插件不在网页中执行 Office 转换。原文或关联 PDF 变化都会触发刷新，每分钟补查；原文改动后的 PDF 更新由原生应用处理，伴侣不会自行覆盖已有批注版。

数据兼容字段：`pdfPage.sourcePath` 始终为实际呈现和保存批注的 PDF 路径，`page` 为此 PDF 的页码。可选 `originalSourcePath` 指向原文，可选 `originalSourceSHA256` 记录生成呈现页时的原文摘要。两条路径均须是安全的仓库内相对路径。PDF 注释同步摘要和旧标识继续只使用 PDF 路径，原文入口不传 PDF 页码。未含新字段的旧白板保留“打开原件”行为。

旧伴侣可忽略新增字段继续显示 PDF；旧原生版本重存时可能丢失未知的关联字段，建议使用新版原生应用保存这些新格式白板。文档内容仅按文本显示，不执行 Markdown 中的用户 HTML 或脚本。


## 0.5.0 的打印与可编辑备份

原生应用新增 Letter 纸框、已有区域分页、PDF / PNG / JPEG 导出及本机备份。伴侣可安全读取并保留纸框字段和页序，但目前不在网页白板绘制纸框、不执行打印导出或备份恢复；请回 iPad 原生应用操作。恢复包生成独立白板和资料目录，不覆盖原板，新的 Markdown 入口可继续由本伴侣打开。普通 PDF 和图片 ZIP 不是可编辑备份。

Excel 页面是带行列坐标的单元格阅读版，使用文件已保存的公式结果；宽表分段，不代表原 Excel 样式、图表或合并单元格保真。图表、缺失结果等无法可靠呈现时，原生应用明确提示从 Excel 导出 PDF。图片按 EXIF 修正方向并受限降采样，透明部分显示白纸背景；图片原件仍可单独打开。

本目录的 35 项回归使用模拟的 Obsidian 公开 API；原有 27 项显式指定中文并保留原断言，另加 8 项英文与双语兼容回归。覆盖旧板、打印框字段、图片 / Excel 双入口、英文菜单、命令、错误、目录、画布与无障碍文案，以及用户中文、特殊字符路径不变。不能代替真机界面和复杂资料性能验证，不要把旧版本真机结果当作 0.6.0 已经通过。

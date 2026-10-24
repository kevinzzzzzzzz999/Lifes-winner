# Markdown 离线排版

将此 `Markdown` 文件夹作为文件夹资源打包，与现有 `Math` 文件夹同级。此目录的 `index.html` 只加载随应用附带的 Marked 17.0.5 和 KaTeX 0.18.7，不从网络取脚本、字体或图片。

- Marked 17.0.5：`marked.umd.js`；MIT 许可证见 `MARKED-LICENSE.md`。来源：https://github.com/markedjs/marked/tree/v17.0.5
- 现有 KaTeX 资源及其许可证保留在 `Math` 中。没有另复制一份字体。
- 支持标题、段落、列表、任务、表格、代码、普通链接、`[[仓库路径#标题|文字]]`、`![[仓库图片路径|文字]]`、`$行内公式$` 与独占行的 `$$公式$$`。
- 原始 HTML 按文本显示，不执行脚本、iframe 或远程图片。KaTeX `trust:false`；无效或不支持的公式保留其文字。不会执行 Obsidian 插件、Dataview、脚本或递归展开其他笔记。
- 普通本地图片按 Markdown 原文的目录解析，允许仍在仓库内的 `../`；wiki 图片按完整仓库相对路径解析。路径中有符号链接、越出仓库、格式受限或未下载的图片显示占位并返回 warnings。普通 URL 图片不会自动联网。
- 图片目前支持 PNG/JPEG/GIF 首帧/WebP/HEIC/HEIF/TIFF/BMP。SVG 与远程图片显示占位。每次最多 128 个图片引用，单文件 8 MiB，读取原图合计 32 MiB，传给网页的 data URL 合计 32 MiB；原图最多 4000 万像素并缩到最长边 1600 像素。依赖 SHA-256 对应实际读入的原图字节。
- Markdown 仅接受不超过 2 MiB 的 UTF-8（可带 BOM）；保存保留 BOM、首选换行类型及未编辑时完整原字节。保存时重新协调读取并比对原 SHA-256，外部改动会拒绝覆盖。编辑器内保留草稿，不会自动创建所谓“冲突副本”。
- PDF 为 A4，四边留白 36 pt，总共最多 2000 页/128 MiB，排版最多 30 秒。逐页之间退出 UIKit 绘图栈并让出主线程，以响应取消。单页绘制、WebKit 分页与最终 PDF 校验仍是系统同步调用，不能保证每个调用都能立即中断。
- UIKit 网页打印不保留正文 HTML 的 URL 注释，所以 PDF 文末增加“文中链接”页，使用标准 PDF URL 注释提供点击入口。正文中的蓝色链接不被宣称可直接点击。原文未因添加链接页而改变。
- 原文编辑与手写批注分开：保存只修改 Markdown 文本；旧的 PDF 批注页保持原版式与笔迹。重新展开才生成按新原文排版的页面。

API 位于 `Documents/MarkdownDocumentService.swift`。`renderPDF(snapshot:)` 使用传入快照，不重新读取 Markdown 本体，只读取受限的本地图片依赖；输出仅为内存中的 PDF bytes、pageCount、dependencyDigests、rendererVersion、warnings，由调用方保存派生 PDF 并复核源和图像 SHA。

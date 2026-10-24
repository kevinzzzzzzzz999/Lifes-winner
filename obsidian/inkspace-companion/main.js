"use strict";

const { Plugin, ItemView, MarkdownRenderChild, FuzzySuggestModal, TFile, TFolder, Notice, Platform, getLanguage,
  loadPdfJs, loadMathJax, renderMath, finishRenderMath } = require("obsidian");
const VIEW_TYPE = "inkspace-companion-view";
const SUFFIX = ".inkspace.json";
const PAGE_SIZE = 60;
const MAX_BOARD_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BASE64 = 16 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_STROKES = 50000;
const MAX_POINTS = 1000000;
const MAX_STROKE_POINTS = 50000;
const MAX_PDF_BYTES = 128 * 1024 * 1024;
const MAX_DETAIL_NODES = 60;
const MAX_CACHED_PIXELS = 12 * 1024 * 1024;
const POLL_MS = 60000;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const KINDS = new Set(["text", "formula", "document", "pdfPage", "inkGroup"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Obsidian public API, available since 1.8.7. Interface language is independent
// of user titles, source paths, protocol identifiers, and document contents.
function resolveLocale(language) {
  const code = typeof language === "string" ? language.toLowerCase().replace(/_/g, "-") : "";
  return /^(zh|zh-cn|zh-sg|zh-hans(?:-[a-z]+)?)$/.test(code) ? "zh" : "en";
}
function getLocale() {
  try { return resolveLocale(typeof getLanguage === "function" ? getLanguage() : "en"); }
  catch (_) { return "en"; }
}
function dateLocale() { return getLocale() === "zh" ? "zh-CN" : "en"; }
const MESSAGES = {
  "zh": {
    "kind.text": "文字",
    "kind.formula": "LaTeX",
    "kind.document": "文档引用",
    "kind.pdfPage": "PDF 页面",
    "kind.inkGroup": "手写分组",
    "kind.pin": "定位点",
    "error.boardPath": "请选择安全的仓库内 .inkspace.json 文件。",
    "error.sourceType": "请选择仓库内的 PDF、Word、Excel、PowerPoint、Markdown 或 PNG/JPG 图片。",
    "error.vaultName": "无法读取当前仓库名称，请重新打开仓库后重试。",
    "error.folderPath": "请选择仓库内的文件夹。",
    "error.boardObject": "白板不是有效的 JSON 对象。",
    "error.boardVersion": "不支持此白板格式版本；请更新伴侣插件。",
    "error.boardID": "白板标识无效。",
    "error.boardTitle": "白板标题无效。",
    "error.boardRevision": "白板修订编号无效。",
    "error.boardDate": "白板日期无效。",
    "error.canvasSize": "白板画布尺寸与格式不一致。",
    "error.viewport": "白板视口无效。",
    "error.directoryLimit": "白板目录缺失或超过本版预览容量。",
    "error.imageData": "白板图像数据类型无效。",
    "error.itemID": "白板节点类型或标识无效。",
    "error.duplicateItemID": "白板存在重复节点标识。",
    "error.itemData": "白板节点文字或手写数据类型无效。",
    "error.itemGeometry": "白板节点的位置或尺寸无效。",
    "error.sourcePath": "文档引用必须是安全的仓库内相对路径。",
    "error.originalPath": "原文引用必须是安全的仓库内相对路径。",
    "error.originalDigest": "原文版本摘要无效。",
    "error.annotatedPage": "批注页面必须引用关联 PDF。",
    "error.positivePage": "文档页码必须为正整数。",
    "error.missingPage": "PDF 页面节点缺少页码。",
    "error.edge": "导图连线指向无效节点。",
    "error.pin": "定位点数据无效。",
    "error.printDirectory": "打印页目录无效。",
    "error.printID": "打印页标识无效。",
    "error.duplicatePrintID": "打印页标识重复。",
    "error.printBounds": "打印页范围无效。",
    "error.printRatio": "打印纸张比例无效。",
    "error.printClip": "打印裁剪范围无效。",
    "error.printClipOutside": "打印裁剪范围超出纸张。",
    "error.pdfDirectory": "PDF 注释同步目录无效。",
    "error.pdfVersion": "PDF 注释同步版本无效。",
    "error.webInk": "网页手写格式或笔画数量无效。",
    "error.inkColor": "网页笔迹颜色或透明度无效。",
    "error.strokePoints": "网页笔迹采样数量无效。",
    "error.totalPoints": "网页手写超过一百万采样点上限。",
    "error.inkGeometry": "网页笔迹世界坐标或线宽无效。",
    "error.annotatedPDF": "批注版必须是关联 PDF。",
    "source.openOriginalText": "打开原文",
    "source.openAnnotated": "打开批注版",
    "source.openOriginal": "打开原件",
    "error.sourceMissing": "源文件不存在或尚未同步。请在同一仓库中确认文档路径。",
    "error.pdfPage": "PDF 页码无效。",
    "chooser.placeholder": "搜索白板名称或路径（.inkspace.json）",
    "error.embedSize": "白板嵌入内容过长。",
    "error.embedFormat": "请填写 {\"file\":\"InkSpace/名称.inkspace.json\"}。",
    "error.crypto": "当前环境不能核对 PDF 版本，请在原应用重新保存或打开原 PDF。",
    "error.pdfMissing": "PDF 尚未同步，点击可打开原文件。",
    "error.pdfSize": "此 PDF 超过 128 MB 预览上限，请打开原文件。",
    "error.pdfAPI": "此 Obsidian 未提供 PDF 预览接口，请更新或打开原文件。",
    "error.pdfReadLimit": "PDF 超过预览上限。",
    "pdf.changed": "PDF 已更新：此处显示当前原文与本白板笔迹；原件全部注释请点开查看。",
    "error.previewUpdated": "预览已更新。",
    "canvas.overview": "总览",
    "canvas.nativeViewport": "原生视口",
    "canvas.description": "只读白板。拖动平移，双指或按住 Control 滚动缩放，点击 PDF 打开对应页。",
    "canvas.pdfWaiting": "等待 PDF · 点击打开原件",
    "canvas.denseInk": " · 密集笔迹已简化显示",
    "board.choose": "选择白板",
    "board.refresh": "刷新",
    "board.write": "在人生赢家中书写",
    "board.fullView": "完整打开",
    "directory.summary": "搜索文件、节点与定位点",
    "directory.search": "搜索名称、正文、文件路径",
    "board.name": "人生赢家白板",
    "board.missing": "白板尚未同步或已移动。请选择同一仓库中的 .inkspace.json 文件重新连接。",
    "error.boardSize": "白板文件超过 64 MB 安全读取上限。",
    "error.boardReadLimit": "白板文件超过读取上限。",
    "board.untitled": "未命名白板",
    "board.inkNotExported": "未导出",
    "board.keptPrevious": "保留上次完整白板；",
    "board.legacy": "此旧白板尚未导出完整网页手写。对象、PDF 和连线可浏览；手写仅见下方保存时的视口截图。请用新版人生赢家打开并保存一次。",
    "board.legacySummary": "查看旧的局部手写截图（不是全画布）",
    "board.legacyAlt": "原生应用保存时的局部视口截图",
    "directory.locate": "在白板定位",
    "directory.openWeb": "打开网页",
    "directory.previous": "上一页",
    "directory.next": "下一页",
    "command.open": "打开人生赢家白板",
    "command.preview": "预览当前 .inkspace.json",
    "notice.choose": "请先选中 .inkspace.json，或使用“选择白板”。",
    "menu.newFolder": "在此文件夹新建人生赢家白板",
    "menu.preview": "在人生赢家中预览",
    "menu.newSource": "新建人生赢家白板",
    "notice.iPad": "请在 iPad 的 Obsidian 中使用此功能，并先安装人生赢家。",
    "error.folderMoved": "文件夹不存在或已移动，请重新选择文件夹。",
    "error.installApp": "请确认 iPad 已安装人生赢家。",
    "error.sourceMoved": "源文件不存在或已移动，请重新选择文件。",
    "canvas.pdfLoading": "第 {page} 页 · 加载中",
    "canvas.status": "{visible} 个附近对象 · {details} 个细节{dense}{error}",
    "board.capacity": "{items} 个对象 · {edges} 条连线 · {strokes} 笔网页手写 · {size}",
    "board.readOnly": "只读 · 保存于 {saved} · 已检查 {checked} · 文件变化自动刷新，每分钟补查",
    "board.readError": "{kept}暂时不能读取：{error}",
    "directory.pageSuffix": " · 第 {page} 页",
    "directory.originalPath": "原文：{path}",
    "directory.pagination": "第 {page}/{pages} 页 · {total} 项 · 每页最多 {limit} 项",
    "error.embedJSON": "白板嵌入不是有效的 JSON。",
    "error.boardJSON": "白板文件不是有效的 JSON。",
    "error.withBrand": "人生赢家：{error}",
    "error.newBoard": "未能新建白板：{error}",
    "canvas.zoomOut": "缩小",
    "canvas.zoomIn": "放大"
  },
  "en": {
    "kind.text": "Text",
    "kind.formula": "LaTeX",
    "kind.document": "Document reference",
    "kind.pdfPage": "PDF page",
    "kind.inkGroup": "Handwriting group",
    "kind.pin": "Pin",
    "error.boardPath": "Choose a safe .inkspace.json path within this vault.",
    "error.sourceType": "Choose a PDF, Word, Excel, PowerPoint, Markdown, or PNG/JPG file within this vault.",
    "error.vaultName": "The vault name is unavailable. Reopen this vault and try again.",
    "error.folderPath": "Choose a folder within this vault.",
    "error.boardObject": "The board is not a valid JSON object.",
    "error.boardVersion": "This board format version is not supported. Update the companion plugin.",
    "error.boardID": "The board identifiers are invalid.",
    "error.boardTitle": "The board title is invalid.",
    "error.boardRevision": "The board revision is invalid.",
    "error.boardDate": "The board date is invalid.",
    "error.canvasSize": "The canvas dimensions do not match this board format.",
    "error.viewport": "The board viewport is invalid.",
    "error.directoryLimit": "The board directory is missing or exceeds the preview limit.",
    "error.imageData": "The board image data has an invalid type.",
    "error.itemID": "A board item has an invalid type or identifier.",
    "error.duplicateItemID": "The board contains duplicate item identifiers.",
    "error.itemData": "A board item has invalid text or handwriting data.",
    "error.itemGeometry": "A board item has an invalid position or size.",
    "error.sourcePath": "Document references must use safe vault-relative paths.",
    "error.originalPath": "Original source references must use safe vault-relative paths.",
    "error.originalDigest": "The original source digest is invalid.",
    "error.annotatedPage": "Annotation pages must reference their associated PDF.",
    "error.positivePage": "Document page numbers must be positive integers.",
    "error.missingPage": "A PDF page item is missing its page number.",
    "error.edge": "A mind map connection refers to an invalid item.",
    "error.pin": "The pin data is invalid.",
    "error.printDirectory": "The print page list is invalid.",
    "error.printID": "A print page identifier is invalid.",
    "error.duplicatePrintID": "The print page identifiers are duplicated.",
    "error.printBounds": "The print page bounds are invalid.",
    "error.printRatio": "The print page aspect ratio is invalid.",
    "error.printClip": "The print clipping bounds are invalid.",
    "error.printClipOutside": "The print clipping bounds extend beyond the page.",
    "error.pdfDirectory": "The PDF annotation sync list is invalid.",
    "error.pdfVersion": "The PDF annotation sync version is invalid.",
    "error.webInk": "The web handwriting format or stroke count is invalid.",
    "error.inkColor": "A web handwriting stroke has an invalid color or opacity.",
    "error.strokePoints": "A web handwriting stroke has an invalid sample count.",
    "error.totalPoints": "Web handwriting exceeds the one-million-point limit.",
    "error.inkGeometry": "Web handwriting has invalid world coordinates or stroke widths.",
    "error.annotatedPDF": "The annotated version must be an associated PDF.",
    "source.openOriginalText": "Open original source",
    "source.openAnnotated": "Open annotated PDF",
    "source.openOriginal": "Open original file",
    "error.sourceMissing": "The source file is missing or has not synced. Check its path in the same vault.",
    "error.pdfPage": "The PDF page number is invalid.",
    "chooser.placeholder": "Search board names or paths (.inkspace.json)",
    "error.embedSize": "The board embed is too long.",
    "error.embedFormat": "Use {\"file\":\"InkSpace/Board.inkspace.json\"}.",
    "error.crypto": "This environment cannot verify the PDF version. Save again in the native app or open the original PDF.",
    "error.pdfMissing": "The PDF has not synced. Click to open the original file.",
    "error.pdfSize": "This PDF exceeds the 128 MB preview limit. Open the original file.",
    "error.pdfAPI": "PDF preview is unavailable in this Obsidian version. Update Obsidian or open the original file.",
    "error.pdfReadLimit": "The PDF exceeds the preview limit.",
    "pdf.changed": "The PDF has changed: this view shows the current source with this board’s handwriting. Open the original file to see all annotations.",
    "error.previewUpdated": "The preview has been updated.",
    "canvas.overview": "Overview",
    "canvas.nativeViewport": "Saved view",
    "canvas.description": "Read-only board. Drag to pan, pinch or hold Control while scrolling to zoom, and click a PDF to open its page.",
    "canvas.pdfWaiting": "Waiting for PDF · click to open original",
    "canvas.denseInk": " · Dense handwriting is simplified for display",
    "board.choose": "Choose board",
    "board.refresh": "Refresh",
    "board.write": "Write in life'winner",
    "board.fullView": "Open full view",
    "directory.summary": "Search files, items, and pins",
    "directory.search": "Search names, text, and file paths",
    "board.name": "life'winner board",
    "board.missing": "The board has not synced or has moved. Choose its .inkspace.json file in the same vault to reconnect.",
    "error.boardSize": "The board exceeds the 64 MB safe-read limit.",
    "error.boardReadLimit": "The board exceeds the read limit.",
    "board.untitled": "Untitled board",
    "board.inkNotExported": "not exported",
    "board.keptPrevious": "Keeping the last complete board. ",
    "board.legacy": "This older board has no complete web handwriting export. Items, PDFs, and connections are available; handwriting appears only in the saved-view screenshot below. Open and save it once in the latest life'winner app.",
    "board.legacySummary": "View the older partial handwriting screenshot (not the whole board)",
    "board.legacyAlt": "Partial screenshot of the view saved by the native app",
    "directory.locate": "Locate on board",
    "directory.openWeb": "Open web page",
    "directory.previous": "Previous",
    "directory.next": "Next",
    "command.open": "Open life'winner board",
    "command.preview": "Preview current .inkspace.json",
    "notice.choose": "Select an .inkspace.json file first, or use “Choose board”.",
    "menu.newFolder": "New life'winner board in this folder",
    "menu.preview": "Preview in life'winner",
    "menu.newSource": "New life'winner board",
    "notice.iPad": "Use this feature in Obsidian on an iPad with life'winner installed.",
    "error.folderMoved": "The folder is missing or has moved. Choose the folder again.",
    "error.installApp": "Make sure life'winner is installed on your iPad.",
    "error.sourceMoved": "The source file is missing or has moved. Choose the file again.",
    "canvas.pdfLoading": "Page {page} · loading",
    "canvas.status": "Nearby objects: {visible} · Detailed: {details}{dense}{error}",
    "board.capacity": "Objects: {items} · Connections: {edges} · Web strokes: {strokes} · {size}",
    "board.readOnly": "Read-only · saved {saved} · checked {checked} · refreshes on file changes and every minute",
    "board.readError": "{kept}Cannot read the board right now: {error}",
    "directory.pageSuffix": " · Page {page}",
    "directory.originalPath": "Original: {path}",
    "directory.pagination": "Page {page}/{pages} · {total} entries · up to {limit} per page",
    "error.embedJSON": "The board embed is not valid JSON.",
    "error.boardJSON": "The board file is not valid JSON.",
    "error.withBrand": "life'winner: {error}",
    "error.newBoard": "Could not create the board: {error}",
    "canvas.zoomOut": "Zoom out",
    "canvas.zoomIn": "Zoom in"
  }
};
function t(key, values = {}) {
  const template = MESSAGES[getLocale()][key] || MESSAGES.en[key];
  if (typeof template !== "string") throw new Error(`Missing interface message: ${key}`);
  // One pass: literal {tokens}, $&, HTML, and Unicode in user values stay intact.
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}
function kindName(kind) { return MESSAGES.en[`kind.${kind}`] ? t(`kind.${kind}`) : ""; }
function parseJSON(raw, errorKey) {
  try { return JSON.parse(raw); } catch (_) { throw new Error(t(errorKey)); }
}

function isSafeVaultPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") &&
    !/[\\:\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function isBoardPath(path) {
  return isSafeVaultPath(path) && path.endsWith(SUFFIX);
}

function nativeDeepLink(path) {
  if (!isBoardPath(path)) throw new Error(t("error.boardPath"));
  return `inkspace://open?file=${encodeURIComponent(path)}`;
}

function isDocumentSourcePath(path) {
  return isSafeVaultPath(path) && /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|md|markdown|png|jpg|jpeg)$/i.test(path);
}

function nativeNewDeepLink(source, vaultName) {
  if (!isDocumentSourcePath(source)) throw new Error(t("error.sourceType"));
  validateVaultName(vaultName);
  // Each query value is encoded once. Literal %2F, #, &, + and Unicode remain
  // part of the real source name; native URLComponents decodes each value once.
  return `inkspace://new?source=${encodeURIComponent(source)}&vault=${encodeURIComponent(vaultName)}`;
}

function validateVaultName(vaultName) {
  if (typeof vaultName !== "string" || !vaultName.length || /[\u0000-\u001f\u007f]/.test(vaultName)) throw new Error(t("error.vaultName"));
}

function isDirectoryPath(path) { return path === "" || isSafeVaultPath(path); }

function nativeNewFolderDeepLink(folder, vaultName) {
  if (!isDirectoryPath(folder)) throw new Error(t("error.folderPath"));
  validateVaultName(vaultName);
  // The empty folder value explicitly means vault root, not a missing target.
  return `inkspace://new?folder=${encodeURIComponent(folder)}&vault=${encodeURIComponent(vaultName)}`;
}

function exactVaultFolder(vault, path) {
  if (!isDirectoryPath(path)) return null;
  const folder = path === "" ? vault.getRoot() : vault.getAbstractFileByPath(path);
  return folder instanceof TFolder && (path === "" || folder.path === path) ? folder : null;
}

function safeWebURL(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.href : null;
  } catch (_) { return null; }
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function identifier(value) { return typeof value === "string" && UUID.test(value); }
function ensure(condition, message) { if (!condition) throw new Error(message); }

function validateBoard(board) {
  ensure(object(board), t("error.boardObject"));
  ensure(board.schemaVersion === 1, t("error.boardVersion"));
  ensure(identifier(board.id) && identifier(board.writerID), t("error.boardID"));
  ensure(typeof board.title === "string" && board.title.length <= 10000, t("error.boardTitle"));
  ensure(Number.isInteger(board.revision) && board.revision >= 0, t("error.boardRevision"));
  for (const key of ["createdAt", "updatedAt"]) {
    ensure(typeof board[key] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(board[key]) && Number.isFinite(Date.parse(board[key])), t("error.boardDate"));
  }
  ensure((board.canvasWidth === 1000000 || board.canvasWidth === 8000000) && board.canvasHeight === board.canvasWidth, t("error.canvasSize"));
  ensure(object(board.viewport) && finite(board.viewport.x) && finite(board.viewport.y) && finite(board.viewport.zoom) && board.viewport.zoom > 0, t("error.viewport"));
  for (const key of ["items", "edges", "pins"]) ensure(Array.isArray(board[key]) && board[key].length <= MAX_ENTRIES, t("error.directoryLimit"));
  for (const key of ["drawing", "previewPNG"]) ensure(board[key] == null || typeof board[key] === "string", t("error.imageData"));
  const ids = new Set();
  for (const item of board.items) {
    ensure(object(item) && identifier(item.id) && KINDS.has(item.kind), t("error.itemID"));
    const id = item.id.toLowerCase();
    ensure(!ids.has(id), t("error.duplicateItemID"));
    ids.add(id);
    ensure(typeof item.title === "string" && item.title.length <= 10000 && (item.text == null || (typeof item.text === "string" && item.text.length <= 100000)) && (item.url == null || typeof item.url === "string") && (item.inkData == null || typeof item.inkData === "string"), t("error.itemData"));
    ensure([item.x, item.y, item.width, item.height].every(finite) && item.x >= 0 && item.y >= 0 && item.width > 0 && item.height > 0 && item.x + item.width <= board.canvasWidth && item.y + item.height <= board.canvasHeight, t("error.itemGeometry"));
    ensure(item.sourcePath == null || isSafeVaultPath(item.sourcePath), t("error.sourcePath"));
    ensure(item.originalSourcePath == null || isSafeVaultPath(item.originalSourcePath), t("error.originalPath"));
    ensure(item.originalSourceSHA256 == null || (typeof item.originalSourceSHA256 === "string" && /^[a-f0-9]{64}$/i.test(item.originalSourceSHA256) && item.originalSourcePath != null), t("error.originalDigest"));
    // sourcePath keeps its original meaning: the actual PDF for rendering and annotations.
    ensure(item.originalSourcePath == null || item.kind !== "pdfPage" || isPDFSourcePath(item.sourcePath), t("error.annotatedPage"));
    ensure(item.page == null || (Number.isInteger(item.page) && item.page >= 1), t("error.positivePage"));
    ensure(item.kind !== "pdfPage" || Number.isInteger(item.page), t("error.missingPage"));
  }
  for (const edge of board.edges) {
    ensure(object(edge) && identifier(edge.id) && identifier(edge.from) && identifier(edge.to) && edge.from.toLowerCase() !== edge.to.toLowerCase() && ids.has(edge.from.toLowerCase()) && ids.has(edge.to.toLowerCase()), t("error.edge"));
  }
  for (const pin of board.pins) {
    ensure(object(pin) && identifier(pin.id) && typeof pin.title === "string" && [pin.x, pin.y, pin.zoom].every(finite) && pin.x >= 0 && pin.y >= 0 && pin.x <= board.canvasWidth && pin.y <= board.canvasHeight && pin.zoom > 0, t("error.pin"));
  }
  if (board.printFrames != null) {
    ensure(Array.isArray(board.printFrames) && board.printFrames.length <= 2000, t("error.printDirectory"));
    const frameIDs = new Set();
    for (const frame of board.printFrames) {
      ensure(object(frame) && identifier(frame.id), t("error.printID"));
      const id = frame.id.toLowerCase();
      ensure(!frameIDs.has(id), t("error.duplicatePrintID")); frameIDs.add(id);
      ensure([frame.x, frame.y, frame.width, frame.height].every(finite) && frame.x >= 0 && frame.y >= 0 && frame.width > 0 && frame.height > 0 && frame.x + frame.width <= board.canvasWidth && frame.y + frame.height <= board.canvasHeight, t("error.printBounds"));
      ensure(["portrait", "landscape"].includes(frame.orientation) && Math.abs(frame.width / frame.height - (frame.orientation === "portrait" ? 540 / 720 : 720 / 540)) <= 0.000001, t("error.printRatio"));
      if (frame.normalizedClip != null) {
        // CoreGraphics encodes CGRect as [[x,y],[width,height]].
        const clip = frame.normalizedClip;
        ensure(Array.isArray(clip) && clip.length === 2 && clip.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(finite)), t("error.printClip"));
        ensure(clip[0][0] >= 0 && clip[0][1] >= 0 && clip[1][0] > 0 && clip[1][1] > 0 && clip[0][0] + clip[1][0] <= 1.0000001 && clip[0][1] + clip[1][1] <= 1.0000001, t("error.printClipOutside"));
      }
    }
  }
  if (board.webInk != null) validateWebInk(board.webInk);
  if (board.pdfAnnotationSources != null) {
    ensure(Array.isArray(board.pdfAnnotationSources) && board.pdfAnnotationSources.length <= 2000, t("error.pdfDirectory"));
    for (const source of board.pdfAnnotationSources) {
      ensure(object(source) && isSafeVaultPath(source.sourcePath) && typeof source.sha256 === "string" && /^[a-f0-9]{64}$/i.test(source.sha256) && Array.isArray(source.pages) && source.pages.length <= MAX_ENTRIES && source.pages.every(page => Number.isInteger(page) && page >= 1), t("error.pdfVersion"));
    }
  }
  return board;
}

function validateWebInk(ink) {
  ensure(object(ink) && ink.version === 1 && Array.isArray(ink.strokes) && ink.strokes.length <= MAX_STROKES, t("error.webInk"));
  let count = 0;
  for (const stroke of ink.strokes) {
    ensure(object(stroke) && typeof stroke.color === "string" && HEX_COLOR.test(stroke.color) && finite(stroke.opacity) && stroke.opacity >= 0 && stroke.opacity <= 1, t("error.inkColor"));
    ensure(Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length <= MAX_STROKE_POINTS, t("error.strokePoints"));
    count += stroke.points.length;
    ensure(count <= MAX_POINTS, t("error.totalPoints"));
    for (const point of stroke.points) ensure(Array.isArray(point) && point.length === 3 && point.every(finite) && Math.abs(point[0]) <= 8000000 && Math.abs(point[1]) <= 8000000 && point[2] > 0 && point[2] <= 10000, t("error.inkGeometry"));
  }
  return ink;
}

function previewDataURL(value) {
  if (typeof value !== "string" || value.length > MAX_PREVIEW_BASE64 || value.length % 4 !== 0 || !value.startsWith("iVBORw0KGgo") || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return `data:image/png;base64,${value}`;
}

function pageEntries(board, query = "", page = 0, requestedSize = PAGE_SIZE) {
  const size = Math.max(1, Math.min(PAGE_SIZE, Math.floor(Number(requestedSize) || PAGE_SIZE)));
  const needle = String(query).trim().toLocaleLowerCase();
  const matches = [];
  for (const item of board.items) {
    if (!needle || [item.title, item.text || "", item.sourcePath || "", item.originalSourcePath || "", item.url || "", kindName(item.kind)].some(value => value.toLocaleLowerCase().includes(needle))) matches.push({ type: "item", value: item });
  }
  for (const pin of board.pins) {
    if (!needle || pin.title.toLocaleLowerCase().includes(needle) || kindName("pin").toLocaleLowerCase().includes(needle)) matches.push({ type: "pin", value: pin });
  }
  const pageCount = Math.max(1, Math.ceil(matches.length / size));
  const currentPage = Math.max(0, Math.min(pageCount - 1, Math.floor(Number(page) || 0)));
  return { entries: matches.slice(currentPage * size, (currentPage + 1) * size), total: matches.length, page: currentPage, pageCount, size };
}

function isPDFSourcePath(path) { return isSafeVaultPath(path) && /\.pdf$/i.test(path); }
function itemSourceTargets(item) {
  if (!item || !isSafeVaultPath(item.sourcePath)) return [];
  if (item.originalSourcePath != null) {
    ensure(isSafeVaultPath(item.originalSourcePath), t("error.originalPath"));
    if (item.originalSourcePath !== item.sourcePath) {
      ensure(isPDFSourcePath(item.sourcePath), t("error.annotatedPDF"));
      return [{ label: t("source.openOriginalText"), path: item.originalSourcePath }, { label: t("source.openAnnotated"), path: item.sourcePath, page: item.page }];
    }
  }
  return [{ label: t("source.openOriginal"), path: item.sourcePath, page: item.page }];
}
function referencedSourcePaths(board) {
  return [...new Set((board ? board.items : []).flatMap(item => [item.sourcePath, item.originalSourcePath]).filter(isSafeVaultPath))];
}

function exactVaultFile(vault, path) {
  if (!isSafeVaultPath(path)) return null;
  const file = vault.getAbstractFileByPath(path);
  return file instanceof TFile && file.path === path ? file : null;
}

async function openSourceFile(app, path, page) {
  const file = exactVaultFile(app.vault, path);
  if (!file) throw new Error(t("error.sourceMissing"));
  if (page != null && (!Number.isInteger(page) || page < 1)) throw new Error(t("error.pdfPage"));
  const leaf = app.workspace.getLeaf(true);
  // Resolve the exact TFile first: #, [] and % in real names cannot become link syntax.
  await leaf.openFile(file, page ? { eState: { subpath: `#page=${page}` } } : undefined);
}

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, callback, accessibleName = text) {
  const node = make("button", text);
  node.type = "button";
  node.setAttribute("aria-label", accessibleName);
  node.addEventListener("click", callback);
  return node;
}
function short(value, limit = 500) { return value.length > limit ? `${value.slice(0, limit)}…` : value; }
function bytes(value) { return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`; }

class BoardChooser extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.limit = PAGE_SIZE;
    this.setPlaceholder(t("chooser.placeholder"));
  }
  getItems() { return this.app.vault.getFiles().filter(file => isBoardPath(file.path)); }
  getItemText(file) { return file.path; }
  onChooseItem(file) { this.onChoose(file.path); }
}

function intersects(a, b) { return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y; }
function visibleRect(camera, width, height, margin = 0) {
  return { x: camera.x - (width / 2 + margin) / camera.zoom, y: camera.y - (height / 2 + margin) / camera.zoom, width: (width + margin * 2) / camera.zoom, height: (height + margin * 2) / camera.zoom };
}
function screenPoint(camera, width, height, x, y) { return { x: (x - camera.x) * camera.zoom + width / 2, y: (y - camera.y) * camera.zoom + height / 2 }; }
function clampZoom(zoom) { return Math.max(0.0001, Math.min(8, zoom)); }
function strokeBounds(stroke) {
  let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
  for (const [px, py, width] of stroke.points) { const h = width / 2; x = Math.min(x, px - h); y = Math.min(y, py - h); r = Math.max(r, px + h); b = Math.max(b, py + h); }
  return { x, y, width: r - x, height: b - y };
}
function sceneBounds(items, strokes) {
  let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
  for (const item of [...items, ...strokes]) { x = Math.min(x, item.x); y = Math.min(y, item.y); r = Math.max(r, item.x + item.width); b = Math.max(b, item.y + item.height); }
  return Number.isFinite(x) ? { x, y, width: Math.max(1, r - x), height: Math.max(1, b - y) } : null;
}
function fitCamera(bounds, width, height, fallback) {
  if (!bounds) return { x: fallback.x, y: fallback.y, zoom: clampZoom(fallback.zoom) };
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: clampZoom(Math.min(Math.max(1, width - 64) / bounds.width, Math.max(1, height - 64) / bounds.height, 2)) };
}
function chooseDetails(items, rect, camera, limit = MAX_DETAIL_NODES) {
  return items.filter(item => intersects(item, rect) && item.width * camera.zoom >= 48 && item.height * camera.zoom >= 22)
    .sort((a, b) => Math.hypot(a.x + a.width / 2 - camera.x, a.y + a.height / 2 - camera.y) - Math.hypot(b.x + b.width / 2 - camera.x, b.y + b.height / 2 - camera.y))
    .slice(0, Math.min(MAX_DETAIL_NODES, limit));
}
function parseEmbed(source) {
  ensure(typeof source === "string" && source.length <= 4096, t("error.embedSize"));
  const value = parseJSON(source, "error.embedJSON");
  ensure(object(value) && isBoardPath(value.file), t("error.embedFormat"));
  return value.file;
}
function sourceSignature(file) { return file ? `${file.stat.mtime || 0}:${file.stat.size}` : "missing"; }
function declarationFor(board, path) { return (board.pdfAnnotationSources || []).find(source => source.sourcePath === path); }
async function sha256(data) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error(t("error.crypto"));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
}

// Only referenced, nearby PDF pages are requested. No private Obsidian/PDF.js APIs.
class PDFPreviewCache {
  constructor(app, changed) {
    this.app = app; this.changed = changed; this.tiles = new Map(); this.docs = new Map(); this.queue = [];
    this.active = 0; this.epoch = 0; this.pixels = 0; this.closed = false; this.tasks = new Set(); this.wanted = new Set();
  }
  key(item, width, declaration) { return `${item.sourcePath}\u0000${item.page}\u0000${width}\u0000${declaration ? declaration.sha256 : "plain"}`; }
  peek(item, width, declaration) { const key = this.key(item, width, declaration); const tile = this.tiles.get(key); if (tile) { this.tiles.delete(key); this.tiles.set(key, tile); } return tile; }
  request(wanted) {
    this.wanted = new Set(wanted.map(job => this.key(job.item, job.width, job.declaration)));
    this.queue = this.queue.filter(job => this.wanted.has(job.key));
    for (const job of wanted.slice(0, MAX_DETAIL_NODES)) {
      const key = this.key(job.item, job.width, job.declaration);
      if (this.tiles.has(key) || this.queue.some(entry => entry.key === key) || [...this.tasks].some(entry => entry.key === key)) continue;
      this.queue.push({ ...job, key });
    }
    this.pump();
  }
  async document(path, declaration, epoch) {
    const existing = this.docs.get(path);
    if (existing) { existing.used = Date.now(); return existing.promise; }
    const record = { used: Date.now(), busy: 0, doc: null };
    record.promise = (async () => {
      const file = exactVaultFile(this.app.vault, path);
      if (!file || !path.toLowerCase().endsWith(".pdf")) throw new Error(t("error.pdfMissing"));
      if (file.stat.size > MAX_PDF_BYTES) throw new Error(t("error.pdfSize"));
      if (typeof loadPdfJs !== "function") throw new Error(t("error.pdfAPI"));
      const data = await this.app.vault.readBinary(file);
      if (data.byteLength > MAX_PDF_BYTES) throw new Error(t("error.pdfReadLimit"));
      record.matched = Boolean(declaration) && await sha256(data) === declaration.sha256.toLowerCase();
      record.annotationMode = declaration && !record.matched ? 0 : 1;
      record.warning = declaration && !record.matched ? t("pdf.changed") : "";
      if (this.closed || epoch !== this.epoch) throw new Error(t("error.previewUpdated"));
      const pdfjs = await loadPdfJs();
      const loading = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true });
      record.loading = loading;
      const pdf = await loading.promise;
      if (this.closed || epoch !== this.epoch) { await pdf.destroy(); throw new Error(t("error.previewUpdated")); }
      record.doc = pdf; return record;
    })();
    record.promise = record.promise.catch(error => { if (this.docs.get(path) === record) this.docs.delete(path); throw error; });
    this.docs.set(path, record);
    return record.promise;
  }
  pump() {
    while (!this.closed && this.active < 2 && this.queue.length) {
      const job = this.queue.shift(); const epoch = this.epoch;
      this.active++; this.tasks.add(job);
      this.render(job, epoch).finally(() => { this.active--; this.tasks.delete(job); this.trimDocs(); this.pump(); });
    }
  }
  async render(job, epoch) {
    let record, page;
    try {
      record = await this.document(job.item.sourcePath, job.declaration, epoch);
      record.busy++;
      page = await record.doc.getPage(job.item.page);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(job.width / original.width, 2048 / Math.max(original.width, original.height), Math.sqrt(1048576 / (original.width * original.height)));
      const viewport = page.getViewport({ scale: Math.max(0.001, scale) });
      const canvas = make("canvas"); canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
      // Public annotation mode: matched sources keep all annotations; changed sources show the current base PDF with current board webInk.
      job.task = page.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: record.annotationMode });
      await job.task.promise;
      if (this.closed || epoch !== this.epoch) { canvas.width = 0; return; }
      const tile = { canvas, pixels: canvas.width * canvas.height, matched: record.matched && job.declaration.pages.includes(job.item.page), warning: record.warning };
      this.tiles.set(job.key, tile); this.pixels += tile.pixels; this.trimTiles(); this.changed();
    } catch (error) {
      if (!this.closed && epoch === this.epoch) { this.tiles.set(job.key, { error: short(String(error.message || error), 180), pixels: 0 }); this.trimTiles(); this.changed(); }
    } finally { if (record) record.busy = Math.max(0, record.busy - 1); if (page && page.cleanup) { try { page.cleanup(); } catch (_) {} } }
  }
  trimTiles() {
    while (this.tiles.size > 64 || this.pixels > MAX_CACHED_PIXELS) {
      const key = this.tiles.keys().next().value; const tile = this.tiles.get(key); this.tiles.delete(key); this.pixels -= tile.pixels; if (tile.canvas) tile.canvas.width = 0;
    }
  }
  trimDocs() {
    const candidates = [...this.docs.entries()].filter(([, record]) => record.doc && !record.busy).sort((a, b) => a[1].used - b[1].used);
    while (this.docs.size > 2 && candidates.length) { const [path, record] = candidates.shift(); this.docs.delete(path); Promise.resolve(record.doc.destroy()).catch(() => {}); }
  }
  invalidate() {
    this.epoch++; this.queue = [];
    for (const job of this.tasks) if (job.task) job.task.cancel();
    for (const tile of this.tiles.values()) if (tile.canvas) tile.canvas.width = 0;
    for (const record of this.docs.values()) { if (record.loading) Promise.resolve(record.loading.destroy()).catch(() => {}); }
    this.tiles.clear(); this.docs.clear(); this.pixels = 0;
  }
  destroy() { this.closed = true; this.invalidate(); }
}

function drawStroke(context, stroke, step = 1) {
  const points = stroke.points.filter((_, index) => index % step === 0 || index === stroke.points.length - 1);
  context.fillStyle = stroke.color; context.globalAlpha = stroke.opacity;
  context.beginPath();
  if (points.length === 1) { context.arc(points[0][0], points[0][1], points[0][2] / 2, 0, Math.PI * 2); context.fill(); return; }
  const side = (index, sign) => {
    const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)], current = points[index];
    const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy) || 1;
    return [current[0] - dy / length * current[2] / 2 * sign, current[1] + dx / length * current[2] / 2 * sign];
  };
  points.forEach((_, index) => { const p = side(index, 1); if (index === 0) context.moveTo(...p); else context.lineTo(...p); });
  for (let index = points.length - 1; index >= 0; index--) context.lineTo(...side(index, -1));
  context.closePath(); context.fill();
}

class BoardViewer {
  constructor(app, host, onStatus) {
    this.app = app; this.onStatus = onStatus; this.host = host; this.closed = false; this.width = 800; this.height = 540;
    this.camera = { x: 500000, y: 500000, zoom: 1 }; this.pointers = new Map(); this.listeners = []; this.frame = null; this.formulaEpoch = 0; this.nodeElements = new Map();
    this.controls = make("div", undefined, "isc-canvas-controls");
    this.zoomLabel = make("span");
    this.controls.append(button("−", () => this.zoomAt(1 / 1.35), t("canvas.zoomOut")), button("+", () => this.zoomAt(1.35), t("canvas.zoomIn")), this.zoomLabel, button(t("canvas.overview"), () => this.fit()), button(t("canvas.nativeViewport"), () => this.nativeViewport()));
    this.stage = make("div", undefined, "isc-stage"); this.stage.tabIndex = 0; this.stage.setAttribute("aria-label", t("canvas.description"));
    this.base = make("canvas", undefined, "isc-base"); this.ink = make("canvas", undefined, "isc-ink"); this.overlay = make("div", undefined, "isc-nodes");
    this.stage.append(this.base, this.overlay, this.ink); host.append(this.controls, this.stage);
    this.cache = new PDFPreviewCache(app, () => this.schedule());
    this.listen(this.stage, "pointerdown", event => this.down(event)); this.listen(this.stage, "pointermove", event => this.move(event));
    this.listen(this.stage, "pointerup", event => this.up(event)); this.listen(this.stage, "pointercancel", event => this.up(event, true));
    this.listen(this.stage, "lostpointercapture", event => this.pointers.delete(event.pointerId));
    this.listen(this.stage, "wheel", event => { this.autoFit = false; event.preventDefault(); if (event.ctrlKey || event.metaKey) this.zoomAt(Math.exp(-event.deltaY * 0.008), event.offsetX, event.offsetY); else { this.camera.x += event.deltaX / this.camera.zoom; this.camera.y += event.deltaY / this.camera.zoom; this.schedule(); } }, { passive: false });
    this.listen(this.stage, "keydown", event => { if (["+", "=", "-", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { this.autoFit = false; event.preventDefault(); if (event.key === "-") this.zoomAt(1 / 1.25); else if (event.key === "+" || event.key === "=") this.zoomAt(1.25); else { this.camera.x += (event.key === "ArrowRight" ? 80 : event.key === "ArrowLeft" ? -80 : 0) / this.camera.zoom; this.camera.y += (event.key === "ArrowDown" ? 80 : event.key === "ArrowUp" ? -80 : 0) / this.camera.zoom; this.schedule(); } } });
    if (typeof ResizeObserver !== "undefined") { this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.stage); }
    this.resize();
  }
  listen(node, type, callback, options) { node.addEventListener(type, callback, options); this.listeners.push(() => node.removeEventListener(type, callback, options)); }
  resize() {
    const rect = this.stage.getBoundingClientRect(); this.width = Math.max(100, rect.width || 800); this.height = Math.max(100, rect.height || 540);
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1, 4096 / Math.max(this.width, this.height));
    for (const canvas of [this.base, this.ink]) { canvas.width = Math.ceil(this.width * this.dpr); canvas.height = Math.ceil(this.height * this.dpr); }
    if (this.autoFit && this.bounds) this.camera = fitCamera(this.bounds, this.width, this.height, this.board.viewport);
    this.schedule();
  }
  setBoard(board, reset = false) {
    if (!this.board || this.board.id !== board.id) reset = true;
    this.board = board; this.nodeElements.clear(); this.strokeRects = (board.webInk ? board.webInk.strokes : []).map(strokeBounds); this.byID = new Map(board.items.map(item => [item.id.toLowerCase(), item]));
    this.bounds = sceneBounds(board.items, this.strokeRects); this.cache.invalidate();
    if (reset) { this.autoFit = true; this.camera = fitCamera(this.bounds, this.width, this.height, board.viewport); }
    this.schedule();
  }
  fit() { if (this.board) { this.autoFit = true; this.camera = fitCamera(this.bounds, this.width, this.height, this.board.viewport); this.schedule(); } }
  nativeViewport() { if (this.board) { this.autoFit = false; this.camera = { x: this.board.viewport.x, y: this.board.viewport.y, zoom: clampZoom(this.board.viewport.zoom) }; this.schedule(); } }
  locate(value) { this.autoFit = false; this.camera = value.width ? fitCamera(value, this.width, this.height, this.camera) : { x: value.x, y: value.y, zoom: clampZoom(value.zoom) }; this.schedule(); }
  zoomAt(factor, x = this.width / 2, y = this.height / 2) {
    this.autoFit = false;
    const worldX = this.camera.x + (x - this.width / 2) / this.camera.zoom, worldY = this.camera.y + (y - this.height / 2) / this.camera.zoom;
    this.camera.zoom = clampZoom(this.camera.zoom * factor); this.camera.x = worldX - (x - this.width / 2) / this.camera.zoom; this.camera.y = worldY - (y - this.height / 2) / this.camera.zoom; this.schedule();
  }
  eventPoint(event) { const rect = this.stage.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  down(event) {
    if (event.button != null && event.button !== 0) return;
    this.autoFit = false; const p = this.eventPoint(event); this.pointers.set(event.pointerId, p); this.dragStart = p; this.dragged = this.pointers.size > 1;
    try { this.stage.setPointerCapture(event.pointerId); } catch (_) {} this.stage.focus({ preventScroll: true }); event.preventDefault();
  }
  move(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const before = [...this.pointers.values()]; const old = this.pointers.get(event.pointerId), next = this.eventPoint(event);
    this.pointers.set(event.pointerId, next); if (Math.hypot(next.x - this.dragStart.x, next.y - this.dragStart.y) > 5) this.dragged = true;
    if (this.pointers.size === 2) {
      const after = [...this.pointers.values()]; const midBefore = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 }; const midAfter = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
      const distance = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
      if (distance > 1) this.zoomAt(Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y) / distance, midBefore.x, midBefore.y);
      this.camera.x -= (midAfter.x - midBefore.x) / this.camera.zoom; this.camera.y -= (midAfter.y - midBefore.y) / this.camera.zoom;
    } else if (this.pointers.size === 1) { this.camera.x -= (next.x - old.x) / this.camera.zoom; this.camera.y -= (next.y - old.y) / this.camera.zoom; }
    this.schedule(); event.preventDefault();
  }
  up(event, cancelled = false) {
    if (!this.pointers.has(event.pointerId)) return;
    const click = !cancelled && !this.dragged && this.pointers.size === 1; const p = this.eventPoint(event); this.pointers.delete(event.pointerId);
    try { this.stage.releasePointerCapture(event.pointerId); } catch (_) {}
    if (click && this.board) {
      const x = this.camera.x + (p.x - this.width / 2) / this.camera.zoom, y = this.camera.y + (p.y - this.height / 2) / this.camera.zoom;
      const item = [...this.board.items].reverse().find(item => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height);
      if (item && item.sourcePath) openSourceFile(this.app, item.sourcePath, item.page).catch(error => new Notice(error.message));
      else if (item && safeWebURL(item.url)) window.open(safeWebURL(item.url), "_blank", "noopener,noreferrer");
    }
  }
  schedule() { if (!this.closed && this.frame == null) this.frame = window.requestAnimationFrame(() => { this.frame = null; this.draw(); }); }
  draw() {
    if (!this.board || this.closed) return;
    const c = this.base.getContext("2d"), ink = this.ink.getContext("2d"); if (!c || !ink) return;
    const camera = this.camera, z = camera.zoom, rect = visibleRect(camera, this.width, this.height, 100), screen = (x, y) => screenPoint(camera, this.width, this.height, x, y);
    for (const context of [c, ink]) { context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); context.clearRect(0, 0, this.width, this.height); }
    c.fillStyle = "#f5f3ed"; c.fillRect(0, 0, this.width, this.height);
    c.strokeStyle = "#79918a"; c.lineWidth = 1.5;
    for (const edge of this.board.edges) { const a = this.byID.get(edge.from.toLowerCase()), b = this.byID.get(edge.to.toLowerCase()); const p = screen(a.x + a.width / 2, a.y + a.height / 2), q = screen(b.x + b.width / 2, b.y + b.height / 2); c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke(); }
    const details = chooseDetails(this.board.items, rect, camera), detailIDs = new Set(details.map(item => item.id)), jobs = [], holes = [], errors = new Set();
    const visible = this.board.items.filter(item => intersects(item, rect));
    // A single overview canvas can show 2,000 rectangles; at most 60 nearby pages get detail.
    for (const item of visible) {
      const p = screen(item.x, item.y), w = item.width * z, h = item.height * z;
      c.fillStyle = item.kind === "inkGroup" ? "rgba(0,0,0,0)" : "#fff"; c.fillRect(p.x, p.y, w, h); c.strokeStyle = item.kind === "formula" ? "#b69bd1" : "#c8d3ce"; c.lineWidth = 1; c.strokeRect(p.x, p.y, w, h);
      if (item.kind === "pdfPage" && item.sourcePath && detailIDs.has(item.id)) {
        const declaration = declarationFor(this.board, item.sourcePath);
        const desired = Math.min(1024, Math.max(64, Math.pow(2, Math.ceil(Math.log2(Math.max(1, w * this.dpr))))));
        // Share the finite pixel budget among currently visible detail pages.
        const fair = Math.sqrt(MAX_CACHED_PIXELS / Math.max(1, details.length) * item.width / item.height);
        const width = Math.max(32, Math.min(desired, Math.pow(2, Math.floor(Math.log2(Math.max(32, fair))))));
        const tile = this.cache.peek(item, width, declaration);
        jobs.push({ item, width, declaration });
        if (tile && tile.canvas) { if (tile.warning) errors.add(tile.warning); c.drawImage(tile.canvas, p.x, p.y, w, h); if (tile.matched) holes.push({ x: p.x, y: p.y, width: w, height: h }); }
        else { c.fillStyle = "#61746b"; c.font = "12px sans-serif"; c.fillText(tile && tile.error ? t("canvas.pdfWaiting") : t("canvas.pdfLoading", { page: item.page }), p.x + 8, p.y + Math.min(24, h - 4), Math.max(1, w - 16)); if (tile && tile.error) errors.add(tile.error); }
      }
    }
    this.cache.request(jobs);
    for (const pin of this.board.pins) { const p = screen(pin.x, pin.y); if (p.x < -20 || p.y < -20 || p.x > this.width + 20 || p.y > this.height + 20) continue; c.fillStyle = "#d16a39"; c.beginPath(); c.arc(p.x, p.y, 5, 0, Math.PI * 2); c.fill(); }
    const nextNodes = new Map(), renderedNodes = [];
    for (const item of details) {
      if (item.kind === "pdfPage" || item.kind === "inkGroup") continue;
      const p = screen(item.x, item.y);
      let node = this.nodeElements.get(item.id);
      if (!node) {
        node = make("div", undefined, "isc-node");
        const title = make("strong", short(item.title, 300)), body = make("div", short(item.text || item.sourcePath || "", 10000)); node.append(title, body);
        if (item.kind === "formula" && item.text && typeof loadMathJax === "function" && !/\\(?:href|url|html\w*|style|class|cssId|require|includegraphics|newcommand|def)\b/i.test(item.text)) {
          const formulaNode = node;
          loadMathJax().then(() => { if (this.closed || this.nodeElements.get(item.id) !== formulaNode) return; try { body.replaceChildren(renderMath(item.text.slice(0, 10000), true)); finishRenderMath(); } catch (_) { /* Preserve readable TeX if rendering fails. */ } }).catch(() => {});
        }
      }
      node.style.left = `${p.x}px`; node.style.top = `${p.y}px`; node.style.width = `${item.width * z}px`; node.style.height = `${item.height * z}px`; node.style.fontSize = `${Math.max(9, Math.min(30, 17 * z))}px`;
      nextNodes.set(item.id, node); renderedNodes.push(node);
    }
    this.nodeElements = nextNodes; this.overlay.replaceChildren(...renderedNodes);
    // Mask only PDF pages whose exact synced source has actually been painted.
    ink.save();
    ink.translate(this.width / 2 - camera.x * z, this.height / 2 - camera.y * z); ink.scale(z, z);
    const strokes = this.board.webInk ? this.board.webInk.strokes : []; let points = 0;
    for (let index = 0; index < strokes.length; index++) if (intersects(this.strokeRects[index], rect)) points += strokes[index].points.length;
    const step = Math.max(1, Math.ceil(points / 200000));
    for (let index = 0; index < strokes.length; index++) if (intersects(this.strokeRects[index], rect)) drawStroke(ink, strokes[index], step);
    ink.restore(); for (const hole of holes) ink.clearRect(hole.x, hole.y, hole.width, hole.height); this.zoomLabel.textContent = `${(z * 100).toFixed(z < 0.01 ? 2 : 0)}%`;
    this.onStatus(t("canvas.status", { visible: visible.length, details: details.length, dense: step > 1 ? t("canvas.denseInk") : "", error: errors.size ? ` · ${[...errors][0]}` : "" }));
  }
  destroy() {
    this.closed = true; this.formulaEpoch++; if (this.frame != null) window.cancelAnimationFrame(this.frame); if (this.observer) this.observer.disconnect();
    for (const release of this.listeners) release(); for (const id of this.pointers.keys()) { try { this.stage.releasePointerCapture(id); } catch (_) {} } this.pointers.clear(); this.cache.destroy(); this.base.width = 0; this.ink.width = 0;
  }
}

class BoardPanel {
  constructor(plugin, container, path, options = {}) {
    this.plugin = plugin; this.app = plugin.app; this.container = container; this.boardPath = path; this.options = options; this.closed = false; this.readID = 0; this.page = 0; this.query = ""; this.signatures = new Map();
    plugin.panels.add(this); container.classList.add("inkspace-companion"); container.replaceChildren();
    const toolbar = make("div", undefined, "isc-toolbar"); toolbar.append(button(t("board.choose"), () => plugin.chooseBoard()), button(t("board.refresh"), () => { if (this.viewer) this.viewer.cache.invalidate(); this.refresh(); }));
    this.native = make("a", t("board.write"), "isc-native-link"); this.native.target = "_blank"; this.native.rel = "noopener noreferrer"; toolbar.append(this.native);
    if (options.embedded) toolbar.append(button(t("board.fullView"), () => plugin.openBoard(this.boardPath)));
    this.heading = make("h3"); this.status = make("div", undefined, "isc-status"); this.status.setAttribute("role", "status"); this.capacity = make("div", undefined, "isc-muted");
    this.scene = make("div"); this.sceneStatus = make("div", undefined, "isc-scene-status"); this.legacy = make("div", undefined, "isc-legacy");
    const details = make("details", undefined, "isc-directory"); details.append(make("summary", t("directory.summary")));
    this.search = make("input"); this.search.type = "search"; this.search.placeholder = t("directory.search"); this.search.setAttribute("aria-label", this.search.placeholder);
    this.search.addEventListener("input", () => { this.query = this.search.value; this.page = 0; window.clearTimeout(this.searchTimer); this.searchTimer = window.setTimeout(() => this.renderDirectory(), 150); });
    this.entries = make("div", undefined, "isc-entries"); this.pager = make("div", undefined, "isc-pager"); details.append(this.search, this.entries, this.pager);
    container.append(toolbar, this.heading, this.status, this.capacity, this.scene, this.sceneStatus, this.legacy, details);
    this.refresh();
  }
  related(path) { return this.boardPath === path || this.boardPath.startsWith(path + "/") || Boolean(this.board && referencedSourcePaths(this.board).some(source => source === path || source.startsWith(path + "/"))); }
  scheduleRefresh(sourceChanged = false) { if (sourceChanged && this.viewer) this.viewer.cache.invalidate(); window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.refresh(), 350); }
  async refresh() {
    if (this.closed) return;
    const id = ++this.readID, path = this.boardPath;
    this.native.hidden = !isBoardPath(path); if (!this.native.hidden) this.native.href = nativeDeepLink(path);
    const file = exactVaultFile(this.app.vault, path);
    if (!file || !isBoardPath(path)) { this.board = null; this.lastRaw = null; if (this.viewer) { this.viewer.destroy(); this.viewer = null; } this.scene.replaceChildren(); this.entries.replaceChildren(); this.legacy.replaceChildren(); this.heading.textContent = t("board.name"); this.status.textContent = t("board.missing"); return; }
    try {
      ensure(file.stat.size <= MAX_BOARD_BYTES, t("error.boardSize"));
      const raw = await this.app.vault.read(file);
      if (this.closed || id !== this.readID || path !== this.boardPath) return;
      ensure(raw.length <= MAX_BOARD_BYTES, t("error.boardReadLimit"));
      let sourceChanged = false;
      if (this.board) for (const source of referencedSourcePaths(this.board)) { const signature = sourceSignature(exactVaultFile(this.app.vault, source)); if (this.signatures.get(source) !== signature) sourceChanged = true; }
      if (raw !== this.lastRaw) {
        const board = validateBoard(parseJSON(raw, "error.boardJSON")); const reset = !this.board || this.board.id !== board.id;
        this.board = board; this.lastRaw = raw; this.heading.textContent = board.title || t("board.untitled");
        this.capacity.textContent = t("board.capacity", { items: board.items.length, edges: board.edges.length, strokes: board.webInk ? board.webInk.strokes.length : t("board.inkNotExported"), size: bytes(file.stat.size) });
        if (!this.viewer) this.viewer = new BoardViewer(this.app, this.scene, text => { this.sceneStatus.textContent = text; });
        this.viewer.setBoard(board, reset); this.renderLegacy(); this.renderDirectory();
      } else if (sourceChanged && this.viewer) this.viewer.cache.invalidate();
      this.signatures.clear(); for (const source of referencedSourcePaths(this.board)) this.signatures.set(source, sourceSignature(exactVaultFile(this.app.vault, source)));
      if (this.viewer) this.viewer.schedule();
      this.status.textContent = t("board.readOnly", { saved: new Date(this.board.updatedAt).toLocaleString(dateLocale()), checked: new Date().toLocaleTimeString(dateLocale()) });
    } catch (error) { if (!this.closed && id === this.readID) this.status.textContent = t("board.readError", { kept: this.board ? t("board.keptPrevious") : "", error: short(String(error.message || error), 250) }); }
  }
  renderLegacy() {
    this.legacy.replaceChildren(); if (this.board.webInk) return;
    this.legacy.append(make("p", t("board.legacy")));
    const preview = previewDataURL(this.board.previewPNG);
    if (preview) { const details = make("details"); details.append(make("summary", t("board.legacySummary"))); const img = make("img", undefined, "isc-preview"); img.src = preview; img.alt = t("board.legacyAlt"); details.append(img); this.legacy.append(details); }
  }
  renderDirectory() {
    if (!this.board || this.closed) return; this.entries.replaceChildren(); this.pager.replaceChildren();
    const result = pageEntries(this.board, this.query, this.page); this.page = result.page;
    for (const entry of result.entries) {
      const value = entry.value, card = make("div", undefined, "isc-entry"); card.append(make("strong", short(value.title || kindName(value.kind) || t("kind.pin"), 300)));
      if (value.text) card.append(make("p", short(value.text))); if (value.sourcePath) card.append(make("small", `${value.sourcePath}${value.page ? t("directory.pageSuffix", { page: value.page }) : ""}`));
      const actions = make("div", undefined, "isc-entry-actions"); actions.append(button(t("directory.locate"), () => this.viewer && this.viewer.locate(value)));
      if (value.originalSourcePath && value.originalSourcePath !== value.sourcePath) card.append(make("small", t("directory.originalPath", { path: value.originalSourcePath })));
      for (const target of itemSourceTargets(value)) actions.append(button(target.label, () => openSourceFile(this.app, target.path, target.page).catch(error => new Notice(error.message))));
      if (safeWebURL(value.url)) { const link = make("a", t("directory.openWeb")); link.href = safeWebURL(value.url); link.target = "_blank"; link.rel = "noopener noreferrer"; actions.append(link); }
      card.append(actions); this.entries.append(card);
    }
    const prev = button(t("directory.previous"), () => { this.page--; this.renderDirectory(); }), next = button(t("directory.next"), () => { this.page++; this.renderDirectory(); }); prev.disabled = result.page === 0; next.disabled = result.page === result.pageCount - 1;
    this.pager.append(prev, make("span", t("directory.pagination", { page: result.page + 1, pages: result.pageCount, total: result.total, limit: PAGE_SIZE })), next);
  }
  destroy() { if (this.closed) return; this.closed = true; this.readID++; window.clearTimeout(this.timer); window.clearTimeout(this.searchTimer); if (this.viewer) this.viewer.destroy(); this.plugin.panels.delete(this); this.container.replaceChildren(); }
}

class InkSpaceView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.boardPath = ""; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.panel && this.panel.board ? short(this.panel.board.title || t("board.name"), 80) : t("board.name"); }
  getIcon() { return "panels-top-left"; }
  getState() { return { boardPath: this.boardPath }; }
  async setState(state, result) { this.boardPath = state && isBoardPath(state.boardPath) ? state.boardPath : ""; if (this.panel) { this.panel.boardPath = this.boardPath; await this.panel.refresh(); } await super.setState(state, result); }
  async onOpen() { this.panel = new BoardPanel(this.plugin, this.contentEl, this.boardPath); }
  async onClose() { if (this.panel) this.panel.destroy(); }
}
class InkSpaceEmbed extends MarkdownRenderChild {
  constructor(container, plugin, path) { super(container); this.plugin = plugin; this.path = path; }
  onload() { this.panel = new BoardPanel(this.plugin, this.containerEl, this.path, { embedded: true }); }
  onunload() { if (this.panel) this.panel.destroy(); }
}
class InkSpaceCompanion extends Plugin {
  async onload() {
    this.panels = new Set(); this.opening = new WeakSet();
    this.registerView(VIEW_TYPE, leaf => new InkSpaceView(leaf, this));
    this.addRibbonIcon("panels-top-left", t("command.open"), () => this.chooseBoard());
    this.addCommand({ id: "open-board", name: t("board.choose"), callback: () => this.chooseBoard() });
    this.addCommand({ id: "preview-current-board", name: t("command.preview"), callback: () => { const file = this.app.workspace.getActiveFile(); if (file && isBoardPath(file.path)) this.openBoard(file.path); else new Notice(t("notice.choose")); } });
    this.registerMarkdownCodeBlockProcessor("inkspace", (source, el, ctx) => { try { ctx.addChild(new InkSpaceEmbed(el, this, parseEmbed(source))); } catch (error) { el.append(make("p", t("error.withBrand", { error: error.message }))); } });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof TFolder) {
        const path = file === this.app.vault.getRoot() ? "" : file.path;
        if (isDirectoryPath(path)) menu.addItem(item => item.setTitle(t("menu.newFolder")).setIcon("folder-plus").onClick(() => this.createBoardInFolder(path)));
        return;
      }
      if (!(file instanceof TFile)) return;
      if (isBoardPath(file.path)) menu.addItem(item => item.setTitle(t("menu.preview")).setIcon("panels-top-left").onClick(() => this.openBoard(file.path)));
      if (isDocumentSourcePath(file.path)) menu.addItem(item => item.setTitle(t("menu.newSource")).setIcon("file-plus-2").onClick(() => this.createBoardForSource(file.path)));
    }));
    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (!(file instanceof TFile) || !isBoardPath(file.path)) return;
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (leaf && leaf.view.file && leaf.view.file.path === file.path && !this.opening.has(leaf) && leaf.view.getViewType() !== VIEW_TYPE) this.openBoard(file.path, leaf);
    }));
    for (const event of ["modify", "create", "delete"]) this.registerEvent(this.app.vault.on(event, file => { for (const panel of this.panels) if (panel.related(file.path)) panel.scheduleRefresh(file.path !== panel.boardPath); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      for (const panel of this.panels) {
        if (panel.boardPath === oldPath || panel.boardPath.startsWith(oldPath + "/")) {
          panel.boardPath = file.path + panel.boardPath.slice(oldPath.length);
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view.panel === panel) leaf.view.boardPath = panel.boardPath;
          this.app.workspace.requestSaveLayout(); panel.scheduleRefresh();
        } else if (panel.related(oldPath) || panel.related(file.path)) panel.scheduleRefresh(true);
      }
    }));
    this.registerInterval(window.setInterval(() => { if (document.visibilityState === "hidden") return; for (const panel of this.panels) panel.refresh(); }, POLL_MS));
  }
  chooseBoard(leaf) { new BoardChooser(this.app, path => this.openBoard(path, leaf)).open(); }
  createBoardInFolder(path) {
    if (!Platform || !Platform.isIosApp) {
      new Notice(t("notice.iPad"));
      return;
    }
    try {
      if (!exactVaultFolder(this.app.vault, path)) throw new Error(t("error.folderMoved"));
      window.open(nativeNewFolderDeepLink(path, this.app.vault.getName()), "_blank");
    } catch (error) { new Notice(t("error.newBoard", { error: error.message || t("error.installApp") })); }
  }
  createBoardForSource(path) {
    if (!Platform || !Platform.isIosApp) {
      new Notice(t("notice.iPad"));
      return;
    }
    try {
      if (!isDocumentSourcePath(path) || !exactVaultFile(this.app.vault, path)) throw new Error(t("error.sourceMoved"));
      const href = nativeNewDeepLink(path, this.app.vault.getName());
      // Only this explicit menu click launches native. The native app validates
      // its authorized vault and creates the board beside the source itself.
      window.open(href, "_blank");
    } catch (error) { new Notice(t("error.newBoard", { error: error.message || t("error.installApp") })); }
  }
  async openBoard(path, leaf) {
    if (!isBoardPath(path)) return; const target = leaf || this.app.workspace.getLeaf(true); if (this.opening.has(target)) return;
    this.opening.add(target);
    try { await target.setViewState({ type: VIEW_TYPE, state: { boardPath: path }, active: true }); await this.app.workspace.revealLeaf(target); } catch (error) { new Notice(error.message); } finally { this.opening.delete(target); }
  }
  onunload() { for (const panel of [...this.panels]) panel.destroy(); }
}
module.exports = InkSpaceCompanion;
module.exports.helpers = { resolveLocale, getLocale, t, kindName, MESSAGES, BoardChooser, validateBoard, validateWebInk, isSafeVaultPath, isBoardPath, nativeDeepLink, isDocumentSourcePath, nativeNewDeepLink, isDirectoryPath, nativeNewFolderDeepLink, exactVaultFolder, safeWebURL, previewDataURL, pageEntries, exactVaultFile, openSourceFile, isPDFSourcePath, itemSourceTargets, referencedSourcePaths, visibleRect, screenPoint, fitCamera, chooseDetails, strokeBounds, parseEmbed, drawStroke, declarationFor, PAGE_SIZE, MAX_POINTS, MAX_DETAIL_NODES, MAX_CACHED_PIXELS, PDFPreviewCache, BoardViewer, BoardPanel, InkSpaceView, InkSpaceEmbed };

"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
let createdNodes = 0, nextFrame = 0;
// Preserve the original Chinese regression expectations explicitly. New tests
// select English through the same public Obsidian API that the plugin uses.
let obsidianLanguage = "zh", languageUnavailable = false;
test.beforeEach(() => { obsidianLanguage = "zh"; languageUnavailable = false; });
const frames = new Map();
class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.style = {}; this.classList = { add() {}, remove() {} }; this.textContent = ""; this.width = 0; this.height = 0; this.calls = []; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { (this.attributes ||= {})[name] = value; } focus() {} setPointerCapture() {} releasePointerCapture() {}
  getBoundingClientRect() { return { width: 800, height: 540, left: 0, top: 0 }; }
  getContext() { if (!this.context) this.context = new Proxy({}, { get: (object, key) => key in object ? object[key] : (...args) => this.calls.push([key, ...args]), set: (object, key, value) => { object[key] = value; return true; } }); return this.context; }
}
class TFolder { constructor(folderPath) { this.path = folderPath; } }
class TFile { constructor(filePath, size = 1) { this.path = filePath; this.stat = { size, mtime: 1 }; } }
class ItemView { constructor(leaf) { this.leaf = leaf; this.app = {}; this.contentEl = new FakeNode("div"); } async setState() {} }
const notices = [];
class Plugin {} class FuzzySuggestModal {
  constructor(app) { this.app = app; }
  setPlaceholder(value) { this.placeholder = value; }
} class Notice { constructor(message) { notices.push(message); } }
const Platform = { isIosApp: false, isMobileApp: false };
class MarkdownRenderChild { constructor(container) { this.containerEl = container; } }
let pdfCalls = [], pdfReads = 0, renderActive = 0, maxRenderActive = 0, destroyedDocs = 0;
let renderWait = null;
const pdfjs = {
  getDocument(options) {
    pdfCalls.push(["getDocument", options]);
    return { destroy() { destroyedDocs++; }, promise: Promise.resolve({
      async getPage(number) { pdfCalls.push(["page", number]); return {
        getViewport({ scale }) { return { width: 720 * scale, height: 405 * scale }; },
        render(options) { pdfCalls.push(["render", options]); renderActive++; maxRenderActive = Math.max(maxRenderActive, renderActive); return { cancel() {}, promise: (renderWait ? renderWait() : Promise.resolve()).then(() => { renderActive--; }) }; }, cleanup() {}
      }; }, async destroy() { destroyedDocs++; }
    }) };
  }
};
const mockObsidian = { Platform, Plugin, ItemView, FuzzySuggestModal, TFile, TFolder, Notice, MarkdownRenderChild, getLanguage() { if (languageUnavailable) throw new Error("API unavailable"); return obsidianLanguage; }, loadPdfJs: async () => pdfjs, loadMathJax: async () => {}, renderMath: source => new FakeNode(source), finishRenderMath() {} };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) { return request === "obsidian" ? mockObsidian : originalLoad.call(this, request, parent, isMain); };
const Companion = require(path.resolve(__dirname, "../inkspace-companion/main.js")); Module._load = originalLoad;
const h = Companion.helpers;
global.document = { visibilityState: "visible", createElement(tag) { createdNodes++; return new FakeNode(tag); } };
global.window = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame(id) { frames.delete(id); } };
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
global.devicePixelRatio = 2;
function uuid(index) { return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`; }
function board(count = 2) { return { schemaVersion: 1, id: uuid(900001), writerID: uuid(900002), title: "测试白板", revision: 3, createdAt: "2026-09-12T10:00:00Z", updatedAt: "2026-09-12T10:01:00Z", canvasWidth: 1000000, canvasHeight: 1000000, viewport: { x: 500000, y: 500000, zoom: 1 }, items: Array.from({ length: count }, (_, index) => ({ id: uuid(index + 1), kind: "text", x: 499000 + (index % 10) * 750, y: 499000 + Math.floor(index / 10) * 440, width: 720, height: 405, title: `节点 ${index + 1}`, text: `内容 ${index + 1}` })), edges: [], pins: [] }; }
function ink() { return { version: 1, strokes: [{ color: "#2266bb", opacity: 0.4, points: [[499005, 499010, 2], [499100, 499025, 8]] }] }; }
function appFor(value = board()) {
  const files = new Map([["InkSpace/test.inkspace.json", new TFile("InkSpace/test.inkspace.json", 1000)], ["课程/讲义 #[A]%20.pdf", new TFile("课程/讲义 #[A]%20.pdf", 20)]]);
  const rootFolder = new TFolder("/");
  let raw = JSON.stringify(value), reads = 0;
  const events = {};
  const app = { vault: { getName: () => "学习仓库 & #+%", getRoot: () => rootFolder, getAbstractFileByPath: path => files.get(path) || null, getFiles: () => [...files.values()], read: async () => { reads++; return raw; }, readBinary: async () => { pdfReads++; return new Uint8Array([1, 2, 3, 4]).buffer; }, on: (name, callback) => { events[name] = callback; return name; } }, workspace: { getLeaf: () => ({ openFile: async (...args) => { app.opened = args; } }), getLeavesOfType: () => [], requestSaveLayout() {} } };
  return { app, files, events, raw: value => { raw = value; }, reads: () => reads };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function idle(cache) { for (let index = 0; index < 100 && (cache.active || cache.queue.length); index++) await tick(); assert.equal(cache.active, 0); }
function pdfItem(index = 1, path = "课程/讲义 #[A]%20.pdf") { return { ...board(1).items[0], id: uuid(index), kind: "pdfPage", sourcePath: path, page: index }; }

test("native schema, exported world ink and exact special-character paths remain intact", () => {
  const value = board(); value.webInk = ink(); value.items[0] = pdfItem(); value.edges = [{ id: uuid(5000), from: value.items[0].id, to: value.items[1].id }];
  assert.strictEqual(h.validateBoard(value), value);
  for (const name of ["课程/讲义 #[A]%20.pdf", "a/literal%2Fname.pdf"]) assert.equal(h.isSafeVaultPath(name), true);
  for (const name of ["", "/secret", "../a", "a/../b", "a/./b", "a//b", "a/", "a\\b", "file:x", "https://x", "a\0b", "a\nb"]) assert.equal(h.isSafeVaultPath(name), false);
  assert.equal(h.nativeDeepLink("InkSpace/中文 #[]%.inkspace.json"), "inkspace://open?file=" + encodeURIComponent("InkSpace/中文 #[]%.inkspace.json"));
  assert.throws(() => h.nativeDeepLink("notes.json"));
});
test("validator rejects broken geometry, endpoints, unsafe paths and hostile ink", () => {
  for (const modify of [v => v.schemaVersion = 2, v => v.items[0].x = -1, v => v.viewport.zoom = 0, v => v.items[1].id = v.items[0].id, v => v.edges.push({ id: uuid(3), from: uuid(1), to: uuid(9) }), v => v.items[0].sourcePath = "../x.pdf"]) { const value = board(); modify(value); assert.throws(() => h.validateBoard(value)); }
  for (const modify of [v => v.strokes[0].color = "url(https://x)", v => v.strokes[0].opacity = 2, v => v.strokes[0].points[0][0] = Infinity, v => v.strokes[0].points[0][2] = -1, v => v.strokes[0].points = [], v => v.version = 2]) { const value = ink(); modify(value); assert.throws(() => h.validateWebInk(value)); }
  const value = ink(); value.strokes[0].points = Array(50001).fill([1, 2, 3]); assert.throws(() => h.validateWebInk(value));
  const many = ink(); many.strokes = Array.from({ length: 21 }, () => ({ ...ink().strokes[0], points: Array(50000).fill([1, 2, 3]) })); assert.throws(() => h.validateWebInk(many), /一百万/);
});
test("links, PNG fallback and Markdown embed reject unexpected input", () => {
  assert.equal(h.safeWebURL("javascript:alert(1)"), null); assert.equal(h.safeWebURL("file:///secret"), null); assert.equal(h.safeWebURL("https://example.com/a"), "https://example.com/a");
  assert.equal(h.previewDataURL("<svg onload=x>"), null);
  assert.equal(h.parseEmbed('{"file":"InkSpace/test.inkspace.json"}'), "InkSpace/test.inkspace.json");
  assert.throws(() => h.parseEmbed('{"file":"../x.inkspace.json"}')); assert.throws(() => h.parseEmbed("{}").repeat(10));
});
test("2,000 items use at most 60 detail nodes and directory entries, with correct center coordinates", () => {
  const value = board(2000); h.validateBoard(value);
  const page = h.pageEntries(value, "", 33); assert.equal(page.entries.length, 20); assert.equal(page.total, 2000); assert.equal(h.pageEntries(value, "", 0, 5000).entries.length, 60);
  const camera = h.fitCamera(h.strokeBounds({ points: [[0, 0, 2], [1000, 1000, 2]] }), 800, 540, value.viewport);
  assert.deepEqual(h.screenPoint(camera, 800, 540, camera.x, camera.y), { x: 400, y: 270 });
  const visible = h.visibleRect({ x: 500000, y: 500000, zoom: 2 }, 800, 540); assert.equal(visible.x, 499800); assert.equal(visible.width, 400);
  assert.equal(h.chooseDetails(value.items, { x: 0, y: 0, width: 1000000, height: 1000000 }, { x: 500000, y: 500000, zoom: 1 }).length, 60);
  const env = appFor(value), plugin = { app: env.app, panels: new Set() }; const panel = new h.BoardPanel(plugin, new FakeNode("div"), ""); panel.board = value; createdNodes = 0; panel.renderDirectory(); assert.equal(panel.entries.children.length, 60); assert.ok(createdNodes < 400); panel.destroy();
});
test("exact source TFile keeps literal # [] % and passes PDF page separately", async () => {
  const env = appFor(); await h.openSourceFile(env.app, "课程/讲义 #[A]%20.pdf", 2000);
  assert.equal(env.app.opened[0].path, "课程/讲义 #[A]%20.pdf"); assert.deepEqual(env.app.opened[1], { eState: { subpath: "#page=2000" } });
  await assert.rejects(h.openSourceFile(env.app, "../secret", 1)); await assert.rejects(h.openSourceFile(env.app, "课程/讲义 #[A]%20.pdf", -1));
});
test("canvas paints ink and all overview rectangles without creating 2,000 PDF nodes or requests", () => {
  const value = board(2000); value.items = value.items.map((item, index) => ({ ...item, kind: "pdfPage", sourcePath: "课程/讲义 #[A]%20.pdf", page: index + 1 })); value.webInk = ink();
  const env = appFor(value), viewer = new h.BoardViewer(env.app, new FakeNode("div"), () => {}); viewer.setBoard(value); createdNodes = 0; viewer.draw();
  assert.equal(viewer.cache.queue.length, 0); assert.equal(viewer.cache.active, 0); assert.equal(viewer.overlay.children.length, 0); assert.ok(createdNodes < 10);
  assert.equal(viewer.base.calls.filter(call => call[0] === "strokeRect").length, 2000); assert.ok(viewer.ink.calls.some(call => call[0] === "fill"));
  assert.equal(viewer.base.width, 1600); viewer.nativeViewport(); assert.equal(viewer.camera.x, 500000); viewer.destroy(); assert.equal(Object.keys(viewer.stage.listeners).length, 0);
});
test("PDF pipeline uses public API, keeps source annotations, two jobs at most and bounded caches", async () => {
  pdfCalls = []; pdfReads = 0; maxRenderActive = 0; const env = appFor(), cache = new h.PDFPreviewCache(env.app, () => {});
  cache.request(Array.from({ length: 60 }, (_, index) => ({ item: pdfItem(index + 1), width: 128 })));
  await idle(cache); assert.equal(pdfReads, 1); assert.ok(maxRenderActive <= 2); assert.equal(pdfCalls.filter(call => call[0] === "page").length, 60);
  assert.equal(pdfCalls.find(call => call[0] === "getDocument")[1].isEvalSupported, false); assert.equal(pdfCalls.find(call => call[0] === "render")[1].annotationMode, 1);
  assert.ok(cache.tiles.size <= 64); assert.ok(cache.pixels <= h.MAX_CACHED_PIXELS);
  cache.request(Array.from({ length: 60 }, (_, index) => ({ item: pdfItem(index + 61), width: 256 }))); await idle(cache); assert.ok(cache.tiles.size <= 64); cache.destroy(); assert.equal(cache.pixels, 0);
});
test("matching PDF bytes allow owned-ink masking only on declared pages; mismatch renders current unannotated source with current board ink", async () => {
  const digest = Buffer.from(await webcrypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3, 4]))).toString("hex"), env = appFor();
  const good = { sourcePath: "课程/讲义 #[A]%20.pdf", sha256: digest, pages: [1] }, cache = new h.PDFPreviewCache(env.app, () => {});
  cache.request([{ item: pdfItem(1), width: 128, declaration: good }, { item: pdfItem(2), width: 128, declaration: good }]); await idle(cache);
  assert.equal(cache.peek(pdfItem(1), 128, good).matched, true); assert.equal(cache.peek(pdfItem(2), 128, good).matched, false); cache.destroy();
  const bad = { ...good, sha256: "0".repeat(64) }, mismatch = new h.PDFPreviewCache(env.app, () => {}); const before = pdfCalls.length;
  mismatch.request([{ item: pdfItem(1), width: 128, declaration: bad }]); await idle(mismatch); const tile = mismatch.peek(pdfItem(1), 128, bad); assert.match(tile.warning, /PDF 已更新/); assert.ok(tile.canvas); assert.equal(tile.matched, false); assert.ok(pdfCalls.length > before); assert.equal(pdfCalls.filter(call => call[0] === "render").at(-1)[1].annotationMode, 0); mismatch.destroy();
});
test("source changes invalidate nearby PDF cache and fresh vault.read preserves camera", async () => {
  const value = board(); value.items[0] = pdfItem(); value.webInk = ink(); const env = appFor(value), plugin = { app: env.app, panels: new Set() };
  const panel = new h.BoardPanel(plugin, new FakeNode("div"), "InkSpace/test.inkspace.json"); await tick(); assert.ok(panel.viewer); panel.viewer.camera.x = 12345;
  let invalidations = 0; const invalidate = panel.viewer.cache.invalidate.bind(panel.viewer.cache); panel.viewer.cache.invalidate = () => { invalidations++; invalidate(); };
  env.files.get("课程/讲义 #[A]%20.pdf").stat.mtime++; await panel.refresh(); assert.equal(invalidations, 1); assert.equal(panel.viewer.camera.x, 12345); assert.ok(env.reads() >= 2);
  const newer = { ...value, revision: 4, title: "新内容" }; env.raw(JSON.stringify(newer)); await panel.refresh(); assert.equal(panel.heading.textContent, "新内容"); assert.equal(panel.viewer.camera.x, 12345);
  env.raw("{partial"); await panel.refresh(); assert.equal(panel.board.revision, 4); assert.match(panel.status.textContent, /保留/);
  env.files.delete("InkSpace/test.inkspace.json"); await panel.refresh(); assert.equal(panel.viewer, null); assert.match(panel.status.textContent, /重新连接/); panel.destroy(); assert.equal(plugin.panels.size, 0);
});
test("late reads cannot replace a newly selected board; old ink has explicit viewport-only warning", async () => {
  const env = appFor(), plugin = { app: env.app, panels: new Set() }, pending = [];
  env.app.vault.read = () => new Promise(resolve => pending.push(resolve));
  const panel = new h.BoardPanel(plugin, new FakeNode("div"), "InkSpace/test.inkspace.json");
  const second = panel.refresh(); const latest = board(); latest.title = "最新"; pending[1](JSON.stringify(latest)); await second; pending[0](JSON.stringify(board())); await tick();
  assert.equal(panel.board.title, "最新"); assert.match(panel.legacy.children[0].textContent, /尚未导出完整网页手写/); panel.destroy();
});
test("Markdown child owns viewer lifetime; plugin handles suffix only and watches referenced PDFs", async () => {
  const env = appFor(), plugin = new Companion(), workspaceEvents = {}, intervals = [];
  plugin.app = env.app; plugin.registerView = () => {}; plugin.addRibbonIcon = () => {}; plugin.addCommand = () => {}; plugin.registerEvent = () => {}; plugin.registerInterval = id => intervals.push(id);
  plugin.registerMarkdownCodeBlockProcessor = (lang, handler) => { assert.equal(lang, "inkspace"); plugin.processor = handler; };
  env.app.workspace.on = (name, handler) => { workspaceEvents[name] = handler; return name; };
  await plugin.onload(); let child; plugin.processor('{"file":"InkSpace/test.inkspace.json"}', new FakeNode("div"), { addChild: value => { child = value; value.onload(); } }); await tick(); assert.equal(plugin.panels.size, 1); child.onunload(); assert.equal(plugin.panels.size, 0);
  let hits = 0; plugin.panels.add({ boardPath: "InkSpace/test.inkspace.json", related: path => path === "课程/讲义 #[A]%20.pdf", scheduleRefresh: changed => { assert.equal(changed, true); hits++; }, destroy() {} });
  env.events.modify(new TFile("unrelated.md")); env.events.modify(new TFile("课程/讲义 #[A]%20.pdf")); assert.equal(hits, 1);
  workspaceEvents["file-open"](new TFile("normal.json")); // Must not claim other JSON.
  let opened; env.app.workspace.getMostRecentLeaf = () => ({ view: { file: new TFile("InkSpace/test.inkspace.json"), getViewType: () => "markdown" } }); plugin.openBoard = path => { opened = path; };
  workspaceEvents["file-open"](new TFile("InkSpace/test.inkspace.json")); assert.equal(opened, "InkSpace/test.inkspace.json");
  plugin.onunload(); for (const id of intervals) clearInterval(id);
});

test("PDF covers its full world rect and clears web ink only after a matched page is painted", () => {
  const value = board(1); value.items[0] = pdfItem(); value.webInk = ink(); value.pdfAnnotationSources = [{ sourcePath: value.items[0].sourcePath, sha256: "a".repeat(64), pages: [1] }];
  const env = appFor(value), viewer = new h.BoardViewer(env.app, new FakeNode("div"), () => {}); viewer.setBoard(value); viewer.locate(value.items[0]);
  const tile = new FakeNode("canvas"); viewer.cache.request = () => {}; viewer.cache.peek = () => ({ canvas: tile, matched: true }); viewer.draw();
  const painted = viewer.base.calls.find(call => call[0] === "drawImage");
  assert.equal(painted[4], value.items[0].width * viewer.camera.zoom); assert.equal(painted[5], value.items[0].height * viewer.camera.zoom);
  assert.equal(viewer.ink.calls.filter(call => call[0] === "clearRect").length, 2);
  viewer.ink.calls = []; viewer.cache.peek = () => ({ error: "等待同版 PDF 同步" }); viewer.draw();
  assert.equal(viewer.ink.calls.filter(call => call[0] === "clearRect").length, 1); assert.ok(viewer.ink.calls.some(call => call[0] === "fill")); viewer.destroy();
});

test("pan discards queued PDF pages and invalidation discards late completed previews", async () => {
  const env = appFor(), cache = new h.PDFPreviewCache(env.app, () => {}), releases = [];
  renderWait = () => new Promise(resolve => releases.push(resolve)); pdfCalls = [];
  cache.request(Array.from({ length: 60 }, (_, index) => ({ item: pdfItem(index + 1), width: 128 })));
  await tick(); assert.equal(releases.length, 2); cache.request([]); assert.equal(cache.queue.length, 0); cache.invalidate();
  for (const resolve of releases) resolve(); await idle(cache); assert.equal(cache.tiles.size, 0); assert.equal(pdfCalls.filter(call => call[0] === "page").length, 2); renderWait = null; cache.destroy();
});

test("initial overview refits after embedded layout resolves; user navigation survives resize", () => {
  const value = board(4), env = appFor(value), viewer = new h.BoardViewer(env.app, new FakeNode("div"), () => {}); viewer.setBoard(value);
  const initial = viewer.camera.zoom;
  viewer.stage.getBoundingClientRect = () => ({ width: 400, height: 540, left: 0, top: 0 }); viewer.resize(); assert.ok(viewer.camera.zoom < initial);
  viewer.zoomAt(1.5); const chosen = { ...viewer.camera }; viewer.stage.getBoundingClientRect = () => ({ width: 1000, height: 540, left: 0, top: 0 }); viewer.resize(); assert.deepEqual(viewer.camera, chosen); viewer.destroy();
});


test("old 1M boards and new 8M boards validate, render and locate far-away pages without allocating a world bitmap", () => {
  assert.equal(h.validateBoard(board()).canvasWidth, 1000000);
  const value = board(1); value.canvasWidth = value.canvasHeight = 8000000;
  value.viewport = { x: 6000000, y: 7000000, zoom: 1 };
  value.items[0] = { ...pdfItem(), x: 6000000, y: 7000000, width: 1200, height: 1600 };
  value.webInk = { version: 1, strokes: [{ color: "#2266bb", opacity: 1, points: [[6000050, 7000080, 3], [6000750, 7000200, 6]] }] };
  assert.strictEqual(h.validateBoard(value), value);
  const env = appFor(value), viewer = new h.BoardViewer(env.app, new FakeNode("div"), () => {});
  viewer.cache.request = () => {}; viewer.setBoard(value); viewer.locate(value.items[0]); viewer.draw();
  assert.equal(viewer.camera.x, 6000600); assert.equal(viewer.camera.y, 7000800);
  assert.ok(viewer.ink.calls.some(call => call[0] === "fill"));
  assert.equal(viewer.base.width, 1600); assert.equal(viewer.base.height, 1080); viewer.destroy();
  for (const [width, height] of [[1000000,8000000], [8000000,1000000], [2000000,2000000], [8000001,8000001], [0,0], [NaN,NaN]]) {
    const invalid = board(); invalid.canvasWidth=width; invalid.canvasHeight=height; assert.throws(() => h.validateBoard(invalid));
  }
  const edge = { version: 1, strokes: [{ color: "#000000", opacity: 1, points: [[8000000,-8000000,1]] }] };
  h.validateWebInk(edge); edge.strokes[0].points[0][0] = 8000000.01; assert.throws(() => h.validateWebInk(edge));
  const overflow = { ...value, items: [{ ...value.items[0], x: 7999999 }] }; assert.throws(() => h.validateBoard(overflow));
});

test("new native route encodes source and vault exactly once and keeps old open links unchanged", () => {
  const vault = " 学习 & vault=other # + % 🇨🇦 ";
  for (const source of ["课程/讲义 #[A]%20.pdf", "a/literal%2Fname.PDF", "课堂/a&vault=other+?.docx", "课程/中文.ppt", "课程/😀.pptx", "work/表格.xls", "work/a.xlsx", "notes/a.doc", "课堂/笔记 #[A]%2F.md", "notes/UPPER.MARKDOWN", "图片/旋转 #[1]+%.PNG", "相片/a.jpg", "相片/a.JPEG"]) {
    assert.equal(h.isDocumentSourcePath(source), true);
    const route = h.nativeNewDeepLink(source, vault), url = new URL(route);
    assert.equal(url.protocol, "inkspace:"); assert.equal(url.hostname, "new");
    assert.deepEqual([...url.searchParams.keys()], ["source", "vault"]);
    assert.equal(url.searchParams.get("source"), source); assert.equal(url.searchParams.get("vault"), vault);
    assert.equal(url.hash, "");
  }
  assert.match(h.nativeNewDeepLink("a/literal%2Fname.pdf", "V"), /literal%252Fname/);
  for (const source of ["../private.pdf", "/full.pdf", "a/../file.pdf", "a\\x.pdf", "https://x.pdf", "a/a.pdf\n", "a/notes.md.html", "a/test.inkspace.json", "a/archive.zip", "a/folder.pdf/"]) {
    assert.equal(h.isDocumentSourcePath(source), false); assert.throws(() => h.nativeNewDeepLink(source, vault));
  }
  for (const invalid of ["", null, 12, "vault\nother", "vault\0other"]) assert.throws(() => h.nativeNewDeepLink("a.pdf", invalid));
  assert.equal(h.nativeDeepLink("课程/旧 #%.inkspace.json"), "inkspace://open?file=" + encodeURIComponent("课程/旧 #%.inkspace.json"));
});

async function sourceMenuEnvironment() {
  const env = appFor(), plugin = new Companion(), workspaceEvents = {}, intervals = [], launches = [], writes = [], commands = [], ribbons = [], processors = new Map();
  const previousOpen = window.open;
  window.open = (...args) => { launches.push(args); return null; };
  plugin.app = env.app; plugin.registerView = () => {}; plugin.addRibbonIcon = (...args) => ribbons.push(args); plugin.addCommand = command => commands.push(command);
  plugin.registerEvent = () => {}; plugin.registerInterval = id => intervals.push(id); plugin.registerMarkdownCodeBlockProcessor = (language, callback) => processors.set(language, callback);
  env.app.workspace.on = (event, handler) => { workspaceEvents[event] = handler; return event; };
  for (const method of ["create", "createBinary", "modify", "modifyBinary", "delete", "rename"]) env.app.vault[method] = (...args) => { writes.push([method,...args]); throw new Error("Vault writes are forbidden in companion launch"); };
  await plugin.onload();
  function menuFor(file) {
    const entries = [];
    workspaceEvents["file-menu"]({ addItem(callback) { const item = { setTitle(title) { this.title=title;return this; }, setIcon(icon) { this.icon=icon;return this; }, onClick(click) { this.click=click;return this; } }; callback(item); entries.push(item); } }, file);
    return entries;
  }
  return { ...env, plugin, launches, writes, workspaceEvents, menuFor, commands, ribbons, processors,
    close() { plugin.onunload(); for (const id of intervals) clearInterval(id); window.open=previousOpen; Platform.isIosApp=false; Platform.isMobileApp=false; } };
}

test("source file menu opens native only after a click, preserves JSON preview, and never writes a board", async () => {
  const env = await sourceMenuEnvironment(); Platform.isIosApp=true; Platform.isMobileApp=true; notices.length=0;
  try {
    const source=env.files.get("课程/讲义 #[A]%20.pdf"), entries=env.menuFor(source);
    assert.deepEqual(entries.map(x => x.title), ["新建人生赢家白板"]);
    assert.equal(env.launches.length, 0); env.workspaceEvents["file-open"](source); assert.equal(env.launches.length,0);
    entries[0].click(); assert.equal(env.launches.length,1);
    assert.equal(new URL(env.launches[0][0]).searchParams.get("source"),source.path);
    assert.equal(new URL(env.launches[0][0]).searchParams.get("vault"),env.app.vault.getName());
    assert.equal(env.launches[0][1],"_blank"); assert.equal(env.reads(),0); assert.deepEqual(env.writes,[]); assert.deepEqual(notices,[]);
    let preview; env.plugin.openBoard=path => {preview=path;};
    const boardFile=env.files.get("InkSpace/test.inkspace.json"), previewEntries=env.menuFor(boardFile);
    assert.deepEqual(previewEntries.map(x => x.title),["在人生赢家中预览"]); previewEntries[0].click(); assert.equal(preview,boardFile.path); assert.equal(env.launches.length,1);
    assert.equal(env.menuFor(new TFile("notes.md"))[0].title,"新建人生赢家白板"); assert.deepEqual(env.menuFor({path:"folder.pdf"}),[]);
    for (const ext of ["PDF","doc","docx","xls","xlsx","ppt","pptx","md","markdown","PNG","jpg","jpeg"]) assert.equal(env.menuFor(new TFile(`课程/a.${ext}`))[0].title,"新建人生赢家白板");
  } finally {env.close();}
});

test("desktop and Android guide users to iPad; a removed source or launch failure cannot create files", async () => {
  const env=await sourceMenuEnvironment(); notices.length=0;
  try {
    const source=env.files.get("课程/讲义 #[A]%20.pdf"), entry=env.menuFor(source)[0];
    entry.click(); Platform.isMobileApp=true; entry.click();
    assert.equal(env.launches.length,0); assert.equal(notices.length,2); assert.ok(notices.every(x => /请在 iPad/.test(x)));
    Platform.isIosApp=true; env.files.delete(source.path); entry.click(); assert.match(notices.at(-1),/源文件不存在或已移动/); assert.equal(env.launches.length,0);
    env.files.set(source.path,source); window.open=()=>{throw new Error("Unavailable scheme");}; entry.click(); assert.match(notices.at(-1),/未能新建白板/);
    assert.deepEqual(env.writes,[]);
  } finally {env.close();}
});


test("folder routes preserve literal paths, encode empty vault root, and cannot include a source target", () => {
  for (const folder of ["", "COURSE101", "学期/COURSE101 # &+%2F", "课程/Week 01"]) {
    const route = new URL(h.nativeNewFolderDeepLink(folder,"课程 & name=other"));
    assert.deepEqual([...route.searchParams.keys()],["folder","vault"]);
    assert.equal(route.searchParams.get("folder"),folder);
    assert.equal(route.searchParams.get("vault"),"课程 & name=other");
    assert.equal(route.searchParams.has("source"),false);
  }
  assert.match(h.nativeNewFolderDeepLink("", "V"), /new\?folder=&vault=V$/);
  for (const path of [null, undefined, 0, "/", "/COURSE101", "../COURSE101", "a/../b", "a//b", "a\\b", "a\0b", "a\nb", "file:a"]) assert.throws(()=>h.nativeNewFolderDeepLink(path,"V"));
  for (const vault of ["",null,"v\nother"]) assert.throws(()=>h.nativeNewFolderDeepLink("COURSE101",vault));
});

test("only real existing folders launch a directory board after clicking, including vault root", async () => {
  const env=await sourceMenuEnvironment(); Platform.isIosApp=true; Platform.isMobileApp=true; notices.length=0;
  try {
    const folder=new TFolder("COURSE101 & #+%2F"); env.files.set(folder.path,folder);
    const entry=env.menuFor(folder)[0]; assert.equal(entry.title,"在此文件夹新建人生赢家白板"); assert.equal(env.launches.length,0);
    entry.click(); assert.equal(env.launches.length,1);
    const url=new URL(env.launches[0][0]); assert.equal(url.searchParams.get("folder"),folder.path); assert.equal(url.searchParams.has("source"),false);
    env.menuFor(env.app.vault.getRoot())[0].click(); assert.equal(new URL(env.launches[1][0]).searchParams.get("folder"),"");
    env.app.vault.getRoot().path=""; env.menuFor(env.app.vault.getRoot())[0].click(); assert.equal(env.launches.length,3);
    assert.deepEqual(env.menuFor({path:"COURSE101"}),[]); assert.deepEqual(env.menuFor(new TFolder("../outside")),[]);
    env.files.delete(folder.path); entry.click(); assert.equal(env.launches.length,3); assert.match(notices.at(-1),/文件夹不存在或已移动/);
    env.files.set(folder.path,new TFile(folder.path)); entry.click(); assert.equal(env.launches.length,3);
    env.files.set(folder.path,new TFolder("different/path")); entry.click(); assert.equal(env.launches.length,3);
    env.app.vault.getRoot=()=>({path:""}); env.plugin.createBoardInFolder(""); assert.equal(env.launches.length,3);
    assert.deepEqual(env.writes,[]); assert.equal(env.reads(),0);
    Platform.isIosApp=false; env.plugin.createBoardInFolder("COURSE101"); assert.match(notices.at(-1),/请在 iPad/); assert.equal(env.launches.length,3);
  } finally {env.close();}
});


test("dual original and PDF paths validate independently and retain PDF digest semantics", () => {
  const value = board(1); value.items[0] = {...pdfItem(), originalSourcePath:"课程/讲义 #[A]%2F.docx", originalSourceSHA256:"Ab".repeat(32)};
  value.pdfAnnotationSources=[{sourcePath:value.items[0].sourcePath,sha256:"c".repeat(64),pages:[1]}];
  assert.strictEqual(h.validateBoard(value),value);
  assert.equal(h.declarationFor(value,value.items[0].originalSourcePath),undefined);
  assert.equal(h.declarationFor(value,value.items[0].sourcePath).sha256,"c".repeat(64));
  for(const original of ["../private.md","/tmp/source.docx","a/../b.pptx","a\\b.md","https://host/file.md","a/x\n.md",42,{}]) {
    const bad=structuredClone(value);bad.items[0].originalSourcePath=original;assert.throws(()=>h.validateBoard(bad));
  }
  for(const sha of ["", "a".repeat(63), "g".repeat(64), 123, {digest:"a".repeat(64)}]) {
    const bad=structuredClone(value);bad.items[0].originalSourceSHA256=sha;assert.throws(()=>h.validateBoard(bad));
  }
  const noOriginal=structuredClone(value);delete noOriginal.items[0].originalSourcePath;assert.throws(()=>h.validateBoard(noOriginal));
  const wrongTarget=structuredClone(value);wrongTarget.items[0].sourcePath="课程/source.docx";assert.throws(()=>h.validateBoard(wrongTarget),/关联 PDF/);
  const legacy=board(1);legacy.items[0]=pdfItem();assert.strictEqual(h.validateBoard(legacy),legacy);
});

test("directory opens editable Markdown original without a PDF subpath and annotated PDF on its exact page", async () => {
  const value=board(1),original="课程/原文 #[A]%2F.md",pdf="课程/讲义 #[A]%20.pdf";
  value.items[0]={...pdfItem(12,pdf),originalSourcePath:original,originalSourceSHA256:"b".repeat(64),text:"<img src=x onerror=alert(1)>"};
  const env=appFor(value);env.files.set(original,new TFile(original));const writes=[];
  for(const method of ["modify","modifyBinary","create","createBinary"])env.app.vault[method]=()=>{writes.push(method);throw Error("unexpected write")};
  const plugin={app:env.app,panels:new Set()},panel=new h.BoardPanel(plugin,new FakeNode("div"),"");panel.board=value;panel.renderDirectory();
  const card=panel.entries.children[0],actions=card.children.at(-1),labels=actions.children.map(n=>n.textContent);
  assert.deepEqual(labels,["在白板定位","打开原文","打开批注版"]);
  actions.children[1].listeners.click();await tick();assert.equal(env.app.opened[0].path,original);assert.equal(env.app.opened[1],undefined);
  actions.children[2].listeners.click();await tick();assert.equal(env.app.opened[0].path,pdf);assert.deepEqual(env.app.opened[1],{eState:{subpath:"#page=12"}});
  assert.ok(card.children.some(n=>n.textContent==="<img src=x onerror=alert(1)>"));assert.ok(!card.children.some(n=>n.tagName==="img"));
  assert.deepEqual(writes,[]);panel.destroy();
});

test("original filenames are searchable and refresh watches both paths and containing folders", async () => {
  const value=board(1),original="课程/独特原文名字.pptx";value.items[0]={...pdfItem(),originalSourcePath:original};
  assert.equal(h.pageEntries(value,"独特原文").total,1);
  assert.deepEqual(h.referencedSourcePaths(value),[value.items[0].sourcePath,original]);
  const env=appFor(value);env.files.set(original,new TFile(original));const panel=new h.BoardPanel({app:env.app,panels:new Set()},new FakeNode("div"),"InkSpace/test.inkspace.json");await tick();
  assert.equal(panel.related(original),true);assert.equal(panel.related("课程"),true);assert.equal(panel.related("课"),false);assert.equal(panel.related("unrelated.md"),false);
  let changes=0;panel.viewer.cache.invalidate=()=>changes++;env.files.get(original).stat.mtime++;await panel.refresh();assert.equal(changes,1);assert.ok(panel.signatures.has(original));
  env.files.delete(original);await panel.refresh();assert.equal(changes,2);assert.ok(env.reads()>=3);panel.destroy();
});

test("Markdown source menu requires exact existing file, encodes once, and leaves original text to Obsidian", async () => {
  const env=await sourceMenuEnvironment();Platform.isIosApp=true;Platform.isMobileApp=true;
  try{
    const original="课堂/原文 & #[]%2F.markdown",file=new TFile(original);env.files.set(original,file);
    const entry=env.menuFor(file)[0];assert.equal(env.launches.length,0);entry.click();
    assert.equal(new URL(env.launches[0][0]).searchParams.get("source"),original);assert.equal(new URL(env.launches[0][0]).hash,"");
    await h.openSourceFile(env.app,original);assert.strictEqual(env.app.opened[0],file);assert.equal(env.app.opened[1],undefined);assert.equal(env.reads(),0);assert.deepEqual(env.writes,[]);
    env.files.delete(original);await assert.rejects(h.openSourceFile(env.app,original),/源文件不存在/);
  }finally{env.close();}
});

test("legacy single-source actions and exact PDF click keep their prior meaning", () => {
  const legacy=pdfItem(9);assert.deepEqual(h.itemSourceTargets(legacy),[{label:"打开原件",path:legacy.sourcePath,page:9}]);
  assert.deepEqual(h.itemSourceTargets({...legacy,originalSourcePath:legacy.sourcePath}),h.itemSourceTargets(legacy));
  assert.deepEqual(h.itemSourceTargets({kind:"text",title:"plain"}),[]);
  assert.throws(()=>h.itemSourceTargets({...legacy,originalSourcePath:"../a.md"}));
  assert.throws(()=>h.itemSourceTargets({...legacy,sourcePath:"a.docx",originalSourcePath:"b.md"}));
  const value=board(2);value.items=[{...legacy,originalSourcePath:"a.md"},{...legacy,id:uuid(2),originalSourcePath:"a.md"}];
  assert.equal(h.referencedSourcePaths(value).length,2);
});


test("Letter frames survive native JSON without changing page order or old boards", () => {
  assert.equal(h.validateBoard(board()).printFrames, undefined);
  const value = board();
  value.printFrames = [
    {id:uuid(980002),x:200,y:300,width:540,height:720,orientation:"portrait",normalizedClip:[[0,0],[0.4,0.7]]},
    {id:uuid(980001),x:800,y:300,width:1440,height:1080,orientation:"landscape"}
  ];
  const decoded = JSON.parse(JSON.stringify(value));
  assert.strictEqual(h.validateBoard(decoded), decoded);
  assert.deepEqual(decoded.printFrames, value.printFrames);
  for (const alter of [
    v=>v.printFrames[1].id=v.printFrames[0].id,
    v=>v.printFrames[0].orientation="A4",
    v=>v.printFrames[0].width=720,
    v=>v.printFrames[0].x=-1,
    v=>v.printFrames[0].normalizedClip=[[0,0],[1.01,1]],
    v=>v.printFrames[0].normalizedClip=[[0,0],[0,1]],
    v=>v.printFrames[0].normalizedClip=[[0,0],[Infinity,1]],
    v=>v.printFrames[0].normalizedClip={x:0,y:0,width:1,height:1},
    v=>v.printFrames=Array(2001).fill(value.printFrames[0])
  ]) { const invalid=structuredClone(value); alter(invalid); assert.throws(()=>h.validateBoard(invalid)); }
});

test("image and Excel derived PDFs expose both exact original and annotated targets", () => {
  for (const ext of ["PNG","jpg","JPEG","xls","xlsx"]) {
    const value=board(1); const original=`课程/文件 #[A]+%.${ext}`;
    value.items[0]={...pdfItem(), originalSourcePath:original, originalSourceSHA256:"ab".repeat(32)};
    h.validateBoard(value);
    assert.deepEqual(h.itemSourceTargets(value.items[0]),[
      {label:"打开原文",path:original},
      {label:"打开批注版",path:value.items[0].sourcePath,page:1}
    ]);
    assert.ok(h.referencedSourcePaths(value).includes(original));
  }
});

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function visibleText(node) { return descendants(node).map(value => value.textContent).filter(Boolean); }

test("public app language chooses Simplified Chinese or English with complete messages and safe placeholders", () => {
  const manifest = require("../inkspace-companion/manifest.json");
  assert.equal(manifest.version, "0.6.0"); assert.equal(manifest.minAppVersion, "1.8.7"); assert.equal(manifest.id, "inkspace-companion"); assert.equal(manifest.name, "人生赢家");
  for (const language of ["zh", "zh-CN", "zh_SG", "zh-Hans", "zh-Hans-CN"]) { obsidianLanguage=language; assert.equal(h.getLocale(),"zh"); }
  for (const language of ["en", "en-CA", "fr", "zh-TW", "", undefined, null, 12]) { obsidianLanguage=language; assert.equal(h.getLocale(),"en"); }
  languageUnavailable=true; assert.equal(h.getLocale(),"en"); languageUnavailable=false;
  assert.deepEqual(Object.keys(h.MESSAGES.zh).sort(),Object.keys(h.MESSAGES.en).sort());
  for (const [key, value] of Object.entries(h.MESSAGES.en)) {
    assert.ok(value.length>0,key); assert.doesNotMatch(value.replaceAll("人生赢家",""),/\p{Script=Han}/u,key);
    assert.deepEqual((value.match(/\{[a-zA-Z]+\}/g)||[]).sort(),(h.MESSAGES.zh[key].match(/\{[a-zA-Z]+\}/g)||[]).sort(),key);
  }
  const source = "课程/原文 {page} $& <script>😀.md";
  obsidianLanguage="en"; assert.equal(h.t("directory.originalPath",{path:source}),"Original: "+source);
  obsidianLanguage="zh"; assert.equal(h.t("directory.originalPath",{path:source}),"原文："+source);
});

test("English commands, chooser, Markdown embed errors and menu labels retain stable command and protocol IDs", async () => {
  obsidianLanguage="en"; const env=await sourceMenuEnvironment(); notices.length=0;
  try {
    assert.deepEqual(env.commands.map(({id,name})=>({id,name})),[
      {id:"open-board",name:"Choose board"},{id:"preview-current-board",name:"Preview current .inkspace.json"}
    ]);
    assert.equal(env.ribbons[0][1],"Open 人生赢家 board");
    const chooser=new h.BoardChooser(env.app,()=>{}); assert.equal(chooser.placeholder,"Search board names or paths (.inkspace.json)");
    assert.equal(chooser.getItemText(env.files.get("InkSpace/test.inkspace.json")),"InkSpace/test.inkspace.json");
    env.app.workspace.getActiveFile=()=>null; env.commands[1].callback(); assert.equal(notices.at(-1),'Select an .inkspace.json file first, or use “Choose board”.');
    assert.deepEqual([...env.processors.keys()],["inkspace"]);
    const host=new FakeNode("div"); env.processors.get("inkspace")("{partial",host,{}); assert.equal(host.children[0].textContent,"人生赢家: The board embed is not valid JSON.");
    const file=env.files.get("InkSpace/test.inkspace.json"), source=env.files.get("课程/讲义 #[A]%20.pdf");
    assert.equal(env.menuFor(file)[0].title,"Preview in 人生赢家"); assert.equal(env.menuFor(source)[0].title,"New 人生赢家 board");
    assert.deepEqual(env.launches,[]); assert.deepEqual(env.writes,[]);
  } finally { env.close(); }
});

test("English folder and source actions encode non-ASCII user paths once and report localized failures without writes", async () => {
  obsidianLanguage="en"; const env=await sourceMenuEnvironment(); notices.length=0;
  try {
    const folder=new TFolder("课程/选择白板 & #+%2F 😀"); env.files.set(folder.path,folder);
    const entry=env.menuFor(folder)[0]; assert.equal(entry.title,"New 人生赢家 board in this folder"); entry.click();
    assert.equal(notices.at(-1),"Use this feature in Obsidian on an iPad with 人生赢家 installed."); assert.equal(env.launches.length,0);
    Platform.isIosApp=true; Platform.isMobileApp=true; entry.click();
    const folderURL=new URL(env.launches[0][0]); assert.equal(folderURL.searchParams.get("folder"),folder.path); assert.equal(folderURL.searchParams.get("vault"),env.app.vault.getName()); assert.equal(folderURL.searchParams.has("source"),false);
    const source=env.files.get("课程/讲义 #[A]%20.pdf"); env.menuFor(source)[0].click();
    const sourceURL=new URL(env.launches[1][0]); assert.equal(sourceURL.searchParams.get("source"),source.path); assert.equal(sourceURL.searchParams.has("folder"),false);
    env.menuFor(env.app.vault.getRoot())[0].click(); assert.equal(new URL(env.launches[2][0]).searchParams.get("folder"),"");
    env.files.delete(folder.path); entry.click(); assert.equal(notices.at(-1),"Could not create the board: The folder is missing or has moved. Choose the folder again.");
    env.files.delete(source.path); env.plugin.createBoardForSource(source.path); assert.equal(notices.at(-1),"Could not create the board: The source file is missing or has moved. Choose the file again.");
    assert.equal(env.launches.length,3); assert.deepEqual(env.writes,[]); assert.equal(env.reads(),0);
  } finally { env.close(); }
});

test("English board panel localizes navigation, counts, accessibility and source actions without translating user data", async () => {
  obsidianLanguage="en";
  const value=board(2), original="课程/原文 {page} #[A]%2F.md";
  value.title="选择白板 — Café 学习 😀"; value.webInk=ink();
  value.items[0]={...pdfItem(12),title:"打开原文",originalSourcePath:original,originalSourceSHA256:"a".repeat(64),text:"内容 <img src=x onerror=alert(1)> {page}",url:"https://example.org/notes"};
  value.items[1].title="文字"; value.items[1].text="刷新";
  value.pins=[{id:uuid(980001),title:"定位点",x:500000,y:500000,zoom:1}];
  const before=JSON.stringify(value), env=appFor(value); env.files.set(original,new TFile(original));
  const plugin={app:env.app,panels:new Set(),chooseBoard(){},openBoard(){}};
  const host=new FakeNode("div"), panel=new h.BoardPanel(plugin,host,"InkSpace/test.inkspace.json",{embedded:true});
  try {
    await tick(); assert.equal(panel.heading.textContent,value.title); assert.equal(panel.native.textContent,"Write in 人生赢家");
    assert.equal(panel.native.href,h.nativeDeepLink("InkSpace/test.inkspace.json"));
    assert.equal(panel.capacity.textContent,"Objects: 2 · Connections: 0 · Web strokes: 1 · 1.0 KB"); assert.match(panel.status.textContent,/^Read-only · saved /);
    assert.equal(panel.search.placeholder,"Search names, text, and file paths"); assert.equal(panel.search.attributes["aria-label"],panel.search.placeholder);
    for (const label of ["Choose board","Refresh","Open full view","Search files, items, and pins"]) assert.ok(visibleText(host).includes(label),label);
    assert.deepEqual(panel.viewer.controls.children.map(n=>n.textContent),["−","+","","Overview","Saved view"]);
    assert.equal(panel.viewer.controls.children[0].attributes["aria-label"],"Zoom out"); assert.equal(panel.viewer.controls.children[1].attributes["aria-label"],"Zoom in");
    assert.match(panel.viewer.stage.attributes["aria-label"],/^Read-only board\./);
    const card=panel.entries.children[0], actions=card.children.at(-1);
    assert.equal(card.children[0].textContent,"打开原文"); assert.ok(visibleText(card).includes(value.items[0].text));
    assert.ok(visibleText(card).includes("Original: "+original)); assert.ok(visibleText(card).includes(value.items[0].sourcePath+" · Page 12"));
    assert.deepEqual(actions.children.map(n=>n.textContent),["Locate on board","Open original source","Open annotated PDF","Open web page"]);
    actions.children[1].listeners.click(); await tick(); assert.equal(env.app.opened[0].path,original); assert.equal(env.app.opened[1],undefined);
    actions.children[2].listeners.click(); await tick(); assert.equal(env.app.opened[0].path,value.items[0].sourcePath); assert.deepEqual(env.app.opened[1],{eState:{subpath:"#page=12"}});
    assert.equal(panel.entries.children[1].children[0].textContent,"文字"); assert.equal(panel.entries.children[2].children[0].textContent,"定位点");
    assert.deepEqual(panel.pager.children.map(n=>n.textContent),["Previous","Page 1/1 · 3 entries · up to 60 per page","Next"]);
    assert.equal(h.pageEntries(value,"PDF page").total,1); assert.equal(h.pageEntries(value,"Pin").total,1); assert.equal(h.pageEntries(value,"Café").total,0);
    assert.equal(h.pageEntries(value,"原文").total,1); assert.equal(JSON.stringify(value),before); assert.equal(JSON.stringify(panel.board),before);
    assert.ok(!descendants(host).some(n=>n.tagName==="img"));
  } finally { panel.destroy(); }
});

test("English canvas PDF placeholders, scene status, empty kind labels and legacy screenshot guidance are readable", () => {
  obsidianLanguage="en"; const value=board(1); value.items[0]={...pdfItem(3),title:""};
  const env=appFor(value), host=new FakeNode("div"), states=[], viewer=new h.BoardViewer(env.app,host,text=>states.push(text));
  try {
    viewer.cache.request=()=>{}; viewer.setBoard(value); viewer.draw();
    assert.ok(viewer.base.calls.some(call=>call[0]==="fillText"&&call[1]==="Page 3 · loading")); assert.equal(states.at(-1),"Nearby objects: 1 · Detailed: 1");
    viewer.cache.peek=()=>({error:"The PDF has not synced. Click to open the original file."}); viewer.draw();
    assert.ok(viewer.base.calls.some(call=>call[0]==="fillText"&&call[1]==="Waiting for PDF · click to open original")); assert.match(states.at(-1),/The PDF has not synced/);
  } finally { viewer.destroy(); }
  const panel=new h.BoardPanel({app:env.app,panels:new Set()},new FakeNode("div"),"");
  try {
    value.previewPNG="iVBORw0KGgo="; panel.board=value; panel.renderLegacy(); panel.renderDirectory();
    assert.match(panel.legacy.children[0].textContent,/older board has no complete web handwriting export/);
    assert.equal(panel.legacy.children[1].children[0].textContent,"View the older partial handwriting screenshot (not the whole board)");
    assert.equal(panel.legacy.children[1].children[1].alt,"Partial screenshot of the view saved by the native app");
    assert.equal(panel.entries.children[0].children[0].textContent,"PDF page");
  } finally { panel.destroy(); }
});

test("English validation failures keep their safety checks, and malformed JSON retains the last complete board", async () => {
  obsidianLanguage="en";
  const mutations=[
    [v=>v.schemaVersion=3,/format version is not supported/],
    [v=>v.id="invalid",/board identifiers are invalid/],
    [v=>v.title=9,/board title is invalid/],
    [v=>v.revision=-1,/board revision is invalid/],
    [v=>v.createdAt="bad",/board date is invalid/],
    [v=>v.canvasHeight=1,/canvas dimensions/],
    [v=>v.viewport.zoom=0,/viewport is invalid/],
    [v=>v.items=null,/directory is missing/],
    [v=>v.drawing=[],/image data/],
    [v=>v.items[0].kind="unknown",/item has an invalid type/],
    [v=>v.items[1].id=v.items[0].id,/duplicate item/],
    [v=>v.items[0].text={},/invalid text or handwriting data/],
    [v=>v.items[0].x=-1,/invalid position or size/],
    [v=>v.items[0].sourcePath="../private.pdf",/Document references must use safe/],
    [v=>v.items[0].originalSourcePath="/outside.md",/Original source references must use safe/],
    [v=>v.items[0].originalSourceSHA256="a".repeat(64),/original source digest is invalid/],
    [v=>v.items[0]={...pdfItem(),originalSourcePath:"a.md",sourcePath:"b.md"},/Annotation pages must reference/],
    [v=>v.items[0].page=0,/positive integers/],
    [v=>v.items[0].kind="pdfPage",/missing its page number/],
    [v=>v.edges=[{id:uuid(88),from:uuid(1),to:uuid(999)}],/connection refers to an invalid item/],
    [v=>v.pins=[{id:uuid(89),title:"pin",x:-1,y:0,zoom:1}],/pin data is invalid/],
    [v=>v.printFrames={},/print page list is invalid/],
    [v=>v.pdfAnnotationSources=[{sourcePath:"a.pdf",sha256:"bad",pages:[1]}],/PDF annotation sync version is invalid/]
  ];
  for(const [mutate,message] of mutations){const value=board();mutate(value);assert.throws(()=>h.validateBoard(value),message);}
  for(const [mutate,message] of [
    [v=>v.strokes[0].opacity=2,/invalid color or opacity/],
    [v=>v.strokes[0].points=[],/invalid sample count/],
    [v=>v.strokes[0].points[0][0]=8000001,/invalid world coordinates/]
  ]){const value=ink();mutate(value);assert.throws(()=>h.validateWebInk(value),message);}
  assert.throws(()=>h.nativeNewFolderDeepLink("../bad","V"),/Choose a folder within this vault/);
  assert.throws(()=>h.parseEmbed("{bad"),/embed is not valid JSON/);
  assert.throws(()=>h.parseEmbed("{}"),/Use \{"file":"InkSpace\/Board.inkspace.json"\}/);
  const value=board(), env=appFor(value), panel=new h.BoardPanel({app:env.app,panels:new Set()},new FakeNode("div"),"InkSpace/test.inkspace.json");
  try {
    await tick(); const before=JSON.stringify(panel.board); env.raw("{partial"); await panel.refresh();
    assert.equal(panel.status.textContent,"Keeping the last complete board. Cannot read the board right now: The board file is not valid JSON.");
    assert.equal(JSON.stringify(panel.board),before);
    env.files.delete("InkSpace/test.inkspace.json"); await panel.refresh(); assert.match(panel.status.textContent,/Choose its .inkspace.json file in the same vault to reconnect/);
  } finally { panel.destroy(); }
});

test("English PDF cache reports missing, oversized and changed files while retaining bounded preview behavior", async () => {
  obsidianLanguage="en"; const env=appFor();
  for(const [item,configure,expected] of [
    [pdfItem(1,"课程/丢失.pdf"),()=>{},/The PDF has not synced/],
    [pdfItem(1),()=>{env.files.get(pdfItem().sourcePath).stat.size=129*1024*1024;},/exceeds the 128 MB preview limit/]
  ]){
    configure(); const cache=new h.PDFPreviewCache(env.app,()=>{});
    try { cache.request([{item,width:128}]); await idle(cache); assert.match(cache.peek(item,128).error,expected); assert.ok(cache.pixels<=h.MAX_CACHED_PIXELS); }
    finally { cache.destroy(); }
  }
  env.files.get(pdfItem().sourcePath).stat.size=20;
  const item=pdfItem(),declaration={sourcePath:item.sourcePath,sha256:"0".repeat(64),pages:[1]},cache=new h.PDFPreviewCache(env.app,()=>{});
  try {cache.request([{item,width:128,declaration}]);await idle(cache);const tile=cache.peek(item,128,declaration);assert.match(tile.warning,/The PDF has changed/);assert.equal(tile.matched,false);assert.ok(tile.canvas);}
  finally {cache.destroy();}
});

test("new English and Chinese views use their selected UI language while preserving identical native board content", async () => {
  const value=board(1); value.title="未命名白板";value.items[0].title="";value.webInk=ink();const before=JSON.stringify(value);
  for(const [language,labels] of [["en",["Choose board","Text","Locate on board"]],["zh",["选择白板","文字","在白板定位"]]]){
    obsidianLanguage=language;const env=appFor(value),host=new FakeNode("div"),panel=new h.BoardPanel({app:env.app,panels:new Set()},host,"InkSpace/test.inkspace.json");
    try{
      await tick();assert.equal(panel.heading.textContent,"未命名白板");
      for(const label of labels)assert.ok(visibleText(host).includes(label),label);
      assert.equal(JSON.stringify(panel.board),before);assert.equal(h.pageEntries(value,labels[1]).total,1);
      const view=new h.InkSpaceView({},{});view.panel=panel;assert.equal(view.getDisplayText(),"未命名白板");assert.equal(view.getViewType(),"inkspace-companion-view");
      assert.equal(h.nativeDeepLink("课程/未命名白板.inkspace.json"),"inkspace://open?file="+encodeURIComponent("课程/未命名白板.inkspace.json"));
    }finally{panel.destroy();}
  }
});

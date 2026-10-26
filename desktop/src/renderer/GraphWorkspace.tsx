import {inspectLibraryGroups,isLibraryDecoration} from '../shared/board-library';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Plus, Minus, Maximize2, Undo2, Redo2, Search, Trash2, Link2, ArrowRight, ArrowDown } from 'lucide-react';
import { Button } from './ui';
import type { Language } from './i18n';
import './graph.css';
import MindInkPreview from './MindInkPreview';
import MindSourcePreview from './MindSourcePreview';
import type {PDFSourceReference} from '../shared/pdf-extend';
import ContextMenu, { type ContextMenuState } from './ContextMenu';

export function sourceReference(node:Record<string,unknown>):PDFSourceReference|undefined{
 const r=node.sourceReference;if(!r||typeof r!=='object'||Array.isArray(r))return;const v=r as Record<string,unknown>,rect=v.rect as Record<string,unknown>;
 if(v.schemaVersion!==1||typeof v.path!=='string'||typeof v.sourceSHA256!=='string'||!/^[a-f0-9]{64}$/.test(v.sourceSHA256)||!Number.isInteger(v.page)||Number(v.page)<1||!rect||![rect.x,rect.y,rect.width,rect.height].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)||Number(rect.x)+Number(rect.width)>1.000001||Number(rect.y)+Number(rect.height)>1.000001)return;
 return v as PDFSourceReference;
}

// Graph model helpers: pure operations preserve non-editable board data.
export type GraphNode = { id: string; path: string; label: string };
export type GraphEdge = { from: string; to: string };
type Point = { x: number; y: number };
type Camera = Point & { zoom: number };
type Size = { width: number; height: number };
type Rect = Point & Size;
type NodeStyle = { fillColor: string; strokeColor: string; textColor: string; fontSize: number; shape: 'rectangle' | 'rounded' | 'ellipse'; strokeWidth: number };
type EdgeStyle = { strokeColor:string;strokeWidth:number;arrow:'none'|'end'|'both';dash?:'solid'|'dashed'|'dotted'|'dashDot';opacity?:number };
type MindNode = Record<string, unknown> & Rect & { id: string; kind: 'text' | 'formula' | 'inkGroup' | 'pdfPage' | 'document' | 'link'; title: string; text?: string; textFormat?:string;richTextHTML?:string; style?: Partial<NodeStyle>; sourcePath?: string; originalSourcePath?: string; page?: number };
type MindEdge = Record<string, unknown> & GraphEdge & { id: string; style?: Partial<EdgeStyle>;relation?:string };
type Model = { nodes: MindNode[]; edges: MindEdge[]; allItems: Record<string, unknown>[]; allEdges: Record<string, unknown>[]; total: number; valid: boolean };
export const GRAPH_LIMIT = 1000;
const GRAPH_EDGE_LIMIT = 5000;
const NODE_STYLE: NodeStyle = { fillColor: '#ffffff', strokeColor: '#8aa9a3', textColor: '#243b38', fontSize: 18, shape: 'rounded', strokeWidth: 2 };
const EDGE_STYLE: EdgeStyle = { strokeColor: '#718f89', strokeWidth: 2, arrow: 'end' };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const lower = (v: unknown) => typeof v === 'string' ? v.toLowerCase() : '';
const textEditable = (item: Record<string, unknown>) => item.kind === 'text' || item.kind === 'formula';
const eligible = (item: Record<string, unknown>) => ['text', 'formula', 'inkGroup', 'pdfPage', 'document', 'link'].includes(String(item.kind));
const color = (v: unknown, fallback: string) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
function numberStyle(v: unknown, fallback: number, min: number, max: number) { return finite(v) ? clamp(v, min, max) : fallback; }
export function nodeStyle(value: unknown): NodeStyle {
 const s = object(value) ? value : {};
 return { fillColor: color(s.fillColor, NODE_STYLE.fillColor), strokeColor: color(s.strokeColor, NODE_STYLE.strokeColor), textColor: color(s.textColor, NODE_STYLE.textColor), fontSize: numberStyle(s.fontSize, 18, 8, 72), shape: ['rectangle', 'rounded', 'ellipse'].includes(String(s.shape)) ? s.shape as NodeStyle['shape'] : 'rounded', strokeWidth: numberStyle(s.strokeWidth, 2, 1, 8) };
}
export function edgeStyle(value: unknown): EdgeStyle {
 const s = object(value) ? value : {};
 return { strokeColor: color(s.strokeColor, EDGE_STYLE.strokeColor), strokeWidth: numberStyle(s.strokeWidth, 2, 1, 12), arrow: ['none', 'end', 'both'].includes(String(s.arrow)) ? s.arrow as EdgeStyle['arrow'] : 'end',dash:['solid','dashed','dotted','dashDot'].includes(String(s.dash))?s.dash as EdgeStyle['dash']:'solid',opacity:numberStyle(s.opacity,1,.1,1) };
}
export function readMindModel(board: Record<string, unknown>): Model {
 const valid = board.schemaVersion === 1 && Array.isArray(board.items) && Array.isArray(board.edges) && board.items.every(object) && board.edges.every(object);
 const allItems = valid ? board.items as Record<string, unknown>[] : [], allEdges = valid ? board.edges as Record<string, unknown>[] : [];
 const groups=allItems.some(i=>'libraryGroup' in i)?inspectLibraryGroups(board):[];
 const editable = allItems.filter(i => !isLibraryDecoration(i,board,groups)&&eligible(i) && typeof i.id === 'string' && typeof i.title === 'string' && [i.x, i.y, i.width, i.height].every(finite) && (i.width as number) > 0 && (i.height as number) > 0) as MindNode[];
 const nodes = editable.slice(0, GRAPH_LIMIT), ids = new Set(nodes.map(i => lower(i.id)));
 const edges = allEdges.filter(e => typeof e.id === 'string' && ids.has(lower(e.from)) && ids.has(lower(e.to))).slice(0, GRAPH_EDGE_LIMIT) as MindEdge[];
 return { nodes, edges, allItems, allEdges, total: editable.length, valid };
}
function extent(board: Record<string, unknown>): Size {
 return { width: finite(board.canvasWidth) && board.canvasWidth > 0 ? board.canvasWidth : 8000000, height: finite(board.canvasHeight) && board.canvasHeight > 0 ? board.canvasHeight : 8000000 };
}
export function boundedPosition(board: Record<string, unknown>, item: Size, point: Point): Point {
 const size = extent(board);
 if (![item.width, item.height, point.x, point.y].every(finite) || item.width <= 0 || item.height <= 0 || item.width > size.width || item.height > size.height) throw Error('bounds');
 return { x: clamp(point.x, 0, size.width - item.width), y: clamp(point.y, 0, size.height - item.height) };
}
export function patchMindNode(board: Record<string, unknown>, id: string, patch: Partial<MindNode>): Record<string, unknown> {
 const model = readMindModel(board), item = model.allItems.find(i => lower(i.id) === lower(id));
 if (!model.valid || !item || !eligible(item)) throw Error('protected');
 const next = { ...item };
 const keys = textEditable(item) ? ['title', 'text', 'kind', 'x', 'y', 'width', 'height', 'style', 'textFormat', 'richTextHTML'] : ['title', 'x', 'y', 'width', 'height', 'style'];
 for (const key of keys) if (patch[key] !== undefined) next[key] = patch[key];
 if (textEditable(item) && !textEditable(next)) throw Error('protected');
 if (!eligible(next) || typeof next.title !== 'string' || next.title.length > 10000 || (next.text != null && (typeof next.text !== 'string' || next.text.length > 100000))) throw Error('invalid');
 if (patch.text !== undefined && patch.text !== item.text && (item.textFormat==='richText'||(item.textFormat==null&&item.kind==='text')) && (patch.richTextHTML===undefined||patch.richTextHTML===item.richTextHTML)) next.richTextHTML='';
 if (patch.kind !== undefined && patch.kind !== item.kind && (patch.textFormat===undefined||patch.textFormat===item.textFormat)) {next.textFormat=patch.kind==='formula'?'latex':'richText';next.richTextHTML='';}
 if (patch.style) next.style = { ...(object(item.style) ? item.style : {}), ...nodeStyle({ ...(object(item.style) ? item.style : {}), ...patch.style }) };
 const position = boundedPosition(board, next as MindNode, next as MindNode);
 if (next.x !== position.x || next.y !== position.y) throw Error('bounds');
 return { ...board, items: model.allItems.map(i => i === item ? next : i) };
}
export function addMindNode(board: Record<string, unknown>, title: string, point: Point, parentID?: string, id:string = crypto.randomUUID(), edgeID:string = crypto.randomUUID()): Record<string, unknown> {
 const model = readMindModel(board);
 if (!model.valid || model.total >= GRAPH_LIMIT || model.allItems.length >= 100000 || model.allItems.some(i => lower(i.id) === lower(id))) throw Error('limit');
 const parent = parentID ? model.nodes.find(n => lower(n.id) === lower(parentID)) : undefined;
 if (parentID && !parent) throw Error('invalid');
 if (parent && model.allEdges.length >= 100000) throw Error('limit');
 const node: MindNode = { id, kind: 'text', title, text: '', width: 300, height: 150, ...boundedPosition(board, { width: 300, height: 150 }, point), style: { ...NODE_STYLE } };
 return { ...board, items: [...model.allItems, node], edges: parent ? [...model.allEdges, { id: edgeID, from: parent.id, to: id, relation:'child', style: { ...EDGE_STYLE } }] : model.allEdges };
}
export function removeMindNode(board: Record<string, unknown>, id: string): Record<string, unknown> {
 const model = readMindModel(board), item = model.allItems.find(i => lower(i.id) === lower(id));
 if (!model.valid || !item || !textEditable(item)) throw Error('protected');
 return { ...board, items: model.allItems.filter(i => i !== item), edges: model.allEdges.filter(e => lower(e.from) !== lower(id) && lower(e.to) !== lower(id)) };
}
export function connectMindNodes(board: Record<string, unknown>, from: string, to: string, id = crypto.randomUUID()): Record<string, unknown> {
 const model = readMindModel(board), ids = new Map(model.nodes.map(i => [lower(i.id), i.id]));
 if (!model.valid || lower(from) === lower(to) || !ids.has(lower(from)) || !ids.has(lower(to))) throw Error('invalid');
 if (model.allEdges.some(e => lower(e.from) === lower(from) && lower(e.to) === lower(to))) return board;
 if (model.allEdges.length >= 100000) throw Error('limit');
 return { ...board, edges: [...model.allEdges, { id, from: ids.get(lower(from))!, to: ids.get(lower(to))!, style: { ...EDGE_STYLE } }] };
}
export function reparentMindNode(board:Record<string,unknown>,childID:string,parentID:string,id=crypto.randomUUID()):Record<string,unknown>{
 const model=readMindModel(board),child=model.nodes.find(n=>lower(n.id)===lower(childID)),parent=model.nodes.find(n=>lower(n.id)===lower(parentID));if(!child||!parent||child===parent)throw Error('invalid');
 const adjacency=new Map<string,string[]>();for(const e of model.allEdges){if(e.relation&&e.relation!=='child')continue;const from=lower(e.from);adjacency.set(from,[...(adjacency.get(from)||[]),lower(e.to)]);}const queue=[lower(childID)],seen=new Set<string>();for(let i=0;i<queue.length;i++){const node=queue[i];if(node===lower(parentID))throw Error('cycle');if(seen.has(node))continue;seen.add(node);for(const next of adjacency.get(node)||[])if(!seen.has(next))queue.push(next);}
 const previous=model.allEdges.find(e=>lower(e.from)===lower(parentID)&&lower(e.to)===lower(childID));const edges=model.allEdges.filter(e=>!((!e.relation||e.relation==='child')&&lower(e.to)===lower(childID))&&e!==previous);if(edges.length>=100000)throw Error('limit');
 let point={x:parent.x+parent.width+100,y:parent.y};const area=extent(board);if(point.x+child.width>area.width)point.x=Math.max(0,parent.x-child.width-100);
 for(let tries=0;tries<2000;tries++){const collision=model.nodes.find(n=>n!==child&&point.x<n.x+n.width+30&&point.x+child.width+30>n.x&&point.y<n.y+n.height+30&&point.y+child.height+30>n.y);if(!collision)break;point.y=collision.y+collision.height+50;if(point.y+child.height>area.height)throw Error('bounds');if(tries===1999)throw Error('limit');}
 const moved=patchMindNode(board,childID,point);return{...moved,edges:[...edges,{...(previous||{}),id:previous?.id||id,from:parent.id,to:child.id,relation:'child',style:{...EDGE_STYLE,...(object(previous?.style)?previous.style:{})}}]};
}
export function setMindRelation(board:Record<string,unknown>,id:string,relation:string){if(relation.length>120)throw Error('invalid');return{...board,edges:(board.edges as Record<string,unknown>[]).map(e=>lower(e.id)===lower(id)?{...e,relation}:e)};}
export const mindDash=(s:EdgeStyle)=>s.dash==='dashed'?'10 6':s.dash==='dotted'?'2 5':s.dash==='dashDot'?'10 5 2 5':undefined;
export function patchMindEdge(board: Record<string, unknown>, id: string, style: EdgeStyle | null): Record<string, unknown> {
 const model = readMindModel(board), edge = model.edges.find(e => lower(e.id) === lower(id));
 if (!edge) throw Error('protected');
 return { ...board, edges: style ? model.allEdges.map(e => e === edge ? { ...e, style: { ...(object(e.style) ? e.style : {}), ...edgeStyle(style) } } : e) : model.allEdges.filter(e => e !== edge) };
}
export function reverseMindEdge(board: Record<string, unknown>, id: string): Record<string, unknown> {
 const model = readMindModel(board), edge = model.edges.find(e => lower(e.id) === lower(id));
 if (!edge) throw Error('protected');
 return { ...board, edges: model.allEdges.map(e => e === edge ? { ...e, from: edge.to, to: edge.from } : e) };
}
// A bounded breadth-first forest handles cycles and disconnected nodes. Layout
// changes only editable nodes; documents, ink and print frames keep their positions.
export function layoutMindTree(board: Record<string, unknown>, direction: 'horizontal' | 'vertical', preferredRoot?: string): Record<string, unknown> {
 const model = readMindModel(board); if (!model.valid || !model.nodes.length) return board;
 const ids = new Map(model.nodes.map(n => [lower(n.id), n])), children = new Map<string, string[]>(), incoming = new Set<string>();
 for (const e of model.edges) { const a = lower(e.from), b = lower(e.to); if (a !== b) { if (!children.has(a)) children.set(a, []); children.get(a)!.push(b); incoming.add(b); } }
 const candidates = [...(preferredRoot && ids.has(lower(preferredRoot)) ? [lower(preferredRoot)] : []), ...model.nodes.filter(n => !incoming.has(lower(n.id))).map(n => lower(n.id)), ...ids.keys()];
 const visited = new Set<string>(), placements = new Map<string, Point>();
 const depthStep = Math.max(...model.nodes.map(n => direction === 'horizontal' ? n.width : n.height)) + 100;
 const rowStep = Math.max(...model.nodes.map(n => direction === 'horizontal' ? n.height : n.width)) + 60;
 let baseRow = 0;
 for (const root of candidates) {
  if (visited.has(root)) continue;
  const queue: { id: string; depth: number }[] = [{ id: root, depth: 0 }], rows = new Map<number, number>(); visited.add(root);
  let maxRows = 0;
  for (let q = 0; q < queue.length; q++) {
   const { id, depth } = queue[q], row = rows.get(depth) || 0; rows.set(depth, row + 1); maxRows = Math.max(maxRows, row + 1);
   placements.set(id, direction === 'horizontal' ? { x: depth * depthStep, y: (baseRow + row) * rowStep } : { x: (baseRow + row) * rowStep, y: depth * depthStep });
   for (const child of children.get(id) || []) if (!visited.has(child)) { visited.add(child); queue.push({ id: child, depth: depth + 1 }); }
  }
  baseRow += maxRows + 1;
 }
 let right = 0, bottom = 0;
 for (const node of model.nodes) { const p = placements.get(lower(node.id))!; right = Math.max(right, p.x + node.width); bottom = Math.max(bottom, p.y + node.height); }
 const size = extent(board); if (right > size.width || bottom > size.height) throw Error('bounds');
 const anchor = ids.get(lower(preferredRoot)) || model.nodes[0];
 const origin = { x: clamp(anchor.x, 0, size.width - right), y: clamp(anchor.y, 0, size.height - bottom) };
 return { ...board, items: model.allItems.map(item => { const p = placements.get(lower(item.id)); return eligible(item) && p ? { ...item, x: p.x + origin.x, y: p.y + origin.y } : item; }) };
}
export function restoreMindGraph(current: Record<string, unknown>, snapshot: Record<string, unknown>): Record<string, unknown> {
 const now = readMindModel(current), old = readMindModel(snapshot);
 if (current.id !== snapshot.id || !now.valid || !old.valid) throw Error('invalid');
 // Undo restores only permitted fields of live source/ink objects. It never
 // resurrects a removed source or replaces native drawing bytes with stale data.
 const liveItems = new Map(now.allItems.map(i => [lower(i.id), i]));
 const seen = new Set<string>(), items: Record<string, unknown>[] = [];
 for (const item of old.allItems) {
  const key = lower(item.id), live = liveItems.get(key);
  if (textEditable(item)) { items.push(item); seen.add(key); }
  else if (live) {
   const restored = { ...live };
   if (eligible(live) && current.revision === snapshot.revision) for (const field of ['x', 'y', 'width', 'height', 'style', 'title']) {
    if (Object.hasOwn(item, field)) restored[field] = item[field]; else delete restored[field];
   }
   items.push(restored); seen.add(key);
  }
 }
 for (const item of now.allItems) if (!textEditable(item) && !seen.has(lower(item.id))) items.push(item);
 const ids = new Set(items.map(i => lower(i.id)));
 return { ...current, items, edges: old.allEdges.filter(e => ids.has(lower(e.from)) && ids.has(lower(e.to))) };
}
export function prepareKnowledgeGraph(nodes: GraphNode[], edges: GraphEdge[]) {
 const unique = new Map<string, GraphNode>(); let truncated = false;
 for (const node of nodes) if (node && typeof node.id === 'string' && typeof node.path === 'string' && typeof node.label === 'string' && !unique.has(node.id)) { if (unique.size >= GRAPH_LIMIT) { truncated = true; break; } unique.set(node.id, node); }
 const displayed = [...unique.values()], seen = new Set<string>();
 const lines: GraphEdge[] = [];
 for (const edge of edges) if (edge && unique.has(edge.from) && unique.has(edge.to) && edge.from !== edge.to) { const key = JSON.stringify([edge.from, edge.to]); if (!seen.has(key)) { if (lines.length >= GRAPH_EDGE_LIMIT) { truncated = true; break; } seen.add(key); lines.push(edge); } }
 const degree = new Map(displayed.map(n => [n.id, 0])); for (const e of lines) { degree.set(e.from, degree.get(e.from)! + 1); degree.set(e.to, degree.get(e.to)! + 1); }
 const ordered = [...displayed].sort((a, b) => degree.get(b.id)! - degree.get(a.id)! || a.id.localeCompare(b.id));
 const positions = new Map<string, Point>();
 ordered.forEach((node, i) => { const angle = i * 2.399963229728653, r = i === 0 ? 0 : 72 * Math.sqrt(i); positions.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r }); });
 return { nodes: displayed, edges: lines, degree, positions, truncated };
}
export function fitGraph(rects: Rect[], size: Size): Camera {
 if (!rects.length) return { x: 0, y: 0, zoom: 1 };
 let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
 for (const r of rects) { x = Math.min(x, r.x); y = Math.min(y, r.y); right = Math.max(right, r.x + r.width); bottom = Math.max(bottom, r.y + r.height); }
 return { x: (x + right) / 2, y: (y + bottom) / 2, zoom: clamp(Math.min(Math.max(20, size.width - 100) / Math.max(1, right - x), Math.max(20, size.height - 100) / Math.max(1, bottom - y)), .00001, 2) };
}
export function zoomGraph(camera: Camera, size: Size, point: Point, factor: number): Camera {
 const zoom = clamp(camera.zoom * factor, .00001, 8), dx = point.x - size.width / 2, dy = point.y - size.height / 2;
 return { zoom, x: camera.x + dx / camera.zoom - dx / zoom, y: camera.y + dy / camera.zoom - dy / zoom };
}
export function textLines(value: string, width: number, fontSize: number, limit: number): string[] {
 if (limit <= 0) return [];
 const max = Math.max(2, Math.floor(width / (fontSize * .62))), lines: string[] = [];
 for (const paragraph of value.slice(0, 3000).split(/\r?\n/)) { const chars = [...paragraph]; if (!chars.length) lines.push(''); for (let i = 0; i < chars.length; i += max) lines.push(chars.slice(i, i + max).join('')); if (lines.length > limit) break; }
 if (lines.length > limit) { lines.length = limit; lines[limit - 1] = (lines[limit - 1] || '').slice(0, Math.max(1, max - 1)) + '…'; }
 return lines;
}
// Graph UI: transient drag positions stay local and commit once on pointer release.
const words = {
 knowledge: ['知识关系图', 'Knowledge graph'], framework: ['思维导图', 'Mind map'], search: ['搜索节点并定位', 'Find and focus a node'], fit: ['总览', 'Fit'], reset: ['重新布局', 'Reset layout'], open: ['打开笔记', 'Open note'], none: ['暂无节点', 'No nodes yet'], emptyKnowledge: ['保存笔记及链接后，关系会显示在这里。', 'Save notes and links to see their connections here.'], limit: ['此视图最多显示 1,000 个节点和 5,000 条连线，超出的内容仍保留。', 'This view shows up to 1,000 nodes and 5,000 connections. Additional content is preserved.'], knowledgeHint: ['拖动节点整理位置，拖动空白平移，滚轮缩放；点击节点打开笔记。布局只影响本次视图。', 'Drag nodes to arrange, drag the background to pan, and scroll to zoom. Click a node to open its note. Layout changes affect this view only.'], frameworkHint: ['文字、公式、手写节点和资料都可以拖动、连线和调整样式。回到白板使用“框成节点”收集手写内容。', 'Move, connect and style text, formulas, handwriting and sources. Use Frame as node on the board to collect handwriting.'], center: ['添加中心节点', 'Add topic'], child: ['添加子分支', 'Add child'], newTopic: ['中心主题', 'Central topic'], newChild: ['新分支', 'New branch'], title: ['标题', 'Title'], text: ['正文 / LaTeX', 'Body / LaTeX'], type: ['节点类型', 'Node type'], textType: ['文字', 'Text'], formulaType: ['公式（LaTeX 源码）', 'Formula (LaTeX source)'], fill: ['背景色', 'Fill'], border: ['边框色', 'Border'], ink: ['文字色', 'Text color'], size: ['字号', 'Font size'], shape: ['形状', 'Shape'], rectangle: ['矩形', 'Rectangle'], rounded: ['圆角矩形', 'Rounded'], ellipse: ['椭圆', 'Ellipse'], width: ['线宽', 'Line width'], apply: ['应用修改', 'Apply changes'], cancel: ['取消草稿', 'Discard draft'], delete: ['删除节点', 'Delete node'], undo: ['撤销', 'Undo'], redo: ['重做', 'Redo'], horizontal: ['水平树形布局', 'Horizontal tree'], vertical: ['垂直树形布局', 'Vertical tree'], choose: ['选择节点可修改内容和样式；拖动可自由摆放。', 'Select a node to edit its content and style. Drag to position it freely.'], connect: ['连接到', 'Connect to'], addConnection: ['添加连线', 'Add connection'], connection: ['连线样式', 'Connection style'], deleteConnection: ['删除连线', 'Delete connection'], arrows: ['箭头', 'Arrows'], noArrow: ['无', 'None'], endArrow: ['单向', 'End'], bothArrow: ['双向', 'Both ends'], lineColor: ['连线色', 'Line color'], invalid: ['白板格式无效，未更改内容。', 'The board format is invalid. Nothing was changed.'], failure: ['操作无法完成，内容仍保留。请检查画布边界或节点数量。', 'Could not complete the action. Content is preserved. Check canvas bounds or the node limit.'], selected: ['已选节点', 'Selected node'], formulaNote: ['框架模式显示 LaTeX 源码，完整公式请在普通白板中阅读。', 'This mode displays LaTeX source. Read the rendered formula in the board reader.'], openSource: ['打开关联原文', 'Open linked source'], zoomIn: ['放大', 'Zoom in'], zoomOut: ['缩小', 'Zoom out'], noMatch: ['没有匹配的节点', 'No matching nodes'], nodes: ['节点', 'nodes'], links: ['连线', 'links'], editsHint: ['拖动后点主窗口保存；手写位置与白板一起保存。可撤销、连线并选择树形布局。', 'Save from the main window after arranging. Ink positions are saved with the board. Undo, connections and tree layouts are available.']
} as const;
const gt = (language: Language, key: keyof typeof words) => words[key][language === 'zh' ? 0 : 1];
function useSurface() {
 const ref = useRef<HTMLDivElement>(null), [size, setSize] = useState<Size>({ width: 800, height: 600 }), [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
 const current = useRef({ camera, size }); current.current = { camera, size };
 const pan = useRef<{ id: number; start: Point; camera: Camera } | null>(null);
 useEffect(() => { const element = ref.current; if (!element) return; const observer = new ResizeObserver(entries => { const r = entries[0].contentRect; setSize({ width: r.width, height: r.height }); }); observer.observe(element); const wheel = (e: WheelEvent) => { e.preventDefault(); const r = element.getBoundingClientRect(); setCamera(c => zoomGraph(c, current.current.size, { x: e.clientX - r.left, y: e.clientY - r.top }, Math.exp(-clamp(e.deltaY, -250, 250) * .003))); }; element.addEventListener('wheel', wheel, { passive: false }); return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); pan.current = null; }; }, []);
 const point = (e: { clientX: number; clientY: number }): Point => { const r = ref.current!.getBoundingClientRect(), c = current.current.camera, s = current.current.size; return { x: (e.clientX - r.left - s.width / 2) / c.zoom + c.x, y: (e.clientY - r.top - s.height / 2) / c.zoom + c.y }; };
 const stopPan = (e: ReactPointerEvent<HTMLDivElement>) => { if (pan.current?.id !== e.pointerId) return; pan.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); };
 return { ref, size, camera, setCamera, point, transform: `translate(${size.width / 2},${size.height / 2}) scale(${camera.zoom}) translate(${-camera.x},${-camera.y})`, handlers: { onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => { if (e.button !== 0 || e.ctrlKey) return; pan.current = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, camera: current.current.camera }; e.currentTarget.setPointerCapture(e.pointerId); }, onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => { const p = pan.current; if (p?.id === e.pointerId) setCamera({ ...p.camera, x: p.camera.x - (e.clientX - p.start.x) / p.camera.zoom, y: p.camera.y - (e.clientY - p.start.y) / p.camera.zoom }); }, onPointerUp: stopPan, onPointerCancel: stopPan, onLostPointerCapture: stopPan } };
}
function ViewTools({ language, surface, onFit, children }: { language: Language; surface: ReturnType<typeof useSurface>; onFit: () => void; children?: ReactNode }) {
 return <div className="graph-tools">{children}<span className="spacer" /><Button onClick={onFit}><Maximize2 />{gt(language, 'fit')}</Button><Button aria-label={gt(language, 'zoomOut')} onClick={() => surface.setCamera(c => ({ ...c, zoom: clamp(c.zoom / 1.3, .00001, 8) }))}><Minus /></Button><span className="graph-zoom">{(surface.camera.zoom * 100).toFixed(surface.camera.zoom < .01 ? 2 : 0)}%</span><Button aria-label={gt(language, 'zoomIn')} onClick={() => surface.setCamera(c => ({ ...c, zoom: clamp(c.zoom * 1.3, .00001, 8) }))}><Plus /></Button></div>;
}
export function KnowledgeGraph({ nodes, edges, language, onOpen }: { nodes: GraphNode[]; edges: GraphEdge[]; language: Language; onOpen: (path: string) => void }) {
 const model = useMemo(() => prepareKnowledgeGraph(nodes, edges), [nodes, edges]), [positions, setPositions] = useState(model.positions), [query, setQuery] = useState(''), [focused, setFocused] = useState<string | null>(null), [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null), surface = useSurface();
 const moving = useRef<{ id: string; pointer: number; start: Point; origin: Point; pixel: Point; moved: boolean } | null>(null);
 const fit = () => surface.setCamera(fitGraph([...positions.values()].map(p => ({ x: p.x - 60, y: p.y - 30, width: 120, height: 70 })), surface.size));
 useEffect(() => { setContextMenu(null); setPositions(model.positions); moving.current = null; setFocused(null); surface.setCamera(fitGraph([...model.positions.values()].map(p => ({ ...p, width: 120, height: 70 })), surface.size)); }, [model]);
 const results = useMemo(() => query.trim() ? model.nodes.filter(n => `${n.label} ${n.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 30) : [], [model, query]);
 const connected = useMemo(() => { const set = new Set<string>(); if (focused) for (const e of model.edges) { if (e.from === focused) set.add(e.to); if (e.to === focused) set.add(e.from); } return set; }, [focused, model]);
 const finish = (e: ReactPointerEvent<SVGGElement>, node: GraphNode, cancel = false) => { const d = moving.current; if (!d || d.pointer !== e.pointerId) return; moving.current = null; if (cancel) setPositions(old => new Map(old).set(d.id, d.origin)); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); if (!cancel && !d.moved) { setFocused(node.id); onOpen(node.path); } };
 return <section className="graph-workspace" aria-label={gt(language, 'knowledge')}><ViewTools language={language} surface={surface} onFit={fit}><strong>{gt(language, 'knowledge')}</strong><Button onClick={() => { setPositions(model.positions); surface.setCamera(fitGraph([...model.positions.values()].map(p => ({ ...p, width: 120, height: 70 })), surface.size)); }}>{gt(language, 'reset')}</Button></ViewTools><div className="graph-body"><div className="graph-surface" ref={surface.ref} {...surface.handlers}><svg className="graph-svg" width={surface.size.width} height={surface.size.height} aria-label={gt(language, 'knowledge')}><g transform={surface.transform}>{model.edges.map((e, i) => { const a = positions.get(e.from), b = positions.get(e.to); return a && b ? <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.from === focused || e.to === focused ? '#168d84' : '#cbd8d6'} strokeWidth={e.from === focused || e.to === focused ? 2 : 1} vectorEffect="non-scaling-stroke" /> : null; })}{model.nodes.map(node => { const p = positions.get(node.id); if (!p) return null; const radius = clamp(6 + Math.sqrt(model.degree.get(node.id) || 0) * 1.7, 6, 19), highlight = focused === node.id || connected.has(node.id); return <g key={node.id} transform={`translate(${p.x},${p.y})`} className="knowledge-node" role="button" tabIndex={0} aria-label={node.label} data-graph-node={node.id} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setFocused(node.id); setContextMenu({ x: e.clientX, y: e.clientY, title: node.label, items: [{ id: 'open', label: gt(language, 'open'), action: () => onOpen(node.path) }, { id: 'focus', label: language === 'zh' ? '定位此节点' : 'Focus this node', action: () => surface.setCamera({ ...p, zoom: 1.3 }) }] }); }} onKeyDown={e => { if (e.key === 'Enter') onOpen(node.path); }} onPointerDown={e => { if (e.button !== 0 || e.ctrlKey) return; e.stopPropagation(); moving.current = { id: node.id, pointer: e.pointerId, start: surface.point(e), origin: p, pixel: { x: e.clientX, y: e.clientY }, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); setFocused(node.id); }} onPointerMove={e => { const d = moving.current; if (!d || d.pointer !== e.pointerId) return; e.stopPropagation(); const point = surface.point(e); d.moved ||= Math.hypot(e.clientX - d.pixel.x, e.clientY - d.pixel.y) > 4; if (d.moved) setPositions(old => new Map(old).set(node.id, { x: d.origin.x + point.x - d.start.x, y: d.origin.y + point.y - d.start.y })); }} onPointerUp={e => finish(e, node)} onPointerCancel={e => finish(e, node, true)} onLostPointerCapture={e => finish(e, node, true)}><title>{node.path}</title><circle r={Math.max(18, radius)} fill="transparent" /><circle r={radius} fill={highlight ? '#087f7a' : '#849d98'} stroke={focused === node.id ? '#c4efdf' : '#fff'} strokeWidth={focused === node.id ? 5 : 2} /><text y={radius + 17} textAnchor="middle" fontSize={12} fill={highlight ? '#165d58' : '#526864'}>{node.label.slice(0, 42)}</text></g>; })}</g></svg>{!model.nodes.length && <div className="graph-empty"><h3>{gt(language, 'none')}</h3><p>{gt(language, 'emptyKnowledge')}</p></div>}<div className="graph-search" onPointerDown={e => e.stopPropagation()}><label><Search /><input aria-label={gt(language, 'search')} placeholder={gt(language, 'search')} value={query} onChange={e => setQuery(e.target.value)} /></label>{query.trim() && <div className="graph-search-results">{results.length ? results.map(n => <button key={n.id} onClick={() => { const p = positions.get(n.id)!; setFocused(n.id); surface.setCamera({ ...p, zoom: 1.3 }); setQuery(''); }}>{n.label}<small>{n.path}</small></button>) : <p>{gt(language, 'noMatch')}</p>}</div>}</div></div></div><footer className="graph-footer"><span>{model.nodes.length} {gt(language, 'nodes')} · {model.edges.length} {gt(language, 'links')}</span><span>{gt(language, 'knowledgeHint')}</span>{model.truncated && <strong>{gt(language, 'limit')}</strong>}</footer><ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} /></section>;
}

const mindViews=new Map<string,{camera:Camera;selected:string|null;edge:string|null}>();
export function MindMapEditor({ studyFocus,hideInspector=false,onStudyNode,board, inkReference, vaultId, language, onChange, onOpenSource, onError, onRemoveNode, onUndo, onRedo, canUndo=false, canRedo=false }: { board: Record<string, unknown>; inkReference?: Record<string, unknown>; vaultId?: string; language: Language; onChange: (nextBoard: Record<string, unknown>) => void; onOpenSource?: (path: string,source?:PDFSourceReference) => void; onError?: (message: string) => void; onRemoveNode?: (id: string) => Promise<void>; onUndo?: () => Promise<void>; onRedo?: () => Promise<void>; canUndo?: boolean; canRedo?: boolean;studyFocus?:{id:string;nonce:number};hideInspector?:boolean;onStudyNode?:(id:string)=>void }) {
 const model = useMemo(() => readMindModel(board), [board]), surface = useSurface(), [selected, setSelected] = useState<string | null>(null), [selectedEdge, setSelectedEdge] = useState<string | null>(null), [draft, setDraft] = useState<MindNode | null>(null), [edgeDraft, setEdgeDraft] = useState<EdgeStyle | null>(null), [relation,setRelation]=useState(''),[dropTarget,setDropTarget]=useState<string|null>(null),[target, setTarget] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState(''), [preview, setPreview] = useState<{ id: string; point: Point } | null>(null), [historyVersion, setHistoryVersion] = useState(0);
 const viewKey=(vaultId||'')+':'+String(board.id),viewSnapshot=useRef({key:viewKey,camera:surface.camera,selected,edge:selectedEdge});viewSnapshot.current={key:viewKey,camera:surface.camera,selected,edge:selectedEdge};
 const saveView=()=>{const v=viewSnapshot.current;if(mindViews.size>=32&&!mindViews.has(v.key))mindViews.delete(mindViews.keys().next().value!);mindViews.set(v.key,{camera:{...v.camera},selected:v.selected,edge:v.edge});};
 useEffect(()=>()=>{if(viewSnapshot.current.key===viewKey)saveView();},[viewKey]);
 const openSource=(path:string,reference?:PDFSourceReference)=>{saveView();onOpenSource?.(path,reference);};
 const current = useRef(board); current.current = board;
 const undo = useRef<Record<string, unknown>[]>([]), redo = useRef<Record<string, unknown>[]>([]), expected = useRef(''), moving = useRef<{ id: string; pointer: number; start: Point; origin: Point; boardID: unknown; point: Point; size: Size } | null>(null);
 const [remoteBusy,setRemoteBusy]=useState(false);const remoteLock=useRef(false);
 const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
 const nodeTitleRef = useRef<HTMLInputElement>(null), relationRef = useRef<HTMLInputElement>(null);
 useEffect(() => { if (remoteBusy) setContextMenu(null); }, [remoteBusy]);
 const remoteAction=async(action:()=>Promise<void>)=>{if(remoteLock.current)return;remoteLock.current=true;setRemoteBusy(true);try{await action();undo.current=[];redo.current=[];setHistoryVersion(v=>v+1);setError('');setSelected(null);setSelectedEdge(null);}catch(e){const message=e instanceof Error?e.message:gt(language,'failure');setError(message);onError?.(message);}finally{remoteLock.current=false;setRemoteBusy(false);}};
 const marker = 'mind-' + useId().replace(/[^a-zA-Z0-9]/g, '');
 const graphSignature = useMemo(() => JSON.stringify({ id: board.id, items: model.allItems.filter(eligible), edges: model.allEdges }), [board]);
 const chosen = model.nodes.find(n => lower(n.id) === lower(selected)), chosenEdge = model.edges.find(e => lower(e.id) === lower(selectedEdge));
 const chosenSignature = JSON.stringify(chosen), chosenEdgeSignature = JSON.stringify(chosenEdge);
 useEffect(() => { setDraft(chosen ? { ...chosen, style: nodeStyle(chosen.style) } : null); setTarget(''); }, [chosenSignature]);
 useEffect(() => { setEdgeDraft(chosenEdge ? edgeStyle(chosenEdge.style) : null);setRelation(chosenEdge?.relation||''); }, [chosenEdgeSignature]);
 useEffect(() => { setContextMenu(null); if (expected.current && expected.current !== graphSignature) { undo.current = []; redo.current = []; setHistoryVersion(v => v + 1); } expected.current = graphSignature; }, [graphSignature]);
 useEffect(() => { const saved=mindViews.get(viewKey);setSelected(saved?.selected||null); setSelectedEdge(saved?.edge||null); setPreview(null); moving.current = null; undo.current = []; redo.current = []; setError(''); surface.setCamera(saved?.camera||fitGraph(model.nodes, surface.size)); }, [viewKey]);
 const fail = () => { const message = gt(language, 'failure'); setError(message); onError?.(message); };
 const emit = (next: Record<string, unknown>) => { expected.current = JSON.stringify({ id: next.id, items: readMindModel(next).allItems.filter(eligible), edges: next.edges }); onChange(next); };
 const commit = (operation: (value: Record<string, unknown>) => Record<string, unknown>) => { if (remoteLock.current) return; try { const before = current.current, next = operation(before); if (next === before) return; undo.current.push(before); if (undo.current.length > 20) undo.current.shift(); redo.current = []; emit(next); setHistoryVersion(v => v + 1); setError(''); } catch { fail(); } };
 const history = (back: boolean) => { if(remoteLock.current)return;if(!(back?undo.current:redo.current).length){const action=back?onUndo:onRedo;if(action&&(back?canUndo:canRedo))void remoteAction(action);return;}try { const source = back ? undo.current : redo.current, destination = back ? redo.current : undo.current, old = source.pop(); if (!old) return; const next = restoreMindGraph(current.current, old); destination.push(current.current); emit(next); setHistoryVersion(v => v + 1); setError(''); } catch { fail(); } };
 const focus = (node: MindNode) => { setSelected(node.id); setSelectedEdge(null); surface.setCamera(fitGraph([node], surface.size)); };
 const add = (parent?: MindNode, position?: Point) => { if (remoteLock.current) return; const id = crypto.randomUUID(), count = parent ? model.edges.filter(e => lower(e.from) === lower(parent.id)).length : 0; commit(value => addMindNode(value, gt(language, parent ? 'newChild' : 'newTopic'), parent ? { x: parent.x + parent.width + 90, y: parent.y + count * 210 } : position || { x: Math.max(0, surface.camera.x - 150), y: Math.max(0, surface.camera.y - 75) }, parent?.id, id)); setSelected(id); setSelectedEdge(null); };
 const beginDrag = (e: ReactPointerEvent<SVGGElement>, node: MindNode) => { if (e.button !== 0 || e.ctrlKey || remoteLock.current) return; e.stopPropagation(); setSelected(node.id); setSelectedEdge(null); moving.current = { id: node.id, pointer: e.pointerId, start: surface.point(e), origin: { x: node.x, y: node.y }, point: { x: node.x, y: node.y }, boardID: board.id, size: { width: node.width, height: node.height } }; e.currentTarget.setPointerCapture(e.pointerId); };
 const moveDrag = (e: ReactPointerEvent<SVGGElement>, node: MindNode) => { const d = moving.current; if (!d || d.pointer !== e.pointerId) return; e.stopPropagation(); const point = surface.point(e); d.point = boundedPosition(board, node, { x: d.origin.x + point.x - d.start.x, y: d.origin.y + point.y - d.start.y }); setPreview({ id: d.id, point: d.point });const candidate=model.nodes.find(n=>n.id!==d.id&&point.x>=n.x&&point.x<=n.x+n.width&&point.y>=n.y&&point.y<=n.y+n.height);setDropTarget(candidate?.id||null); };
 const finishDrag = (e: ReactPointerEvent<SVGGElement>, cancel = false) => { const d = moving.current; if (!d || d.pointer !== e.pointerId) return; moving.current = null; setPreview(null);setDropTarget(null); const point=surface.point(e);const parent=model.nodes.find(n=>n.id!==d.id&&point.x>=n.x&&point.x<=n.x+n.width&&point.y>=n.y&&point.y<=n.y+n.height);if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); if (!cancel && d.boardID === current.current.id && (d.point.x !== d.origin.x || d.point.y !== d.origin.y)) commit(value => { const live = readMindModel(value).allItems.find(item => lower(item.id) === lower(d.id)); if (!live || live.x !== d.origin.x || live.y !== d.origin.y || live.width !== d.size.width || live.height !== d.size.height) throw Error('changed'); if(parent){const next=reparentMindNode(value,d.id,parent.id);const edge=readMindModel(next).edges.find(edge=>lower(edge.from)===lower(parent.id)&&lower(edge.to)===lower(d.id));setSelected(null);setSelectedEdge(edge?.id||null);return next;}return patchMindNode(value, d.id, d.point); }); };
 const displayed = model.nodes.map(n => preview?.id === n.id ? { ...n, ...preview.point } : n), byID = new Map(displayed.map(n => [lower(n.id), n]));
 const visibleNodes=displayed.filter(n=>n.x+n.width>=surface.camera.x-surface.size.width/2/surface.camera.zoom&&n.x<=surface.camera.x+surface.size.width/2/surface.camera.zoom&&n.y+n.height>=surface.camera.y-surface.size.height/2/surface.camera.zoom&&n.y<=surface.camera.y+surface.size.height/2/surface.camera.zoom);
 const inkPreviewIDs=new Set(visibleNodes.filter(n=>n.kind==='inkGroup').slice(0,24).map(n=>n.id));
 const sourcePreviewIDs=new Set(visibleNodes.filter(n=>n.kind==='pdfPage').slice(0,12).map(n=>n.id));
 const results = query.trim() ? model.nodes.filter(n => `${n.title} ${n.text || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 30) : [];
 const setStyle = (patch: Partial<NodeStyle>) => setDraft(d => d ? { ...d, style: { ...nodeStyle(d.style), ...patch } } : null);
 const style = nodeStyle(draft?.style);
 // Read historyVersion to make toolbar state refresh without storing big snapshots in React state.
 void historyVersion;
 const lastStudyFocus=useRef<number|undefined>(undefined);
 useEffect(()=>{if(studyFocus&&lastStudyFocus.current!==studyFocus.nonce&&surface.size.width>0&&surface.size.height>0){const n=model.nodes.find(n=>lower(n.id)===lower(studyFocus.id));if(n){focus(n);lastStudyFocus.current=studyFocus.nonce;}}},[studyFocus?.nonce,surface.size.width,surface.size.height]);
 if (!model.valid) return <p className="inline-error">{gt(language, 'invalid')}</p>;
 const removeNode = (id: string) => { const node = readMindModel(current.current).nodes.find(n => lower(n.id) === lower(id)); if (!node || remoteLock.current) return; if (onRemoveNode) void remoteAction(() => onRemoveNode(node.id)); else if (textEditable(node)) { commit(value => removeMindNode(value, node.id)); setSelected(null); } };
 const removeChosen = () => { if (chosen) removeNode(chosen.id); };
 const openNodeMenu = (event: ReactMouseEvent<SVGGElement>, node: MindNode) => {
  event.preventDefault(); event.stopPropagation(); if (remoteLock.current) return;
  setSelected(node.id); setSelectedEdge(null);
  const sourcePath = node.originalSourcePath || node.sourcePath;
  setContextMenu({ x: event.clientX, y: event.clientY, title: node.title || gt(language, 'selected'), items: [
   { id: 'edit-node', label: language === 'zh' ? '编辑节点内容与样式' : 'Edit node content and style', action: () => { requestAnimationFrame(() => nodeTitleRef.current?.focus()); } },
   { id: 'add-child', label: gt(language, 'child'), disabled: model.total >= GRAPH_LIMIT, action: () => { const live = readMindModel(current.current).nodes.find(n => lower(n.id) === lower(node.id)); if (live) add(live); } },
   { id: 'focus-node', label: language === 'zh' ? '定位此节点' : 'Focus this node', action: () => focus(node) },
   { id: 'study-node', label: language==='zh'?'学习与复习':'Study & review', disabled:!onStudyNode, action:()=>onStudyNode?.(node.id) },
   { id: 'open-source', label: gt(language, 'openSource'), disabled: !sourcePath || !onOpenSource, action: () => { if (sourcePath) openSource(sourcePath,sourceReference(node)); } },
   { id: 'remove-node', label: language === 'zh' ? '移除白板节点' : 'Remove board node', separatorBefore: true, danger: true, disabled: !textEditable(node) && !onRemoveNode, action: () => removeNode(node.id) }
  ] });
 };
 const openEdgeMenu = (event: ReactMouseEvent<SVGGElement>, edge: MindEdge) => {
  event.preventDefault(); event.stopPropagation(); if (remoteLock.current) return;
  setSelectedEdge(edge.id); setSelected(null);
  setContextMenu({ x: event.clientX, y: event.clientY, title: gt(language, 'connection'), items: [
   { id: 'edit-connection', label: language === 'zh' ? '编辑关系与连线样式' : 'Edit relationship and line style', action: () => { requestAnimationFrame(() => relationRef.current?.focus()); } },
   { id: 'reverse-connection', label: language === 'zh' ? '反转方向' : 'Reverse direction', action: () => commit(value => reverseMindEdge(value, edge.id)) },
   { id: 'remove-connection', label: gt(language, 'deleteConnection'), separatorBefore: true, danger: true, action: () => { commit(value => patchMindEdge(value, edge.id, null)); setSelectedEdge(null); } }
  ] });
 };
 const openBackgroundMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
  if ((event.target as Element).closest('input,textarea,select,button,[contenteditable=true]')) return;
  event.preventDefault(); event.stopPropagation(); if (remoteLock.current) return;
  const point = surface.point(event);
  setSelected(null); setSelectedEdge(null);
  setContextMenu({ x: event.clientX, y: event.clientY, title: gt(language, 'framework'), items: [
   { id: 'add-topic', label: gt(language, 'center'), disabled: model.total >= GRAPH_LIMIT, action: () => add(undefined, { x: Math.max(0, point.x - 150), y: Math.max(0, point.y - 75) }) },
   { id: 'fit', label: gt(language, 'fit'), action: () => surface.setCamera(fitGraph(readMindModel(current.current).nodes, surface.size)) },
   { id: 'horizontal', label: gt(language, 'horizontal'), separatorBefore: true, disabled: !model.nodes.length, action: () => commit(value => layoutMindTree(value, 'horizontal')) },
   { id: 'vertical', label: gt(language, 'vertical'), disabled: !model.nodes.length, action: () => commit(value => layoutMindTree(value, 'vertical')) },
   { id: 'undo', label: gt(language, 'undo'), shortcut: '⌘Z', separatorBefore: true, disabled: !undo.current.length && !canUndo, action: () => history(true) },
   { id: 'redo', label: gt(language, 'redo'), shortcut: '⇧⌘Z', disabled: !redo.current.length && !canRedo, action: () => history(false) }
  ] });
 };
 return <section inert={remoteBusy||undefined} aria-busy={remoteBusy} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!(e.target as HTMLElement).closest('input,textarea,[contenteditable=true]')){e.preventDefault();history(!e.shiftKey);}if(['Delete','Backspace'].includes(e.key)&&!(e.target as HTMLElement).closest('input,textarea,[contenteditable=true]')){if(chosenEdge){e.preventDefault();commit(value=>patchMindEdge(value,chosenEdge.id,null));setSelectedEdge(null);}else if(chosen&&(textEditable(chosen)||onRemoveNode)){e.preventDefault();removeChosen();}}}} className="graph-workspace mind-workspace" aria-label={gt(language, 'framework')}><ViewTools language={language} surface={surface} onFit={() => surface.setCamera(fitGraph(model.nodes, surface.size))}><Button onClick={() => add()} disabled={model.total >= GRAPH_LIMIT}><Plus />{gt(language, 'center')}</Button>{onStudyNode&&<Button disabled={!chosen} onClick={()=>chosen&&onStudyNode(chosen.id)}>{language==='zh'?'复习此节点':'Review this node'}</Button>}<Button disabled={!chosen || model.total >= GRAPH_LIMIT} onClick={() => chosen && add(chosen)}><Plus />{gt(language, 'child')}</Button><Button aria-label={gt(language, 'undo')} disabled={!undo.current.length&&!canUndo} onClick={() => history(true)}><Undo2 /></Button><Button aria-label={gt(language, 'redo')} disabled={!redo.current.length&&!canRedo} onClick={() => history(false)}><Redo2 /></Button><Button aria-label={gt(language, 'horizontal')} title={gt(language, 'horizontal')} disabled={!model.nodes.length} onClick={() => commit(value => layoutMindTree(value, 'horizontal', selected || undefined))}><ArrowRight /></Button><Button aria-label={gt(language, 'vertical')} title={gt(language, 'vertical')} disabled={!model.nodes.length} onClick={() => commit(value => layoutMindTree(value, 'vertical', selected || undefined))}><ArrowDown /></Button></ViewTools>{error && <p className="graph-error" role="alert">{error}</p>}<div className="graph-body"><div className="graph-surface" ref={surface.ref} {...surface.handlers} onContextMenu={openBackgroundMenu}><svg className="graph-svg" width={surface.size.width} height={surface.size.height} aria-label={gt(language, 'framework')}><defs><marker id={marker + '-end'} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs><g transform={surface.transform}>{model.edges.map(edge => { const a = byID.get(lower(edge.from)), b = byID.get(lower(edge.to)); if (!a || !b) return null; const s = edgeStyle(edge.style), ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2, dx = bx - ax, dy = by - ay, aScale = 1 / Math.max(Math.abs(dx) / (a.width / 2), Math.abs(dy) / (a.height / 2), 1), bScale = 1 / Math.max(Math.abs(dx) / (b.width / 2), Math.abs(dy) / (b.height / 2), 1), path = `M ${ax + dx * aScale} ${ay + dy * aScale} L ${bx - dx * bScale} ${by - dy * bScale}`; return <g key={edge.id} className="mind-edge" role="button" tabIndex={0} aria-label={gt(language, 'connection')} data-mind-edge={edge.id} onContextMenu={e => openEdgeMenu(e, edge)} onPointerDown={e => e.stopPropagation()} onClick={() => { setSelectedEdge(edge.id); setSelected(null); }} onKeyDown={e => { if (e.key === 'Enter') { setSelectedEdge(edge.id); setSelected(null); } }}><path d={path} stroke="transparent" strokeWidth={Math.max(14 / surface.camera.zoom, s.strokeWidth + 8)} fill="none" /><path d={path} stroke={s.strokeColor} strokeWidth={s.strokeWidth} strokeDasharray={mindDash(s)} opacity={s.opacity??1} strokeLinecap="round" fill="none" markerEnd={s.arrow !== 'none' ? `url(#${marker}-end)` : undefined} markerStart={s.arrow === 'both' ? `url(#${marker}-end)` : undefined} />{edge.relation&&<text x={(ax+bx)/2} y={(ay+by)/2-10} textAnchor="middle" fontSize={14} fill={s.strokeColor} opacity={s.opacity??1}>{edge.relation==='child'?(language==='zh'?'从属':'Child'):edge.relation}</text>}{selectedEdge === edge.id && <path d={path} stroke="#12a594" strokeWidth={2} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" fill="none" />}</g>; })}{visibleNodes.map(node => { const s = nodeStyle(node.style), area = node.kind==='inkGroup' ? {x:4,y:4,width:Math.max(1,node.width-8),height:Math.max(1,node.height-8)} : s.shape === 'ellipse' ? { x: node.width * .16, y: node.height * .16, width: node.width * .68, height: node.height * .68 } : { x: 18, y: 18, width: Math.max(1, node.width - 36), height: Math.max(1, node.height - 36) }, lines = textLines(node.title, area.width, s.fontSize, Math.max(1, Math.min(2, Math.floor(area.height / (s.fontSize * 1.3))))), bodySize = Math.max(8, s.fontSize * .83), bodyY = area.y + lines.length * s.fontSize * 1.3 + 8, body = textLines(node.text || '', area.width, bodySize, Math.max(0, Math.min(6, Math.floor((area.y + area.height - bodyY) / (bodySize * 1.4))))), clip = marker + '-' + node.id; return <g key={node.id} transform={`translate(${node.x},${node.y})`} className="mind-node" role="button" tabIndex={0} aria-label={node.title || gt(language, 'selected')} data-mind-node={node.id} onContextMenu={e => openNodeMenu(e, node)} onKeyDown={e => { if (e.key === 'Enter') { setSelected(node.id); setSelectedEdge(null); } }} onPointerDown={e => beginDrag(e, node)} onPointerMove={e => moveDrag(e, node)} onPointerUp={e => finishDrag(e)} onPointerCancel={e => finishDrag(e, true)} onLostPointerCapture={e => finishDrag(e, true)}><defs><clipPath id={clip}><rect x={area.x} y={area.y} width={area.width} height={area.height} /></clipPath></defs>{s.shape === 'ellipse' ? <ellipse cx={node.width / 2} cy={node.height / 2} rx={node.width / 2} ry={node.height / 2} fill={s.fillColor} stroke={s.strokeColor} strokeWidth={s.strokeWidth} /> : <rect width={node.width} height={node.height} rx={s.shape === 'rounded' ? 16 : 0} fill={s.fillColor} stroke={s.strokeColor} strokeWidth={s.strokeWidth} />}{(selected === node.id||dropTarget===node.id) && <rect x={-5} y={-5} width={node.width + 10} height={node.height + 10} rx={8} fill="none" stroke="#0d9d8b" strokeWidth={2} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />}<g clipPath={`url(#${clip})`} pointerEvents="none">{node.kind!=='inkGroup'&&<><text x={area.x} y={area.y + s.fontSize} fontSize={s.fontSize} fill={s.textColor} fontWeight={600}>{lines.map((line, i) => <tspan key={i} x={area.x} dy={i ? s.fontSize * 1.3 : 0}>{line}</tspan>)}</text><text x={area.x} y={bodyY + bodySize} fontSize={bodySize} fill={s.textColor} opacity={.82} fontFamily={node.kind === 'formula' ? 'monospace' : undefined}>{body.map((line, i) => <tspan key={i} x={area.x} dy={i ? bodySize * 1.4 : 0}>{line}</tspan>)}</text></>}</g>{node.kind==='inkGroup'&&<text x={0} y={-8} fontSize={Math.min(14,s.fontSize)} fill={s.textColor} pointerEvents="none">{node.title.slice(0,28)}</text>}{node.kind==='inkGroup'&&inkPreviewIDs.has(node.id)&&<foreignObject x={area.x} y={area.y} width={area.width} height={area.height} pointerEvents="none"><MindInkPreview board={inkReference||board} id={node.id} width={area.width} height={area.height}/></foreignObject>}{node.kind==='pdfPage'&&sourcePreviewIDs.has(node.id)&&node.sourcePath&&<foreignObject x={area.x} y={bodyY+bodySize+8} width={area.width} height={Math.max(1,area.y+area.height-bodyY-bodySize-8)} pointerEvents="none"><MindSourcePreview vaultId={vaultId} board={inkReference||board} id={node.id} sourcePath={node.sourcePath} page={node.page||1} width={area.width} height={Math.max(1,area.y+area.height-bodyY-bodySize-8)}/></foreignObject>}{!textEditable(node)&&node.kind!=='inkGroup'&&<text x={area.x} y={bodyY+bodySize} fontSize={bodySize} fill={s.textColor} pointerEvents="none">{node.kind==='pdfPage'?'PDF · '+String(node.page||1):node.kind==='document'?(language==='zh'?'关联资料':'Linked source'):''}</text>}<title>{node.title.slice(0, 1000) + (node.text ? '\n' + node.text.slice(0, 2000) : '')}</title></g>; })}</g></svg>{!model.nodes.length && <div className="graph-empty"><h3>{gt(language, 'none')}</h3><Button onClick={() => add()}><Plus />{gt(language, 'center')}</Button></div>}<div className="graph-search" onPointerDown={e => e.stopPropagation()}><label><Search /><input aria-label={gt(language, 'search')} placeholder={gt(language, 'search')} value={query} onChange={e => setQuery(e.target.value)} /></label>{query.trim() && <div className="graph-search-results">{results.length ? results.map(n => <button key={n.id} onClick={() => { focus(n); setQuery(''); }}>{n.title}</button>) : <p>{gt(language, 'noMatch')}</p>}</div>}</div></div><aside hidden={hideInspector} className="mind-inspector" aria-label={gt(language, 'framework')}><h3>{gt(language, 'framework')}</h3><p className="mind-scope">{gt(language, 'frameworkHint')}</p>{draft && chosen ? <form onSubmit={e => { e.preventDefault(); commit(value => patchMindNode(value, chosen.id, draft)); }}><label>{gt(language, 'title')}<input aria-label={gt(language, 'title')} data-testid="mind-title" ref={nodeTitleRef} value={draft.title} maxLength={10000} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>{textEditable(draft) && <><label>{gt(language, 'text')}<textarea aria-label={gt(language, 'text')} data-testid="mind-body" value={draft.text || ''} maxLength={100000} rows={5} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label><label>{gt(language, 'type')}<select aria-label={gt(language, 'type')} value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as MindNode['kind'] })}><option value="text">{gt(language, 'textType')}</option><option value="formula">{gt(language, 'formulaType')}</option></select></label>{draft.kind === 'formula' && <p className="mind-scope">{gt(language, 'formulaNote')}</p>}</>}<div className="mind-colors">{(['fillColor', 'strokeColor', 'textColor'] as const).map((key, i) => <label key={key}>{gt(language, (['fill', 'border', 'ink'] as const)[i])}<input type="color" value={style[key]} onChange={e => setStyle({ [key]: e.target.value })} /></label>)}</div><label>{gt(language, 'shape')}<select aria-label={gt(language, 'shape')} value={style.shape} onChange={e => setStyle({ shape: e.target.value as NodeStyle['shape'] })}>{(['rectangle', 'rounded', 'ellipse'] as const).map(shape => <option key={shape} value={shape}>{gt(language, shape)}</option>)}</select></label><div className="mind-fields"><label>{gt(language, 'size')}<input aria-label={gt(language, 'size')} type="number" min={8} max={72} value={style.fontSize} onChange={e => setStyle({ fontSize: numberStyle(e.target.valueAsNumber, style.fontSize, 8, 72) })} /></label><label>{gt(language, 'width')}<input aria-label={gt(language, 'width')} type="number" min={1} max={8} step={.5} value={style.strokeWidth} onChange={e => setStyle({ strokeWidth: numberStyle(e.target.valueAsNumber, style.strokeWidth, 1, 8) })} /></label></div><div className="mind-fields"><label>{language==='zh'?'模块宽度':'Object width'}<input type="number" min={40} value={draft.width} onChange={e=>setDraft({...draft,width:e.target.valueAsNumber})}/></label><label>{language==='zh'?'模块高度':'Object height'}<input type="number" min={40} value={draft.height} onChange={e=>setDraft({...draft,height:e.target.valueAsNumber})}/></label></div><div className="mind-actions"><Button className="primary" type="submit">{gt(language, 'apply')}</Button><Button type="button" onClick={() => setDraft({ ...chosen, style: nodeStyle(chosen.style) })}>{gt(language, 'cancel')}</Button></div><hr /><label>{gt(language, 'connect')}<select aria-label={gt(language, 'connect')} value={target} onChange={e => setTarget(e.target.value)}><option value="">—</option>{model.nodes.filter(n => n.id !== chosen.id).map(n => <option key={n.id} value={n.id}>{n.title.slice(0, 70)}</option>)}</select></label><Button type="button" disabled={!target} onClick={() => commit(value => connectMindNodes(value, chosen.id, target))}><Link2 />{gt(language, 'addConnection')}</Button>{onOpenSource && (chosen.originalSourcePath || chosen.sourcePath) && <Button type="button" onClick={() => openSource(chosen.originalSourcePath || chosen.sourcePath!,sourceReference(chosen))}>{gt(language, 'openSource')}</Button>}<Button disabled={!textEditable(chosen)&&!onRemoveNode} title={language==='zh'?'移除白板节点，关联原文件仍保留':'Remove the board node; linked originals are kept'} className="mind-delete" type="button" onClick={removeChosen}><Trash2 />{gt(language, 'delete')}</Button></form> : chosenEdge && edgeDraft ? <form onSubmit={e => { e.preventDefault(); commit(value => setMindRelation(patchMindEdge(value, chosenEdge.id, edgeDraft),chosenEdge.id,relation)); }}><h4>{gt(language, 'connection')}</h4><label>{language==='zh'?'关系名称':'Relationship'}<input data-testid="mind-relation" ref={relationRef} list="mind-relations" value={relation} maxLength={120} onChange={e=>setRelation(e.target.value)}/><datalist id="mind-relations"><option value="child">{language==='zh'?'从属':'Child'}</option><option value={language==='zh'?'引用':'Reference'}/><option value={language==='zh'?'相关':'Related'}/><option value={language==='zh'?'导致':'Causes'}/></datalist></label><label>{language==='zh'?'线型':'Line pattern'}<select data-testid="mind-line-pattern" value={edgeDraft.dash||'solid'} onChange={e=>setEdgeDraft({...edgeDraft,dash:e.target.value as EdgeStyle['dash']})}><option value="solid">{language==='zh'?'实线':'Solid'}</option><option value="dashed">{language==='zh'?'虚线':'Dashed'}</option><option value="dotted">{language==='zh'?'点线':'Dotted'}</option><option value="dashDot">{language==='zh'?'点划线':'Dash-dot'}</option></select></label><label>{language==='zh'?'不透明度':'Opacity'}<input data-testid="mind-line-opacity" type="range" min={.1} max={1} step={.1} value={edgeDraft.opacity??1} onChange={e=>setEdgeDraft({...edgeDraft,opacity:Number(e.target.value)})}/></label><label>{gt(language, 'lineColor')}<input type="color" value={edgeDraft.strokeColor} onChange={e => setEdgeDraft({ ...edgeDraft, strokeColor: e.target.value })} /></label><label>{gt(language, 'width')}<input aria-label={gt(language, 'width')} type="number" min={1} max={12} value={edgeDraft.strokeWidth} onChange={e => setEdgeDraft({ ...edgeDraft, strokeWidth: numberStyle(e.target.valueAsNumber, edgeDraft.strokeWidth, 1, 12) })} /></label><label>{gt(language, 'arrows')}<select aria-label={gt(language, 'arrows')} value={edgeDraft.arrow} onChange={e => setEdgeDraft({ ...edgeDraft, arrow: e.target.value as EdgeStyle['arrow'] })}><option value="none">{gt(language, 'noArrow')}</option><option value="end">{gt(language, 'endArrow')}</option><option value="both">{gt(language, 'bothArrow')}</option></select></label><Button type="submit" className="primary">{gt(language, 'apply')}</Button><Button type="button" data-testid="mind-reverse-edge" onClick={() => commit(value => reverseMindEdge(setMindRelation(patchMindEdge(value, chosenEdge.id, edgeDraft),chosenEdge.id,relation), chosenEdge.id))}>{language === 'zh' ? '反转方向' : 'Reverse direction'}</Button><Button type="button" className="mind-delete" onClick={() => { commit(value => patchMindEdge(value, chosenEdge.id, null)); setSelectedEdge(null); }}><Trash2 />{gt(language, 'deleteConnection')}</Button></form> : <p className="mind-empty-inspector">{gt(language, 'choose')}</p>}</aside></div><footer className="graph-footer"><span>{model.nodes.length} / {model.total} {gt(language, 'nodes')}</span><span>{gt(language, 'editsHint')}</span>{(model.total > GRAPH_LIMIT || model.edges.length >= GRAPH_EDGE_LIMIT) && <strong>{gt(language, 'limit')}</strong>}</footer><ContextMenu menu={remoteBusy ? null : contextMenu} onClose={() => setContextMenu(null)} /></section>;
}

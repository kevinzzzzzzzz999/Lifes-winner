import {BoardRegionSelection} from './BoardRegionSelection';
import type {CaptureRect} from '../shared/desktop-api';
import BoardLibraryDialog,{BoardLibraryPreview} from './BoardLibraryDialog';
import type {LibraryConfig} from './board-library-favorites';
import {inspectLibraryGroups,isLibraryDecoration,libraryPrintFrame,type BoardLibraryGroup} from '../shared/board-library';
import {boardExportSheet,printExportSheets} from './board-export';
import BoardMergeGhost from './BoardMergeGhost';
import {clampMergePosition,type MergePoint,type MergeRect} from './board-merge-placement';
import {boardPDFOwnerIDs} from '../shared/board-pdf-owners';
import {createBoardSourceResolver} from './board-source';
import {boardPDFSourceReference} from './board-source-navigation';
import type {PDFSourceReference} from '../shared/pdf-extend';
import BoardWebCard from './BoardWebCard';
import BoardRelinkDialog from './BoardRelinkDialog';
import {useBoardTextSelection} from './BoardTextSelection';
import {isBoardWebCard,makeWebCardContent,boardWebURL} from './board-web-links';
import InkReplayDialog from './InkReplayDialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Minus, Plus, List, MapPin, FileText, Pencil, Type, FolderPlus,ChevronsUp,ChevronsDown,Undo2,Redo2,Trash2,Layers,LocateFixed,X,ClipboardPaste } from 'lucide-react';
import { Button, Modal } from './ui';
import {BoardArrangeToolbar,rectangleBetween,itemsWithin,hitBoardItem,sourceCardForSelection,type BoardTool,type BoardViewerOperation} from './BoardArrangeToolbar';
export type {BoardViewerOperation} from './BoardArrangeToolbar';
import { type Language, tr } from './i18n';
import {renderPDFThumbnail } from './PDFViewer';
import {BoardPDFDetail} from './BoardPDFDetail';
import {BOARD_PDF_PIXELS,planBoardPDFRegions,splitPDFPixelBudget,type PDFRenderRegion} from './board-pdf-resolution';
import {usePDFTranslation,type PDFSelectionConfig} from './PDFTranslation';
import {BoardPagePreviews,previewKey,previewEdge,previewAwait} from './BoardPagePreviews';
import BoxContent from './BoxContent';
import {clipboardBoardContent,boardPastePosition,internalClipboardPath,type BoardPasteContent} from './board-paste';
import VideoPlayer,{isVideoPath,type VideoPlaybackState} from './VideoPlayer';
import { ReviewMark, reviewRect, type ReviewFocus } from './ReviewPanel';
import type { ReviewRecord, OpenedFile, BoardChildLink, BoardChildPresentation, BoardTextFormat } from '../shared/desktop-api';
import ResolvedChildBoardPortal from './ResolvedChildBoardPortal';
import {selectChildPortals,sameChildCamera,childCanvasDPR,childEntries,childBounds,childCanExpand,validChildPresentation,layoutChildPortals,type ChildCamera} from './child-board-model';
import {childSession,childSessionsBusy,subscribeChildSessions} from './child-board-session';
import './board-viewer.css';
import {VAULT_DRAG_TYPE,decodeVaultDrag} from './file-tree-management';
import ContextMenu,{type ContextMenuItem,type ContextMenuState} from './ContextMenu';
import {boardInkStrokeBounds} from './board-ink-clip';
import {paintBoardInkStroke} from './board-ink-paint';
import BoardPaperDialog from './BoardPaperDialog';
import {paperScreenStyle} from './board-paper';

// Board navigation helpers: shared by the actual viewer and its synthetic checks.
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Size = { width: number; height: number };
type Camera = Point & { zoom: number };
type Item = Rect & { boardNotesObject?: Record<string, unknown>; childBoards?:BoardChildLink[]; id: string; kind: string; title: string; text?: string; textFormat?: string; richTextHTML?: string; sourcePath?: string; sourceCardID?: string; originalSourcePath?: string; sourceReference?:unknown; page?: number; url?: string; style?: { fillColor?: string; strokeColor?: string; textColor?: string; fontSize?: number; shape?: string; strokeWidth?: number } };
type Pin = Camera & { id: string; title: string };
type Stroke = { color: string; opacity: number; points: number[][]; clipPath?: number[][] };
type PDFDeclaration = { sourcePath: string; sha256: string; pages: number[] };
type PDFAsset = { url: string; sha256: string };
type AssetCache = { load: (sourcePath: string, hideBoardID?:string) => Promise<PDFAsset>; clear: () => void; resolve:(sourcePath:string)=>Promise<string> };
type Board = { id: string; canvasWidth:number;canvasHeight:number; title?: string; updatedAt?: string; schemaVersion: number; items: Item[]; edges: { from: string; to: string; style?: { strokeColor?: string; strokeWidth?: number; arrow?: string;dash?:string;opacity?:number } ;relation?:string}[]; pins: Pin[]; webInk?: { strokes: Stroke[] }; pdfAnnotationSources?: PDFDeclaration[]; pdfMergedOwnerIDs?:string[]; viewport?: Camera; previewPNG?: string; lastInkLocation?:Rect };
type DirectoryEntry = { type: 'item'; value: Item } | { type: 'pin'; value: Pin };
const DIRECTORY_PAGE_SIZE = 50;
const MAX_DETAIL_NODES = 24;
const MAX_PDF_NODES = 12;
const intersects = (a: Rect, b: Rect) => a.x + a.width >= b.x && a.y + a.height >= b.y && a.x <= b.x + b.width && a.y <= b.y + b.height;
const clampZoom = (v: number) => Math.min(8, Math.max(.00001, Number.isFinite(v) ? v : 1));
const validCamera = (value: Camera | undefined): value is Camera => !!value && [value.x, value.y, value.zoom].every(Number.isFinite) && value.zoom > 0;
const safeColor = (color: string | undefined, fallback: string) => /^#[a-f0-9]{6}$/i.test(color || '') ? color! : fallback;
function rectForStroke(s: Stroke): Rect {
  if(s.clipPath!==undefined)return boardInkStrokeBounds(s) ?? {x:NaN,y:NaN,width:0,height:0};
  let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
  for(const p of s.points){x=Math.min(x,p[0]-p[2]);y=Math.min(y,p[1]-p[2]);right=Math.max(right,p[0]+p[2]);bottom=Math.max(bottom,p[1]+p[2]);}
  return{x,y,width:right-x,height:bottom-y};
}
function fitBoard(rects: Rect[], size: Size, fallback?: Camera): Camera {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const rect of rects) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
    x = Math.min(x, rect.x); y = Math.min(y, rect.y); right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
  }
  if (!Number.isFinite(x)) return validCamera(fallback) ? { ...fallback, zoom: clampZoom(fallback.zoom) } : { x: 0, y: 0, zoom: 1 };
  return { x: (x + right) / 2, y: (y + bottom) / 2, zoom: clampZoom(Math.min(Math.max(1, size.width - 80) / Math.max(1, right - x), Math.max(1, size.height - 80) / Math.max(1, bottom - y), 2)) };
}
function boardWorldPoint(camera: Camera, size: Size, point: Point): Point {
  return { x: camera.x + (point.x - size.width / 2) / camera.zoom, y: camera.y + (point.y - size.height / 2) / camera.zoom };
}
function zoomBoard(camera: Camera, size: Size, point: Point, factor: number): Camera {
  const world = boardWorldPoint(camera, size, point), zoom = clampZoom(camera.zoom * factor);
  return { x: world.x - (point.x - size.width / 2) / zoom, y: world.y - (point.y - size.height / 2) / zoom, zoom };
}
function keyboardBoard(camera: Camera, size: Size, key: string, shift = false): Camera | null {
  const delta = (shift ? 240 : 80) / camera.zoom;
  if (key === 'ArrowLeft') return { ...camera, x: camera.x - delta };
  if (key === 'ArrowRight') return { ...camera, x: camera.x + delta };
  if (key === 'ArrowUp') return { ...camera, y: camera.y - delta };
  if (key === 'ArrowDown') return { ...camera, y: camera.y + delta };
  if (key === '+' || key === '=') return zoomBoard(camera, size, { x: size.width / 2, y: size.height / 2 }, 1.25);
  if (key === '-' || key === '_') return zoomBoard(camera, size, { x: size.width / 2, y: size.height / 2 }, 1 / 1.25);
  return null;
}
function shouldFitBoard(previous: { identity: string; width: number; height: number } | null, identity: string, size: Size, autoFit: boolean): boolean {
  return !previous || previous.identity !== identity || (autoFit && (previous.width !== size.width || previous.height !== size.height));
}
function safeBoardSource(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/^[\/]/.test(path) && !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function itemSourceTargets(item: Item): { kind: 'original' | 'annotated' | 'source'; path: string; page?: number }[] {
  if (!safeBoardSource(item.sourcePath)) return [];
  const page = /\.pdf$/i.test(item.sourcePath) && Number.isSafeInteger(item.page) && item.page! > 0 ? item.page : undefined;
  if (item.originalSourcePath != null && item.originalSourcePath !== item.sourcePath) {
    const excerpt=boardPDFSourceReference(item.sourceReference);
    if(excerpt?.path===item.originalSourcePath&&/\.(png|jpe?g)$/i.test(item.sourcePath))return [{kind:'original',path:excerpt.path,page:excerpt.page}];
    if (!safeBoardSource(item.originalSourcePath) || !/\.pdf$/i.test(item.sourcePath)) return [];
    return [{ kind: 'original', path: item.originalSourcePath }, { kind: 'annotated', path: item.sourcePath, page }];
  }
  return [{ kind: 'source', path: item.sourcePath, page }];
}
function boardDirectory(items: Item[], pins: Pin[], query: string, page: number, language: Language) {
  const needle = query.trim().toLocaleLowerCase();
  const tokens=needle.split(/\s+/).filter(Boolean);
  const kinds: Record<string, string> = language === 'zh' ? { text: '文字 文本', formula: '公式', pdfPage: 'PDF 页面', document: '资料 文件', inkGroup: '手写节点', link: '链接', pin: '定位 大头针' } : { pin: 'pin location', inkGroup: 'ink node' };
  const matches: DirectoryEntry[] = [];
  for (const item of items) if (!needle || tokens.every(token=>[item.title,item.text,item.sourcePath,item.originalSourcePath,item.url,item.kind,kinds[item.kind],item.page?`${item.page} page ${item.page} 第${item.page}页 p${item.page}`:''].some(value=>typeof value==='string'&&value.toLocaleLowerCase().includes(token)))) matches.push({ type: 'item', value: item });
  for (const pin of pins) if (!needle || [pin.title, 'pin', kinds.pin].some(value => value.toLocaleLowerCase().includes(needle))) matches.push({ type: 'pin', value: pin });
  const pageCount = Math.max(1, Math.ceil(matches.length / DIRECTORY_PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(pageCount - 1, Math.floor(page) || 0));
  return { entries: matches.slice(currentPage * DIRECTORY_PAGE_SIZE, (currentPage + 1) * DIRECTORY_PAGE_SIZE), total: matches.length, page: currentPage, pageCount };
}
function validInkLocation(value:unknown,world:number):value is Rect {
  const r=value as Rect|undefined;return !!r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=world&&r.y+r.height<=world;
}
function inkLocationCamera(rect:Rect,size:Size):Camera {
  const camera=fitBoard([{x:rect.x-64,y:rect.y-64,width:rect.width+128,height:rect.height+128}],size);return{...camera,zoom:Math.min(1.5,camera.zoom)};
}
function boardPreviewURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024 || value.length % 4 !== 0 || !value.startsWith('iVBORw0KGgo') || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return `data:image/png;base64,${value}`;
}
function chooseBoardDetails(items: Item[], camera: Camera, size: Size) {
  const world = { x: camera.x - size.width / 2 / camera.zoom, y: camera.y - size.height / 2 / camera.zoom, width: size.width / camera.zoom, height: size.height / camera.zoom };
  const visible = items.filter(item => intersects(item, world));
  const details = visible.filter(item => item.width * camera.zoom >= 50 && item.height * camera.zoom >= 30).sort((a, b) => Math.hypot(a.x + a.width / 2 - camera.x, a.y + a.height / 2 - camera.y) - Math.hypot(b.x + b.width / 2 - camera.x, b.y + b.height / 2 - camera.y)).slice(0, MAX_DETAIL_NODES);
  return { world, visible, details, pdfIDs: new Set(details.filter(item => item.kind === 'pdfPage').slice(0, MAX_PDF_NODES).map(item => item.id)) };
}
function matchesPDFWriteback(declaration: PDFDeclaration | undefined, page: number, sha256: string): boolean {
  return !!declaration && declaration.pages.includes(page) && sha256 === declaration.sha256;
}
// Board navigation UI: no helper above reads or modifies the board or vault.

function createAssetCache(vaultId: string,boardPath?:string,boardSHA?:string,ownerIDs?:string[]): AssetCache {
  const resolve=createBoardSourceResolver(vaultId,boardPath,boardSHA);
  const entries = new Map<string, Promise<PDFAsset>>();
  return { resolve,clear: () => entries.clear(), load: (sourcePath,hideBoardID) => {
    const key=JSON.stringify([sourcePath,hideBoardID||null]);
    const existing = entries.get(key);
    if (existing) { entries.delete(key); entries.set(key, existing); return existing; }
    const request = resolve(sourcePath).then(path=>window.desktop.getAssetUrl({ vaultId, path,...(hideBoardID?{hideBoardIDs:ownerIDs?.length?ownerIDs:[hideBoardID]}:{}) })).then(result => {
      if (!result.ok) throw Error('PDF unavailable');
      return result.value;
    });
    entries.set(key, request);
    while (entries.size > 64) entries.delete(entries.keys().next().value!);
    void request.catch(() => { if (entries.get(key) === request) entries.delete(key); });
    return request;
  } };
}
function BoardImage({item,assets,language,onRelink}:{item:Item;assets:AssetCache;language:Language;onRelink?:()=>void}){
 const [state,setState]=useState<{owner:AssetCache;path:string;url?:string;failed?:boolean}|null>(null);
 useEffect(()=>{let active=true;setState(null);void assets.load(item.sourcePath!).then(value=>{if(active)setState({owner:assets,path:item.sourcePath!,url:value.url});}).catch(()=>{if(active)setState({owner:assets,path:item.sourcePath!,failed:true});});return()=>{active=false;};},[assets,item.sourcePath]);
 const current=state?.owner===assets&&state.path===item.sourcePath?state:null;
 return <div className="board-image-content">{!item.boardNotesObject&&<strong>{item.title}</strong>}{current?.url?<img crossOrigin="anonymous" src={current.url} alt={item.title} draggable={false} onError={()=>setState({owner:assets,path:item.sourcePath!,failed:true})}/>:<small className={current?.failed?'inline-error':'muted'}>{current?.failed?tr(language,'missingSource'):(language==='zh'?'正在读取图片…':'Loading image…')}</small>}{current?.failed&&onRelink&&<button onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onRelink();}}>{language==='zh'?'重新关联资料':'Relink source'}</button>}</div>;
}
function LinkedBoardVideo({vaultId,item,assets,language,onOpen}:{vaultId:string;item:Item;assets:AssetCache;language:Language;onOpen:(path:string,playback:VideoPlaybackState)=>void}){
 const[source,setSource]=useState<{owner:AssetCache;path:string;canonical?:string;failed?:boolean}|null>(null);
 useEffect(()=>{let live=true;void assets.resolve(item.sourcePath!).then(canonical=>{if(live)setSource({owner:assets,path:item.sourcePath!,canonical});}).catch(()=>{if(live)setSource({owner:assets,path:item.sourcePath!,failed:true});});return()=>{live=false;};},[assets,item.sourcePath]);
 const current=source?.owner===assets&&source.path===item.sourcePath?source:null;
 return current?.canonical?<VideoPlayer vaultId={vaultId} path={current.canonical} title={item.title} language={language} onOpen={playback=>onOpen(current.canonical!,playback)}/>:<small className={current?.failed?'inline-error':'muted'}>{language==='zh'?(current?.failed?'视频资料暂不可用，请重新关联。':'正在定位视频…'):(current?.failed?'Video unavailable. Relink its source.':'Locating video…')}</small>;
}
function BoardPDF({ item,boardID, forceFilter=false,assets, region, declaration, onPaint, language,translation,onRelink }: { item: Item; boardID:string; forceFilter?:boolean; assets: AssetCache; region?:PDFRenderRegion; declaration?: PDFDeclaration; onPaint: (id: string, matched: boolean) => void; language: Language;translation?:PDFSelectionConfig;onRelink?:()=>void }) {
  const [loaded, setLoaded] = useState<{ owner: AssetCache; asset: PDFAsset;filtered:boolean } | null>(null), [error, setError] = useState(false);
  const current = loaded?.owner === assets ? loaded : null;
  const asset=current?.asset;
  useEffect(() => {
    let live = true; setLoaded(null); setError(false);onPaint(item.id,false);
    void assets.load(item.sourcePath!).then(async original=>{
      const filter=forceFilter||!!declaration&&!matchesPDFWriteback(declaration,item.page||1,original.sha256);
      const result=filter?await assets.load(item.sourcePath!,boardID):original;
      if(live)setLoaded({owner:assets,asset:result,filtered:filter});
    }).catch(()=>{if(live)setError(true);});
    return () => { live = false; onPaint(item.id, false); };
  }, [assets, item.id, item.sourcePath,item.page,boardID,forceFilter,declaration, onPaint]);
  const matched = !!asset && !current?.filtered && matchesPDFWriteback(declaration, item.page || 1, asset.sha256);
  useEffect(() => { onPaint(item.id, false); }, [asset?.url, item.id, item.page, matched, onPaint]);
  // A stale declaration uses an in-memory PDF view with only this board's old
  // annotations hidden. All other PDF annotations remain visible. The source
  // bytes are unchanged, and current webInk remains over the filtered preview.
  const sourceIdentity=JSON.stringify([asset?.url,asset?.sha256,item.page,current?.filtered,matched,1]);
  return asset && region ? <BoardPDFDetail key={sourceIdentity} url={asset.url} page={item.page||1} region={region} translation={translation} onCoverageChange={covered=>onPaint(item.id,covered&&matched)}/> : <small className={error ? 'inline-error' : 'muted'}>{error ? tr(language, 'missingSource') : `PDF · ${item.page || 1}`}{error&&onRelink&&<button onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onRelink();}}>{language==='zh'?'重新关联资料':'Relink source'}</button>}</small>;
}
export type BoardViewerProps = {
  focusItemRequest?: {id:string;nonce:number;highlight?:boolean};
  onFocusApplied?:(request:{id:string;nonce:number})=>void;
  raw: Record<string, unknown>; vaultId: string; language: Language;
  boardPath?:string; boardSHA?:string;
  onOpen: (path: string, page?: number, playback?: VideoPlaybackState) => void;
  onOpenSource?: (path:string,reference?:PDFSourceReference,page?:number)=>void;
  reviews?: ReviewRecord[]; reviewFocus?: ReviewFocus | null; onReview?: (review: ReviewRecord) => void;
  /** Increment for linked assets changed independently of the board JSON; preserves camera. */
  assetRevision?: string | number;
  onReplayActiveChange?: (active:boolean)=>void;
  onEditItem?: (id: string) => void;
  onAddChildBoard?: (point:Point)=>void;
  onBeforeChildMutation?: (path:string)=>Promise<void>;
  onChildSaved?: (file:OpenedFile)=>void;
  onChildBusyChange?: (busy:boolean)=>void;
  initialCompact?:boolean; initialDirectoryOpen?:boolean;
  embedded?:boolean; ancestorPaths?:string[]; displayScale?:number; pdfPixelBudget?:number;
  initialViewport?:ChildCamera; fitRequest?:number; onStageRectChange?:(rect:Rect)=>void; onViewportChange?:(camera:ChildCamera)=>void;
  onPrepareRegionCard?:()=>Promise<void>;
  onCreateRegionCard?:(value:{rect:CaptureRect;screenRect:CaptureRect;canvasID:string})=>Promise<void>;
  onPasteContent?: (content:BoardPasteContent,point:Point)=>Promise<{selectedIDs?:string[]}|void>;
  onAddNote?: (point: Point) => void;
  onAddFile?: (point: Point) => void;
  onUndo?:()=>Promise<void>;onRedo?:()=>Promise<void>;canUndo?:boolean;canRedo?:boolean;onChildBoards?:(id:string)=>void;
  onDropFiles?: (paths:string[],point:Point)=>Promise<void>;
  onBoardOperation?: (operation: BoardViewerOperation) => Promise<{selectedIDs?:string[]}|void>;
  operationBusy?: boolean;
  disabled?: boolean;
  mergePlacement?:{source:Record<string,unknown>;sourceBounds:MergeRect;position:MergePoint;fixed:boolean;onPositionChange:(point:MergePoint)=>void;onPlace:(point:MergePoint)=>void};
};
export default function BoardViewer({ focusItemRequest,onFocusApplied,raw, vaultId, language, boardPath, boardSHA, onOpen,onOpenSource, reviews = [], reviewFocus, onReview, assetRevision, onEditItem, onPrepareRegionCard,onCreateRegionCard,onPasteContent, onAddNote, onAddFile, onUndo, onRedo, canUndo=false, canRedo=false, onChildBoards, onDropFiles, onBoardOperation, operationBusy=false, disabled=false, onAddChildBoard,onBeforeChildMutation,onChildSaved,onChildBusyChange,initialCompact,initialDirectoryOpen,embedded=false,ancestorPaths=[],displayScale=1,pdfPixelBudget=BOARD_PDF_PIXELS,initialViewport,fitRequest,onStageRectChange,onViewportChange,onReplayActiveChange,mergePlacement }: BoardViewerProps) {
  const board = raw as unknown as Board, zh = language === 'zh';
  const [regionSelecting,setRegionSelecting]=useState(false),[regionCanvasID,setRegionCanvasID]=useState<string|null>(null),[regionStarting,setRegionStarting]=useState(false);
  const [paperDialog,setPaperDialog]=useState<{raw:Record<string,unknown>}|null>(null);
  const [libraryDialog,setLibraryDialog]=useState<{raw:Record<string,unknown>}|null>(null),[libraryPlacement,setLibraryPlacement]=useState<{groupID:string;config:LibraryConfig;rect:Rect;fixed:boolean;raw:Record<string,unknown>}|null>(null),[libraryExporting,setLibraryExporting]=useState(false);
  const libraryExportAbort=useRef<AbortController|null>(null);
  const libraryGroups=useMemo(()=>Array.isArray(raw.items)&&raw.items.some(i=>!!i&&typeof i==='object'&&Object.hasOwn(i,'libraryGroup'))?inspectLibraryGroups(raw):[],[raw]);
  const libraryByItem=useMemo(()=>new Map(libraryGroups.filter(g=>g.valid).flatMap(g=>g.itemIDs.map(id=>[id.toLowerCase(),g] as const))),[libraryGroups]);
  const libraryDecorations=useMemo(()=>new Set(libraryGroups.length&&Array.isArray(raw.items)?raw.items.filter(i=>!!i&&typeof i==='object'&&isLibraryDecoration(i as Record<string,unknown>,raw,libraryGroups)).map(i=>String(i.id).toLowerCase()):[]),[raw,libraryGroups]);
  const sourceCallbacks=useRef({onOpen,onOpenSource});sourceCallbacks.current={onOpen,onOpenSource};
  const valid = board.schemaVersion === 1 && Array.isArray(board.items) && Array.isArray(board.edges);
  const identity = `${vaultId}\n${board.id}`;
  const arrangeCanvas=useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null), ink = useRef<HTMLCanvasElement>(null), skeleton = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 900, height: 600 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [showList, setShowList] = useState(initialDirectoryOpen??!embedded), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const searchInput=useRef<HTMLInputElement>(null),navRequest=useRef(0),cameraVersion=useRef(0);
  const [sourcesOnly,setSourcesOnly]=useState(false),[navigationStatus,setNavigationStatus]=useState(''),[locatingInk,setLocatingInk]=useState(false);
  const [compactTools,setCompactTools]=useState(()=>initialCompact??(embedded||localStorage.getItem('inkspace.board.compactTools')==='true'));
  const [childVersion,setChildVersion]=useState(0),[childLoading,setChildLoading]=useState(false);
  const mountedChildKeys=useRef(new Set<string>());
  const ancestry=useMemo(()=>[...ancestorPaths,...(boardPath?[boardPath]:[])],[ancestorPaths.join('\n'),boardPath]);
  useEffect(()=>{const update=()=>{setChildVersion(v=>v+1);if(!embedded)onChildBusyChange?.(childSessionsBusy());};update();return subscribeChildSessions(update);},[embedded,onChildBusyChange]);
  const [context, setContext] = useState<{ screen: Point; world: Point; itemID?:string; raw:Record<string,unknown>; identity:string } | null>(null);
  const [tool,setTool]=useState<BoardTool>('read');
  const [inlineReplay,setInlineReplay]=useState<{board:Record<string,unknown>;camera:Camera}|null>(null);
  useEffect(()=>{onReplayActiveChange?.(!!inlineReplay);return()=>onReplayActiveChange?.(false);},[!!inlineReplay,onReplayActiveChange]);
  useEffect(()=>setInlineReplay(null),[identity]);
  const [selected,setSelected]=useState<string[]>([]),[pending,setPending]=useState(false),[operationStatus,setOperationStatus]=useState('');
  const [relink,setRelink]=useState<{id:string;field:'sourcePath'|'originalSourcePath';oldPath:string;raw:typeof raw}|null>(null);
  useEffect(()=>{setRelink(current=>current&&current.raw!==raw?null:current);},[raw]);
  const [gestureRect,setGestureRect]=useState<Rect|null>(null),[movePreview,setMovePreview]=useState<{ids:string[];dx:number;dy:number}|null>(null);
  const [resizePreview,setResizePreview]=useState<Rect|null>(null),[sizeEditor,setSizeEditor]=useState<{id:string;width:number;height:number}|null>(null);
  const [frameDraft,setFrameDraft]=useState<Rect|null>(null),[frameTitle,setFrameTitle]=useState('');
  const [expansionID,setExpansionID]=useState<string|null>(null),[direction,setDirection]=useState<Extract<BoardViewerOperation,{type:'expandDocument'}>['direction']>('vertical'),[scale,setScale]=useState(1),[columns,setColumns]=useState(2);
  type Gesture={kind:'libraryResize'|'resize'|'pan'|'move'|'select'|'frameInk'|'place'|'none';pointerId:number;screen:Point;world:Point;camera:Camera;ids:string[];raw:Record<string,unknown>;moved:boolean;rect?:Rect;corner?:string;groupID?:string;proportional?:boolean};
  const drag=useRef<Gesture|null>(null),spaceDown=useRef(false),operationEpoch=useRef(0),operationPending=useRef(false),mounted=useRef(true);
  const pastePoint=useRef<Point|null>(null);
  const [pasteFormat,setPasteFormat]=useState<BoardTextFormat>('richText');
  const [titleEditor,setTitleEditor]=useState<{id:string;title:string}|null>(null);
  const [webEditor,setWebEditor]=useState<{url:string;title:string;id?:string;link?:boolean}|null>(null),[webError,setWebError]=useState(''),[webSaving,setWebSaving]=useState(false);
  const webSavingRef=useRef(false);
  useEffect(()=>{setWebEditor(null);setWebError('');},[identity]);
  const live=useRef({identity,raw,onBoardOperation,onAddFile,onPasteContent,baseBlocked:false,blocked:false});
  const mutationBlocked=disabled||operationBusy||pending||!!inlineReplay||libraryExporting;
  live.current={identity,raw,onBoardOperation,onAddFile,onPasteContent,baseBlocked:disabled||operationBusy||!!inlineReplay,blocked:mutationBlocked};
  const selectionRef=useRef(selected);selectionRef.current=selected;
  const dialogRaw=useRef<Record<string,unknown>|null>(null);
  const cancelGesture=()=>{const current=drag.current;drag.current=null;setGestureRect(null);setMovePreview(null);setResizePreview(null);if(current&&stage.current?.hasPointerCapture(current.pointerId))stage.current.releasePointerCapture(current.pointerId);};
  const resizeRect=(start:Gesture,dx:number,dy:number,proportional=false):Rect=>{const r=start.rect!,left=start.corner?.includes('w'),top=start.corner?.includes('n');let width=Math.max(40,r.width+(left?-dx:dx)),height=Math.max(40,r.height+(top?-dy:dy));if(proportional){const ratio=Math.max(width/r.width,height/r.height);width=r.width*ratio;height=r.height*ratio;}width=Math.min(width,left?r.x+r.width:board.canvasWidth-r.x);height=Math.min(height,top?r.y+r.height:board.canvasHeight-r.y);return{x:Math.max(0,left?r.x+r.width-width:r.x),y:Math.max(0,top?r.y+r.height-height:r.y),width,height};};
  const chooseSelection=(ids:string[])=>{const expanded=[...new Set(ids.flatMap(id=>libraryByItem.get(id.toLowerCase())?.itemIDs||[id]))];selectionRef.current=expanded;setSelected(expanded);};
  const changeTool=(next:BoardTool)=>{setLibraryPlacement(null);setLibraryDialog(null);setInlineReplay(null);cancelGesture();setContext(null);setTool(next);setOperationStatus('');stage.current?.focus({preventScroll:true});};
  const editWeb=(item?:Item)=>{setWebError('');setWebEditor({url:item?.url||item?.text||'https://',title:item?.title||'',id:item?.id});};
  const openWebLink=(url:string)=>{setWebError('');setWebEditor({url,title:'',link:true});};
  const editBoardItem=(item:Item)=>{if(isBoardWebCard(item))editWeb(item);else onEditItem?.(item.id);};
  const translation=usePDFTranslation(identity+'\n'+(boardPath||'')+'\n'+(boardSHA||''),language,()=>changeTool('read'));
  useEffect(()=>{if(tool!=='read')translation.disable();},[tool]);
  const textSelection=useBoardTextSelection({stage,language,preferredItemIDs:()=>selectionRef.current,enabled:(tool==='read'||tool==='arrange')&&!mutationBlocked&&!inlineReplay&&!translation.selection&&!libraryPlacement&&!libraryDialog,revision:JSON.stringify([identity,boardSHA,tool,camera.x,camera.y,camera.zoom,size.width,size.height,displayScale]),displayScale,cancelPan:()=>{cancelGesture();setContext(null);},onExtract:onPasteContent&&!mutationBlocked?async(text,point)=>{const bounds=stage.current?.getBoundingClientRect();if(!bounds||live.current.blocked||childSessionsBusy())throw Error(zh?'白板忙，请稍后重试。':'The board is busy. Try again.');const prepared=clipboardBoardContent({text,html:'',warnings:[]},language,'richText');const world=boardWorldPoint(cameraRef.current,size,{x:(point.x-bounds.left)/displayScale,y:(point.y-bounds.top)/displayScale});const position=boardPastePosition(world,cameraRef.current,size,prepared.size,{width:board.canvasWidth,height:board.canvasHeight});try{await onPasteContent(prepared.content,position);}catch(error){setOperationStatus(error instanceof Error?error.message:String(error));throw error;}}:undefined});
  useEffect(()=>{textSelection.clear();},[raw]);
  const startReplay=()=>{if(disabled||operationBusy||pending||childSessionsBusy()||frameDraft||expansionID||sizeEditor||titleEditor)return;cancelGesture();setContext(null);translation.disable();autoFit.current=false;setInlineReplay({board:structuredClone(raw),camera:{...camera}});};

  const submitOperation=async(operation:BoardViewerOperation)=>{
    if(!live.current.onBoardOperation||live.current.blocked||operationPending.current)return false;
    if((libraryPlacement||libraryDialog)&&operation.type!=='insertLibrary'&&operation.type!=='transformLibrary'){setOperationStatus(zh?'请先完成或取消素材预览。':'Finish or cancel the library preview first.');return false;}
    if('ids' in operation&&operation.ids.length>2000){setOperationStatus(zh?'每次最多整理 2,000 个对象，请缩小选择范围。':'Arrange at most 2,000 objects at a time. Reduce the selection.');return false;}
    const currentIdentity=identity,epoch=++operationEpoch.current;operationPending.current=true;setPending(true);setOperationStatus(operation.type==='expandDocument'&&operation.direction==='onenote'?(zh?'正在拼接 OneNote PDF，完成后保存到白板…':'Stitching the OneNote PDF and saving it to the board…'):(zh?'正在保存白板操作…':'Saving board operation…'));
    try{const result=await live.current.onBoardOperation(operation);
      if(!mounted.current||live.current.identity!==currentIdentity||operationEpoch.current!==epoch)return false;
      if(result?.selectedIDs)chooseSelection(result.selectedIDs);setOperationStatus(zh?'白板操作已保存。':'Board operation saved.');return true;
    }catch(error){if(mounted.current&&live.current.identity===currentIdentity&&operationEpoch.current===epoch)setOperationStatus(error instanceof Error?error.message:zh?'操作未完成，原内容保留。':'The operation did not complete. Existing content was preserved.');return false;
    }finally{if(mounted.current&&live.current.identity===currentIdentity&&operationEpoch.current===epoch){operationPending.current=false;setPending(false);}}
  };

  const saveWebCard=async()=>{
    if(!webEditor||webSavingRef.current||live.current.blocked||operationPending.current||childSessionsBusy())return;
    const edit=webEditor,owner=identity;webSavingRef.current=true;setWebSaving(true);setWebError('');
    let ownsPending=false;
    try{
      const text=makeWebCardContent(edit.url,edit.title);
      if(edit.id){if(!await submitOperation({type:'patchItems',items:[{id:edit.id,title:text.title,text:text.text,url:text.url,textFormat:'web'}]}))return;}
      else {if(!live.current.onPasteContent)return;operationPending.current=true;ownsPending=true;setPending(true);const point=boardPastePosition(null,camera,size,{width:text.width,height:text.height},{width:board.canvasWidth,height:board.canvasHeight});const result=await live.current.onPasteContent({text},point);if(mounted.current&&live.current.identity===owner&&result?.selectedIDs)chooseSelection(result.selectedIDs);}
      if(mounted.current&&live.current.identity===owner)setWebEditor(null);
    }catch(error){if(mounted.current&&live.current.identity===owner)setWebError(error instanceof Error?error.message:String(error));}
    finally{webSavingRef.current=false;if(mounted.current){setWebSaving(false);if(ownsPending&&live.current.identity===owner){operationPending.current=false;setPending(false);}}}
  };

  const pasteClipboard=async(point:Point|null=pastePoint.current)=>{
    if(libraryPlacement||libraryDialog||!live.current.onPasteContent||live.current.blocked||operationPending.current||childSessionsBusy())return;
    const owner=identity,snapshot=raw,epoch=++operationEpoch.current;operationPending.current=true;setPending(true);setContext(null);cancelGesture();setOperationStatus(zh?'正在读取并粘贴…':'Reading and pasting…');
    try{
      const response=await window.desktop.readBoardClipboard({});
      if(!mounted.current||live.current.identity!==owner||live.current.raw!==snapshot||operationEpoch.current!==epoch)throw Error(zh?'白板已改变，请在当前白板重新粘贴。':'The board changed. Paste again into the current board.');
      if(!response.ok)throw Error(response.error.message);
      const prepared=clipboardBoardContent(response.value,language,pasteFormat),position=boardPastePosition(point,cameraRef.current,size,prepared.size,{width:board.canvasWidth,height:board.canvasHeight});
      // A draft or another portal may have become active while native RTF conversion ran.
      if(live.current.baseBlocked||childSessionsBusy()||!live.current.onPasteContent)throw Error(zh?'请先完成正在进行的编辑，再粘贴。':'Finish the current edit before pasting.');
      const saved=await live.current.onPasteContent(prepared.content,position);
      if(!mounted.current||live.current.identity!==owner||operationEpoch.current!==epoch)return;
      autoFit.current=false;setTool('arrange');if(saved?.selectedIDs)chooseSelection(saved.selectedIDs);
      pastePoint.current={x:position.x+prepared.size.width/2+32,y:position.y+prepared.size.height/2+32};stage.current?.focus({preventScroll:true});
      setOperationStatus((zh?'已粘贴并保存，可编辑、调整大小或撤销。':'Pasted and saved. Edit, resize or undo it.')+(prepared.notice?' '+prepared.notice:''));
    }catch(error){if(mounted.current&&live.current.identity===owner&&operationEpoch.current===epoch)setOperationStatus(error instanceof Error?error.message:String(error));}
    finally{if(mounted.current&&live.current.identity===owner&&operationEpoch.current===epoch){operationPending.current=false;setPending(false);}}
  };

  const autoFit = useRef(true), layout = useRef<{ identity: string; width: number; height: number } | null>(null);
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const items = useMemo(() => valid ? board.items.filter(item => typeof item.id === 'string' && [item.x, item.y, item.width, item.height].every(Number.isFinite) && item.width > 0 && item.height > 0) : [], [raw]);
  const pins = useMemo(() => (board.pins || []).filter(pin => typeof pin.id === 'string' && typeof pin.title === 'string' && validCamera(pin)), [raw]);
  const strokes = useMemo(() => board.webInk?.strokes || [], [raw]);
  const strokeRects = useMemo(() => strokes.map(rectForStroke), [strokes]);
  const children=useMemo(()=>childEntries(items),[items]);
  const expandedChildren=children.filter(entry=>validChildPresentation(entry.link.presentation)&&entry.link.presentation.expanded);
  const allRects = useMemo(() => [...items, ...strokeRects,...children.flatMap(entry=>validChildPresentation(entry.link.presentation)&&entry.link.presentation.expanded?[entry.link.presentation]:[])], [items, strokeRects,children]);
  // Keep the selected rendered text stable while the user reads, including app focus rescans.
  useEffect(()=>{setRegionSelecting(false);setRegionCanvasID(null);},[identity,raw,camera.x,camera.y,camera.zoom,size.width,size.height]);
  // Board content/camera changes still cancel selection; refresh linked assets after it closes.
  const textAssetRevision = useRef(assetRevision);
  if (!textSelection.active) textAssetRevision.current = assetRevision;
  const assets = useMemo(() => createAssetCache(vaultId,boardPath,boardSHA,boardPDFOwnerIDs(board)), [vaultId,boardPath,boardSHA, raw, textAssetRevision.current]);
  const activeAssets = useRef(assets); activeAssets.current = assets;
  const [painted, setPainted] = useState<{ owner: AssetCache; ids: Set<string> }>(() => ({ owner: assets, ids: new Set() }));
  useEffect(() => () => assets.clear(), [assets]);
  const paint = useCallback((id: string, matched: boolean) => {
    if (activeAssets.current !== assets) return;
    setPainted(old => {
      const ids = old.owner === assets ? old.ids : new Set<string>();
      if (old.owner === assets && ids.has(id) === matched) return old;
      const next = new Set(ids); if (matched) next.add(id); else next.delete(id);
      return { owner: assets, ids: next };
    });
  }, [assets]);
  const itemByID = useMemo(() => new Map(items.map(item => [item.id.toLowerCase(), item])), [items]);
  const selectedItems=useMemo(()=>selected.flatMap(id=>{const item=itemByID.get(id.toLowerCase());return item?[item]:[];}),[selected,itemByID]);
  const hitItems=useMemo(()=>libraryDecorations.size?[...items.filter(i=>libraryDecorations.has(i.id.toLowerCase())),...items.filter(i=>!libraryDecorations.has(i.id.toLowerCase()))]:items,[items,libraryDecorations]);
  const selectedLibraryGroup=useMemo(()=>libraryGroups.find(g=>g.valid&&g.itemIDs.length===selected.length&&g.itemIDs.every(id=>selected.includes(id)))||null,[libraryGroups,selected]);
  const sourceCard=useMemo(()=>sourceCardForSelection(items,selected),[items,selected]);
  const sourceExpanded=!!sourceCard&&items.some(item=>item.sourceCardID?.toLowerCase()===sourceCard.id.toLowerCase());
  const canUnpack=selectedItems.length>0&&selectedItems.every(item=>item.kind==='inkGroup');
  const declarations = useMemo(() => new Map((board.pdfAnnotationSources || []).map(source => [source.sourcePath, source])), [raw]);
  const { world, visible, details, pdfIDs } = useMemo(() => chooseBoardDetails(libraryDecorations.size?items.filter(i=>!libraryDecorations.has(i.id.toLowerCase())):items, camera, size), [items, camera, size,libraryDecorations]);
  const decorationItems=useMemo(()=>libraryDecorations.size?items.filter(i=>libraryDecorations.has(i.id.toLowerCase())):[],[items,libraryDecorations]);
  const previews=useMemo(()=>new BoardPagePreviews(async(request,signal)=>{
    const original=await previewAwait(assets.load(request.sourcePath),signal);if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const declaration=declarations.get(request.sourcePath),matched=matchesPDFWriteback(declaration,request.page,original.sha256);
    const source=declaration&&!matched?await previewAwait(assets.load(request.sourcePath,board.id),signal):original;if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const canvas=await renderPDFThumbnail(source.url,request.page,request.edge,signal);return{canvas,matched,sha256:original.sha256,edge:request.edge};
  }),[assets]);
  const[previewVersion,setPreviewVersion]=useState(0);
  useEffect(()=>{const off=previews.subscribe(()=>setPreviewVersion(v=>v+1));return()=>{off();previews.dispose();};},[previews]);
  useEffect(()=>{previews.update(visible.flatMap(item=>{
    if(item.kind!=='pdfPage'||!safeBoardSource(item.sourcePath)||!Number.isSafeInteger(item.page)||item.page!<1)return[];
    const edge=previewEdge(item.width,item.height,camera.zoom);return edge?[{key:previewKey(item.sourcePath,item.page!),sourcePath:item.sourcePath,page:item.page!,edge,priority:Math.hypot(item.x+item.width/2-camera.x,item.y+item.height/2-camera.y)}]:[];
  }));},[previews,visible,camera.zoom]);
  const previewStats=previews.snapshot();
  const lowResolution=visible.flatMap(item=>{if(item.kind!=='pdfPage'||!item.sourcePath||!item.page)return[];const tile=previews.peek(previewKey(item.sourcePath,item.page));return tile&&tile.canvas.width>0?[{item,tile}]:[];});
  const lowPainted=new Set(lowResolution.filter(value=>value.tile.matched).map(value=>value.item.id));

  // Preserve mounted ancestors too: a descendant's draft belongs to its portal subtree.
  const childWorkPending=childSessionsBusy(),protectedChild=(entry:typeof expandedChildren[number])=>childWorkPending&&mountedChildKeys.current.has(entry.itemID+'\n'+entry.link.id);
  const visibleChildEntries=expandedChildren.filter(entry=>intersects(entry.link.presentation!,world)||protectedChild(entry));
  const liveChildEntries=selectChildPortals(visibleChildEntries.filter(entry=>childCanExpand(entry.link.path,ancestry)),protectedChild,entry=>Math.hypot(entry.link.presentation!.x+entry.link.presentation!.width/2-camera.x,entry.link.presentation!.y+entry.link.presentation!.height/2-camera.y));
  const liveChildKeys=new Set(liveChildEntries.map(e=>e.itemID+'\n'+e.link.id));mountedChildKeys.current=liveChildKeys;

  const visibleInk = useMemo(() => {
    const included = strokes.map((s, i) => ({ s, b: strokeRects[i] })).filter(({ b }) => intersects(b, world));
    return { included, points: included.reduce((count, { s }) => count + s.points.length, 0) };
  }, [strokes, strokeRects, world]);
  const matchingReviews = reviews.filter(review => review.boardID.toLowerCase() === board.id?.toLowerCase());
  const results = useMemo(() => boardDirectory(sourcesOnly?items.filter(item=>!!(item.sourcePath||item.originalSourcePath)):items,sourcesOnly?[]:pins,query,page,language), [items,pins,query,page,language,sourcesOnly]);
  const previewURL = useMemo(() => boardPreviewURL(board.previewPNG), [board.previewPNG]);
  const updated = board.updatedAt && Number.isFinite(Date.parse(board.updatedAt)) ? new Date(board.updatedAt).toLocaleString(zh ? 'zh-CN' : 'en') : null;
  const viewportCallback=useRef(onViewportChange);viewportCallback.current=onViewportChange;
  const manualCamera = (next: Camera) => { cameraVersion.current++;autoFit.current = false;cameraRef.current=next;setCamera(next);viewportCallback.current?.(next); };
  const viewportKey=JSON.stringify(initialViewport||null);
  useEffect(()=>{if(initialViewport&&validCamera(initialViewport)){const next={...initialViewport,zoom:clampZoom(initialViewport.zoom)},current=cameraRef.current;if(sameChildCamera(next,current))return;autoFit.current=false;cameraRef.current=next;setCamera(next);}},[viewportKey]);
  const locate = (rect: Rect) => manualCamera(fitBoard([rect], size));
  const lastStudyLocation=useRef<number|undefined>(undefined),focusAppliedCallback=useRef(onFocusApplied);focusAppliedCallback.current=onFocusApplied;
  useEffect(()=>{if(!focusItemRequest||lastStudyLocation.current===focusItemRequest.nonce||!size.width||!size.height||operationBusy||disabled)return;const target=items.find(item=>item.id.toLowerCase()===focusItemRequest.id.toLowerCase());if(!target)return;cancelGesture();setInlineReplay(null);setContext(null);if(focusItemRequest.highlight)chooseSelection([target.id]);locate(target);lastStudyLocation.current=focusItemRequest.nonce;focusAppliedCallback.current?.(focusItemRequest);},[focusItemRequest?.nonce,size.width,size.height,items,operationBusy,disabled]);
  const openDirectory=()=>{cancelGesture();setShowList(true);setSourcesOnly(true);setPage(0);requestAnimationFrame(()=>searchInput.current?.focus());};
  const locateLastInk=async()=>{
    if(locatingInk)return;cancelGesture();setContext(null);setNavigationStatus('');
    const owner=identity,snapshot=raw,epoch=++navRequest.current,cameraAtRequest=cameraVersion.current;
    if(validInkLocation(board.lastInkLocation,board.canvasWidth)){manualCamera(inkLocationCamera(board.lastInkLocation,size));setNavigationStatus(zh?'已回到最后一笔。':'Returned to the last ink stroke.');return;}
    if(!boardPath||!boardSHA){setNavigationStatus(zh?'此旧白板尚未保存最后一笔位置，请完整打开或在 iPad 保存后重试。':'This older board has no saved ink location. Open the full board or save it on iPad first.');return;}
    setLocatingInk(true);
    try{const response=await window.desktop.getLastInkLocation({vaultId,path:boardPath,expectedSHA256:boardSHA});
      if(!mounted.current||live.current.identity!==owner||live.current.raw!==snapshot||navRequest.current!==epoch||cameraVersion.current!==cameraAtRequest)return;
      if(!response.ok)throw new Error(response.error.message);
      const value=response.value;if(value.boardID.toLowerCase()!==board.id.toLowerCase()||value.sha256!==boardSHA)throw Error(zh?'白板版本已改变，请刷新后重试。':'The board version changed. Refresh and try again.');
      if(value.location&&validInkLocation(value.location,board.canvasWidth)){manualCamera(inkLocationCamera(value.location,size));setNavigationStatus(value.source==='preview'?(zh?'已定位旧版预览中的最后一条笔迹；该预览没有原生书写时间。':'Located the final stroke in this legacy preview; native stroke timestamps are unavailable.'):(zh?'已回到最后一笔。':'Returned to the last ink stroke.'));}
      else setNavigationStatus(value.source==='unavailable'?(zh?'此设备无法读取旧版原生笔迹位置，请在 iPad 保存后重试。':'This device cannot read the older native ink location. Save the board on iPad first.'):(zh?'这块白板还没有可定位的手写笔迹。':'This board has no visible handwriting to locate.'));
    }catch(error){if(mounted.current&&live.current.identity===owner&&live.current.raw===snapshot&&navRequest.current===epoch&&cameraVersion.current===cameraAtRequest)setNavigationStatus(error instanceof Error?error.message:String(error));}
    finally{if(mounted.current&&navRequest.current===epoch)setLocatingInk(false);}
  };

  const locatePin = (pin: Pin) => manualCamera({ x: pin.x, y: pin.y, zoom: clampZoom(pin.zoom) });
  const overview = () => { cameraVersion.current++;autoFit.current = true;const element=stage.current,measured=element&&element.clientWidth>0&&element.clientHeight>0?{width:element.clientWidth,height:element.clientHeight}:size;const next=fitBoard(allRects,measured,board.viewport);cameraRef.current=next;setCamera(next);viewportCallback.current?.(next); }; 
  const presentChild=async(itemID:string,childID:string,presentation:BoardChildPresentation)=>{const old=children.find(e=>e.itemID===itemID&&e.link.id===childID)?.link.presentation;let next=presentation;if(old&&presentation.expanded&&(presentation.width>old.width||presentation.height>old.height)){const occupied=[...items,...expandedChildren.filter(e=>e.itemID!==itemID||e.link.id!==childID).map(e=>e.link.presentation!)];const overlaps=(r:Rect)=>presentation.x<r.x+r.width+48&&presentation.x+presentation.width+48>r.x&&presentation.y<r.y+r.height+48&&presentation.y+presentation.height+48>r.y;if(occupied.some(overlaps))next={...presentation,y:Math.max(presentation.y,...occupied.map(r=>r.y+r.height))+96};}return submitOperation({type:'setChildBoardPresentations',updates:[{id:itemID,childID,presentation:next}]});};
  const expandChildren=async(entries:typeof children,fullContents=false)=>{if(!entries.length||childLoading||mutationBlocked||childSessionsBusy())return;setChildLoading(true);setOperationStatus(zh?'正在读取子白板范围…':'Reading child board bounds…');
    try{const requested=entries.filter(entry=>childCanExpand(entry.link.path,ancestry));if(requested.length!==entries.length)throw Error(zh?'循环链接或层级过深，请完整打开对应子白板。':'A recursive link or depth limit prevents expansion. Open that child board directly.');
      const bounds=new Map<string,Rect>();for(const entry of requested){const canonical=await assets.resolve(entry.link.path);if(!childCanExpand(canonical,ancestry))throw Error(zh?'循环链接已停止；请完整打开子白板。':'Recursive child link stopped. Open the full board.');const session=childSession(vaultId,canonical);await session.refresh();const file=session.snapshot().file;if(file?.board&&String(file.board.id).toLowerCase()===entry.link.id.toLowerCase())bounds.set(entry.link.path,childBounds(file.board));}
      const selected=new Set(requested.map(e=>e.itemID+'\n'+e.link.id));const occupied=[...items,...expandedChildren.filter(e=>!selected.has(e.itemID+'\n'+e.link.id)).map(e=>e.link.presentation!)];
      const updates=layoutChildPortals(requested,occupied,{width:board.canvasWidth,height:board.canvasHeight},bounds,fullContents);if(await submitOperation({type:'setChildBoardPresentations',updates})){autoFit.current=true;const next=fitBoard([...items,...updates.map(u=>u.presentation),...strokeRects],size);setCamera(next);onViewportChange?.(next);}
    }catch(error){setOperationStatus(error instanceof Error?error.message:String(error));}finally{setChildLoading(false);}
  };
  const collapseChildren=()=>{if(childSessionsBusy())return;void submitOperation({type:'setChildBoardPresentations',updates:expandedChildren.map(e=>({id:e.itemID,childID:e.link.id,presentation:{...e.link.presentation!,expanded:false}}))});};
  const position = (r: Rect) => ({ left: (r.x - camera.x) * camera.zoom + size.width / 2, top: (r.y - camera.y) * camera.zoom + size.height / 2, width: r.width * camera.zoom, height: r.height * camera.zoom });
  const pdfBudgetShare=splitPDFPixelBudget(pdfPixelBudget,pdfIDs.size>0,liveChildEntries.length);
  const pdfRegions=planBoardPDFRegions(details.filter(item=>pdfIDs.has(item.id)).map(item=>{const p=position(item);return{id:item.id,x:p.left,y:p.top,width:p.width,height:p.height};}),size,displayScale,window.devicePixelRatio||1,pdfBudgetShare,true);
  const sourceLabel = (kind: 'original' | 'annotated' | 'source') => kind === 'original' ? (zh ? '打开原文' : 'Open original') : kind === 'annotated' ? (zh ? '打开批注版' : 'Open annotated PDF') : (zh ? '打开原文件' : 'Open source');
  const openSource=(path:string,page?:number,playback?:VideoPlaybackState,reference?:PDFSourceReference)=>{const owner=identity;void assets.resolve(path).then(canonical=>{if(mounted.current&&live.current.identity===owner){const callbacks=sourceCallbacks.current;if(callbacks.onOpenSource&&!playback&&/\.pdf$/i.test(canonical))return callbacks.onOpenSource(canonical,reference?.path===path?{...reference,path:canonical}:undefined,page);return callbacks.onOpen(canonical,page,playback);}}).catch(()=>{if(mounted.current&&live.current.identity===owner)setOperationStatus(zh?'暂时无法定位这份资料，请确认资料文件夹或重新关联。':'The linked source is unavailable. Check the vault or relink it.');});};
  const openItemSource=(item:Item,path:string,page?:number)=>openSource(path,page,undefined,boardPDFSourceReference(item.sourceReference));
  const defaultOpen = (item: Item) => { const targets = itemSourceTargets(item), target = targets.find(target => target.kind === 'annotated') || targets[0]; if (target) openItemSource(item,target.path, target.page); };

  // Rebuild the menu from live props/selection; an iCloud refresh invalidates its snapshot.
  const contextItems:ContextMenuItem[]=[];
  if(context&&context.raw===raw&&context.identity===identity){
    const contextBlocked=mutationBlocked||childSessionsBusy();
    const menuIDs=selectedItems.map(item=>item.id),single=selectedItems.length===1?selectedItems[0]:undefined;
    const add=(id:string,cn:string,en:string,run:()=>unknown|Promise<unknown>,options:{mutates?:boolean;disabled?:boolean;danger?:boolean;separatorBefore?:boolean;shortcut?:string;selection?:boolean}={})=>{
      const {mutates=false,selection=false,...presentation}=options;
      contextItems.push({id,label:zh?cn:en,...presentation,disabled:!!options.disabled||(mutates&&contextBlocked),action:async()=>{
        if(live.current.identity!==context.identity||live.current.raw!==context.raw)return;
        if(mutates&&(live.current.blocked||operationPending.current||childSessionsBusy()))return;
        if(selection&&(menuIDs.length!==selectionRef.current.length||menuIDs.some((id,index)=>id!==selectionRef.current[index])))return;
        try{await run();}catch(error){if(mounted.current&&live.current.identity===context.identity)setOperationStatus(error instanceof Error?error.message:String(error));}
      }});
    };
    if(onPasteContent)add('board-paste-here','在此粘贴','Paste here',()=>pasteClipboard(context.world),{mutates:true,shortcut:'⌘V'});
    if(context.itemID){
      if(single){
        if(onEditItem&&['text','formula'].includes(single.kind))add('board-edit-text','编辑文字 / 格式','Edit text / format',()=>editBoardItem(single),{mutates:true,selection:true});
        for(const target of itemSourceTargets(single))add('board-open-'+target.kind,isVideoPath(target.path)?'打开视频播放器':sourceLabel(target.kind),isVideoPath(target.path)?'Open video player':sourceLabel(target.kind),()=>openItemSource(single,target.path,target.page),{selection:true});
        if(onBoardOperation&&boardPath&&boardSHA)for(const field of ['sourcePath','originalSourcePath'] as const)if(safeBoardSource(single[field]))add('board-relink-'+field,field==='originalSourcePath'?'重新关联失联原件…':'重新关联失联资料…',field==='originalSourcePath'?'Relink missing original…':'Relink missing source…',()=>setRelink({id:single.id,field,oldPath:single[field]!,raw}),{mutates:true,selection:true});
        add('board-focus-item','定位并放大此模块','Focus this object',()=>locate(single),{selection:true});
      }else add('board-focus-selection','查看所选模块','Fit selected objects',()=>manualCamera(fitBoard(selectedItems,size)),{selection:true});
      if(onBoardOperation){
        add('board-arrange-selection','管理 / 移动所选模块','Arrange / move selected objects',()=>changeTool('arrange'),{mutates:true,selection:true,separatorBefore:true});
        if(single)add('board-resize','调整模块大小…','Resize object…',()=>{changeTool('arrange');dialogRaw.current=raw;setSizeEditor({id:single.id,width:single.width,height:single.height});},{mutates:true,selection:true});
        if(menuIDs.length>1)add('board-connect-selection','连接为思维导图分支','Connect as mind map branches',()=>submitOperation({type:'connect',ids:menuIDs}),{mutates:true,selection:true});
        if(canUnpack)add('board-unpack-ink','解包手写节点','Unpack ink nodes',()=>submitOperation({type:'unpackInk',ids:menuIDs}),{mutates:true,selection:true});
        if(sourceCard?.sourcePath?.toLowerCase().endsWith('.pdf'))add('board-expand-document',sourceExpanded?'重新排列展开页面…':'展开文档页面…',sourceExpanded?'Rearrange expanded pages…':'Expand document pages…',()=>{dialogRaw.current=raw;setDirection('vertical');setScale(1);setColumns(2);setExpansionID(sourceCard.id);},{mutates:true,selection:true});
        if(sourceCard&&sourceExpanded)add('board-collapse-document','收起文档页面','Collapse document pages',()=>submitOperation({type:'collapseDocument',id:sourceCard.id}),{mutates:true,selection:true});
      }
      if(single&&onChildBoards)add('board-child-boards','添加 / 管理子白板…','Add / manage child boards…',()=>onChildBoards(single.id),{mutates:true,selection:true,separatorBefore:true});
      if(single)for(const entry of children.filter(entry=>entry.itemID===single.id)){
        const title=entry.link.title.slice(0,42)|| (zh?'子白板':'Child board');
        add('board-child-open-'+entry.link.id,`完整打开：${title}`,`Open child: ${title}`,()=>openSource(entry.link.path),{selection:true});
        if(onBoardOperation)add('board-child-toggle-'+entry.link.id,`${entry.link.presentation?.expanded?'收起':'展开'}：${title}`,`${entry.link.presentation?.expanded?'Collapse':'Expand'}: ${title}`,()=>entry.link.presentation?.expanded?presentChild(entry.itemID,entry.link.id,{...entry.link.presentation,expanded:false}):expandChildren([entry]),{mutates:true,selection:true,disabled:childLoading||(!entry.link.presentation?.expanded&&!childCanExpand(entry.link.path,ancestry))});
      }
      if(onBoardOperation)add('board-remove-selection',menuIDs.length>1?'从白板移除所选模块（保留原文件）':'从白板移除此模块（保留原文件）',menuIDs.length>1?'Remove selected objects (keep source files)':'Remove object (keep source file)',()=>submitOperation({type:'remove',ids:menuIDs}),{mutates:true,selection:true,danger:true,separatorBefore:true,shortcut:'⌫'});
      add('board-clear-selection','取消选择','Clear selection',()=>chooseSelection([]));
    }else{
      if(onAddNote)add('board-add-note-here','在此添加文字…','Add text here…',()=>onAddNote(context.world),{mutates:true});
      if(onAddFile)add('board-add-file-here','在此添加资料…','Add files here…',()=>onAddFile(context.world),{mutates:true});
      if(onAddChildBoard)add('board-add-child-here','在此添加子白板…','Add child board here…',()=>onAddChildBoard(context.world),{mutates:true});
      if(onBoardOperation){
        add('board-mode-read','阅读模式','Reading mode',()=>changeTool('read'),{separatorBefore:contextItems.length>0});
        add('board-mode-arrange','管理 / 移动模式','Arrange / move mode',()=>changeTool('arrange'),{mutates:true});
        if(onAddFile)add('board-mode-place','放置资料模式','Place files mode',()=>changeTool('place'),{mutates:true});
        add('board-mode-frame','框成手写节点','Frame handwriting as a node',()=>changeTool('frameInk'),{mutates:true});
        if(children.length)add('board-expand-all-children','展开全部子白板','Expand all child boards',()=>expandChildren(children,true),{mutates:true,disabled:childLoading});
        if(expandedChildren.length)add('board-collapse-all-children','收起全部子白板','Collapse all child boards',collapseChildren,{mutates:true});
      }
    }
    if(onUndo)add('board-undo','撤销','Undo',onUndo,{mutates:true,disabled:!canUndo,separatorBefore:true,shortcut:'⌘Z'});
    if(onRedo)add('board-redo','重做','Redo',onRedo,{mutates:true,disabled:!canRedo,shortcut:'⇧⌘Z'});
    add('board-fit','适应窗口','Fit board to window',overview,{separatorBefore:true});
    add('board-saved-view','原生视口','Saved native view',()=>{if(validCamera(board.viewport))manualCamera({...board.viewport,zoom:clampZoom(board.viewport.zoom)});},{disabled:!validCamera(board.viewport)});
    add('board-find-sources','定位白板中的资料…','Find sources on this board…',openDirectory);
    add('board-last-ink','回到最后一笔','Return to last ink stroke',locateLastInk,{disabled:locatingInk});
  }
  const contextMenu:ContextMenuState|null=context&&contextItems.length?{x:context.screen.x,y:context.screen.y,title:context.itemID?(selectedItems.length>1?(zh?`${selectedItems.length} 个模块已选`:`${selectedItems.length} objects selected`):(selectedItems[0]?.title||(zh?'白板模块':'Board object'))):(zh?'白板':'Board'),items:contextItems}:null;

  const viewerRoot=useRef<HTMLDivElement>(null),stageRectCallback=useRef(onStageRectChange);stageRectCallback.current=onStageRectChange;
  useEffect(() => {
    const measure=()=>{const element=stage.current,root=viewerRoot.current;if(!element||!root)return;const rect=element.getBoundingClientRect(),outer=root.getBoundingClientRect();const width=rect.width/displayScale,height=rect.height/displayScale;if(width>0&&height>0){setSize(old=>Math.abs(old.width-width)<.001&&Math.abs(old.height-height)<.001?old:{width,height});stageRectCallback.current?.({x:(rect.left-outer.left)/displayScale,y:(rect.top-outer.top)/displayScale,width,height});}};
    const observer = new ResizeObserver(measure);
    if (stage.current) observer.observe(stage.current);
    measure();return () => observer.disconnect();
  }, [valid,displayScale]);
  useEffect(() => {
    const isNew = layout.current?.identity !== identity;
    if (isNew) { pastePoint.current=null;navRequest.current++;setNavigationStatus('');setLocatingInk(false);setSourcesOnly(false);autoFit.current = true; setQuery(''); setPage(0); setContext(null); cancelGesture(); setTool('read'); chooseSelection([]); setFrameDraft(null);setExpansionID(null);setSizeEditor(null);setTitleEditor(null);setOperationStatus('');operationEpoch.current++;operationPending.current=false;setPending(false); }
    if (shouldFitBoard(layout.current, identity, size, autoFit.current)) {if(isNew&&validCamera(initialViewport)){autoFit.current=false;cameraRef.current=initialViewport;setCamera(initialViewport);}else{const next=fitBoard(allRects,size,board.viewport);cameraRef.current=next;setCamera(next);if(!isNew)viewportCallback.current?.(next);}}
    layout.current = { identity, ...size };
    // JSON refresh alone never changes a manually selected camera or the current overview.
  }, [identity, raw, size.width, size.height]);
  const lastFitRequest=useRef(fitRequest);
  useEffect(()=>{if(fitRequest!==lastFitRequest.current){lastFitRequest.current=fitRequest;if(fitRequest)overview();}},[fitRequest]);
  useEffect(()=>{if(libraryDialog&&libraryDialog.raw!==raw)setLibraryDialog(null);if(libraryPlacement&&libraryPlacement.raw!==raw){setLibraryPlacement(null);setOperationStatus(zh?'白板已更新，本次素材预览已停止；请在组管理中检查已保存结果。':'The board updated; the preview stopped. Check placed groups for saved results.');}libraryExportAbort.current?.abort();},[raw]);
  useEffect(()=>{if(!libraryPlacement)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!operationPending.current){event.preventDefault();event.stopPropagation();setLibraryPlacement(null);cancelGesture();stage.current?.focus({preventScroll:true});}};window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true);},[!!libraryPlacement]);
  useEffect(()=>{
    setContext(null);
    if(drag.current&&drag.current.raw!==raw){cancelGesture();setOperationStatus(zh?'白板已刷新，本次拖动已取消。':'The board refreshed; this drag was cancelled.');}
    if(dialogRaw.current&&dialogRaw.current!==raw&&(frameDraft||expansionID||sizeEditor)){setFrameDraft(null);setExpansionID(null);setSizeEditor(null);setTitleEditor(null);dialogRaw.current=null;setOperationStatus(zh?'白板已刷新，请重新选择操作范围。':'The board refreshed. Select the operation area again.');}
    const ids=new Set(items.map(item=>item.id.toLowerCase()));setSelected(old=>old.filter(id=>ids.has(id.toLowerCase())));
  },[raw]);
  useEffect(()=>{const blur=()=>{spaceDown.current=false;cancelGesture();};window.addEventListener('blur',blur);return()=>window.removeEventListener('blur',blur);},[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operationEpoch.current++;navRequest.current++;drag.current=null;libraryExportAbort.current?.abort();};},[]);
  useEffect(()=>{if(mutationBlocked)cancelGesture();},[mutationBlocked]);
  const lastReviewFocus = useRef<string>('');
  const focusedReview = reviewFocus && matchingReviews.find(review => review.id.toLowerCase() === reviewFocus.review.id.toLowerCase());
  useEffect(() => {
    if (!focusedReview || !reviewFocus) return;
    const focusKey = `${identity}:${focusedReview.id}:${reviewFocus.nonce}`;
    if (lastReviewFocus.current === focusKey) return;
    lastReviewFocus.current = focusKey;
    const rect = reviewRect(focusedReview, items);
    cameraVersion.current++; autoFit.current = false;
    setCamera(fitBoard([{ x: rect.x - rect.width * .3, y: rect.y - rect.height * .3, width: Math.max(160, rect.width * 1.6), height: Math.max(160, rect.height * 1.6) }], size));
  }, [identity, reviewFocus?.nonce, !!focusedReview]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if((event.target as HTMLElement).closest('.board-stage')!==element)return;
      const table=(event.target as HTMLElement).closest<HTMLElement>('.box-content');
      if(tool==='read'&&!event.ctrlKey&&!event.metaKey&&table?.querySelector('table')&&(table.scrollHeight>table.clientHeight+1||table.scrollWidth>table.clientWidth+1)){
        event.preventDefault();event.stopPropagation();cancelGesture();
        const unit=event.deltaMode===1?16:event.deltaMode===2?table.clientHeight:1;
        table.scrollTop+=event.shiftKey?0:event.deltaY*unit;table.scrollLeft+=(event.deltaX+(event.shiftKey?event.deltaY:0))*unit;return;
      }
      // A non-passive listener is required for trackpad pinch not to zoom the whole app.
      event.preventDefault(); cancelGesture(); cameraVersion.current++; autoFit.current = false; setContext(null);
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      const current=cameraRef.current;const next=event.ctrlKey||event.metaKey?zoomBoard(current,size,{x:(event.clientX-rect.left)/displayScale,y:(event.clientY-rect.top)/displayScale},Math.exp(-event.deltaY*unit*.006)):{...current,x:current.x+event.deltaX*unit/current.zoom/displayScale,y:current.y+event.deltaY*unit/current.zoom/displayScale};cameraRef.current=next;setCamera(next);viewportCallback.current?.(next);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [valid, size,displayScale,tool]);
  useEffect(() => { if (!context) return; const dismiss = () => setContext(null); window.addEventListener('blur', dismiss); return () => window.removeEventListener('blur', dismiss); }, [!!context]);

  const canvasDPR=embedded?childCanvasDPR(size,window.devicePixelRatio||1,displayScale):Math.min(2,window.devicePixelRatio||1);
  useEffect(() => {
    const canvas = skeleton.current; if (!canvas) return;
    const dpr = canvasDPR; canvas.width = Math.ceil(size.width * dpr); canvas.height = Math.ceil(size.height * dpr);
    const c = canvas.getContext('2d'); if (!c) return; c.scale(dpr, dpr);
    // Two thousand overview rectangles remain one canvas, not two thousand DOM layers.
    for (const item of [...decorationItems,...visible]) {
      if (item.kind === 'inkGroup') continue;
      const p = position(item); c.fillStyle = safeColor(item.style?.fillColor, '#ffffff'); c.strokeStyle = safeColor(item.style?.strokeColor, '#cbd6d2'); c.lineWidth = Math.max(1, Math.min(8, item.style?.strokeWidth || 1));
      c.beginPath();
      if (item.style?.shape === 'ellipse') c.ellipse(p.left + p.width / 2, p.top + p.height / 2, p.width / 2, p.height / 2, 0, 0, Math.PI * 2);
      else if (item.style?.shape === 'rounded') c.roundRect(p.left, p.top, p.width, p.height, Math.min(16, p.width / 4, p.height / 4));
      else c.rect(p.left, p.top, p.width, p.height);
      c.fill(); c.stroke();
      const tile=item.kind==='pdfPage'&&item.sourcePath&&item.page?previews.peek(previewKey(item.sourcePath,item.page)):undefined;
      if(tile&&tile.canvas.width>0&&tile.canvas.height>0){c.save();c.clip();c.drawImage(tile.canvas,p.left,p.top,p.width,p.height);c.restore();}
    }
  }, [visible, decorationItems,camera, size,previews,previewVersion,canvasDPR,displayScale]);
  useEffect(() => {
    const node = ink.current; if (!node) return;
    const dpr = canvasDPR; node.width = Math.ceil(size.width * dpr); node.height = Math.ceil(size.height * dpr);
    const c = node.getContext('2d'); if (!c) return; c.scale(dpr, dpr); c.translate(size.width / 2 - camera.x * camera.zoom, size.height / 2 - camera.y * camera.zoom); c.scale(camera.zoom, camera.zoom);
    const step = Math.max(1, Math.ceil(visibleInk.points / 200000));
    for (const { s } of visibleInk.included) {
      paintBoardInkStroke(c,s,step);
    }
    c.globalAlpha = 1;
    // A late old-asset callback cannot clip a freshly refreshed ink layer.
    for (const item of visible) if (lowPainted.has(item.id)||(painted.owner===assets&&painted.ids.has(item.id)&&pdfIDs.has(item.id))) c.clearRect(item.x,item.y,item.width,item.height);
  }, [camera, size, raw, painted, assets,previews,previewVersion,canvasDPR,displayScale]);

  useEffect(()=>{
    const canvas=arrangeCanvas.current;if(!canvas)return;const dpr=canvasDPR;canvas.width=Math.ceil(size.width*dpr);canvas.height=Math.ceil(size.height*dpr);
    const c=canvas.getContext('2d');if(!c)return;c.scale(dpr,dpr);
    c.strokeStyle='#087f7a';c.lineWidth=2;
    for(const item of selectedItems){if(!intersects(item,world))continue;const p=position(item);c.strokeRect(p.left,p.top,p.width,p.height);}
    if(movePreview){const ids=new Set(movePreview.ids);let labels=0;c.strokeStyle='#075d77';c.fillStyle='#075d7710';c.setLineDash([6,4]);
      for(const item of selectedItems){if(!ids.has(item.id))continue;const next={...item,x:item.x+movePreview.dx,y:item.y+movePreview.dy};if(!intersects(next,world))continue;const p=position(next);c.fillRect(p.left,p.top,p.width,p.height);c.strokeRect(p.left,p.top,p.width,p.height);if(labels++<12){c.save();c.setLineDash([]);c.fillStyle='#075d77';c.font='12px system-ui';c.fillText((item.title||item.kind).slice(0,40),p.left+7,p.top+17);c.restore();}}
    }
  },[selectedItems,movePreview,camera,size,world,canvasDPR,displayScale]);

  if (!valid) return <p className="inline-error">{tr(language, 'invalidBoard')}</p>;
  const clampLibrary=(point:Point,config:LibraryConfig):Rect=>({x:Math.max(0,Math.min(board.canvasWidth-config.width,point.x)),y:Math.max(0,Math.min(board.canvasHeight-config.height,point.y)),width:config.width,height:config.height});
  const beginLibrary=(config:LibraryConfig,currentView:boolean)=>{cancelGesture();setContext(null);textSelection.clear();translation.disable();chooseSelection([]);setTool('read');setLibraryDialog(null);setLibraryPlacement({groupID:crypto.randomUUID(),config,rect:clampLibrary({x:cameraRef.current.x-config.width/2,y:cameraRef.current.y-config.height/2},config),fixed:currentView,raw});stage.current?.focus({preventScroll:true});};
  const previewPrintFrame=libraryPlacement?.config.addPrintFrame?libraryPrintFrame(libraryPlacement.rect):null;
  const placementFits=!previewPrintFrame||previewPrintFrame.x>=0&&previewPrintFrame.y>=0&&previewPrintFrame.x+previewPrintFrame.width<=board.canvasWidth&&previewPrintFrame.y+previewPrintFrame.height<=board.canvasHeight;
  const exportLibraryFrame=async(group:BoardLibraryGroup)=>{if(!boardPath||!boardSHA||mutationBlocked||childSessionsBusy())throw Error(zh?'请先完成白板操作后再导出。':'Finish board operations before exporting.');const frame=(Array.isArray(raw.printFrames)?raw.printFrames:[]).find(f=>group.printFrameIDs.includes(String(f.id)));if(!frame||![frame.x,frame.y,frame.width,frame.height].every(Number.isFinite))throw Error('Print frame unavailable');const owner=identity,sourceRaw=raw,abort=new AbortController();libraryExportAbort.current=abort;setLibraryExporting(true);try{const r=await window.desktop.readFile({vaultId,path:boardPath});if(!r.ok)throw Error(r.error.message);if(r.value.sha256!==boardSHA||JSON.stringify(r.value.board)!==JSON.stringify(sourceRaw)||live.current.identity!==owner||live.current.raw!==sourceRaw)throw Error(zh?'请保存并核对白板后重试，未导出旧版本。':'Save and review this board before export; an outdated version was not exported.');const sheet=await boardExportSheet(r.value,vaultId,abort.signal,text=>{if(mounted.current)setOperationStatus(text);},{x:frame.x,y:frame.y,width:frame.width,height:frame.height});await printExportSheets([sheet],'Library-'+group.presetID+'-print-frame',abort.signal,undefined,{vaultId,path:boardPath,expectedSHA256:boardSHA});if(mounted.current&&live.current.identity===owner)setOperationStatus(zh?'打印框导出流程已结束，素材组保留。':'Print-frame export finished; the group was kept.');}finally{if(libraryExportAbort.current===abort)libraryExportAbort.current=null;if(mounted.current)setLibraryExporting(false);}};
  return <div ref={viewerRoot} className={`board-reader board-viewer ${compactTools?'compact-tools':''} ${embedded?'board-embedded-viewer':''} ${inlineReplay?'is-replay-mode':''}`}  data-child-session-version={childVersion}>
    <div className="subtoolbar board-viewer-toolbar">
      <Button data-testid="board-directory-toggle" disabled={!!inlineReplay} aria-expanded={showList} onClick={openDirectory}><List />{zh?'定位资料':'Find sources'}</Button>
      <Button data-testid="board-last-ink" disabled={locatingInk||!!inlineReplay} onClick={()=>void locateLastInk()}><LocateFixed/>{locatingInk?(zh?'正在定位…':'Locating…'):(zh?'最后一笔':'Last ink')}</Button>
      <Button data-testid="board-overview" disabled={!!inlineReplay} onClick={overview}><Crosshair />{tr(language, 'fit')}</Button>
      <Button data-testid="board-saved-view" disabled={!!inlineReplay||!validCamera(board.viewport)} onClick={() => validCamera(board.viewport) && manualCamera({ ...board.viewport, zoom: clampZoom(board.viewport.zoom) })}>{zh ? '原生视口' : 'Saved view'}</Button>
      {onBoardOperation&&<Button data-testid="board-library-open" disabled={mutationBlocked||!!inlineReplay||!!mergePlacement||!!libraryPlacement||childSessionsBusy()} onClick={()=>setLibraryDialog({raw})}>{zh?'素材库':'Library'}</Button>}
      {onCreateRegionCard&&!embedded&&<Button data-testid="board-region-card" disabled={regionStarting||mutationBlocked||!!inlineReplay||childSessionsBusy()||!!libraryPlacement||!!libraryDialog} onClick={()=>{const id=identity;setRegionStarting(true);void(async()=>{try{await onPrepareRegionCard?.();await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));if(!mounted.current||live.current.identity!==id)return;cancelGesture();setContext(null);textSelection.clear();translation.disable();chooseSelection([]);setTool('read');setRegionCanvasID(crypto.randomUUID());setRegionSelecting(true);}catch(e){if(mounted.current)setOperationStatus(e instanceof Error?e.message:String(e));}finally{if(mounted.current)setRegionStarting(false);}})();}}>{zh?'框选区域制卡':'Region to card'}</Button>}
      {onBoardOperation&&<Button data-testid="board-paper" disabled={!!libraryPlacement||!!libraryDialog||mutationBlocked||!!inlineReplay||childSessionsBusy()} onClick={()=>setPaperDialog({raw})}>{zh?'纸张与网格':'Paper & grid'}</Button>}
      {onAddChildBoard&&<Button disabled={!!libraryPlacement||!!libraryDialog||mutationBlocked||childSessionsBusy()} data-testid="board-add-child" onClick={()=>onAddChildBoard({x:camera.x,y:camera.y})}><Layers/>{zh?'添加子白板':'Add child board'}</Button>}
      {children.length>0&&onBoardOperation&&<><Button data-testid="board-expand-all-children" disabled={mutationBlocked||childLoading||childSessionsBusy()} onClick={()=>void expandChildren(children,true)}><ChevronsDown/>{zh?'展开全部子白板':'Expand all children'}</Button>{expandedChildren.length>0&&<Button data-testid="board-collapse-all-children" disabled={mutationBlocked||childSessionsBusy()} onClick={collapseChildren}><ChevronsUp/>{zh?'收起全部':'Collapse all'}</Button>}</>}
      {onAddNote && <Button disabled={!!libraryPlacement||!!libraryDialog||mutationBlocked} data-testid="board-add-note" onClick={() => onAddNote({ x: camera.x, y: camera.y })}><Type />{zh ? '添加文字' : 'Add text'}</Button>}
      {onPasteContent&&<><select aria-label={zh?'粘贴文字格式':'Pasted text format'} title={zh?'只影响源码文字；文件和图片按原类型粘贴':'Applies to text only; files and images keep their type'} value={pasteFormat} disabled={!!libraryPlacement||!!libraryDialog||mutationBlocked} onChange={event=>setPasteFormat(event.target.value as BoardTextFormat)}><option value="richText">{zh?'文字 / 富文本':'Text / rich text'}</option><option value="markdown">Markdown</option><option value="latex">LaTeX</option><option value="python">Python</option></select><Button disabled={!!libraryPlacement||!!libraryDialog||mutationBlocked||childSessionsBusy()} data-testid="board-paste" title={zh?'粘贴剪贴板里的文件、文字、表格或图片（⌘V）':'Paste clipboard files, text, tables or images (⌘V)'} onClick={()=>void pasteClipboard()}><ClipboardPaste/>{zh?'粘贴':'Paste'}</Button></>}
      {onPasteContent&&<Button disabled={!!libraryPlacement||!!libraryDialog||mutationBlocked} data-testid="board-add-web" onClick={()=>editWeb()}>{zh?'添加网页':'Add web page'}</Button>}
      {onAddFile && <Button disabled={!!libraryPlacement||!!libraryDialog||mutationBlocked} data-testid="board-add-file" onClick={() => onAddFile({ x: camera.x, y: camera.y })}><FolderPlus />{zh ? '添加资料' : 'Add file'}</Button>}
      {compactTools&&onBoardOperation&&<select className="board-compact-mode" aria-label={zh?'白板模式':'Board mode'} value={inlineReplay?'replay':tool} disabled={disabled||operationBusy||pending} onChange={event=>event.target.value==='replay'?startReplay():changeTool(event.target.value as BoardTool)}><option value="read">{zh?'阅读':'Read'}</option><option value="arrange">{zh?'管理移动':'Arrange'}</option><option value="place">{zh?'放置资料':'Place file'}</option><option value="frameInk">{zh?'框成节点':'Frame ink'}</option><option value="replay">{zh?'回放':'Replay'}</option></select>}
      <Button data-testid="board-tools-collapse" aria-expanded={!compactTools} onClick={()=>setCompactTools(value=>{localStorage.setItem('inkspace.board.compactTools',String(!value));return !value;})}>{compactTools?<ChevronsDown/>:<ChevronsUp/>}{compactTools?(zh?'展开工具':'Expand tools'):(zh?'收起工具':'Collapse tools')}</Button>
      {onUndo&&<Button data-testid="board-undo" aria-label={zh?'撤销':'Undo'} disabled={mutationBlocked||!canUndo} onClick={()=>void onUndo().catch(e=>setOperationStatus(e.message))}><Undo2/></Button>}{onRedo&&<Button data-testid="board-redo" aria-label={zh?'重做':'Redo'} disabled={mutationBlocked||!canRedo} onClick={()=>void onRedo().catch(e=>setOperationStatus(e.message))}><Redo2/></Button>}
      {!inlineReplay&&textSelection.control}{!inlineReplay&&translation.controls}<span className="spacer" />
      <Button disabled={!!inlineReplay} onClick={() => manualCamera({ ...camera, zoom: clampZoom(camera.zoom / 1.3) })} aria-label={tr(language, 'zoomOut')}><Minus /></Button>
      <span className="board-zoom" data-testid="board-zoom">{(camera.zoom * 100).toFixed(camera.zoom < .01 ? 2 : 0)}%</span>
      <Button disabled={!!inlineReplay} onClick={() => manualCamera({ ...camera, zoom: clampZoom(camera.zoom * 1.3) })} aria-label={tr(language, 'zoomIn')}><Plus /></Button>
    </div>
    {translation.notice}
    {libraryPlacement&&<div className="board-library-placement-toolbar" data-testid="board-library-placement"><strong>{libraryPlacement.config.title}</strong><span>{zh?'点击选定位置 · 拖动平移 · 滚轮缩放 · Esc取消':'Click to fix position · drag to pan · wheel to zoom · Esc cancels'}</span>{(['x','y'] as const).map(k=><label key={k}>{k.toUpperCase()}<input data-testid={'board-library-position-'+k} type="number" value={Math.round(libraryPlacement.rect[k])} onChange={e=>{const v=Number(e.target.value);if(Number.isFinite(v))setLibraryPlacement({...libraryPlacement,rect:clampLibrary({...libraryPlacement.rect,[k]:v},libraryPlacement.config),fixed:true});}}/></label>)}{!placementFits&&<span role="status">{zh?'外接打印框超出白板，请移动位置。':'The enclosing print frame exceeds the board; move the position.'}</span>}<Button data-testid="board-library-place-confirm" disabled={mutationBlocked||!libraryPlacement.fixed||!placementFits} onClick={()=>{const placement=libraryPlacement;void submitOperation({type:'insertLibrary',groupID:placement.groupID,presetID:placement.config.presetID,title:placement.config.title,colors:placement.config.colors,rect:placement.rect,addPin:placement.config.addPin,addPrintFrame:placement.config.addPrintFrame}).then(ok=>{if(ok){setLibraryPlacement(null);setTool('arrange');}});}}>{zh?'放置到这里（一次）':'Place here once'}</Button><Button disabled={mutationBlocked} onClick={()=>setLibraryPlacement({...libraryPlacement,fixed:false})}>{zh?'重新选位置':'Choose again'}</Button><Button data-testid="board-library-place-cancel" disabled={mutationBlocked} onClick={()=>setLibraryPlacement(null)}>{zh?'取消':'Cancel'}</Button></div>}
    {onBoardOperation&&<BoardArrangeToolbar language={language} tool={tool} onTool={changeTool} replayActive={!!inlineReplay} onReplay={startReplay} selectedCount={inlineReplay?0:selected.length} busy={disabled||operationBusy||pending} canPlace={!!onAddFile} canExpand={!!sourceCard?.sourcePath?.toLowerCase().endsWith('.pdf')} canCollapse={!!sourceCard&&sourceExpanded} canUnpack={canUnpack}
      onClear={()=>chooseSelection([])} onConnect={()=>void submitOperation({type:'connect',ids:selected})} onUnpack={()=>void submitOperation({type:'unpackInk',ids:selected})}
      onExpand={()=>{if(sourceCard){dialogRaw.current=raw;setDirection('vertical');setScale(1);setColumns(2);setExpansionID(sourceCard.id);}}}
      onCollapse={()=>{if(sourceCard)void submitOperation({type:'collapseDocument',id:sourceCard.id});}}/>}
    {onBoardOperation&&!inlineReplay&&tool==='arrange'&&selectedItems.length===1&&!selectedLibraryGroup&&<div className="board-selected-actions"><span>{selectedItems[0].title.slice(0,45)}</span><Button disabled={mutationBlocked} data-testid="board-set-size" onClick={()=>{const item=selectedItems[0];dialogRaw.current=raw;setSizeEditor({id:item.id,width:item.width,height:item.height});}}>{zh?'调整大小':'Resize'}</Button>{onChildBoards&&<Button data-testid="board-child-boards" disabled={mutationBlocked} onClick={()=>onChildBoards(selectedItems[0].id)}><Layers/>{zh?'子白板':'Child boards'}</Button>}<Button data-testid="board-remove-selected" disabled={mutationBlocked} onClick={()=>void submitOperation({type:'remove',ids:selected})}><Trash2/>{zh?'移除卡片':'Remove card'}</Button></div>}
    {selectedLibraryGroup&&tool==='arrange'&&!libraryPlacement&&<div className="board-library-group-actions" data-testid="board-library-selected-group"><strong>{zh?'素材整组':'Library group'}</strong><span>{selectedLibraryGroup.itemIDs.length} {zh?'项 · 拖动或四角缩放':'members · drag or resize corners'}</span><Button data-testid="board-library-remove-group" disabled={mutationBlocked} onClick={()=>void submitOperation({type:'removeLibrary',groupID:selectedLibraryGroup.groupID})}>{zh?'移除整组':'Remove group'}</Button>{selectedLibraryGroup.printFrameIDs.length>0&&<Button disabled={mutationBlocked} onClick={()=>void exportLibraryFrame(selectedLibraryGroup).catch(e=>setOperationStatus(e instanceof Error?e.message:String(e)))}>{zh?'导出打印框':'Export print frame'}</Button>}</div>}
    {onBoardOperation&&!inlineReplay&&tool==='arrange'&&selectedItems.length>1&&<div className="board-selected-actions"><span>{selectedItems.length} {zh?'项已选':'selected'}</span><Button disabled={mutationBlocked} onClick={()=>void submitOperation({type:'remove',ids:selected})}><Trash2/>{zh?'移除所选卡片':'Remove selected cards'}</Button></div>}
    {onBoardOperation&&<div className={`board-arrange-feedback ${operationStatus?'has-status':''}`} role="status" data-testid="board-operation-status">{operationStatus||(tool==='arrange'?(zh?'点击选择 · 双击文字编辑 · Shift 点击多选 · Shift 拖动空白框选 · 拖对象后松开保存 · 方向键微调 · 空格拖动平移':'Click to select · Double-click text to edit · Shift-click to add · Shift-drag blank space to select · Release an object drag to save · Arrow keys nudge · Space-drag pans'):tool==='place'?(zh?'点击画布上的准确位置，再选择要放置的资料。':'Click the exact canvas position, then choose a file.'):tool==='frameInk'?(zh?'拖出矩形，将范围内的原始笔迹整理成可连接的节点。':'Drag a rectangle to organize original ink into a connectable node.'):(zh?'阅读模式；原文件与白板对象保持各自保存。':'Read mode; source files and board objects retain their own storage.'))}</div>}
    {navigationStatus&&<div className="board-navigation-status" role="status" data-testid="board-navigation-status">{navigationStatus}</div>}
    <div className="board-viewer-status"><strong title={board.title}>{board.title || (zh ? '白板' : 'Board')}</strong><span data-testid="board-object-count">{items.length} {zh ? '个对象' : 'objects'} · {board.edges.length} {zh ? '条连线' : 'edges'} · {strokes.length} {zh ? '笔手写' : 'ink strokes'} · {pins.length} {zh ? '个定位' : 'pins'}</span>{updated && <time dateTime={board.updatedAt}>{zh ? '保存于 ' : 'Saved '}{updated}</time>}</div>
    {visible.some(item=>item.kind==='pdfPage')&&<div className="board-preview-status" role="status" data-testid="board-preview-status">{previewStats.failed>0?(zh?'部分页面预览暂时无法读取；可打开原文件检查。':'Some page previews could not be read. Open the source to check.'):(previewStats.queued>0||previewStats.active>0)?(zh?`正在逐步显示页面轮廓 · ${lowResolution.length} 页`:`Loading page outlines · ${lowResolution.length} pages`):(lowResolution.length>0?(zh?'缩小保留页面轮廓，放大查看清晰细节。':'Page outlines stay visible when zoomed out. Zoom in for clear details.'):(zh?'页面当前小于可辨像素，请稍微放大查看内容轮廓。':'These pages are smaller than distinguishable pixels. Zoom in slightly for content outlines.'))}</div>}
    <div className={'board-body'+(inlineReplay?' is-replaying':'')}>
      {inlineReplay&&<div className="board-inline-replay"><InkReplayDialog board={inlineReplay.board} vaultId={vaultId} language={language} embedded initialCamera={inlineReplay.camera} onClose={()=>setInlineReplay(null)}/></div>}
      {showList && <nav inert={!!inlineReplay||undefined} aria-hidden={!!inlineReplay||undefined} className="board-directory" aria-label={zh ? '白板目录与定位' : 'Board directory and pins'}>
        <div className="board-directory-heading"><strong>{zh?'定位资料':'Find sources'}</strong><Button aria-label={zh?'关闭资料目录':'Close source directory'} onClick={()=>setShowList(false)}><X/></Button></div>
        <label className="board-directory-filter"><input type="checkbox" checked={sourcesOnly} onChange={event=>{setSourcesOnly(event.target.checked);setPage(0);}}/>{zh?'只看资料':'Sources only'}</label>
        <input ref={searchInput} data-testid="board-directory-search" aria-label={tr(language, 'search')} placeholder={zh ? '搜索标题、文件路径或页码' : 'Search title, source path or page'} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        <div className="board-directory-count">{results.total} {zh ? '项' : 'results'}</div>
        {results.entries.map(entry => <article className="board-directory-entry" key={`${entry.type}:${entry.value.id}`} data-board-directory-id={entry.value.id} data-arrange-selected={entry.type==='item'&&selected.includes(entry.value.id)}>
          <button className="board-locate" onClick={event => {if(entry.type==='pin')locatePin(entry.value);else{if(onBoardOperation&&tool==='arrange'&&!mutationBlocked){const id=entry.value.id;chooseSelection(event.shiftKey?(selected.includes(id)?selected.filter(value=>value!==id):[...selected,id]):[id]);}locate(entry.value);}}}>{entry.type === 'pin' && <MapPin />}<span>{entry.value.title || (entry.type === 'item' ? entry.value.kind : zh ? '定位' : 'Pin')}{entry.type === 'item' && entry.value.page ? ` · ${entry.value.page}` : ''}</span></button>
          {entry.type === 'item' && <>
            {(entry.value.originalSourcePath || entry.value.sourcePath) && <small className="board-source-path" title={entry.value.originalSourcePath || entry.value.sourcePath}>{entry.value.originalSourcePath || entry.value.sourcePath}</small>}
            <div className="board-source-actions">{itemSourceTargets(entry.value).map(target => <button key={target.kind} data-source-kind={target.kind} title={target.path} onClick={() => openItemSource(entry.value,target.path, target.page)}><FileText />{sourceLabel(target.kind)}</button>)}
              {onBoardOperation&&boardPath&&boardSHA&&(['sourcePath','originalSourcePath'] as const).filter(field=>safeBoardSource(entry.value[field])).map(field=><button key={'relink-'+field} disabled={mutationBlocked} data-testid={`board-relink-${entry.value.id}-${field}`} onClick={()=>setRelink({id:entry.value.id,field,oldPath:entry.value[field]!,raw})}>{field==='originalSourcePath'?(zh?'重新关联原件':'Relink original'):(zh?'重新关联资料':'Relink source')}</button>)}
              {onEditItem && ['text', 'formula'].includes(entry.value.kind) && <button disabled={mutationBlocked} data-testid={`board-edit-item-${entry.value.id}`} onClick={() => editBoardItem(entry.value)}><Pencil />{zh ? '编辑文字' : 'Edit text'}</button>}
            </div>
          </>}
        </article>)}
        {!results.total && <p className="muted">{zh ? '没有匹配的项目' : 'No matching items'}</p>}
        <div className="board-pages"><Button disabled={results.page === 0} onClick={() => setPage(results.page - 1)}>{tr(language, 'previous')}</Button><span>{results.page + 1}/{results.pageCount}</span><Button disabled={results.page >= results.pageCount - 1} onClick={() => setPage(results.page + 1)}>{tr(language, 'next')}</Button></div>
      </nav>}
      <div inert={!!inlineReplay||undefined} aria-hidden={!!inlineReplay||undefined} className={`board-stage board-tool-${onBoardOperation?tool:'read'}`} style={paperScreenStyle(raw.background,camera,size)} data-board-tool={onBoardOperation?tool:'read'} data-selected-ids={JSON.stringify(selected)} aria-busy={pending||operationBusy} ref={stage} tabIndex={0} aria-label={tr(language, 'boardObjects')} data-testid="board-stage" data-region-canvas-id={regionCanvasID||undefined} data-board-camera={JSON.stringify(camera)} data-camera-x={camera.x} data-camera-y={camera.y} data-camera-zoom={camera.zoom}
        onPointerDownCapture={textSelection.captureDown} onPointerMoveCapture={textSelection.captureMove} onPointerUpCapture={textSelection.cancelPress} onPointerCancelCapture={textSelection.cancelPress}
        onPaste={event=>{
          const target=event.target as HTMLElement;
          if(!onPasteContent||target.closest('.board-stage')!==event.currentTarget||target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),video,audio'))return;
          event.preventDefault();event.stopPropagation();
          // Use one native snapshot so Finder files and image representations win
          // over incidental filenames, URLs and HTML supplied by the browser event.
          void pasteClipboard();
        }}
        onKeyDown={event => {
          if(event.target!==event.currentTarget||event.altKey)return;
          if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='v'&&onPasteContent){event.preventDefault();event.stopPropagation();void pasteClipboard();return;}
          if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){
            const action=event.shiftKey?onRedo:onUndo,enabled=event.shiftKey?canRedo:canUndo;
            if(action){event.preventDefault();event.stopPropagation();if(enabled&&!mutationBlocked&&!childSessionsBusy())void action().catch(e=>setOperationStatus(e instanceof Error?e.message:String(e)));}return;
          }
          if(event.ctrlKey||event.metaKey)return;
          if(['Delete','Backspace'].includes(event.key)&&tool==='arrange'&&selected.length){event.preventDefault();void submitOperation({type:'remove',ids:selected});return;}if(event.key==='Escape'){event.preventDefault();textSelection.clear();cancelGesture();setContext(null);if(!mutationBlocked){setFrameDraft(null);setExpansionID(null);if(tool!=='read')changeTool('read');else chooseSelection([]);}return;}
          if(event.code==='Space'){event.preventDefault();spaceDown.current=true;return;}
          if(onBoardOperation&&tool==='arrange'&&selected.length&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
            event.preventDefault();if(!mutationBlocked){const step=event.shiftKey?10:1;void submitOperation({type:'move',ids:selected,dx:event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy:event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0});}return;
          }
          const next=keyboardBoard(camera,size,event.key,event.shiftKey);if(next){event.preventDefault();cancelGesture();manualCamera(next);setContext(null);}
        }}
        onKeyUp={event=>{if(event.code==='Space')spaceDown.current=false;}}
        onBlur={()=>{spaceDown.current=false;}}
        onDragOver={event=>{if(onDropFiles&&!mutationBlocked&&event.dataTransfer.types.includes(VAULT_DRAG_TYPE)){event.preventDefault();event.dataTransfer.dropEffect='copy';}}}
        onDrop={event=>{if(libraryPlacement||libraryDialog||!onDropFiles||mutationBlocked)return;event.preventDefault();event.stopPropagation();const data=decodeVaultDrag(event.dataTransfer.getData(VAULT_DRAG_TYPE),vaultId);if(!data)return;const bounds=event.currentTarget.getBoundingClientRect();const point=boardWorldPoint(cameraRef.current,size,{x:(event.clientX-bounds.left)/displayScale,y:(event.clientY-bounds.top)/displayScale});void onDropFiles(data.paths,point).catch(e=>setOperationStatus(e instanceof Error?e.message:String(e)));}}
        onPointerDown={event=>{
          if(![0,1].includes(event.button)||event.ctrlKey||(event.target as HTMLElement).closest('.board-stage')!==event.currentTarget||(event.target as HTMLElement).closest('button,input,select,textarea,[contenteditable]:not([contenteditable=\"false\"]),summary,a,video,audio,.legacy-preview'))return;
          event.currentTarget.focus({preventScroll:true});setContext(null);
          const bounds=event.currentTarget.getBoundingClientRect(),screen={x:event.clientX,y:event.clientY};
          const point=boardWorldPoint(cameraRef.current,size,{x:(event.clientX-bounds.left)/displayScale,y:(event.clientY-bounds.top)/displayScale});
          pastePoint.current=point;
          const mode=onBoardOperation?tool:'read';let kind:Gesture['kind']='pan',ids:string[]=[];
          if(!libraryPlacement&&!spaceDown.current&&event.button!==1&&mode!=='read'){
            if(mutationBlocked)return;
            if(mode==='frameInk')kind='frameInk';else if(mode==='place')kind='place';else{
              const hit=hitBoardItem(hitItems,point);
              if(hit){const included=selectionRef.current.includes(hit.id);ids=event.shiftKey?(included?selectionRef.current.filter(id=>id!==hit.id):[...selectionRef.current,hit.id]):included?selectionRef.current:[hit.id];ids=[...new Set(ids.flatMap(id=>libraryByItem.get(id.toLowerCase())?.itemIDs||[id]))];chooseSelection(ids);kind=event.shiftKey&&included?'none':'move';}
              else if(event.shiftKey){kind='select';ids=[...selectionRef.current];}else{chooseSelection([]);kind='pan';}
            }
          }
          event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
          drag.current={kind,pointerId:event.pointerId,screen,world:point,camera:cameraRef.current,ids,raw,moved:false};
        }}
        onPointerMove={event=>{
          const start=drag.current;if(!start){if(libraryPlacement&&!libraryPlacement.fixed){const r=event.currentTarget.getBoundingClientRect(),point=boardWorldPoint(cameraRef.current,size,{x:(event.clientX-r.left)/displayScale,y:(event.clientY-r.top)/displayScale});setLibraryPlacement({...libraryPlacement,rect:clampLibrary(point,libraryPlacement.config)});}if(mergePlacement&&!mergePlacement.fixed){const rect=event.currentTarget.getBoundingClientRect();const world=boardWorldPoint(cameraRef.current,size,{x:(event.clientX-rect.left)/displayScale,y:(event.clientY-rect.top)/displayScale});mergePlacement.onPositionChange(clampMergePosition(world,mergePlacement.sourceBounds));}return;}if(start.pointerId!==event.pointerId)return;
          const dx=(event.clientX-start.screen.x)/start.camera.zoom/displayScale,dy=(event.clientY-start.screen.y)/start.camera.zoom/displayScale;
          if(Math.hypot(event.clientX-start.screen.x,event.clientY-start.screen.y)>3)start.moved=true;
          if(start.kind==='pan'&&start.moved)manualCamera({...start.camera,x:start.camera.x-dx,y:start.camera.y-dy});
          else if((start.kind==='resize'||start.kind==='libraryResize')&&start.moved)setResizePreview(resizeRect(start,dx,dy,event.shiftKey||start.proportional));
          else if(start.kind==='move'&&start.moved)setMovePreview({ids:start.ids,dx,dy});
          else if(start.kind==='select'||start.kind==='frameInk')setGestureRect(rectangleBetween(start.world,{x:start.world.x+dx,y:start.world.y+dy}));
        }}
        onPointerUp={event=>{
          const start=drag.current;if(!start||start.pointerId!==event.pointerId)return;drag.current=null;
          if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
          const dx=(event.clientX-start.screen.x)/start.camera.zoom/displayScale,dy=(event.clientY-start.screen.y)/start.camera.zoom/displayScale;
          setMovePreview(null);setGestureRect(null);setResizePreview(null);
          if(libraryPlacement){if(!start.moved&&event.button===0&&!spaceDown.current&&start.raw===live.current.raw)setLibraryPlacement({...libraryPlacement,rect:clampLibrary(start.world,libraryPlacement.config),fixed:true});return;}
          if(mergePlacement){if(!mergePlacement.fixed&&!start.moved&&event.button===0&&!spaceDown.current&&start.raw===live.current.raw)mergePlacement.onPlace(clampMergePosition(start.world,mergePlacement.sourceBounds));return;}
          if(start.raw!==live.current.raw||live.current.identity!==identity||live.current.blocked){if(start.kind!=='pan')setOperationStatus(zh?'白板或操作状态已改变，请重试。':'The board or operation state changed. Try again.');return;}
          if(start.kind==='libraryResize'&&start.moved&&start.groupID)void submitOperation({type:'transformLibrary',groupID:start.groupID,rect:resizeRect(start,dx,dy,event.shiftKey||start.proportional)});
          else if(start.kind==='resize'&&start.moved&&start.ids.length)void submitOperation({type:'patchItems',items:[{id:start.ids[0],...resizeRect(start,dx,dy,event.shiftKey)}]});
          else if(start.kind==='move'&&start.moved&&start.ids.length)void submitOperation({type:'move',ids:start.ids,dx,dy});
          else if(start.kind==='select'&&start.moved){const rect=rectangleBetween(start.world,{x:start.world.x+dx,y:start.world.y+dy});chooseSelection([...new Set([...start.ids,...itemsWithin(items,rect)])]);}
          else if(start.kind==='frameInk'&&start.moved&&Math.abs(dx*start.camera.zoom)>=6&&Math.abs(dy*start.camera.zoom)>=6){dialogRaw.current=raw;setFrameTitle(zh?'手写节点':'Ink node');setFrameDraft(rectangleBetween(start.world,{x:start.world.x+dx,y:start.world.y+dy}));}
          else if(start.kind==='place'&&!start.moved&&onAddFile){changeTool('arrange');onAddFile(start.world);}
        }}
        onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}
        onDoubleClick={event => {
          if(textSelection.active)return;
          if (libraryPlacement||(onBoardOperation&&!['read','arrange'].includes(tool))||mutationBlocked||(event.target as HTMLElement).closest('.board-stage')!==event.currentTarget||(event.target as HTMLElement).closest('button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),summary,a,.legacy-preview')) return;
          cancelGesture();
          const rect = event.currentTarget.getBoundingClientRect(), point = boardWorldPoint(camera, size, { x: (event.clientX - rect.left)/displayScale, y: (event.clientY - rect.top)/displayScale });
          const item = [...visible].reverse().find(item => intersects(item, { ...point, width: 0, height: 0 })); if (item) { if (onEditItem && ['text', 'formula'].includes(item.kind) && (!onBoardOperation || tool === 'arrange')) editBoardItem(item); else if(onBoardOperation&&tool==='arrange'&&point.y<=item.y+Math.min(item.height,40/camera.zoom)){dialogRaw.current=raw;chooseSelection([item.id]);setTitleEditor({id:item.id,title:item.title});}else if(item.childBoards?.length){const entry=children.find(e=>e.itemID===item.id);if(entry){if(onBoardOperation)void expandChildren([entry]);else openSource(entry.link.path);}}else defaultOpen(item); }
        }}
        onContextMenu={event => {
          if(mergePlacement){event.preventDefault();return;}
          const target=event.target as HTMLElement;
          if(target.closest('.board-native-text-active,.board-ocr-text,.board-text-actions'))return;
          // Native text/video menus keep their editing and playback actions. A child
          // viewer owns its event even when React portals place its menu in <body>.
          if(target.closest('.board-stage')!==event.currentTarget||target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),video,audio,button,summary,a,.legacy-preview'))return;
          event.preventDefault();event.stopPropagation();cancelGesture();spaceDown.current=false;
          const rect=event.currentTarget.getBoundingClientRect(),screen={x:(event.clientX-rect.left)/displayScale,y:(event.clientY-rect.top)/displayScale};
          const world=boardWorldPoint(cameraRef.current,size,screen),hit=hitBoardItem(hitItems,world);
          if(hit&&!selectionRef.current.some(id=>id.toLowerCase()===hit.id.toLowerCase()))chooseSelection([hit.id]);
          stage.current?.focus({preventScroll:true});
          setContext({screen:{x:event.clientX,y:event.clientY},world,itemID:hit?.id,raw,identity});
        }}>
        {regionSelecting&&regionCanvasID&&<BoardRegionSelection language={language} onCancel={()=>{setRegionSelecting(false);setRegionCanvasID(null);}} onSelect={r=>{const element=stage.current;if(!element||!onCreateRegionCard)return;const bounds=element.getBoundingClientRect(),canvasID=regionCanvasID,a=boardWorldPoint(cameraRef.current,size,{x:r.x,y:r.y}),b=boardWorldPoint(cameraRef.current,size,{x:r.x+r.width,y:r.y+r.height}),rect={x:a.x,y:a.y,width:b.x-a.x,height:b.y-a.y},screenRect={x:Math.round(bounds.left+r.x),y:Math.round(bounds.top+r.y),width:Math.round(r.width),height:Math.round(r.height)};setRegionSelecting(false);void(async()=>{try{await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));if(!mounted.current||stage.current?.getAttribute('data-region-canvas-id')!==canvasID)return;await onCreateRegionCard({rect,screenRect,canvasID});}catch(e){if(mounted.current)setOperationStatus(e instanceof Error?e.message:String(e));}})();}}/>}
        <canvas ref={skeleton} className="board-skeleton" data-testid="board-page-previews" data-preview-stats={JSON.stringify(previewStats)} data-painted-count={lowResolution.length} data-matched-count={lowPainted.size} aria-hidden="true" />
        <svg className="board-edges" width={size.width} height={size.height}><defs><marker id="board-edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill="context-stroke" /></marker></defs>{board.edges.slice(0, 10000).map((edge, index) => {
          const a = itemByID.get(edge.from.toLowerCase()), b = itemByID.get(edge.to.toLowerCase()); if (!a || !b) return null;
          const dx = b.x + b.width / 2 - a.x - a.width / 2, dy = b.y + b.height / 2 - a.y - a.height / 2;
          const endpoint = (item: Item, sign: number) => { const scale = item.style?.shape === 'ellipse' ? 1 / Math.sqrt((dx / (item.width / 2)) ** 2 + (dy / (item.height / 2)) ** 2) : Math.min(Math.abs(item.width / (2 * dx)), Math.abs(item.height / (2 * dy))); const offset = Number.isFinite(scale) ? scale : 0; return position({ x: item.x + item.width / 2 + sign * dx * offset, y: item.y + item.height / 2 + sign * dy * offset, width: 0, height: 0 }); };
          const start = endpoint(a, 1), end = endpoint(b, -1);
          return <line key={index} x1={start.left} y1={start.top} x2={end.left} y2={end.top} stroke={safeColor(edge.style?.strokeColor, '#8bada8')} strokeWidth={Math.max(1, Math.min(12, edge.style?.strokeWidth || 1))} opacity={edge.style?.opacity??1} strokeDasharray={edge.style?.dash==='dashed'?'10 6':edge.style?.dash==='dotted'?'2 5':edge.style?.dash==='dashDot'?'10 5 2 5':undefined} markerStart={edge.style?.arrow === 'both' ? 'url(#board-edge-arrow)' : undefined} markerEnd={['both', 'end'].includes(edge.style?.arrow || '') ? 'url(#board-edge-arrow)' : undefined} />;
        })}</svg>
        {details.map(item => <div key={item.id} data-board-item={item.id} className={`board-item kind-${item.kind}${libraryByItem.has(item.id.toLowerCase())?' library-member-content':''}${item.boardNotesObject&&item.kind==='document'&&/\.(png|jpe?g)$/i.test(item.sourcePath||'')?' boardnotes-image':''}`} style={{ ...position(item), fontSize: Math.max(10, Math.min(72, (Number.isFinite(item.style?.fontSize) ? Math.max(8, Math.min(72, item.style!.fontSize!)) : 16) * camera.zoom)), backgroundColor: item.kind==='pdfPage'?'transparent':safeColor(item.style?.fillColor,item.kind==='inkGroup'?'transparent':'#ffffff'), color: safeColor(item.style?.textColor, '#233c36'), borderColor: safeColor(item.style?.strokeColor, '#cbd6d2'), borderWidth: Math.max(1, Math.min(8, item.style?.strokeWidth || 1)), borderRadius: item.style?.shape === 'ellipse' ? '50%' : item.style?.shape === 'rounded' ? 16 : undefined }}>
          {libraryByItem.has(item.id.toLowerCase())?<div className="board-library-content" data-testid="board-library-content">{item.text||item.title}</div>:isBoardWebCard(item) ? <BoardWebCard url={item.url||item.text||''} title={item.title} language={language} interactive={tool==='read'&&!inlineReplay} /> : item.kind === 'document' && safeBoardSource(item.sourcePath) && /\.(png|jpe?g)$/i.test(item.sourcePath!) ? <BoardImage item={item} assets={assets} language={language} onRelink={onBoardOperation&&boardPath&&boardSHA&&!mutationBlocked?()=>setRelink({id:item.id,field:'sourcePath',oldPath:item.sourcePath!,raw}):undefined}/> : item.kind === 'document' && safeBoardSource(item.sourcePath) && isVideoPath(item.sourcePath!) && (!onBoardOperation || tool === 'read') ? <LinkedBoardVideo vaultId={vaultId} item={item} assets={assets} language={language} onOpen={(path,playback)=>onOpen(path,undefined,playback)} /> : pdfIDs.has(item.id) && safeBoardSource(item.sourcePath) ? <BoardPDF item={item} onRelink={onBoardOperation&&boardPath&&boardSHA&&!mutationBlocked?()=>setRelink({id:item.id,field:'sourcePath',oldPath:item.sourcePath!,raw}):undefined} boardID={board.id} forceFilter={!!board.pdfMergedOwnerIDs?.length} assets={assets} language={language} region={pdfRegions.get(item.id)} declaration={declarations.get(item.sourcePath)} onPaint={paint} translation={tool==='read'&&translation.selection?{...translation.selection,overlayCanvases:()=>ink.current?[ink.current]:[]}:undefined} /> : item.kind !== 'inkGroup'&&item.kind!=='pdfPage' ? <><strong>{item.title}</strong>{item.kind === 'text' || item.kind === 'formula' ? internalClipboardPath(item.text||'')?<a href="#" onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.preventDefault();event.stopPropagation();onOpen(internalClipboardPath(item.text||'')!);}}>{item.text}</a>:<BoxContent onOpenWebLink={openWebLink} text={item.text || ''} textFormat={item.textFormat} richTextHTML={item.richTextHTML} fallbackKind={item.kind} /> : <p>{(item.text || item.originalSourcePath || item.sourcePath || '').slice(0, 10000)}</p>}</> : null}
        </div>)}
        {details.filter(item=>item.childBoards?.length).map(item=><div key={'children-'+item.id} className="board-child-card-actions" style={{left:position(item).left+8,top:position(item).top+Math.max(28,position(item).height-44),maxWidth:Math.max(120,position(item).width-16)}} onPointerDown={e=>e.stopPropagation()}>{children.filter(e=>e.itemID===item.id).map(entry=><div key={entry.link.id}><span title={entry.link.path}>{entry.link.title}</span><button data-testid="board-child-open" onClick={()=>openSource(entry.link.path)}>{zh?'打开':'Open'}</button>{onBoardOperation&&<button data-testid="board-child-expand" disabled={mutationBlocked||childLoading||childSessionsBusy()} onClick={()=>{if(entry.link.presentation?.expanded)void presentChild(entry.itemID,entry.link.id,{...entry.link.presentation,expanded:false});else void expandChildren([entry]);}}>{entry.link.presentation?.expanded?(zh?'收起':'Collapse'):(zh?'展开':'Expand')}</button>}</div>)}</div>)}
        {visibleChildEntries.filter(entry=>!liveChildKeys.has(entry.itemID+'\n'+entry.link.id)).map(entry=><div className="board-child-placeholder" key={'paused-'+entry.itemID+'-'+entry.link.id} style={position(entry.link.presentation!)}><strong>{entry.link.title}</strong><p>{childCanExpand(entry.link.path,ancestry)?(zh?'放大这块子白板即可继续查看和编辑。':'Zoom into this child board to read and edit.'):(zh?'递归链接在此停止；可完整打开原文件。':'This recursive link stops here; open the original board to continue.')}</p><Button onClick={()=>childCanExpand(entry.link.path,ancestry)?locate(entry.link.presentation!):openSource(entry.link.path)}>{zh?'查看子白板':'View child board'}</Button></div>)}
        {liveChildEntries.map(entry=>{const rect=entry.link.presentation!,offset=movePreview?.ids.includes(entry.itemID)?{dx:movePreview.dx,dy:movePreview.dy}:{dx:0,dy:0},p=position({...rect,x:rect.x+offset.dx,y:rect.y+offset.dy});return <ResolvedChildBoardPortal resolvePath={assets.resolve} key={entry.itemID+'-'+entry.link.id} entry={entry} presentation={rect} parentSize={size} vaultId={vaultId} language={language} left={p.left} top={p.top} scale={camera.zoom} displayScale={displayScale*camera.zoom} pdfPixelBudget={pdfBudgetShare} ancestors={ancestry} editable={!!onBoardOperation&&!disabled} onOpen={onOpen} onPresentation={value=>presentChild(entry.itemID,entry.link.id,value)} onBeforeChildMutation={onBeforeChildMutation} onChildSaved={onChildSaved}/>;})}
        <canvas ref={ink} className="board-ink" />
        {libraryPlacement&&<>{previewPrintFrame&&<div className="board-library-ghost" data-testid="board-library-frame-ghost" style={{...position(previewPrintFrame),borderColor:placementFits?'#b78d37':'#c44b36',opacity:.45}}/>}<div className={'board-library-ghost '+(libraryPlacement.fixed?'fixed':'')} data-testid="board-library-ghost" data-world-rect={JSON.stringify(libraryPlacement.rect)} style={position(libraryPlacement.rect)}><BoardLibraryPreview config={libraryPlacement.config}/><span>{libraryPlacement.fixed?(zh?'位置已选定，点击上方确认':'Position fixed; confirm above'):(zh?'点击画布选位置':'Click canvas to choose position')}</span></div></>}
        {mergePlacement&&<><div className="board-merge-placement-hit" aria-hidden="true"/><div className={`board-merge-ghost ${mergePlacement.fixed?'fixed':''}`} data-testid="merge-placement-ghost" data-world-rect={JSON.stringify({...mergePlacement.position,width:mergePlacement.sourceBounds.width,height:mergePlacement.sourceBounds.height})} style={position({...mergePlacement.position,width:mergePlacement.sourceBounds.width,height:mergePlacement.sourceBounds.height})}><BoardMergeGhost raw={mergePlacement.source} bounds={mergePlacement.sourceBounds}/><span>{zh?(mergePlacement.fixed?'已选定位置':'点击放置 · 拖动移动视图'):(mergePlacement.fixed?'Position selected':'Click to place · Drag to pan')}</span></div></>}
        {textSelection.overlay}{textSelection.actions}
        <div className="board-pin-layer">{pins.filter(pin => intersects({ ...pin, width: 0, height: 0 }, world)).slice(0, 200).map(pin => <button key={pin.id} className="board-pin" title={pin.title} aria-label={`${zh ? '定位' : 'Pin'}: ${pin.title}`} style={{ left: position({ ...pin, width: 0, height: 0 }).left, top: position({ ...pin, width: 0, height: 0 }).top }} onPointerDown={event => event.stopPropagation()} onClick={() => locatePin(pin)}><MapPin /></button>)}</div>
        <div className="review-overlay" data-testid="board-review-overlay">{matchingReviews.map(review => ({ review, rect: reviewRect(review, items) })).filter(({ rect }) => intersects(rect, world)).slice(0, 1000).map(({ review, rect }) => { const p = position(rect); return <ReviewMark key={review.id} review={review} rect={{ x: p.left, y: p.top, width: p.width, height: p.height }} selected={reviewFocus?.review.id === review.id} onSelect={() => onReview?.(review)} />; })}</div>
        {onBoardOperation&&<><canvas className="board-arrange-canvas" ref={arrangeCanvas} aria-hidden="true"/><svg className="board-arrange-overlay" width={size.width} height={size.height} aria-hidden="true">
          {(gestureRect||frameDraft)&&(()=>{const p=position((gestureRect||frameDraft)!);return <rect data-testid="board-world-selection" data-world-rect={JSON.stringify(gestureRect||frameDraft)} x={p.left} y={p.top} width={p.width} height={p.height} className="board-frame-outline"/>;})()}
        </svg></>}
        {!board.webInk && (previewURL ? <details open className="legacy-preview" data-testid="board-legacy-preview"><summary>{zh ? '旧版保存视口截图（局部）' : 'Legacy saved-view screenshot (partial)'}</summary><img src={previewURL} alt={zh ? '原生应用保存的局部手写预览，并非完整白板' : 'Partial handwriting preview saved by the native app, not the complete board'} /><p>{zh ? '此旧文件尚无完整手写预览数据；在原生应用保存后可更新。' : 'Full handwriting preview data is unavailable in this older file. Save it in the native app to update.'}</p></details> : <p className="legacy-warning">{tr(language, 'nativeInk')}</p>)}
        {selectedLibraryGroup&&tool==='arrange'&&!mutationBlocked&&!libraryPlacement&&(()=>{const r=resizePreview||selectedLibraryGroup.rect,p=position(r);return <div className="board-size-outline" data-testid="board-library-resize-outline" style={{left:p.left,top:p.top,width:p.width,height:p.height}}>{['nw','ne','sw','se'].map(corner=><button key={corner} className={'board-resize-handle handle-'+corner} data-testid={'board-library-resize-'+corner} aria-label={'Resize library '+corner} onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();cancelGesture();drag.current={kind:'libraryResize',pointerId:event.pointerId,screen:{x:event.clientX,y:event.clientY},world:{x:r.x,y:r.y},camera:cameraRef.current,ids:selectedLibraryGroup.itemIDs,groupID:selectedLibraryGroup.groupID,raw,moved:false,rect:selectedLibraryGroup.rect,corner,proportional:!!selectedLibraryGroup.printFrameIDs.length};stage.current?.setPointerCapture(event.pointerId);}}/>)}</div>;})()}
        {onBoardOperation&&!inlineReplay&&tool==='arrange'&&selectedItems.length===1&&!selectedLibraryGroup&&!mutationBlocked&&(()=>{const item=selectedItems[0],rect=resizePreview||item,p=position(rect);return <div className="board-size-outline" style={{left:p.left,top:p.top,width:p.width,height:p.height}} data-testid="board-resize-outline">{['nw','ne','sw','se'].map(corner=><button key={corner} className={'board-resize-handle handle-'+corner} aria-label={(zh?'调整大小 ':'Resize ')+corner} data-testid={'board-resize-'+corner} onPointerDown={event=>{if(event.button!==0||event.ctrlKey)return;event.preventDefault();event.stopPropagation();if(!stage.current)return;cancelGesture();drag.current={kind:'resize',pointerId:event.pointerId,screen:{x:event.clientX,y:event.clientY},world:{x:item.x,y:item.y},camera:cameraRef.current,ids:[item.id],raw,moved:false,rect:item,corner};stage.current.setPointerCapture(event.pointerId);}}/> )}</div>;})()}

      </div>
    </div>
    {webEditor&&<Modal title={webEditor.link?(zh?'打开链接':'Open link'):(zh?'白板网页':'Board web page')} closeOnBackdrop={false} onClose={()=>{if(!webSavingRef.current)setWebEditor(null);}}>
      <label className="form-label">{zh?'网址':'URL'}<input data-testid="board-web-url" disabled={webSaving} autoFocus type="url" value={webEditor.url} onChange={e=>setWebEditor({...webEditor,url:e.target.value})}/></label>
      <label className="form-label">{zh?'标题':'Title'}<input data-testid="board-web-title" disabled={webSaving} value={webEditor.title} onChange={e=>setWebEditor({...webEditor,title:e.target.value})}/></label>
      <p>{zh?'网页可以放在白板中浏览；整理模式下可拖动和调整大小。':'Browse the page on your board. Switch to Arrange to move or resize it.'}</p>
      {webError&&<p role="alert" className="inline-error">{webError}</p>}
      <div className="modal-actions"><Button disabled={webSaving||!boardWebURL(webEditor.url)} onClick={()=>{void window.desktop.openExternal({url:webEditor.url,application:'browser'}).then(result=>{if(result.ok)setWebEditor(null);else setWebError(result.error.message);}).catch(e=>setWebError(String(e)));}}>{zh?'内部浏览器':'In-app browser'}</Button>
      {onPasteContent&&<Button className="primary" data-testid="board-web-save" disabled={webSaving||mutationBlocked||!boardWebURL(webEditor.url)} onClick={()=>void saveWebCard()}>{webSaving?(zh?'正在保存…':'Saving…'):webEditor.id?(zh?'保存网页':'Save page'):(zh?'放入白板':'Place on board')}</Button>}</div>
    </Modal>}
    {paperDialog&&paperDialog.raw===raw&&<BoardPaperDialog current={raw.background} language={language} onClose={()=>setPaperDialog(null)} onApply={async background=>{if(live.current.raw!==paperDialog.raw||live.current.blocked)throw Error(zh?'白板已改变，请重新打开纸张设置。':'The board changed. Reopen paper settings.');if(!await submitOperation({type:'setBackground',background}))throw Error(zh?'背景尚未保存，请检查白板提示后重试。':'The background was not saved. Check the board status and retry.');}}/>}
    <ContextMenu menu={contextMenu} onClose={()=>setContext(null)}/>
    {relink&&boardPath&&boardSHA&&relink.raw===raw&&<BoardRelinkDialog vaultId={vaultId} boardPath={boardPath} boardSHA={boardSHA} id={relink.id} field={relink.field} oldPath={relink.oldPath} language={language} blocked={mutationBlocked} onConfirm={submitOperation} onClose={()=>setRelink(null)}/>}
    {libraryDialog&&<BoardLibraryDialog language={language} groups={libraryGroups} onClose={()=>setLibraryDialog(null)} onPlace={beginLibrary} onSelectGroup={g=>{changeTool('arrange');chooseSelection(g.itemIDs);locate(g.rect);}} onExportFrame={exportLibraryFrame}/>}
    {titleEditor&&<Modal closeOnBackdrop={false} title={zh?'编辑模块标题':'Edit card title'} onClose={()=>{setTitleEditor(null);dialogRaw.current=null;}}><p>{zh?'只修改白板上的标题；文件正文仍通过原有阅读和编辑入口打开。':'This changes the board title. Open the original file to edit its contents.'}</p><label className="form-label">{zh?'标题':'Title'}<input autoFocus maxLength={1000} value={titleEditor.title} onChange={event=>setTitleEditor({...titleEditor,title:event.target.value})} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setTitleEditor(null);dialogRaw.current=null;}}}/></label><div className="modal-actions"><Button onClick={()=>{setTitleEditor(null);dialogRaw.current=null;}}>{zh?'取消':'Cancel'}</Button><Button className="primary" disabled={mutationBlocked} onClick={()=>{const edit=titleEditor;setTitleEditor(null);dialogRaw.current=null;void submitOperation({type:'patchItems',items:[edit]});}}>{zh?'保存标题':'Save title'}</Button></div></Modal>}
    {sizeEditor&&<Modal title={zh?'调整模块大小':'Resize board object'} onClose={()=>{if(!mutationBlocked){setSizeEditor(null);dialogRaw.current=null;}}}><p>{zh?'拖动四个角可直接调整；按住 Shift 拖动保持比例。尺寸与白板一起保存。':'Drag any corner to resize; hold Shift to keep proportions. Size is saved with the board.'}</p><label className="form-label">{zh?'宽度':'Width'}<input type="number" min={40} max={board.canvasWidth} value={sizeEditor.width} onChange={e=>setSizeEditor({...sizeEditor,width:e.target.valueAsNumber})}/></label><label className="form-label">{zh?'高度':'Height'}<input type="number" min={40} max={board.canvasHeight} value={sizeEditor.height} onChange={e=>setSizeEditor({...sizeEditor,height:e.target.valueAsNumber})}/></label><div className="modal-actions"><Button disabled={mutationBlocked||![sizeEditor.width,sizeEditor.height].every(n=>Number.isFinite(n)&&n>=40)} onClick={()=>{const edit=sizeEditor;setSizeEditor(null);dialogRaw.current=null;void submitOperation({type:'patchItems',items:[edit]});}}>{zh?'应用尺寸':'Apply size'}</Button></div></Modal>}
    {frameDraft&&<Modal title={zh?'创建手写节点':'Create ink node'} onClose={()=>{if(!mutationBlocked){setFrameDraft(null);dialogRaw.current=null;}}}><p>{zh?'使用所框范围中的原始笔迹创建节点。保存前会检查笔迹是否能完整处理；不会用截图替代。':'Create a node from original ink inside the rectangle. Ink integrity is checked before saving; a screenshot is not used as a replacement.'}</p><label className="form-label">{zh?'节点名称':'Node title'}<input data-testid="board-frame-title" value={frameTitle} maxLength={1000} disabled={mutationBlocked} onChange={event=>setFrameTitle(event.target.value)}/></label><div className="modal-actions"><Button disabled={mutationBlocked} onClick={()=>{setFrameDraft(null);dialogRaw.current=null;}}>{zh?'取消':'Cancel'}</Button><Button data-testid="board-frame-confirm" className="primary" disabled={mutationBlocked} onClick={()=>{const rect=frameDraft;setFrameDraft(null);dialogRaw.current=null;void submitOperation({type:'frameInk',rect,title:frameTitle}).then(ok=>{if(ok&&mounted.current)setTool('arrange');});}}>{zh?'创建节点':'Create node'}</Button></div></Modal>}
    {expansionID&&<Modal title={zh?'展开所选资料':'Expand selected document'} onClose={()=>{if(!mutationBlocked){setExpansionID(null);dialogRaw.current=null;}}}><div className="board-expansion-content">
      <p>{direction==='onenote'?(zh?'将 OneNote 打印 PDF 按行连续拼接，保留原 PDF 与文件卡片。':'Stitch a PDF printed from OneNote into rows, keeping the original PDF and source card.'):(zh?'保留原文件卡片，在它下方按所选方向排列页面；已有页面会重新排列，保存前检查笔迹能否完整移动。':'Keep the source card and arrange its pages below it in the chosen direction. Existing pages are rearranged; ink integrity is checked before saving.')}</p>
      <label className="form-label">{zh?'展开方向':'Direction'}<select data-testid="board-expand-direction" value={direction} disabled={mutationBlocked} onChange={event=>setDirection(event.target.value as typeof direction)}><option value="vertical">{zh?'垂直':'Vertical'}</option><option value="horizontal">{zh?'水平':'Horizontal'}</option><option value="grid">{zh?'网格':'Grid'}</option><option value="onenote">{zh?'OneNote 连续拼接':'OneNote continuous stitching'}</option></select></label>
      {(direction==='onenote'||direction==='grid')&&<label className="form-label">{zh?'每行页数':'Pages per row'}<select data-testid="board-expand-columns" value={columns} disabled={mutationBlocked} onChange={event=>setColumns(Number(event.target.value))}>{[1,2,3,4,5,6,7,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
      {direction==='onenote'&&<div className="board-expansion-note" data-testid="board-onenote-guidance"><div className="board-expansion-order" data-testid="board-expand-order" aria-label={zh?'页面拼接顺序示意':'Stitching page order'} style={{gridTemplateColumns:`repeat(${columns}, minmax(0, 1fr))`}}>{Array.from({length:columns*2},(_,index)=><span key={index}>{index+1}</span>)}</div><p>{zh?'保留空白页的位置；自动去除可识别的打印页脚，并对齐重复边缘。没有匹配的页面，仅在页间白缝处拼接。':'Blank pages keep their positions. Recognizable print footers are removed and repeated edges aligned. Where no match is found, pages join only at the white page gap.'}</p></div>}
      <label className="form-label">{zh?'页面比例':'Page scale'}<select data-testid="board-expand-scale" value={scale} disabled={mutationBlocked} onChange={event=>setScale(Number(event.target.value))}>{[.25,.5,.75,1,1.25,1.5,1.75,2].map(value=><option key={value} value={value}>{value*100}%</option>)}</select></label>
      <div className="modal-actions"><Button disabled={mutationBlocked} onClick={()=>{setExpansionID(null);dialogRaw.current=null;}}>{zh?'取消':'Cancel'}</Button><Button data-testid="board-expand-confirm" className="primary" disabled={mutationBlocked} onClick={()=>{const id=expansionID;setExpansionID(null);dialogRaw.current=null;void submitOperation({type:'expandDocument',id,direction,scale,...(direction==='onenote'||direction==='grid'?{columns}:{})});}}>{direction==='onenote'?(zh?'拼接到白板':'Stitch onto board'):(zh?'展开页面':'Expand pages')}</Button></div>
    </div></Modal>}
    {translation.card}{!inlineReplay && <p className="board-hint">{zh ? '长按选字 · 拖动平移 · 方向键移动 · + / − 缩放 · 双击打开批注版或原文件' : 'Long-press to select text · Drag to pan · Arrow keys to move · + / − to zoom · Double-click to open the annotated PDF or source'} {onPasteContent&&(zh?' · 点击空白处后 ⌘V 粘贴':' · Click blank space, then ⌘V to paste')} · {visible.length} {zh ? '项在视野内' : 'in view'} · {details.length} {zh ? '项细节' : 'details'}{visibleInk.points > 200000 && <span className="board-ink-simplified" role="status"> · {zh ? '当前手写已简化显示，放大可查看细节；原始笔迹不变。' : 'Handwriting is simplified at this scale. Zoom in for detail; original ink is unchanged.'}</span>}</p>}
  </div>;
}

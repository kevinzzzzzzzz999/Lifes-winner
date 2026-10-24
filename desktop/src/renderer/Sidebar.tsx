import { useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, Network, Search, FolderOpen, Folder, ChevronRight, FileText, FileCode2, LayoutTemplate, RefreshCw, Plus, Globe, Activity, Settings, LoaderCircle, CircleDot, Trash2, Share2, FolderInput, ArrowUp, ArrowDown, Wrench, ListChecks, CalendarDays } from 'lucide-react';
import type { ApiResult, DirectoryListing, Vault, VaultEntry } from '../shared/desktop-api';
import { type Language, tr } from './i18n';
import { Button } from './ui';
import './file-tree.css';
import './file-management.css';
import {VAULT_DRAG_TYPE,decodeVaultDrag,selectionAfterClick,reorderPaths,orderedEntries,treeDropIntent,type VaultDrag,type TreeDropIntent} from './file-tree-management';
import type {FileAction} from './FileManagementDialog';
import ContextMenu,{type ContextMenuState,type ContextMenuItem} from './ContextMenu';

// File tree model: these exact helpers and request guards are tested with synthetic directories.
const TREE_PAGE_SIZE = 100;
const TREE_ROW_LIMIT = 3000;
const TREE_DIRECTORY_LIMIT = 256;
const TREE_CACHE_ENTRY_LIMIT = 50000;
const naturalNames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortTreeEntries(entries: VaultEntry[]): VaultEntry[] {
  return [...entries].sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || naturalNames.compare(a.name, b.name) || a.path.localeCompare(b.path));
}
function parentTreePath(path: string): string { return path.split('/').slice(0, -1).join('/'); }
function treeAncestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean), result = [''];
  for (let index = 1; index <= Math.min(64, parts.length); index++) result.push(parts.slice(0, index).join('/'));
  return result;
}
function fileTreeBadge(entry: VaultEntry): string {
  if (entry.path.endsWith('.inkcalendar.json')) return 'CAL';
  if (entry.path.endsWith('.inkcheck.json')) return 'LIST';
  if (entry.kind === 'folder') return '';
  if (entry.kind === 'board') return 'BOARD';
  const extension = entry.name.includes('.') ? entry.name.split('.').at(-1)!.toUpperCase() : '';
  return extension === 'MARKDOWN' ? 'MD' : extension.slice(0, 8) || 'FILE';
}
type TreeDirectory = { listing?: DirectoryListing; loading: boolean; error: boolean; limited?: boolean };
type TreeNode = { entry: VaultEntry; depth: number; children: TreeNode[]; open: boolean; state?: TreeDirectory; remaining: number; parent: string };
function visibleFileTree(cache: Map<string, TreeDirectory>, expanded: Set<string>, counts: Map<string, number>, query: string) {
  const needle = query.trim().toLocaleLowerCase(), wanted = new Set<string>();
  let matches = 0;
  if (needle) for (const state of cache.values()) for (const entry of state.listing?.entries || []) {
    if (![entry.name, entry.path].some(value => value.toLocaleLowerCase().includes(needle))) continue;
    matches++; wanted.add(entry.path); for (const ancestor of treeAncestors(parentTreePath(entry.path))) wanted.add(ancestor);
  }
  let count = 0, capped = false;
  const rows: TreeNode[] = [];
  const build = (path: string, depth: number): { nodes: TreeNode[]; remaining: number } => {
    if (depth > 64) { capped = true; return { nodes: [], remaining: 0 }; }
    const entries = (cache.get(path)?.listing?.entries || []).filter(entry => !needle || wanted.has(entry.path));
    const pageLimit = Math.max(TREE_PAGE_SIZE, counts.get(path) || TREE_PAGE_SIZE);
    const shown = Math.min(entries.length, pageLimit), nodes: TreeNode[] = [];
    for (let index = 0; index < shown; index++) {
      if (count >= TREE_ROW_LIMIT) { capped = true; break; }
      const entry = entries[index], state = cache.get(entry.path);
      const open = entry.kind === 'folder' && (expanded.has(entry.path) || (!!needle && wanted.has(entry.path) && !!state?.listing));
      const node: TreeNode = { entry, depth, children: [], open, state, remaining: 0, parent: path };
      count++; rows.push(node); nodes.push(node);
      if (open) { const child = build(entry.path, depth + 1); node.children = child.nodes; node.remaining = child.remaining; }
    }
    return { nodes, remaining: entries.length - nodes.length };
  };
  const result = build('', 1);
  return { ...result, rows, count, capped, matches, filtering: !!needle };
}
/** The store owns one vault. Older requests can never populate a new vault or overwrite a newer refresh. */
class FileTreeDirectoryStore {
  readonly directories = new Map<string, TreeDirectory>();
  private requests = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private serial = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private closed = false;
  private listeners = new Set<() => void>();
  limitReached = false;
  constructor(private loader: (path: string) => Promise<ApiResult<DirectoryListing>>) {}
  subscribe(listener: () => void) { this.closed = false; this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { for (const listener of this.listeners) listener(); }
  dispose() { this.closed = true; this.requests.clear(); this.listeners.clear(); }
  private install(path: string, listing: DirectoryListing): boolean {
    if (listing.path !== path || !Array.isArray(listing.entries)) return false;
    const entries = sortTreeEntries(listing.entries.filter(entry => parentTreePath(entry.path) === path && entry.path !== path));
    const previousSize = this.directories.get(path)?.listing?.entries.length || 0;
    const size = [...this.directories.values()].reduce((sum, record) => sum + (record.listing?.entries.length || 0), 0) - previousSize + entries.length;
    if (size > TREE_CACHE_ENTRY_LIMIT || entries.length > 10000) { this.limitReached = true; return false; }
    this.directories.set(path, { listing: { ...listing, entries }, loading: false, error: false });
    // A deleted/replaced folder cannot survive as an orphan in cached search results.
    const validChildren = new Set(entries.filter(entry => entry.kind === 'folder').map(entry => entry.path));
    for (const key of this.directories.keys()) {
      if (key === path || !key || (path && !key.startsWith(path + '/'))) continue;
      const relative = path ? key.slice(path.length + 1) : key;
      const directChild = path ? path + '/' + relative.split('/')[0] : relative.split('/')[0];
      if (!validChildren.has(directChild)) { this.directories.delete(key); this.requests.delete(key); this.pending.delete(key); }
    }
    return true;
  }
  accept(listing: DirectoryListing) {
    if (this.closed) return;
    if (!this.directories.has(listing.path) && this.directories.size >= TREE_DIRECTORY_LIMIT) { this.limitReached = true; this.notify(); return; }
    this.requests.set(listing.path, ++this.serial); this.pending.delete(listing.path);
    if (!this.install(listing.path, listing)) this.directories.set(listing.path, { ...this.directories.get(listing.path), loading: false, error: true });
    this.notify();
  }
  load(path: string, force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!force && this.pending.has(path)) return this.pending.get(path)!;
    if (!force && this.directories.get(path)?.listing) return Promise.resolve();
    if (!this.directories.has(path) && this.directories.size >= TREE_DIRECTORY_LIMIT) { this.limitReached = true; this.notify(); return Promise.resolve(); }
    const request = ++this.serial; this.requests.set(path, request);
    this.directories.set(path, { ...this.directories.get(path), loading: true, error: false }); this.notify();
    const task = (async () => {
      try {
        const reply = await this.loader(path);
        if (this.closed || this.requests.get(path) !== request) return;
        if (!reply.ok || !this.install(path, reply.value)) this.directories.set(path, { ...this.directories.get(path), loading: false, error: true });
      } catch {
        if (!this.closed && this.requests.get(path) === request) this.directories.set(path, { ...this.directories.get(path), loading: false, error: true });
      } finally {
        if (!this.closed && this.requests.get(path) === request) { this.pending.delete(path); this.notify(); }
      }
    })();
    this.pending.set(path, task); return task;
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshPromise) {
      this.refreshAgain = true;
      for (const path of this.requests.keys()) { this.requests.set(path, ++this.serial); this.pending.delete(path); }
      return this.refreshPromise;
    }
    // Repeated watcher notifications coalesce: at most one four-read refresh batch is active.
    const work = (async () => {
      do {
        this.refreshAgain = false;
        const paths = ['', ...[...this.directories.keys()].filter(path => path !== '')];
        for (const path of paths) { this.requests.set(path, ++this.serial); this.pending.delete(path); }
        let next = 0;
        const worker = async () => { while (!this.closed && !this.refreshAgain && next < paths.length) { const path = paths[next++]; if (path && !this.directories.has(path)) continue; await this.load(path, true); } };
        await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker));
      } while (!this.closed && this.refreshAgain);
    })();
    this.refreshPromise = work;
    void work.finally(() => { if (this.refreshPromise === work) this.refreshPromise = null; }).catch(() => {});
    return work;
  }
}
// File tree UI.
export function FileIcon({ path, kind }: { path: string; kind: string }) {
  if (kind === 'folder') return <Folder />;
  if (kind === 'board') return <LayoutTemplate />;
  if (path.endsWith('.inkcalendar.json')) return <CalendarDays />;
  if (path.endsWith('.inkcheck.json')) return <ListChecks />;
  if (/\.(py|js|ts|json|tex)$/i.test(path)) return <FileCode2 />;
  return <FileText />;
}
export type SidebarProps = {
  language: Language; setLanguage: (value: Language) => void; vault: Vault | null; listing: DirectoryListing | null; active: string | null;
  onHome?: () => void; onChecklist?: (folder?:string) => void; onBrowser?: () => void; onImportClip?: () => void; onMath?: () => void; onMedia?:()=>void; onChoose: () => void; onOpen: (entry: VaultEntry) => void; onFolder: (path: string) => void; onRefresh: () => void; onNew: (parentPath?:string) => void;
  onManage?: (action:FileAction)=>void; onShare?: (paths:string[])=>void; onNewBoard?:(parentPath?:string)=>void; onExternalOpen?:(path:string,application:'default'|'choose')=>void; onReveal?:(path:string)=>void; onCopyReference?:(path:string,kind:'path'|'link')=>void; actionsDisabled?:boolean; onDiagnostics: () => void; onSettings?: () => void; onSearch: () => void; onGraph: () => void;
  /** Increment for an arrived vault change; refreshes only folders already loaded in this tree. */
  revision?: string | number; managementRevision?:number; managementRequest?:number;
};
export default function Sidebar({ language, setLanguage, vault, listing, active, onChoose, onHome, onChecklist, onBrowser, onImportClip, onMath, onMedia, onOpen, onFolder, onRefresh, onNew, onDiagnostics, onSettings, onSearch, onGraph, revision, onManage, onShare, onNewBoard, onExternalOpen, onReveal, onCopyReference, actionsDisabled=false, managementRevision, managementRequest }: SidebarProps) {
  const zh = language === 'zh', t = (key: Parameters<typeof tr>[1]) => tr(language, key);
  const store = useMemo(() => new FileTreeDirectoryStore(path => vault ? window.desktop.listDirectory({ vaultId: vault.id, path }) : Promise.resolve({ ok: false, error: { code: 'NO_VAULT', message: '' } })), [vault?.id]);
  const [tick, setTick] = useState(0), [query, setQuery] = useState('');
  const [menu,setMenu]=useState<ContextMenuState|null>(null);
  useEffect(()=>setMenu(null),[vault?.id,revision,managementRevision,actionsDisabled]);
  const [selecting,setSelecting]=useState(false),[selectedPaths,setSelectedPaths]=useState<Set<string>>(()=>new Set()),[sort,setSort]=useState('manual');
  useEffect(()=>{if(managementRequest){setSelecting(true);setQuery('');}},[managementRequest]);
  const [orders,setOrders]=useState<Record<string,string[]>>({});const selectionAnchor=useRef<string|null>(null);const dragged=useRef<VaultDrag|null>(null);
  const [dropHover,setDropHover]=useState<{path:string;zone:'inside'|'before'|'after'|'invalid';note:string}|null>(null);
  const [sortNote,setSortNote]=useState('');const orderPending=useRef(false),orderEpoch=useRef(0);
  useEffect(()=>{setSelectedPaths(new Set());},[managementRevision]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>()), rootButton = useRef<HTMLButtonElement>(null);
  const scope = useRef(store); scope.current = store;
  const target = listing?.path || '';
  const lastReveal = useRef<{ store: FileTreeDirectoryStore; target: string; active: string | null } | null>(null);
  const previousRevision = useRef<{ store: FileTreeDirectoryStore; revision: string | number | undefined } | null>(null);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setTick(value => value + 1));
    setExpanded(new Set()); setCounts(new Map()); setQuery(''); setFocusedPath(null);setSelectedPaths(new Set());setSelecting(false);setOrders({});setDropHover(null);dragged.current=null;
    if (vault) void store.load('');
    return () => { unsubscribe(); store.dispose(); };
  }, [store]);
  useEffect(() => { if (vault && listing) store.accept(listing); }, [store, listing]);
  useEffect(() => {
    if (!vault) return;
    const prior = previousRevision.current; previousRevision.current = { store, revision };
    if (prior?.store === store && prior.revision !== revision) void store.refresh();
  }, [store, revision]);
  useEffect(() => {
    if (!vault) return;
    const previous = lastReveal.current;
    const targetChanged = previous?.store !== store || previous.target !== target;
    const activeChanged = previous?.store !== store || previous.active !== active;
    lastReveal.current = { store, target, active };
    const directories = new Set<string>();
    if (targetChanged) for (const path of treeAncestors(parentTreePath(target))) directories.add(path);
    if (activeChanged) for (const path of treeAncestors(active ? parentTreePath(active) : '')) directories.add(path);
    directories.delete('');
    if (directories.size) setExpanded(old => new Set([...old, ...directories]));
    const reads = new Set(['', ...directories, ...(targetChanged ? [target] : [])]);
    void (async () => { for (const path of reads) { if (scope.current !== store) return; await store.load(path); } })();
  }, [store, target, active]);
  const loadedOrderPaths=[...store.directories].filter(([,r])=>r.listing).map(([p])=>p).sort().join('\0');
  useEffect(()=>{if(!vault||!window.desktop.getFolderOrder)return;let cancelled=false;const paths=loadedOrderPaths?loadedOrderPaths.split('\0'):[''];let index=0;const id=++orderEpoch.current;const worker=async()=>{while(!cancelled&&index<paths.length){const path=paths[index++];const result=await window.desktop.getFolderOrder({vaultId:vault.id,path});if(cancelled||id!==orderEpoch.current)return;if(result.ok)setOrders(old=>JSON.stringify(old[path])===JSON.stringify(result.value.paths)?old:{...old,[path]:result.value.paths});}};void Promise.all(Array.from({length:Math.min(4,paths.length)},worker)).catch(()=>{});return()=>{cancelled=true;};},[store,loadedOrderPaths,revision,managementRevision]);
  const tree = useMemo(() => {const cache=new Map([...store.directories].map(([p,record])=>[p,{...record,listing:record.listing?{...record.listing,entries:orderedEntries(record.listing.entries,sort,orders[p])}:undefined}]));return visibleFileTree(cache, expanded, counts, query);}, [store, tick, expanded, counts, query, sort, orders]);
  const selectEntry=(path:string,range=false)=>{setSelecting(true);setSelectedPaths(old=>selectionAfterClick(old,path,tree.rows.map(n=>n.entry.path),selectionAnchor.current,range));if(!range)selectionAnchor.current=path;};
  const saveOrder=(parent:string,paths:string[])=>{if(!vault||orderPending.current)return;orderPending.current=true;orderEpoch.current++;const targetVault=vault.id;setSortNote(zh?'正在保存排列…':'Saving order…');void window.desktop.setFolderOrder({vaultId:targetVault,path:parent,paths}).then(result=>{if(scope.current!==store)return;if(result.ok){setOrders(old=>({...old,[parent]:result.value.paths}));window.dispatchEvent(new CustomEvent('inkspace-folder-order',{detail:{vaultId:targetVault}}));setSort('manual');setSortNote(zh?'排列已保存 · 随 iCloud 同步':'Order saved · syncs with iCloud');}else setSortNote(zh?'排列未能保存，请刷新后重试。':'Order could not be saved. Refresh and retry.');}).catch(()=>setSortNote(zh?'排列保存失败':'Could not save order')).finally(()=>{orderPending.current=false;});};
  const nudge=(delta:number,paths=[...selectedPaths])=>{const chosen=paths;if(chosen.length!==1)return;const path=chosen[0],parent=parentTreePath(path);const siblings=orderedEntries(store.directories.get(parent)?.listing?.entries||[],sort,orders[parent]).map(e=>e.path);const index=siblings.indexOf(path),targetIndex=index+delta;if(index<0||targetIndex<0||targetIndex>=siblings.length)return;[siblings[index],siblings[targetIndex]]=[siblings[targetIndex],siblings[index]];saveOrder(parent,siblings);};

  const dropIntent=(event:React.DragEvent<HTMLButtonElement>,entry:VaultEntry,data:VaultDrag)=>{const rect=event.currentTarget.getBoundingClientRect();return treeDropIntent(data.paths,entry,sort,rect.height>0?(event.clientY-rect.top)/rect.height:.5);};
  const dropNote=(intent:TreeDropIntent,entry:VaultEntry)=>intent.kind==='move'?(zh?`放开以移入「${entry.path}」`:`Release to move into “${entry.path}”`):intent.kind==='reorder'?(zh?`放开以排在「${entry.name}」${intent.placement==='before'?'之前':'之后'}`:`Release to place ${intent.placement} “${entry.name}”`):intent.reason==='self'||intent.reason==='descendant'?(zh?'不能移入自身或其子文件夹。':'Cannot move an item into itself or its subfolder.'):intent.reason==='same-folder'?(zh?'所选项目已在这个文件夹内。':'The selection already contains an item in this folder.'):(zh?'请拖到文件夹中间以移动；单个同层项目可拖到行的上沿或下沿排序。':'Drop in a folder center to move, or at a row edge to reorder one sibling.');
  const hoverDrop=(event:React.DragEvent<HTMLButtonElement>,entry:VaultEntry)=>{if(!event.dataTransfer.types.includes(VAULT_DRAG_TYPE))return;const data=dragged.current||decodeVaultDrag(event.dataTransfer.getData(VAULT_DRAG_TYPE),vault?.id||'');if(!data){if(entry.kind==='folder'&&onManage){event.preventDefault();event.dataTransfer.dropEffect='move';setDropHover({path:entry.path,zone:'inside',note:zh?`放开以移入「${entry.path}」`:`Release to move into “${entry.path}”`});}return;}const intent=dropIntent(event,entry,data),allowed=intent.kind==='reorder'||(intent.kind==='move'&&!!onManage);if(allowed)event.preventDefault();event.dataTransfer.dropEffect=allowed?'move':'none';const next={path:entry.path,zone:intent.kind==='reorder'?intent.placement:intent.kind==='move'?'inside':'invalid',note:dropNote(intent,entry)} as NonNullable<typeof dropHover>;setDropHover(previous=>previous?.path===next.path&&previous.zone===next.zone&&previous.note===next.note?previous:next);};
  const receiveDrop=(event:React.DragEvent<HTMLButtonElement>,entry:VaultEntry)=>{event.preventDefault();event.stopPropagation();setDropHover(null);const data=decodeVaultDrag(event.dataTransfer.getData(VAULT_DRAG_TYPE),vault?.id||'');dragged.current=null;if(!data)return;const intent=dropIntent(event,entry,data);if(intent.kind==='reorder'){const parent=parentTreePath(intent.source),paths=orderedEntries(store.directories.get(parent)?.listing?.entries||[],sort,orders[parent]).map(e=>e.path);saveOrder(parent,reorderPaths(paths,intent.source,intent.target,intent.placement));}else if(intent.kind==='move'){setSortNote(zh?`移动到：${intent.targetPath}`:`Move into: ${intent.targetPath}`);onManage?.({kind:'move',paths:intent.paths,targetPath:intent.targetPath});}else setSortNote(dropNote(intent,entry));};

  const focusPath = tree.rows.some(node => node.entry.path === focusedPath) ? focusedPath : tree.rows.some(node => node.entry.path === active) ? active : tree.rows[0]?.entry.path;
  const focus = (path: string) => { setFocusedPath(path); requestAnimationFrame(() => { if (scope.current === store) (path === '' ? rootButton.current : buttons.current.get(path))?.focus(); }); };
  const toggle = (path: string) => {
    const opening = !expanded.has(path); setExpanded(old => { const next = new Set(old); if (opening) next.add(path); else next.delete(path); return next; });
    if (opening) void store.load(path);
  };
  const activate = (entry: VaultEntry) => { if (entry.kind === 'folder') { toggle(entry.path); onFolder(entry.path); } else onOpen(entry); };
  const keyboard = (event: React.KeyboardEvent<HTMLButtonElement>, node: TreeNode) => {
    if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){contextAt(event,node.entry);return;}
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const index = tree.rows.findIndex(row => row.entry.path === node.entry.path);
    if (event.key === 'ArrowDown') { event.preventDefault(); if (index < tree.rows.length - 1) focus(tree.rows[index + 1].entry.path); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (index > 0) focus(tree.rows[index - 1].entry.path); else focus(''); }
    else if (event.key === 'Home') { event.preventDefault(); if (tree.rows.length) focus(tree.rows[0].entry.path); }
    else if (event.key === 'End') { event.preventDefault(); if (tree.rows.length) focus(tree.rows.at(-1)!.entry.path); }
    else if (event.key === 'ArrowRight' && node.entry.kind === 'folder') { event.preventDefault(); if (!node.open) { setExpanded(old => new Set([...old, node.entry.path])); void store.load(node.entry.path); } else if (node.children.length) focus(node.children[0].entry.path); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (node.open && !tree.filtering) setExpanded(old => { const next = new Set(old); next.delete(node.entry.path); return next; }); else focus(node.parent); }
    else if (event.key === 'Delete' || event.key === 'Backspace') {event.preventDefault();onManage?.({kind:'trash',paths:selectedPaths.size?[...selectedPaths]:[node.entry.path]});}
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if(selecting)selectEntry(node.entry.path,event.shiftKey);else activate(node.entry); }
  };
  const contextAt=(event:React.MouseEvent|React.KeyboardEvent,entry?:VaultEntry,parentOverride?:string)=>{
    event.preventDefault();event.stopPropagation();
    const el=event.currentTarget as HTMLElement;el.focus({preventScroll:true});
    const box=el.getBoundingClientRect(),x='clientX'in event?event.clientX:box.left+24,y='clientY'in event?event.clientY:box.top+20;
    const paths=entry?(selectedPaths.has(entry.path)?[...selectedPaths]:[entry.path]):[];
    if(entry&&!selectedPaths.has(entry.path))setSelectedPaths(selecting?new Set([entry.path]):new Set());
    const single=paths.length===1,folder=entry?.kind==='folder',parent=folder?entry!.path:entry?parentTreePath(entry.path):parentOverride??target;
    const items:ContextMenuItem[]=[];
    const add=(id:string,cn:string,en:string,action:()=>void,extra:Partial<ContextMenuItem>={})=>items.push({id,label:zh?cn:en,action,disabled:actionsDisabled,...extra});
    if(entry&&single){
      add('open',folder?(expanded.has(entry.path)?'收起文件夹':'展开文件夹'):'打开',folder?(expanded.has(entry.path)?'Collapse folder':'Expand folder'):'Open',()=>activate(entry));
      if(!folder&&/\.(xlsx?|xlsm|csv|docx?|pptx?|pdf|png|jpe?g|md|markdown|tex|txt|mp4|mov|m4v)$/i.test(entry.path)&&onExternalOpen){
        add('open-default','使用默认应用打开','Open in default app',()=>onExternalOpen(entry.path,'default'));
        add('open-with','选择其他应用打开…','Open with another app…',()=>onExternalOpen(entry.path,'choose'));
      }
    }
    if(!entry||single){
      add('new-board','在此文件夹新建白板…','New board in this folder…',()=>{(onNewBoard||onNew)(parent);},{separatorBefore:!!entry});
      if(onChecklist)add('course-checklist','课程清单…','Course checklist…',()=>onChecklist(parent));
      add('new-file','在此文件夹新建文件…','New file in this folder…',()=>onNew(parent));
    }
    if(entry){
      if(onManage){
        add('move',paths.length>1?`移动 ${paths.length} 项…`:'移动到…',paths.length>1?`Move ${paths.length} items…`:'Move to…',()=>onManage({kind:'move',paths}),{separatorBefore:true});
        if(single)add('rename','重命名…','Rename…',()=>onManage({kind:'rename',paths,isFolder:folder}));
      }
      if(onShare)add('share',paths.length>1?`分享 ${paths.length} 项…`:'分享…',paths.length>1?`Share ${paths.length} items…`:'Share…',()=>onShare(paths));
      if(single){
        if(onReveal)add('reveal','在访达中显示','Show in Finder',()=>onReveal(entry.path));
        if(onCopyReference){add('copy-path','复制相对路径','Copy relative path',()=>onCopyReference(entry.path,'path'),{separatorBefore:true});if(!folder)add('copy-link','复制内部链接','Copy internal link',()=>onCopyReference(entry.path,'link'));}
        const siblings=orderedEntries(store.directories.get(parentTreePath(entry.path))?.listing?.entries||[],sort,orders[parentTreePath(entry.path)]).map(e=>e.path),index=siblings.indexOf(entry.path);
        add('order-up','上移显示顺序','Move up in list',()=>nudge(-1,paths),{separatorBefore:true,disabled:actionsDisabled||index<=0});
        add('order-down','下移显示顺序','Move down in list',()=>nudge(1,paths),{disabled:actionsDisabled||index<0||index>=siblings.length-1});
      }
      add('select',selecting?'保留所选，继续多选':'选择多个项目','Select multiple items',()=>{setSelecting(true);setSelectedPaths(new Set(paths));selectionAnchor.current=entry.path;},{separatorBefore:true});
      if(onManage)add('trash',paths.length>1?`移到回收站（${paths.length} 项）…`:'移到回收站…',paths.length>1?`Move ${paths.length} items to trash…`:'Move to trash…',()=>onManage({kind:'trash',paths}),{danger:true});
    }else{
      add('refresh','刷新文件夹','Refresh folder',()=>{void store.refresh();onRefresh();},{separatorBefore:true});
      add('collapse-folders','收起全部文件夹','Collapse all folders',()=>setExpanded(new Set()));
      if(onManage)add('open-trash','打开回收站','Open trash',()=>onManage({kind:'restore',paths:[]}));
    }
    setMenu({x,y,title:paths.length>1?(zh?`已选 ${paths.length} 项`:`${paths.length} items selected`):entry?.name||parent||vault?.name,items});
  };
  const more = (path: string) => setCounts(old => new Map(old).set(path, (old.get(path) || TREE_PAGE_SIZE) + TREE_PAGE_SIZE));
  const stateMessage = (state: TreeDirectory | undefined, path: string) => state?.loading ? <li role="none" className="file-tree-message" aria-live="polite"><LoaderCircle className="tree-spinner" />{zh ? '正在读取…' : 'Loading…'}</li> : state?.error ? <li role="none" className="file-tree-message tree-error"><span>{zh ? '读取未完成，已保留上次列表。' : 'Could not refresh; the previous list is retained.'}</span><button onClick={() => void store.load(path, true)}>{zh ? '重试' : 'Retry'}</button></li> : null;
  const renderNodes = (nodes: TreeNode[]) => nodes.map(node => {
    const { entry } = node, isTarget = entry.kind === 'folder' && target === entry.path, selected = active === entry.path;
    return <li key={entry.path} role="treeitem" aria-level={node.depth} aria-expanded={entry.kind === 'folder' ? node.open : undefined} aria-selected={selecting?selectedPaths.has(entry.path):selected || isTarget} data-tree-node={entry.path}>
      <button ref={element => { if (element) buttons.current.set(entry.path, element); else buttons.current.delete(entry.path); }} className={`file-row tree-row ${selected ? 'selected' : ''} ${selectedPaths.has(entry.path)?'multi-selected':''} ${isTarget ? 'tree-target' : ''} ${dropHover?.path===entry.path?'tree-drop-'+dropHover.zone:''}`} data-drop-zone={dropHover?.path===entry.path?dropHover.zone:undefined} data-tree-path={entry.path} data-new-target={isTarget || undefined} title={`${entry.path}${isTarget ? zh ? '\n新文件将创建在此目录' : '\nNew files will be created here' : ''}`} aria-label={entry.name} aria-current={selected ? 'page' : undefined} tabIndex={focusPath === entry.path ? 0 : -1} onFocus={() => setFocusedPath(entry.path)} onKeyDown={event => keyboard(event, node)} onContextMenu={event=>contextAt(event,entry)} onClick={event => {if(event.ctrlKey)return;if(selecting||event.metaKey||event.shiftKey)selectEntry(entry.path,event.shiftKey);else activate(entry);}}
        draggable onDragStart={event=>{const paths=selectedPaths.has(entry.path)?[...selectedPaths]:[entry.path],data={vaultId:vault?.id||'',paths};dragged.current=data;setDropHover(null);event.dataTransfer.setData(VAULT_DRAG_TYPE,JSON.stringify(data));event.dataTransfer.effectAllowed='copyMove';}} onDragEnd={()=>{dragged.current=null;setDropHover(null);}}
        onDragOver={event=>hoverDrop(event,entry)} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDropHover(previous=>previous?.path===entry.path?null:previous);}}
        onDrop={event=>receiveDrop(event,entry)}>
        {selecting&&<span className={`tree-check ${selectedPaths.has(entry.path)?'checked':''}`} aria-hidden="true">{selectedPaths.has(entry.path)?'✓':''}</span>}
        <span className={`tree-chevron ${node.open ? 'expanded' : ''}`} aria-hidden="true" onClick={event=>{if(entry.kind==='folder'){event.stopPropagation();toggle(entry.path);onFolder(entry.path);}}}>{entry.kind === 'folder' && <ChevronRight />}</span>
        {entry.kind === 'folder' && node.open ? <FolderOpen /> : <FileIcon path={entry.path} kind={entry.kind} />}
        <span className="tree-name">{entry.name}</span>
        {isTarget && <CircleDot className="tree-target-dot" aria-hidden="true" />}
        {entry.kind !== 'folder' && <span className={`tree-format tree-format-${fileTreeBadge(entry).toLowerCase()}`} aria-hidden="true">{fileTreeBadge(entry)}</span>}
      </button>
      {node.open && <ul role="group" className="tree-children">
        {renderNodes(node.children)}{stateMessage(node.state, entry.path)}
        {!node.state?.loading && !node.state?.error && node.state?.listing?.entries.length === 0 && <li role="none" className="file-tree-message">{zh ? '空文件夹' : 'Empty folder'}</li>}
        {!!node.state?.listing?.warnings.length && <li role="none" className="file-tree-message tree-warning">{zh ? '部分不可用或链接文件未列出。' : 'Some unavailable or linked files are omitted.'}</li>}
        {node.remaining > 0 && !tree.capped && <li role="none"><button className="tree-more" onClick={() => more(entry.path)}>{zh ? `再显示 ${Math.min(TREE_PAGE_SIZE, node.remaining)} 项` : `Show ${Math.min(TREE_PAGE_SIZE, node.remaining)} more`} <span>({node.remaining})</span></button></li>}
      </ul>}
    </li>;
  });
  const rootState = store.directories.get('');
  return <aside className="sidebar hierarchical-sidebar">
    <div className="sidebar-heading"><strong>{zh?'文件夹':'Folders'}</strong></div>
    <Button className="sidebar-open-folder" onClick={onChoose} data-testid="sidebar-open-folder" title={zh?'选择本机或 iCloud 中的资料文件夹':'Choose a folder on this Mac or in iCloud'}><FolderOpen aria-hidden="true"/><span>{t('openFolder')}</span></Button>
    {!vault&&<div className="sidebar-file-hint">{zh?'打开资料文件夹后，在这里逐层浏览文件。':'Open a folder to browse your files here.'}<Button onClick={onHome||onChoose}>{zh?'前往首页':'Go to Home'}</Button></div>}
    {vault && <>
      <div className="folder-title tree-heading">
        <button ref={rootButton} className={`tree-root ${target === '' ? 'tree-target' : ''}`} aria-label={zh ? `选择仓库根目录 ${vault.name}` : `Select vault root ${vault.name}`} title={vault.name} onContextMenu={event=>contextAt(event,undefined,'')} data-testid="file-tree-root" data-new-target={target === '' || undefined} onClick={() => onFolder('')} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); if (tree.rows[0]) focus(tree.rows[0].entry.path); } }}><FolderOpen /><span>{vault.name}</span>{target === '' && <CircleDot className="tree-target-dot" aria-hidden="true" />}</button>
        <Button className="icon-button" title={t('refresh')} aria-label={t('refresh')} onClick={() => { void store.refresh(); onRefresh(); }}><RefreshCw /></Button>
        <Button className="icon-button" data-testid="sidebar-create" title={zh?'新建文件或文件夹':'New file or folder'} aria-label={zh?'新建文件或文件夹':'New file or folder'} onClick={()=>onNew()}><Plus /></Button>
      </div>
      <div className="tree-target-label" data-testid="file-tree-new-target" title={target || vault.name}>{zh ? '新建位置：' : 'Create in: '}{target || (zh ? '仓库根目录' : 'Vault root')}</div>
      <div className="tree-management"><Button data-testid="tree-select" onClick={()=>{setSelecting(!selecting);setSelectedPaths(new Set());}}>{selecting?(zh?'完成':'Done'):(zh?'多选':'Select')}</Button><Button aria-label={zh?'回收站':'Trash'} onClick={()=>onManage?.({kind:'restore',paths:[]})}><Trash2/></Button><select className="tree-sort" aria-label={zh?'排列方式':'Sort order'} value={sort} onChange={e=>setSort(e.target.value)}><option value="name">{zh?'名称 A–Z':'Name A–Z'}</option><option value="descending">{zh?'名称 Z–A':'Name Z–A'}</option><option value="size">{zh?'文件大小':'Size'}</option><option value="manual">{zh?'手动排列':'Manual order'}</option></select></div>
      {selecting&&<div className="tree-selection-tools"><p>{zh?`已选 ${selectedPaths.size} / 100 项`:`${selectedPaths.size} / 100 selected`}</p><div className="tree-management"><Button disabled={!selectedPaths.size} onClick={()=>onManage?.({kind:'move',paths:[...selectedPaths]})}><FolderInput/>{zh?'移动':'Move'}</Button><Button disabled={!selectedPaths.size} onClick={()=>onShare?.([...selectedPaths])}><Share2/>{zh?'分享':'Share'}</Button><Button disabled={!selectedPaths.size} onClick={()=>onManage?.({kind:'trash',paths:[...selectedPaths]})}><Trash2/>{zh?'删除':'Delete'}</Button><Button disabled={selectedPaths.size!==1} aria-label={zh?'上移显示顺序':'Move up in list'} onClick={()=>nudge(-1)}><ArrowUp/></Button><Button disabled={selectedPaths.size!==1} aria-label={zh?'下移显示顺序':'Move down in list'} onClick={()=>nudge(1)}><ArrowDown/></Button></div></div>}
      {sort==='manual'&&<details className="tree-organization-help"><summary>{zh?'移动与排序提示':'Moving and sorting'}</summary><p>{zh?'拖到文件夹中间可移入；拖到同层项目的上沿或下沿可排序。':'Drop in a folder center to move; drop at a sibling’s top or bottom edge to reorder.'}</p></details>}<p className={`tree-management-hint tree-drop-status ${dropHover?'active':''}`} data-testid="tree-drop-status" role="status">{dropHover?.note||sortNote||''}</p>
      <input className="file-filter" placeholder={zh ? '筛选已载入的目录' : 'Filter loaded folders'} aria-label={t('searchFiles')} value={query} onChange={event => setQuery(event.target.value)} />
      {query && <p className="tree-filter-hint">{zh ? '仅筛选已载入项目，保留父级路径。搜索全部正文请用知识库搜索。' : 'Filters loaded items and keeps parent paths. Use knowledge search for all text.'}</p>}
      <nav className="file-list file-tree" aria-label={t('folder')} onContextMenu={event=>contextAt(event)}>
        <ul role="tree" aria-label={zh ? '文件与文件夹' : 'Files and folders'}>{renderNodes(tree.nodes)}{stateMessage(rootState, '')}
          {!rootState?.loading && !rootState?.error && rootState?.listing?.entries.length === 0 && <li role="none" className="file-tree-message">{t('noFiles')}</li>}
          {query && tree.count === 0 && <li role="none" className="file-tree-message">{zh ? '已载入项目中没有匹配项。' : 'No matching loaded items.'}</li>}
          {tree.remaining > 0 && !tree.capped && <li role="none"><button className="tree-more" onClick={() => more('')}>{zh ? `再显示 ${Math.min(TREE_PAGE_SIZE, tree.remaining)} 项` : `Show ${Math.min(TREE_PAGE_SIZE, tree.remaining)} more`} <span>({tree.remaining})</span></button></li>}
        </ul>
      </nav>
      {(tree.capped || store.limitReached) && <p className="tree-filter-hint" role="status">{zh ? '目录较大：当前最多显示 3,000 项、缓存 256 个目录／50,000 项。请收起其他目录或选择较小的课程根目录。' : 'Large tree: up to 3,000 visible rows and 256 cached folders / 50,000 entries. Collapse other folders or open a smaller course root.'}</p>}
      {!!rootState?.listing?.warnings.length && <p className="tree-filter-hint">{zh ? '部分不可用或链接文件未列出。' : 'Some unavailable or linked files are omitted.'}</p>}
    </>}
    <ContextMenu menu={menu} onClose={()=>setMenu(null)}/>
  </aside>;
}

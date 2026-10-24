/** In-memory UI state only: drafts, outputs and kernels remain owned by App. */
export type NotebookEditorSelection={cellID?:string;cellIndex:number;anchor:number;head:number;scrollTop:number;scrollLeft:number};
export type NotebookViewportAnchor={cellID?:string;cellIndex:number;offset:number};
export type NotebookEditorSession={
 schemaVersion:1;selected:number;anchor:number;selectedCellID?:string;anchorCellID?:string;
 editing:boolean;raw:boolean;scrollTop:number;scrollLeft:number;
 editorSelection?:NotebookEditorSelection;viewportAnchor?:NotebookViewportAnchor;
 outlineOpen?:boolean;outlineCollapsedIDs?:string[];
 lineNumbers:Record<string,boolean>;hiddenOutputs:Record<string,boolean>;scrollOutputs:Record<string,boolean>;
};
const finite=(value:unknown,max=1e9)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(0,value)):0;
const index=(value:unknown,max=1e6)=>Math.floor(finite(value,max));
const offset=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.min(1e9,Math.max(-1e9,value)):0;
const cellID=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=200?value:undefined;
const flags=(value:unknown):Record<string,boolean>=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([key,flag])=>key.length<=200&&typeof flag==='boolean').slice(0,2000)):{};
/** Copy and bound values so stale UI or a foreign object cannot retain documents. */
export function normalizeNotebookSession(value:unknown,cellCount?:number):NotebookEditorSession{
 const source=value&&typeof value==='object'?value as Partial<NotebookEditorSession>:{};
 const max=cellCount===undefined?1e6:Math.max(0,index(cellCount)-1);
 const selection=source.editorSelection,viewport=source.viewportAnchor;
 return {schemaVersion:1,selected:index(source.selected,max),anchor:index(source.anchor,max),
  ...(cellID(source.selectedCellID)?{selectedCellID:source.selectedCellID}:{}),...(cellID(source.anchorCellID)?{anchorCellID:source.anchorCellID}:{}),
  editing:source.editing===true,raw:source.raw===true,scrollTop:finite(source.scrollTop),scrollLeft:finite(source.scrollLeft),
  ...(selection&&typeof selection==='object'?{editorSelection:{cellIndex:index(selection.cellIndex,max),...(cellID(selection.cellID)?{cellID:selection.cellID}:{}),anchor:index(selection.anchor,2*1024*1024),head:index(selection.head,2*1024*1024),scrollTop:finite(selection.scrollTop),scrollLeft:finite(selection.scrollLeft)}}:{}),
  ...(viewport&&typeof viewport==='object'?{viewportAnchor:{cellIndex:index(viewport.cellIndex,max),...(cellID(viewport.cellID)?{cellID:viewport.cellID}:{}),offset:offset(viewport.offset)}}:{}),
  ...(typeof source.outlineOpen==='boolean'?{outlineOpen:source.outlineOpen}:{}),
  ...(Array.isArray(source.outlineCollapsedIDs)?{outlineCollapsedIDs:[...new Set(source.outlineCollapsedIDs.filter((value):value is string=>typeof value==='string'&&value.length>0&&value.length<=400))].slice(0,2000)}:{}),
  lineNumbers:flags(source.lineNumbers),hiddenOutputs:flags(source.hiddenOutputs),scrollOutputs:flags(source.scrollOutputs)};
}
export function restoreNotebookSession(value:unknown,cellIDs:readonly string[]):NotebookEditorSession{
 const session=normalizeNotebookSession(value,cellIDs.length);
 const selected=session.selectedCellID?cellIDs.indexOf(session.selectedCellID):-1,anchor=session.anchorCellID?cellIDs.indexOf(session.anchorCellID):-1;
 if(selected>=0)session.selected=selected;if(anchor>=0)session.anchor=anchor;
 if(session.editorSelection?.cellID){const found=cellIDs.indexOf(session.editorSelection.cellID);if(found>=0)session.editorSelection.cellIndex=found;else delete session.editorSelection;}
 if(!cellIDs.length)delete session.viewportAnchor;
 else if(session.viewportAnchor?.cellID){const found=cellIDs.indexOf(session.viewportAnchor.cellID);if(found>=0)session.viewportAnchor.cellIndex=found;else{delete session.viewportAnchor.cellID;session.viewportAnchor.offset=0;}}
 return session;
}
/** Compensate for content-visibility changing earlier cells' measured heights. */
export function notebookViewportScroll(value:{scrollTop:number;cellTop:number;viewportTop:number;offset:number;maxScrollTop:number}){
 const next=finite(value.scrollTop)+offset(value.cellTop)-offset(value.viewportTop)-offset(value.offset);
 return Math.max(0,Math.min(finite(value.maxScrollTop),next));
}
export const notebookSessionKey=(vaultId:string,path:string)=>JSON.stringify([vaultId,path]);
/** Hidden pages own no editor DOM. Only open notebook tabs keep small snapshots. */
export function retainNotebookSessions(store:Map<string,NotebookEditorSession>,files:readonly {vaultId:string;path:string}[]){
 const keys=new Set(files.map(file=>notebookSessionKey(file.vaultId,file.path)));for(const key of store.keys())if(!keys.has(key))store.delete(key);
}
export function remapNotebookSessions(store:Map<string,NotebookEditorSession>,vaultId:string,moves:readonly {from:string;to:string}[],removed:readonly string[]){
 const ordered=moves.filter(move=>move.from&&move.to&&move.from!==move.to).slice().sort((a,b)=>b.from.length-a.from.length),within=(value:string,parent:string)=>value===parent||value.startsWith(parent+'/');
 const migrated:Array<[string,NotebookEditorSession]>=[];
 for(const [key,value] of store){let identity:unknown;try{identity=JSON.parse(key);}catch{continue;}if(!Array.isArray(identity)||identity[0]!==vaultId||typeof identity[1]!=='string')continue;
  store.delete(key);const path=identity[1];if(removed.some(parent=>parent&&within(path,parent)))continue;const move=ordered.find(move=>within(path,move.from));migrated.push([notebookSessionKey(vaultId,move?move.to+path.slice(move.from.length):path),value]);
 }
 for(const [key,value]of migrated)store.set(key,value);
}

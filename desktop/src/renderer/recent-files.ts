// Local navigation history stores references only, never document content.
export type RecentFile={path:string;openedAt:string};
export type FileHistory=Record<string,RecentFile[]>;
export const historyKey='inkspace.workspace.recentFiles.v1';
export const maxHistoryBytes=256*1024;
const maxVaults=8,maxFiles=12;
const validID=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9_-]{1,160}$/i.test(value);
const validDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const byteLength=(value:string)=>new TextEncoder().encode(value).length;
// Match the backend's Mac relative-path boundary; trailing spaces and dots are
// valid filename characters and must never be trimmed from a saved reference.
export function safeRecentPath(value:unknown):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\\\x00-\x1f\x7f-\x9f:]/.test(value)&&!value.startsWith('/')&&
  !value.split('/').some(part=>!part||part==='.'||part==='..'||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function boundedHistory(entries:Array<[string,unknown]>):FileHistory{
 const result:Array<[string,RecentFile[]]>=[];let bytes=2;
 for(const [id,items] of entries){
  if(!validID(id)||!Array.isArray(items))continue;if(result.length===maxVaults)break;
  const files:RecentFile[]=[],seen=new Set<string>();let entryBytes=byteLength(JSON.stringify(id))+3+(result.length?1:0);
  for(const value of items){
   if(!value||typeof value!=='object'||!safeRecentPath(value.path)||!validDate(value.openedAt)||seen.has(value.path))continue;
   const file={path:value.path,openedAt:value.openedAt},fileBytes=byteLength(JSON.stringify(file))+(files.length?1:0);
   if(bytes+entryBytes+fileBytes>maxHistoryBytes)break;
   files.push(file);seen.add(file.path);entryBytes+=fileBytes;if(files.length===maxFiles)break;
  }
  if(bytes+entryBytes>maxHistoryBytes)break;
  result.push([id,files]);bytes+=entryBytes;
 }
 return Object.fromEntries(result);
}
export function parseFileHistory(raw:string|null):FileHistory{
 try{
  if(!raw||raw.length>maxHistoryBytes||byteLength(raw)>maxHistoryBytes)return{};
  const data:unknown=JSON.parse(raw);if(!data||Array.isArray(data)||typeof data!=='object')return{};
  return boundedHistory(Object.entries(data));
 }catch{return{};}
}
export function rememberFile(history:FileHistory,id:string,path:string,now=new Date().toISOString()):FileHistory{
 if(!validID(id)||!safeRecentPath(path)||!validDate(now))return history;
 const previous=Object.hasOwn(history,id)&&Array.isArray(history[id])?history[id]:[];
 return boundedHistory([[id,[{path,openedAt:now},...previous.filter(file=>file.path!==path)]],...Object.entries(history).filter(([key])=>key!==id)]);
}
export function remapRecentFiles(history:FileHistory,id:string,moves:Array<{from:string;to:string}>,removed:string[]):FileHistory{
 if(!validID(id)||!Object.hasOwn(history,id)||!Array.isArray(history[id]))return history;
 const ordered=moves.filter(move=>safeRecentPath(move.from)&&safeRecentPath(move.to)).sort((a,b)=>b.from.length-a.from.length),deleted=removed.filter(safeRecentPath);
 const files=history[id].filter(file=>!deleted.some(path=>file.path===path||file.path.startsWith(path+'/'))).map(file=>{
  const match=ordered.find(move=>file.path===move.from||file.path.startsWith(move.from+'/'));
  return {path:match?match.to+file.path.slice(match.from.length):file.path,openedAt:file.openedAt};
 });
 return boundedHistory(Object.entries(history).map(([key,value])=>[key,key===id?files:value]));
}

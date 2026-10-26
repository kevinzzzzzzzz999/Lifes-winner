'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{isDeepStrictEqual}=require('node:util');
const {fail}=require('./errors.cjs'),{validateBoard}=require('./board-validation.cjs');
const SHA=/^[a-f0-9]{64}$/,MAX_COMPARE_BYTES=96*1024*1024,MAX_ROWS=200;
function parse(bytes){let board;try{board=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes),(_k,v)=>{if(typeof v==='number'&&Number.isInteger(v)&&!Number.isSafeInteger(v))fail('INVALID_BOARD');return v;});}catch{fail('INVALID_BOARD');}validateBoard(board);return board;}
function shape(board){return{title:board.title,revision:board.revision,items:board.items.length,edges:board.edges.length,pins:board.pins.length,webStrokes:board.webInk?.strokes?.length||0,nativeInk:typeof board.drawing==='string'&&board.drawing.length>0,paper:typeof board.background?.kind==='string'?board.background.kind.slice(0,64):'original'};}
const fieldLabels={title:'标题',text:'文字',richTextHTML:'富文本',textFormat:'文字格式',x:'横坐标',y:'纵坐标',width:'宽度',height:'高度',style:'样式',sourcePath:'来源',originalSourcePath:'原件',sourceReference:'原文摘录',page:'页码',url:'网址',inkData:'原始笔迹',childBoards:'子白板'};
function diffBoards(before,after){
 const changes=[],result={before:shape(before),after:shape(after),items:{added:0,removed:0,changed:0},edges:{added:0,removed:0,changed:0},pins:{added:0,removed:0,changed:0},nativeInkChanged:before.drawing!==after.drawing,webInkChanged:!isDeepStrictEqual(before.webInk,after.webInk),paperChanged:!isDeepStrictEqual(before.background,after.background),viewportChanged:!isDeepStrictEqual(before.viewport,after.viewport),titleChanged:before.title!==after.title,otherFields:[],details:changes,detailsLimited:false};
 for(const kind of ['items','edges','pins']){
  const a=new Map(before[kind].map(v=>[v.id.toLowerCase(),v])),b=new Map(after[kind].map(v=>[v.id.toLowerCase(),v]));
  const add=(change,entry,old)=>{result[kind][change]++;if(changes.length<MAX_ROWS){const fields=old?[...new Set([...Object.keys(old),...Object.keys(entry)])].filter(k=>!isDeepStrictEqual(old[k],entry[k])).map(k=>fieldLabels[k]||k).slice(0,30):[];const text=v=>typeof v?.text==='string'?v.text.slice(0,2000):'';changes.push({kind,change,id:entry.id,title:String(entry.title||entry.id).slice(0,200),fields,beforeText:text(old),afterText:change==='removed'?'':text(entry),textPreviewLimited:(old?.text?.length||0)>2000||(entry?.text?.length||0)>2000});}else result.detailsLimited=true;};
  for(const[id,old]of a){const next=b.get(id);if(!next)add('removed',old,old);else if(!isDeepStrictEqual(old,next))add('changed',next,old);}
  for(const[id,next]of b)if(!a.has(id))add('added',next,null);
 }
 const named=new Set(['id','writerID','revision','createdAt','updatedAt','title','items','edges','pins','drawing','webInk','background','viewport','previewPNG']);
 result.otherFields=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>!named.has(k)&&!isDeepStrictEqual(before[k],after[k])).map(k=>k.slice(0,100));
 return result;
}
class BoardVersions{
 constructor(vaults){this.vaults=vaults;this.history=vaults.boardHistory;}
 async context(request){
  if(!SHA.test(request.expectedSHA256||''))fail('INVALID_REQUEST');
  await this.history.directories();const scope=await this.history.scope(request),snap=await this.vaults.snapshot(request,this.history.limits.maxObjectBytes);
  if(snap.sha256!==request.expectedSHA256)fail('CONFLICT');const board=parse(snap.data);let record=await this.history.record(scope);
  // A new whiteboard may reuse an old filename. Keep its predecessor's private
  // history intact, but do not expose those snapshots as versions of this board.
  if(record&&record.boardID.toLowerCase()!==board.id.toLowerCase())record=null;
  const versions=[...new Set((record?.steps||[]).flatMap(step=>[step.beforeSHA256,step.afterSHA256]))].reverse();
  return{snap,board,record,versions};
 }
 async bytes(context,sha){if(!SHA.test(sha||''))fail('INVALID_REQUEST');if(sha===context.snap.sha256)return context.snap.data;if(!context.versions.includes(sha))fail('PATH_DENIED');return this.history.object(sha);}
 async list(request){return this.history.locked(async()=>{
  const c=await this.context(request),entries=[{sha256:c.snap.sha256,current:true,available:true,bytes:c.snap.data.length,recordedAt:c.board.updatedAt}],warnings=[];
  for(const sha of c.versions){if(sha===c.snap.sha256)continue;try{const file=path.join(this.history.root,'objects',sha+'.bin'),st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>this.history.limits.maxObjectBytes)throw Error('Invalid history object');entries.push({sha256:sha,current:false,available:true,bytes:st.size,recordedAt:st.mtime.toISOString()});}catch{entries.push({sha256:sha,current:false,available:false,bytes:0,recordedAt:null});warnings.push('Some local snapshots are unavailable. The current whiteboard was not changed.');}}
  return{path:request.path,expectedSHA256:c.snap.sha256,summary:shape(c.board),entries,warnings:[...new Set(warnings)],localOnly:true};
 });}
 async compare(request){return this.history.locked(async()=>{
  const c=await this.context(request),a=await this.bytes(c,request.fromSHA256),b=await this.bytes(c,request.toSHA256);
  if(a.length+b.length>MAX_COMPARE_BYTES)fail('TOO_LARGE');const before=parse(a),after=parse(b);if(before.id.toLowerCase()!==c.board.id.toLowerCase()||after.id.toLowerCase()!==c.board.id.toLowerCase())fail('CONFLICT');
  const diff=diffBoards(before,after);const current=await this.vaults.snapshot(request,this.history.limits.maxObjectBytes);if(current.sha256!==c.snap.sha256)fail('CONFLICT');return{...diff,fromSHA256:request.fromSHA256,toSHA256:request.toSHA256,expectedSHA256:c.snap.sha256};
 });}
 async restoreCopy(request){return this.vaults.locked(request.vaultId+':file-management',()=>this.history.locked(async()=>{
  const c=await this.context(request),bytes=await this.bytes(c,request.versionSHA256);let old=parse(bytes);
  if(old.id.toLowerCase()!==c.board.id.toLowerCase())fail('CONFLICT');
  const name=request.name;if(typeof name!=='string'||!name.endsWith('.inkspace.json')||name.startsWith('.')||name.includes('/')||name.includes('\\')||name.includes('\0')||Buffer.byteLength(name)>240)fail('INVALID_REQUEST');
  const {relativePath}=require('./vault-service.cjs');relativePath(name);const parent=path.posix.dirname(request.path)==='.'?'':path.posix.dirname(request.path),nextPath=parent?parent+'/'+name:name;if(nextPath===request.path)fail('INVALID_REQUEST');
  // Historical objects stay immutable. Only the new copy follows an exact,
  // checksum-verified PNG organization receipt; a changed attachment stops it.
  old=await require('./png-organization-service.cjs').remapHistoricalBoard(this.vaults,{vaultId:request.vaultId,path:request.path},old);validateBoard(old);
  // A missing attachment must not turn an apparently complete recovery into a broken copy.
  const resolver=require('./board-source-resolver.cjs');
  const sources=new Set();for(const item of old.items){if(item.sourcePath)sources.add(item.sourcePath);if(item.originalSourcePath)sources.add(item.originalSourcePath);if(item.sourceReference?.path)sources.add(item.sourceReference.path);for(const child of item.childBoards||[])sources.add(child.path);}for(const source of old.pdfAnnotationSources||[])sources.add(source.sourcePath);
  if(sources.size>2000)fail('TOO_LARGE');
  for(const sourcePath of sources)await resolver.resolveSourceInBoard(this.vaults,{vaultId:request.vaultId,boardPath:request.path,expectedBoardSHA256:c.snap.sha256,sourcePath},old,{timeoutMs:15000});
  const ownerIDs=[...new Set([old.id,...(old.pdfMergedOwnerIDs||[])].map(id=>id.toLowerCase()))];if(ownerIDs.length>128)fail('TOO_LARGE');
  const now=new Date().toISOString(),next={...old,id:crypto.randomUUID(),title:old.title.slice(0,9980)+' · 版本副本',revision:0,writerID:await this.vaults.writerID(),createdAt:now,updatedAt:now,pdfMergedOwnerIDs:ownerIDs};validateBoard(next);
  const latest=await this.vaults.snapshot(request,this.history.limits.maxObjectBytes);if(latest.sha256!==c.snap.sha256)fail('CONFLICT');
  const result=await this.vaults.createData(request.vaultId,parent,name,Buffer.from(JSON.stringify(next)));
  return{...result,sourceSHA256:request.versionSHA256,sourceUnchanged:true,independentRecordsNotCopied:true};
 }));}
}
const instances=new WeakMap();function boardVersions(vaults){let instance=instances.get(vaults);if(!instance){instance=new BoardVersions(vaults);instances.set(vaults,instance);}return instance;}
module.exports={BoardVersions,boardVersions,diffBoards};

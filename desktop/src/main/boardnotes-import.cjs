'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{Worker}=require('node:worker_threads');
const {fail,AppError}=require('./errors.cjs'),{relativePath}=require('./vault-path.cjs'),{validateBoard}=require('./board-validation.cjs');
const {safeName}=require('./boardnotes-zip.cjs');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function bad(){fail('BOARDNOTES_INVALID');}
function scalarRecord(record,keys){
 if(!object(record))bad();const allowed=new Set(keys.split(' '));
 for(const [key,value] of Object.entries(record)){
  if(value!==null&&typeof value==='object'&&!(Array.isArray(value)&&value.length===0))fail('BOARDNOTES_UNSUPPORTED');
  if(!allowed.has(key)&&value!==null&&value!==false&&value!==0&&value!==''&&!(Array.isArray(value)&&value.length===0))fail('BOARDNOTES_UNSUPPORTED');
 }
}
function extract(data,signal){return new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(Object.assign(Error(),{code:'CANCELLED'}));
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');try{const entries=require(workerData.module).decodeEntries(Buffer.from(workerData.data));parentPort.postMessage({ok:true,entries:[...entries]});}catch(e){parentPort.postMessage({ok:false,code:e.code||'BOARDNOTES_INVALID'});}`,{eval:true,workerData:{module:require.resolve('./boardnotes-zip.cjs'),data}});
 let ended=false,timer;const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);void worker.terminate();error?reject(error):resolve(value);};
 const cancel=()=>finish(Object.assign(Error(),{code:'CANCELLED'}));signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>finish(Object.assign(Error(),{code:'TOO_LARGE'})),90000);
 worker.on('message',r=>r.ok?finish(null,new Map(r.entries.map(([name,bytes])=>[name,Buffer.from(bytes)]))):finish(Object.assign(Error(),{code:r.code})));
 worker.on('error',()=>finish(Object.assign(Error(),{code:'BOARDNOTES_RUNTIME'})));worker.on('exit',()=>{if(!ended)finish(Object.assign(Error(),{code:'BOARDNOTES_RUNTIME'}));});
 });}
function inspect(entries){
 const raw=entries.get('jsonData.data');if(!raw||raw.length>4*1024*1024)bad();let meta;try{meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{bad();}
 if(!object(meta)||!object(meta.board)||meta.board.type!==0||meta.board.isDel!==0||!Array.isArray(meta.boardFile)||!object(meta.boardCanvas))fail('BOARDNOTES_UNSUPPORTED');
 // Empty optional arrays are harmless; nonempty unrecognized object collections
 // must be supported deliberately, never silently omitted from a success board.
 const allowed=new Set(['board','boardFile','boardDrawingHistory','boardCanvas']);for(const [k,v] of Object.entries(meta))if(!allowed.has(k)&&v!=null&&!(Array.isArray(v)&&v.length===0))fail('BOARDNOTES_UNSUPPORTED');
 scalarRecord(meta.board,'id userID noteTopLayerType isDel noteListSelectIndex noteBottomLayerType notePage type isDirty noteScrollMode createTime favoriteState noteDisplayMode recordName updateTime');
 const canvas=meta.boardCanvas;scalarRecord(canvas,'updateTime bgStyle isDel showLineState userID offsetX backgroundType zoomScale boardID isDirty lineSpaceState lockState offsetY id createTime recordName');if([canvas.bgStyle,canvas.backgroundType,canvas.showLineState].some(v=>v!==undefined&&v!==0))fail('BOARDNOTES_UNSUPPORTED');
 if(typeof meta.board.recordName!=='string'||!meta.board.recordName||canvas.boardID!==meta.board.recordName)bad();
 for(const f of meta.boardFile){if(!object(f)||![0,1].includes(f.isDel))bad();scalarRecord(f,'boardID fileName fileType isDirty id recordName isDel updateTime userID');}
 const files=meta.boardFile.filter(v=>v.isDel===0),current=files.filter(v=>v.fileType===1);if(current.length!==1)fail('BOARDNOTES_UNSUPPORTED');
 const fileNames=new Set();for(const f of files){if(!object(f)||![0,1].includes(f.fileType)||typeof f.fileName!=='string'||f.boardID!==meta.board.recordName)fail('BOARDNOTES_UNSUPPORTED');safeName(f.fileName);if(f.fileName.includes('/')||fileNames.has(f.fileName))bad();fileNames.add(f.fileName);if(!entries.has(f.fileName))bad();}
 const drawing=entries.get(current[0].fileName);if(!current[0].fileName.endsWith('.data')||drawing.length>40*1024*1024)fail('TOO_LARGE');
 const history=meta.boardDrawingHistory??[];if(!Array.isArray(history)||history.length>2000)bad();for(const f of history){scalarRecord(f,'id fileName count boardID createTime');if(!object(f)||typeof f.fileName!=='string'||f.boardID!==meta.board.recordName)bad();safeName(f.fileName);if(!entries.has(f.fileName))bad();}
 const previews=[];for(const f of files.filter(v=>v.fileType===0)){const bytes=entries.get(f.fileName),info=require('./image-import.cjs').imageInfo(bytes);if(!['png','jpg'].includes(info.extension))bad();previews.push({name:f.fileName,bytes,info});}
 return{meta,drawing,currentName:current[0].fileName,history,previews,unreferenced:[...entries.keys()].filter(n=>n!=='jsonData.data'&&!fileNames.has(n)&&!history.some(h=>h.fileName===n))};
}
function titleOf(name){if(typeof name!=='string'||path.basename(name)!==name||!name.toLowerCase().endsWith('.boardnotes'))fail('INVALID_REQUEST');const stem=name.slice(0,-11).trim();return([...stem].slice(0,72).join('')||'BoardNotes').replace(/[\x00-\x1f/\\:]/g,'_');}
function inspectIndex(raw,index){
 if(!raw||raw.length>4*1024*1024)bad();let meta;try{meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{bad();}
 if(!object(meta)||!object(meta.board)||meta.board.type!==0||meta.board.isDel!==0||!Array.isArray(meta.boardFile)||!object(meta.boardCanvas))fail('BOARDNOTES_UNSUPPORTED');
 const allowed=new Set(['board','boardFile','boardDrawingHistory','boardCanvas','boardRecord','boardContent','pdfPage','pdfOutLine']);for(const [k,v]of Object.entries(meta))if(!allowed.has(k)&&v!=null&&!(Array.isArray(v)&&!v.length))fail('BOARDNOTES_UNSUPPORTED');
 scalarRecord(meta.board,'id userID noteTopLayerType isDel noteListSelectIndex noteBottomLayerType notePage type isDirty noteScrollMode createTime favoriteState noteDisplayMode recordName updateTime title');
 const canvas=meta.boardCanvas;scalarRecord(canvas,'updateTime bgStyle isDel showLineState userID offsetX backgroundType zoomScale boardID isDirty lineSpaceState lockState offsetY id createTime recordName');if([canvas.bgStyle,canvas.backgroundType,canvas.showLineState].some(v=>v!==undefined&&v!==0))fail('BOARDNOTES_UNSUPPORTED');
 if(typeof meta.board.recordName!=='string'||!meta.board.recordName||canvas.boardID!==meta.board.recordName)bad();
 for(const f of meta.boardFile){if(!object(f)||![0,1].includes(f.isDel))bad();scalarRecord(f,'boardID fileName fileType isDirty id recordName isDel updateTime userID relPdfID');}
 const files=meta.boardFile.filter(f=>f.isDel===0),current=files.filter(f=>f.fileType===1);if(current.length!==1)fail('BOARDNOTES_UNSUPPORTED');const seen=new Set();
 const member=name=>{safeName(name);if(name.includes('/')||!index.has(name)||index.get(name).directory)bad();return index.get(name);};
 for(const f of files){if(![0,1,2].includes(f.fileType)||typeof f.fileName!=='string'||f.boardID!==meta.board.recordName)fail('BOARDNOTES_UNSUPPORTED');member(f.fileName);if(seen.has(f.fileName))bad();seen.add(f.fileName);}
 const currentName=current[0].fileName;if(!currentName.endsWith('.data')||member(currentName).expanded>40*1024*1024)fail('BOARDNOTES_CONTENT_LIMIT');
 const history=meta.boardDrawingHistory??[];if(!Array.isArray(history)||history.length>2000)bad();for(const f of history){scalarRecord(f,'id fileName count boardID createTime');if(typeof f.fileName!=='string'||f.boardID!==meta.board.recordName)bad();member(f.fileName);}
 const objects=require('./boardnotes-objects.cjs').planObjects(meta,index),previews=files.filter(f=>[0,2].includes(f.fileType));
 const needed=new Set(['jsonData.data',currentName,...previews.map(f=>f.fileName),...objects.resourceNames]);
 return{meta,currentName,history,previews,objects,needed,unreferenced:[...index.keys()].filter(n=>!needed.has(n)&&!history.some(h=>h.fileName===n))};
}
function extractFile(file,directory,names,signal,resourceTypes={}){return new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(Object.assign(Error(),{code:'CANCELLED'}));
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');require(workerData.module).extractSelected(workerData.file,workerData.directory,workerData.names,{resourceTypes:workerData.resourceTypes}).then(files=>parentPort.postMessage({ok:true,files}),e=>parentPort.postMessage({ok:false,code:e.code||'BOARDNOTES_INVALID'}));`,{eval:true,workerData:{module:require.resolve('./boardnotes-file-zip.cjs'),file,directory,names:[...names],resourceTypes}});
 let ended=false,timer;const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);void worker.terminate().then(()=>error?reject(error):resolve(value));};const cancel=()=>finish(Object.assign(Error(),{code:'CANCELLED'}));signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>finish(Object.assign(Error(),{code:'FILE_SCAN_TIMEOUT'})),15*60*1000);
 worker.on('message',r=>r.ok?finish(null,r.files):finish(Object.assign(Error(),{code:r.code})));worker.on('error',()=>finish(Object.assign(Error(),{code:'BOARDNOTES_RUNTIME'})));worker.on('exit',()=>{if(!ended)finish(Object.assign(Error(),{code:'BOARDNOTES_RUNTIME'}));});
});}
async function importBoardNotes({snapshot,name,directory,parentPath='',writerID,revalidate=async()=>{},nativeInkBridge,signal}){
 const {walkFile,copyVerified}=require('./exchange-stream.cjs'),{verifyDirectory,verifyOwnedFile}=require('./exchange-file-identity.cjs');const os=require('node:os');
 let phase='prepare-source',completedResult=null;
 const diagnostics=(reason,rollback='not-started',committed=false)=>({operation:'boardnotes-import',phase,reason,rollback,committed});
 if(!snapshot||typeof snapshot.sha256!=='string')bad();relativePath(parentPath,true);const title=titleOf(name);if(!nativeInkBridge?.apply)fail('BOARDNOTES_RUNTIME');
 const initial=await fs.lstat(directory);if(!initial.isDirectory()||initial.isSymbolicLink())fail('PATH_DENIED');
 const check=async(options={})=>{if(signal?.aborted)fail('CANCELLED');await revalidate(options);const now=await fs.lstat(directory);if(!now.isDirectory()||now.isSymbolicLink()||now.dev!==initial.dev||now.ino!==initial.ino)fail('CONFLICT');};
 await check();const temp=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-boardnotes-read-'));let archiveFile=snapshot.file,output,outputIdentity,stage,stageIdentity;const published=[],staged=[];
 try{
  if(Buffer.isBuffer(snapshot.data)){if(hash(snapshot.data)!==snapshot.sha256)bad();archiveFile=path.join(temp,'source');await fs.writeFile(archiveFile,snapshot.data,{flag:'wx',mode:0o600});}
  if(typeof archiveFile!=='string')bad();const verified=await walkFile(archiveFile,{signal});if(verified.sha256!==snapshot.sha256)bad();
  phase='read-archive';const archive=await require('./boardnotes-file-zip.cjs').openArchive(archiveFile,{signal});let parsed;
  try{const index=new Map(archive.entries.map(e=>[e.name,e]));if(!index.has('jsonData.data'))bad();parsed=inspectIndex(await archive.readEntry(index.get('jsonData.data')),index);}finally{await archive.close();}
  phase='extract-content';const extractedDir=path.join(temp,'entries');await fs.mkdir(extractedDir,{mode:0o700});const resourceTypes=Object.fromEntries([...parsed.objects.resourceNames.map(n=>[n,n.toLowerCase().endsWith('.pdf')?'pdf':'image']),...parsed.previews.map(p=>[p.fileName,'image'])]);const extracted=await extractFile(archiveFile,extractedDir,parsed.needed,signal,resourceTypes),resources=new Map(extracted.map(e=>[e.name,{...e,file:path.join(extractedDir,e.filename)}]));await check();
  phase='convert-ink';const board=require('./board-elements.cjs').newBoard(title,writerID);board.items=[];board.drawing=(await fs.readFile(resources.get(parsed.currentName).file)).toString('base64');
  let ink;const cancelInk=()=>nativeInkBridge.cancel?.();signal?.addEventListener('abort',cancelInk,{once:true});try{ink=await nativeInkBridge.apply({board,operation:{kind:'importDrawing',...(parsed.objects.bounds?{rect:parsed.objects.bounds}:{})}});}finally{signal?.removeEventListener('abort',cancelInk);}
  if(!ink||typeof ink.drawing!=='string'||!ink.webInk||!Number.isSafeInteger(ink.importedStrokeCount)||!Array.isArray(ink.importTranslation))bad();board.drawing=ink.drawing;board.webInk=ink.webInk;if(ink.lastInkLocation)board.lastInkLocation=ink.lastInkLocation;
  // The short-lived extraction worker validates resources before the native ink
  // conversion. Only small metadata survives; image/PDF allocations are released.
  phase='prepare-assets';const assets=new Map();for(const source of parsed.objects.resourceNames){const resource=resources.get(source),extension=source.toLowerCase().endsWith('.pdf')?'pdf':resource.info.extension;assets.set(source,{...resource,filename:'资源-'+String(assets.size+1).padStart(5,'0')+'.'+extension});}
  await check();
  phase='create-output';for(let n=0;n<1000;n++){const folder=title+'（BoardNotes）'+(n?' ('+(n+1)+')':''),candidate=path.join(directory,folder);try{await fs.mkdir(candidate,{mode:0o700});output=candidate;outputIdentity=await fs.lstat(output);break;}catch(e){if(e.code!=='EEXIST')throw e;}}if(!output)fail('EXISTS');
  const rel=[parentPath,path.basename(output)].filter(Boolean).join('/');const mapped=require('./boardnotes-objects.cjs').mapObjects(parsed.objects,{translation:ink.importTranslation,sourcePrefix:rel,assets,placementAnchor:'topLeft'});board.items=mapped.items;
  const focus=ink.lastInkLocation??ink.importedBounds??board.items[0];board.viewport=focus?{x:focus.x+focus.width/2,y:focus.y+focus.height/2,zoom:1}:{x:512,y:512,zoom:1};
  const all=[...(ink.importedBounds?[ink.importedBounds]:[]),...board.items];if(all.length){const x=Math.min(...all.map(i=>i.x)),y=Math.min(...all.map(i=>i.y)),right=Math.max(...all.map(i=>i.x+i.width)),bottom=Math.max(...all.map(i=>i.y+i.height));board.pins=[{id:crypto.randomUUID(),title:'笔记总览 / Overview',x:(x+right)/2,y:(y+bottom)/2,zoom:Math.min(1,1000/Math.max(right-x,bottom-y))}];}
  const report={schemaVersion:1,format:'BoardNotes',supportedContent:board.items.length?'handwriting-and-positioned-content':'handwriting-whiteboard',currentStrokes:ink.importedStrokeCount,controlPoints:ink.importedControlPointCount,historyFiles:parsed.history.length,assets:assets.size,objects:board.items.length,previewFiles:parsed.previews.length,unreferencedFiles:parsed.unreferenced.length,sourceSHA256:snapshot.sha256,sourceMetadataFile:'BoardNotes原始元数据.json',currentDrawing:parsed.currentName,translation:ink.importTranslation,sourceCanvas:parsed.meta.boardCanvas,notes:['Current editable PencilKit handwriting is imported at its original scale.','History versions and unreferenced files are retained in the unchanged original archive, not overlaid.','Preview/derived image variants are not duplicated on the canvas. Original JSON metadata is retained alongside the original archive.',...(mapped.notes??[])]};
  board.boardNotesImport={schemaVersion:1,sourceSHA256:snapshot.sha256,originalName:name,currentDrawing:parsed.currentName,translation:ink.importTranslation,metadataPath:rel+'/BoardNotes原始元数据.json'};validateBoard(board);const boardBytes=Buffer.from(JSON.stringify(board));if(boardBytes.length>64*1024*1024)fail('BOARDNOTES_CONTENT_LIMIT');
  phase='stage-content';stage=path.join(directory,'.inkspace-boardnotes-'+crypto.randomUUID()+'.tmp');await fs.mkdir(stage,{mode:0o700});stageIdentity=await fs.lstat(stage);
  const stageCheck=()=>verifyDirectory(stage,stageIdentity);
  const write=async(file,data)=>{await stageCheck();const h=await fs.open(path.join(stage,file),'wx',0o600);let stat;const sha256=hash(data);try{await h.writeFile(data);await h.sync();stat=await h.stat();staged.push({path:path.join(stage,file),stat,sha256});}finally{await h.close();}await stageCheck();return{file,sha256,stat};};
  const copy=async(file,source,sha256)=>{await stageCheck();const result=await copyVerified(source,path.join(stage,file),{sha256,signal});const stat=result.destinationStat;staged.push({path:path.join(stage,file),stat,sha256});await stageCheck();return{file,sha256,stat};};
  const payloads=[await copy('原始文件.boardNotes',archiveFile,snapshot.sha256),await write('导入说明.json',Buffer.from(JSON.stringify(report,null,2))),await copy('BoardNotes原始元数据.json',resources.get('jsonData.data').file,resources.get('jsonData.data').sha256)];
  for(const resource of assets.values())payloads.push(await copy(resource.filename,resource.file,resource.sha256));
  for(let i=0;i<parsed.previews.length;i++){const resource=resources.get(parsed.previews[i].fileName);payloads.push(await copy('封面预览'+(i+1)+'.'+resource.info.extension,resource.file,resource.sha256));}
  const boardFile=await write(title+'.inkspace.json',boardBytes);
  const outputCheck=async options=>{await check(options);const s=await fs.lstat(output);if(!s.isDirectory()||s.isSymbolicLink()||s.dev!==outputIdentity.dev||s.ino!==outputIdentity.ino)fail('CONFLICT');};
  for(const file of [...payloads,boardFile]){
   phase=file===boardFile?'verify-source':'publish-content';await outputCheck(file===boardFile?{fullHash:true}:{});await stageCheck();const source=path.join(stage,file.file);
   const verified=await verifyOwnedFile(source,{identity:file.stat,sha256:file.sha256,directory:{path:stage,identity:stageIdentity},signal});file.stat=verified.stat;
   phase='publish-content';const dest=path.join(output,file.file);await fs.link(source,dest);const stat=await fs.lstat(dest),publishedFile={path:dest,stat,sha256:file.sha256};published.push(publishedFile);
   // Hardlink creation itself changes ctime. Recheck bytes while accepting only
   // metadata changes; a different inode or different content still aborts.
   const checked=await verifyOwnedFile(dest,{identity:file.stat,sha256:file.sha256,directory:{path:output,identity:outputIdentity},signal});publishedFile.stat=checked.stat;
   const stagedFile=staged.find(f=>f.path===source);stagedFile.stat=checked.stat;
  }
  completedResult={path:rel+'/'+boardFile.file,archivePath:rel+'/原始文件.boardNotes',manifestPath:rel+'/导入说明.json',sha256:boardFile.sha256,bytes:boardBytes.length,report};return completedResult;
 }catch(error){
  const failurePhase=phase;let unsafe=false;
  for(const f of [...published].reverse()){
   try{await verifyOwnedFile(f.path,{identity:f.stat,sha256:f.sha256,forceHash:true,directory:{path:output,identity:outputIdentity}});await fs.unlink(f.path);}
   catch(e){if(e.code!=='ENOENT'&&e.transactionReason!=='file-missing')unsafe=true;}
  }
  if(output)try{await verifyDirectory(output,outputIdentity);await fs.rmdir(output);}catch(e){if(e.code!=='ENOENT'&&e.transactionReason!=='directory-missing')unsafe=true;}
  const resultError=unsafe?new AppError('FILE_OPERATION_RECOVERY'):error;resultError.diagnostic={...diagnostics(error.transactionReason||error.code||'IO_FAILED',unsafe?'incomplete':output?'complete':'not-started'),phase:failurePhase};throw resultError;
 }finally{
  if(stage){const cleanupReasons=[];
   try{await verifyDirectory(stage,stageIdentity);
    for(const f of staged){try{await verifyOwnedFile(f.path,{identity:f.stat,sha256:f.sha256,directory:{path:stage,identity:stageIdentity}});await fs.unlink(f.path);}catch(e){if(e.code!=='ENOENT'&&e.transactionReason!=='file-missing')cleanupReasons.push(e.transactionReason||e.code||'IO_FAILED');}}
    try{await verifyDirectory(stage,stageIdentity);await fs.rmdir(stage);}catch(e){if(e.code!=='ENOENT'&&e.transactionReason!=='directory-missing')cleanupReasons.push(e.transactionReason||e.code||'IO_FAILED');}
   }catch(e){if(e.code!=='ENOENT'&&e.transactionReason!=='directory-missing')cleanupReasons.push(e.transactionReason||e.code||'IO_FAILED');}
   if(cleanupReasons.length){
    const detail={...diagnostics(cleanupReasons[0],completedResult?'not-needed':'incomplete',!!completedResult),phase:'cleanup',retainedTemporaryDirectory:stage};
    if(completedResult){
     // Cleanup can fail because a provider or another process replaced a stage
     // entry. Success is still valid only if every published byte remains ours.
     try{for(const f of published)await verifyOwnedFile(f.path,{identity:f.stat,sha256:f.sha256,forceHash:true,directory:{path:output,identity:outputIdentity}});}
     catch(cause){await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});const error=new AppError('FILE_OPERATION_RECOVERY');error.diagnostic={...detail,reason:'published-content-unverified',verificationReason:cause.transactionReason||cause.code||'IO_FAILED',rollback:'not-started'};throw error;}
     completedResult.diagnostic=detail;completedResult.report.notes.push('白板已完整导入。临时清理时发现文件身份或内容变化，已保留相关临时文件；请勿重复导入。 / The board was imported completely. Changed temporary files were preserved during cleanup; do not repeat the import.');
    }
    else{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});const error=new AppError('FILE_OPERATION_RECOVERY');error.diagnostic=detail;throw error;}
   }
  }
  await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
 }

}
module.exports={importBoardNotes,inspect,inspectIndex,extract,extractFile,titleOf};

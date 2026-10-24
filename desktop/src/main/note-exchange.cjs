'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {constants}=require('node:fs');const {fail,publicError}=require('./errors.cjs');
const {relativePath}=require('./vault-path.cjs');
const {FILE_BYTES,BATCH_BYTES,snapshotFile,copyVerified}=require('./exchange-stream.cjs');
const {verifyOwnedFile}=require('./exchange-file-identity.cjs');
const LIMITS=Object.freeze({fileBytes:FILE_BYTES,batchBytes:BATCH_BYTES,files:100,validationBytes:128*1024*1024});
const FORMATS=new Set(['.pdf','.png','.jpg','.jpeg','.md','.markdown','.txt','.m4a','.mp3','.wav','.aac','.mp4','.goodnotes','.note','.nbn','.boardnotes','.one','.onetoc2','.onepkg','.zip']);
const ARCHIVES=new Set(['.goodnotes','.note','.nbn','.boardnotes','.one','.onetoc2','.onepkg','.zip']);
const APPS=new Set(['boardnotes','goodnotes','notability','onenote','other']);
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function app(value){if(!APPS.has(value))fail('INVALID_REQUEST');return value;}
function classify(name){const ext=path.extname(name).toLowerCase();if(!FORMATS.has(ext))fail('UNSUPPORTED');return{ext,archive:ARCHIVES.has(ext),readable:['.pdf','.png','.jpg','.jpeg','.md','.markdown','.txt'].includes(ext)};}
function safeName(name){relativePath(name);if(name.includes('/')||name.startsWith('.')||Buffer.byteLength(name)>240)fail('PATH_DENIED');return name;}
function numbered(name,n){if(!n)return name;const extension=name.toLowerCase().endsWith('.inkspace.json')?'.inkspace.json':path.extname(name);return name.slice(0,-extension.length)+' ('+(n+1)+')'+extension;}
async function validateContent(data,ext,imageDecoder){
 if(ext==='.pdf'){
  if(!data.subarray(0,1024).includes(Buffer.from('%PDF-'))||!data.subarray(Math.max(0,data.length-2048)).includes(Buffer.from('%%EOF')))fail('INTEROP_INVALID_CONTENT');
  try{const pdf=await require('pdf-lib').PDFDocument.load(data,{ignoreEncryption:false,updateMetadata:false,throwOnInvalidObject:true});if(pdf.isEncrypted)fail('INTEROP_ENCRYPTED');const count=pdf.getPageCount();if(!count||count>5000)fail('TOO_LARGE');}catch(error){if(error.name==='EncryptedPDFError'||/encrypted/i.test(error.message||''))fail('INTEROP_ENCRYPTED');if(error.code)throw error;fail('INTEROP_INVALID_CONTENT');}
 }
 if(['.png','.jpg','.jpeg'].includes(ext)){
  let info;try{info=require('./image-import.cjs').imageInfo(data);}catch(error){if(error.code==='TOO_LARGE')throw error;fail('INTEROP_INVALID_CONTENT');}
  if(info.extension!==(ext==='.png'?'png':'jpg'))fail('INTEROP_INVALID_CONTENT');
  if(imageDecoder&&!imageDecoder(data,info))fail('INTEROP_INVALID_CONTENT');
 }
 if(['.md','.markdown','.txt'].includes(ext)){if(data.length>4*1024*1024)fail('TOO_LARGE');try{const text=new TextDecoder('utf-8',{fatal:true}).decode(data);if(text.includes('\0'))fail('INVALID_TEXT');}catch{fail('INVALID_TEXT');}}
}
async function externalSnapshot(full,options){return snapshotFile(full,options);}
async function validateSnapshot(snapshot,ext,imageDecoder){
 if(!['.pdf','.png','.jpg','.jpeg','.md','.markdown','.txt'].includes(ext))return;
 const maximum=['.md','.markdown','.txt'].includes(ext)?4*1024*1024:LIMITS.validationBytes;if(snapshot.bytes>maximum)fail('INTEROP_DECODE_LIMIT');
 await validateContent(await fs.readFile(snapshot.file),ext,imageDecoder);
}
async function createUniqueSnapshot(directory,name,snapshot,revalidate=async()=>{}){
 safeName(name);const first=await fs.lstat(directory);if(!first.isDirectory()||first.isSymbolicLink())fail('PATH_DENIED');const temp=path.join(directory,'.inkspace-exchange-'+crypto.randomUUID()+'.tmp');let identity;
 try{identity=(await copyVerified(snapshot.file,temp,{sha256:snapshot.sha256})).destinationStat;await revalidate();const now=await fs.lstat(directory);if(!now.isDirectory()||now.isSymbolicLink()||now.dev!==first.dev||now.ino!==first.ino)fail('CONFLICT');await verifyOwnedFile(temp,{identity,sha256:snapshot.sha256,directory:{path:directory,identity:first}});for(let n=0;n<1000;n++){const candidate=numbered(name,n);try{const dest=path.join(directory,candidate);await fs.link(temp,dest);const published=await fs.lstat(dest);if(published.dev!==identity.dev||published.ino!==identity.ino)fail('FILE_OPERATION_RECOVERY');return candidate;}catch(error){if(error.code!=='EEXIST')throw error;}}fail('EXISTS');
 }finally{if(identity){let unsafe=false;try{await verifyOwnedFile(temp,{identity,sha256:snapshot.sha256,directory:{path:directory,identity:first}});await fs.unlink(temp);}catch(error){if(error.code!=='ENOENT')unsafe=true;}if(unsafe)fail('FILE_OPERATION_RECOVERY');}}
}
// Create-only publication: a hidden complete file is linked to an unused name. Existing names are never replaced.
async function createUnique(directory,name,data,revalidate=async()=>{}){
 safeName(name);const first=await fs.lstat(directory);if(!first.isDirectory()||first.isSymbolicLink())fail('PATH_DENIED');const temp=path.join(directory,'.inkspace-exchange-'+crypto.randomUUID()+'.tmp');const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
 try{await revalidate();const current=await fs.lstat(directory);if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==first.dev||current.ino!==first.ino)fail('CONFLICT');for(let n=0;n<1000;n++){const candidate=numbered(name,n);try{await fs.link(temp,path.join(directory,candidate));return candidate;}catch(error){if(error.code!=='EEXIST')throw error;}}fail('EXISTS');}finally{await fs.unlink(temp).catch(()=>{});}
}
class NoteExchange{
 constructor(vaults,{imageDecoder,diagnosticsDirectory,onError}={}){this.vaults=vaults;this.imageDecoder=imageDecoder;this.diagnosticsDirectory=diagnosticsDirectory;this.onError=onError;this.busy=false;}
 async recordFailure(error,name,parentPath){
  this.onError?.('importNoteExchange',error);
  const input=error?.diagnostic;if(!input||input.operation!=='boardnotes-import')return undefined;
  const bounded=value=>typeof value==='string'?value.slice(0,120):undefined;
  const recovery={id:crypto.randomUUID(),phase:bounded(input.phase),reason:bounded(input.reason),rollback:bounded(input.rollback),committed:input.committed===true,recordSaved:false,...(typeof input.retainedTemporaryDirectory==='string'?{retainedTemporaryDirectory:input.retainedTemporaryDirectory.slice(0,4096)}:{})};
  if(this.diagnosticsDirectory)try{await fs.mkdir(this.diagnosticsDirectory,{recursive:true,mode:0o700});const parent=await fs.lstat(this.diagnosticsDirectory);if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Unsupported recovery directory');const recordPath=path.join(this.diagnosticsDirectory,recovery.id+'.json');await fs.writeFile(recordPath,JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),operation:'boardnotes-import',name,parentPath,error:publicError(error),...recovery,recordSaved:true},null,2),{flag:'wx',mode:0o600});recovery.recordSaved=true;recovery.recordPath=recordPath;}catch{this.onError?.('noteImportRecovery',Object.assign(Error(),{code:'IO_FAILED'}));}
  return recovery;
 }
 async exclusive(fn){if(this.busy)fail('BUSY');this.busy=true;try{return await fn();}finally{this.busy=false;}}
 async import(request,{dialog,window}){
  app(request.source);relativePath(request.parentPath,true);await this.vaults.resolve(request.vaultId,request.parentPath,{directory:true});
  return this.exclusive(async()=>{const choice=await dialog.showOpenDialog(window,{title:'Import notes / 导入笔记',properties:['openFile','multiSelections'],filters:[{name:'Notes / 笔记',extensions:[...FORMATS].map(x=>x.slice(1))}]});if(choice.canceled)return{cancelled:true,results:[]};return this.importSelected(request,choice.filePaths);});
 }
 async importSelected(request,files){
  app(request.source);relativePath(request.parentPath,true);if(!Array.isArray(files)||files.length>LIMITS.files)fail('TOO_LARGE');let total=0;const results=[];
  for(const full of files){const name=path.basename(full);let snapshot;try{safeName(name);const format=classify(name),size=(await fs.lstat(full)).size;if(size>LIMITS.fileBytes||total+size>LIMITS.batchBytes)fail('TOO_LARGE');snapshot=await externalSnapshot(full,{maxBytes:Math.min(LIMITS.fileBytes,LIMITS.batchBytes-total)});total+=snapshot.bytes;await validateSnapshot(snapshot,format.ext,this.imageDecoder);
    const dest=await this.vaults.resolve(request.vaultId,request.parentPath,{directory:true});
    if(format.ext==='.boardnotes'){
      const converted=await require('./boardnotes-import.cjs').importBoardNotes({snapshot,name,directory:dest.full,parentPath:request.parentPath,writerID:await this.vaults.writerID(),nativeInkBridge:this.vaults.nativeInkBridge,revalidate:async(options={})=>{await snapshot.revalidate(options);await this.vaults.resolve(request.vaultId,request.parentPath,{directory:true});}});
      if(converted.diagnostic)converted.recovery=await this.recordFailure(Object.assign(Error(),{code:'FILE_OPERATION_RECOVERY',diagnostic:converted.diagnostic}),name,request.parentPath);
      results.push({name,...converted,status:'imported',readable:true,bytes:snapshot.bytes,sourceSHA256:snapshot.sha256,note:'boardnotes-native'});continue;
    }
    const imported=await createUniqueSnapshot(dest.full,name,snapshot,async()=>{await snapshot.revalidate({fullHash:true});await this.vaults.resolve(request.vaultId,request.parentPath,{directory:true});});const rel=[request.parentPath,imported].filter(Boolean).join('/');
    results.push({name,path:rel,status:format.archive?'archive':'imported',readable:format.readable,bytes:snapshot.bytes,sha256:snapshot.sha256,note:format.ext==='.zip'?'zip-preserved':format.archive?'private-preserved':'original-copy'});
   }catch(error){const recovery=await this.recordFailure(error,name,request.parentPath);results.push({name,status:'failed',readable:false,error:publicError(error),...(recovery?{recovery}:{})});}finally{await snapshot?.dispose();}}
  return{cancelled:false,results};
 }
 async outline(request){
  const snapshot=await this.vaults.snapshot(request,1024*1024);if(!['.md','.markdown'].includes(path.extname(request.path).toLowerCase()))fail('UNSUPPORTED');if(snapshot.sha256!==request.expectedSHA256)fail('CONFLICT');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(snapshot.data);}catch{fail('INVALID_TEXT');}
  const title=path.basename(request.path,path.extname(request.path)),board=require('./note-outline.cjs').outlineBoard(text,title,await this.vaults.writerID()),parent=path.posix.dirname(request.path)==='.'?'':path.posix.dirname(request.path),dest=await this.vaults.resolve(request.vaultId,parent,{directory:true});
  const name=await createUnique(dest.full,title.slice(0,100)+'.inkspace.json',Buffer.from(JSON.stringify(board)),async()=>{const fresh=await this.vaults.snapshot(request,1024*1024);if(fresh.sha256!==snapshot.sha256)fail('CONFLICT');await this.vaults.resolve(request.vaultId,parent,{directory:true});});return{path:[parent,name].filter(Boolean).join('/'),nodeCount:board.items.length};
 }
 async export(request,{dialog,window}){
  app(request.target);if(!Array.isArray(request.paths)||!request.paths.length||request.paths.length>LIMITS.files||new Set(request.paths).size!==request.paths.length)fail('INVALID_REQUEST');for(const p of request.paths)relativePath(p);if(!['original','outline'].includes(request.mode))fail('INVALID_REQUEST');
  return this.exclusive(async()=>{const chosen=await dialog.showOpenDialog(window,{title:'Choose export folder / 选择导出文件夹',properties:['openDirectory','createDirectory']});if(chosen.canceled)return{cancelled:true,results:[]};return this.exportSelected(request,chosen.filePaths[0]);});
 }
 async exportSelected(request,directory){
  app(request.target);const canonical=await fs.realpath(directory),stat=await fs.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())fail('PATH_DENIED');
  const label='人生赢家-'+request.target+'-'+new Date().toISOString().replace(/[:.]/g,'-');let output;for(let n=0;n<1000;n++){const candidate=path.join(canonical,label+(n?' ('+(n+1)+')':''));try{await fs.mkdir(candidate,{mode:0o700});output=candidate;break;}catch(e){if(e.code!=='EEXIST')throw e;}}if(!output)fail('EXISTS');
  const results=[];let total=0;
  for(const rel of request.paths){const name=path.posix.basename(rel);let diskSnapshot;try{let data,snapshot,outName=name,note='original-copy',exported,bytes,sha256;
   if(request.mode==='outline'){snapshot=await this.vaults.snapshot({vaultId:request.vaultId,path:rel},64*1024*1024);if(!rel.toLowerCase().endsWith('.inkspace.json'))fail('UNSUPPORTED');let board;try{board=JSON.parse(snapshot.data);}catch{fail('INVALID_BOARD');}data=Buffer.from(require('./note-outline.cjs').exportOutline(board).text);outName=name.slice(0,-'.inkspace.json'.length)+'.节点纲要.md';note='titles-only';bytes=data.length;if(total+bytes>LIMITS.batchBytes)fail('TOO_LARGE');total+=bytes;sha256=digest(data);
    exported=await createUnique(output,outName,data,async()=>{const fresh=await this.vaults.snapshot({vaultId:request.vaultId,path:rel},64*1024*1024);if(fresh.sha256!==snapshot.sha256)fail('CONFLICT');});
   }else{const format=classify(name),source=await this.vaults.resolve(request.vaultId,rel),size=(await fs.lstat(source.full)).size;if(size>LIMITS.fileBytes||total+size>LIMITS.batchBytes)fail('TOO_LARGE');diskSnapshot=await snapshotFile(source.full,{maxBytes:Math.min(LIMITS.fileBytes,LIMITS.batchBytes-total)});snapshot=diskSnapshot;total+=snapshot.bytes;await validateSnapshot(snapshot,format.ext,this.imageDecoder);note=format.ext==='.pdf'?'pdf-original-no-sidecars':format.archive?'private-preserved':'original-copy';bytes=snapshot.bytes;sha256=snapshot.sha256;
    exported=await createUniqueSnapshot(output,outName,snapshot,async()=>{const fresh=await this.vaults.resolve(request.vaultId,rel);if(fresh.full!==source.full)fail('CONFLICT');await snapshot.revalidate({fullHash:true});});
   }
   results.push({name,path:exported,status:'exported',readable:true,bytes,sha256,sourceSHA256:snapshot.sha256,note});
  }catch(error){results.push({name,status:'failed',readable:false,error:publicError(error)});}finally{await diskSnapshot?.dispose();}}
  const report={schemaVersion:1,createdAt:new Date().toISOString(),target:request.target,mode:request.mode,limits:LIMITS,notes:["PDF originals retain annotations already embedded in the PDF. Independent Life's winner layers/reviews, audio timing, and source-app editing objects are not flattened into these copies.",'Node outlines contain titles and tree hierarchy only; no handwriting, layout, rich text, media or attached files.','Source-app native formats are archived unchanged, not decoded or converted in this version. ZIP archives are not extracted.'],results};
  await createUnique(output,'exchange-manifest.json',Buffer.from(JSON.stringify(report,null,2)));return{cancelled:false,folderName:path.basename(output),results};
 }
}
module.exports={NoteExchange,LIMITS,FORMATS,ARCHIVES,externalSnapshot,createUnique,createUniqueSnapshot,classify,validateContent,validateSnapshot};

'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {PDFDocument}=require('pdf-lib');
const {relativePath}=require('./vault-path.cjs'),{fail}=require('./errors.cjs');
const MAX_PDF=128*1024*1024,MAX_REPORT=4*1024*1024;
const DIRECTORY='.inkspace-assets/onenote',PUBLICATION_VERSION='onenote-publication-v1';
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

// New local PDFs can receive metadata updates while the OS indexes them. Reuse
// the bounded reader retry, then independently require the original byte hash.
// Writer snapshots and the board's final CAS remain single-attempt operations.
const oneNoteSnapshot=(vaults,request,maximum)=>vaults.snapshotForRead(request,maximum);
async function verifyOneNoteSources(vaults,vaultId,sources){
 for(const source of sources){const current=await oneNoteSnapshot(vaults,{vaultId,path:source.path},source.maximum??MAX_PDF);if(current.sha256!==source.sha256)fail('CONFLICT');}
}

function oneNotePublicationLocation(request,sourceSHA256,{columns=2}={},version){
 relativePath(request.path);
 if(!request.path.toLowerCase().endsWith('.pdf')||!/^[a-f0-9]{64}$/.test(sourceSHA256||'')||!Number.isInteger(columns)||columns<1||columns>8)fail('INVALID_REQUEST');
 const rendererVersion=version??require('./onenote-pdf.cjs').VERSION;
 if(typeof rendererVersion!=='string'||rendererVersion.length<1||rendererVersion.length>128)fail('UNSUPPORTED');
 const identity={sourcePath:request.path,sourceSHA256,columns,rendererVersion,publicationVersion:PUBLICATION_VERSION};
 const key=digest(Buffer.from(JSON.stringify(identity))),folder=DIRECTORY+'/'+key;
 return{identity,key,folder,path:folder+'/continuous.pdf',reportPath:folder+'/report.json'};
}

async function directory(vaults,vaultId,rel){
 const parts=relativePath(rel).split('/'),held=[];
 for(let i=0;i<parts.length;i++){
  const parent=parts.slice(0,i).join('/'),current=parts.slice(0,i+1).join('/');
  const before=await vaults.resolve(vaultId,parent,{directory:true});
  try{await fs.mkdir(path.join(before.full,parts[i]),{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const after=await vaults.resolve(vaultId,parent,{directory:true});if(!same(before.stat,after.stat))fail('CONFLICT');
  const found=await vaults.resolve(vaultId,current,{directory:true});held.push({path:current,stat:found.stat});
 }
 const revalidate=async()=>{let result;for(const entry of held){result=await vaults.resolve(vaultId,entry.path,{directory:true});if(!same(result.stat,entry.stat))fail('CONFLICT');}return result;};
 return{...await revalidate(),path:rel,revalidate};
}
async function pdfInfo(data){
 let pdf;try{pdf=await PDFDocument.load(data,{updateMetadata:false,throwOnInvalidObject:true});}catch{fail('UNSUPPORTED');}
 if(pdf.isEncrypted||pdf.getPageCount()!==1)fail('UNSUPPORTED');
 const box=pdf.getPage(0).getCropBox();if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<=0||box.height<=0)fail('UNSUPPORTED');
 return pdf;
}
async function optional(vaults,request,maximum){try{return await oneNoteSnapshot(vaults,request,maximum);}catch(error){if(error.code==='ENOENT')return null;throw error;}}

// Only a byte-verified pair is reusable. A partial/changed pair is never repaired
// over an existing name. A different input/version gets a different identity.
async function existing(vaults,request,rel,identity){
 const pdf=await optional(vaults,{vaultId:request.vaultId,path:rel+'/continuous.pdf'},MAX_PDF);
 const metadata=await optional(vaults,{vaultId:request.vaultId,path:rel+'/report.json'},MAX_REPORT);
 if(!pdf&&!metadata)return{empty:true};
 if(!pdf||!metadata)return null;
 let record;try{record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(metadata.data));}catch{return null;}
 if(record?.schemaVersion!==1||JSON.stringify(record.identity)!==JSON.stringify(identity)||record.pdfSHA256!==pdf.sha256||!record.report||typeof record.report!=='object'||Array.isArray(record.report)||record.report.version!==identity.rendererVersion||record.report.sourceSha256!==identity.sourceSHA256||record.report.columns!==identity.columns||record.reportSHA256!==digest(Buffer.from(JSON.stringify(record.report))))return null;
 try{await pdfInfo(pdf.data);}catch{return null;}
 return{path:rel+'/continuous.pdf',sha256:pdf.sha256,reportPath:rel+'/report.json',reportSHA256:metadata.sha256,report:record.report,reused:true};
}
async function publishFile(vaults,request,folder,name,data,publications,checkSource){
 const rel=folder.path+'/'+name,temp=path.join(folder.full,'.inkspace-onenote-'+crypto.randomUUID()+'.tmp');
 await vaults.backup(rel,null,data);
 try{
  await require('./vault-service.cjs').durableWrite(temp,data);
  await folder.revalidate();await checkSource();
  await fs.link(temp,path.join(folder.full,name));publications.push({path:rel,sha256:digest(data)});
 }finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

async function publishOneNotePDF(vaults,request,snapshot,{columns=2}={},publications=[],implementation=null){
 relativePath(request.path);
 if(!request.path.toLowerCase().endsWith('.pdf')||request.path.split('/').some(part=>part.toLowerCase()==='.inkspace-reviews')||!Number.isInteger(columns)||columns<1||columns>8||!Buffer.isBuffer(snapshot?.data)||snapshot.data.length>MAX_PDF||!/^[a-f0-9]{64}$/.test(snapshot.sha256||'')||digest(snapshot.data)!==snapshot.sha256)fail('INVALID_REQUEST');
 const {buildOneNotePDF,VERSION}=implementation||require('./onenote-pdf.cjs');
 if(typeof buildOneNotePDF!=='function'||typeof VERSION!=='string'||VERSION.length<1||VERSION.length>128)fail('UNSUPPORTED');
 const {identity,key,folder:rel}=oneNotePublicationLocation(request,snapshot.sha256,{columns},VERSION);
 const checkSource=()=>verifyOneNoteSources(vaults,request.vaultId,[{path:request.path,sha256:snapshot.sha256}]);
 return vaults.locked(request.vaultId+':onenote:'+key,async()=>{
  await checkSource();await directory(vaults,request.vaultId,DIRECTORY);
  const folder=await directory(vaults,request.vaultId,rel);
  const prior=await existing(vaults,request,rel,identity);await folder.revalidate();await checkSource();
  if(prior&&!prior.empty)return prior;
  if(!prior)fail('CONFLICT');
  const built=await buildOneNotePDF(snapshot.data,{columns});
  if(!Buffer.isBuffer(built?.data)||!built.report||typeof built.report!=='object'||Array.isArray(built.report))fail('UNSUPPORTED');
  if(built.data.length>MAX_PDF)fail('TOO_LARGE');
  if(built.report.version!==VERSION||built.report.sourceSha256!==snapshot.sha256||built.report.columns!==columns)fail('CONFLICT');
  await pdfInfo(built.data);
  const sha256=digest(built.data),reportData=Buffer.from(JSON.stringify({schemaVersion:1,identity,pdfSHA256:sha256,reportSHA256:digest(Buffer.from(JSON.stringify(built.report))),report:built.report}));
  if(reportData.length>MAX_REPORT)fail('TOO_LARGE');
  const local=[];
  try{
   await publishFile(vaults,request,folder,'continuous.pdf',built.data,local,checkSource);
   await publishFile(vaults,request,folder,'report.json',reportData,local,checkSource);
   publications.push(...local);
   const checked=await existing(vaults,request,rel,identity);await folder.revalidate();await checkSource();
   if(!checked||checked.empty||checked.sha256!==sha256)fail('CONFLICT');
   return{...checked,reused:false};
  }catch(error){
   // Same {path,sha256} protocol as Excel: only our unchanged new files can
   // be removed. Reused or subsequently edited publications are retained.
   await vaults.excel.rollback(request.vaultId,local);
   if(error.code==='EEXIST')fail('CONFLICT');
   throw error;
  }
 });
}
module.exports={publishOneNotePDF,oneNotePublicationLocation,oneNoteSnapshot,verifyOneNoteSources,MAX_PDF,MAX_REPORT,DIRECTORY,PUBLICATION_VERSION};

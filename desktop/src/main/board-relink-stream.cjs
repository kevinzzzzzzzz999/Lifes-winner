'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {fail}=require('./errors.cjs');
const {walkFile,same}=require('./exchange-stream.cjs');
const {verifyOwnedFile}=require('./exchange-file-identity.cjs');
const MAX_SOURCE=8*1024*1024*1024, jobs=new WeakMap(), UUID=/^[a-f0-9-]{36}$/i;
function state(vaults){let map=jobs.get(vaults);if(!map){map=new Map();jobs.set(vaults,map);}return map;}
function jobKey(vaultId,requestId){if(typeof vaultId!=='string'||!UUID.test(requestId||''))fail('INVALID_REQUEST');return vaultId+':'+requestId;}
function current(vaults,vaultId,requestId){const job=state(vaults).get(jobKey(vaultId,requestId));if(!job||!job.active)fail('INVALID_REQUEST');return job;}
function abort(job){if(job?.controller.signal.aborted)fail('CANCELLED');}
async function withJob(vaults,vaultId,requestId,fn){
 const map=state(vaults),key=jobKey(vaultId,requestId);if(map.get(key)?.active)fail('BUSY');
 for(const [id,job] of map)if(!job.active)map.delete(id);if(map.size>=16)fail('BUSY');
 const job={active:true,phase:'checking',bytesDone:0,bytesTotal:0,cancellable:true,controller:new AbortController()};map.set(key,job);
 try{const value=await fn(job);job.phase='done';return value;}catch(error){job.phase=error.code==='CANCELLED'?'cancelled':'failed';throw error;}finally{job.active=false;job.cancellable=false;}
}
function progress(vaults,{vaultId,requestId}){const job=state(vaults).get(jobKey(vaultId,requestId));return job?{active:job.active,phase:job.phase,bytesDone:job.bytesDone,bytesTotal:job.bytesTotal,cancellable:job.cancellable}:{active:false,phase:'done',bytesDone:0,bytesTotal:0,cancellable:false};}
function cancel(vaults,{vaultId,requestId}){const job=state(vaults).get(jobKey(vaultId,requestId));if(job?.active&&job.cancellable){job.controller.abort();return{cancelled:true};}return{cancelled:false};}
async function snapshot(vaults,{vaultId,path:rel},job){
 abort(job);const resolved=await vaults.resolve(vaultId,rel);let header=Buffer.alloc(0);
 job.phase='hashing';job.bytesDone=0;job.bytesTotal=resolved.stat.size;
 const result=await walkFile(resolved.full,{maxBytes:MAX_SOURCE,expected:resolved.stat,signal:job.controller.signal,onChunk:(chunk,offset)=>{
  if(offset===0)header=Buffer.from(chunk.subarray(0,1024));job.bytesDone=offset+chunk.length;
 }});
 const checkPath=async()=>{abort(job);const latest=await vaults.resolve(vaultId,rel);if(latest.full!==resolved.full||latest.stat.dev!==result.stat.dev||latest.stat.ino!==result.stat.ino)fail('CONFLICT');return latest;};
 await checkPath();
 return {...result,full:resolved.full,header,revalidate:async()=>{
  job.phase='checking';await checkPath();
  const checked=await verifyOwnedFile(resolved.full,{identity:result.stat,sha256:result.sha256,allowLinks:false,maxBytes:MAX_SOURCE,signal:job.controller.signal,code:'CONFLICT'});
  await checkPath();abort(job);return checked;
 }};
}
async function pdfInfo(candidate,job,{runtimePath=process.env.INKSPACE_RELINK_PDF_INFO||path.join(process.resourcesPath||path.resolve(__dirname,'../..'),'runtime','relink-pdf-info','inkspace-relink-pdf-info')}={}){
 abort(job);job.phase='metadata';
 if(candidate.header.indexOf(Buffer.from('%PDF-'))<0)fail('INTEROP_INVALID_CONTENT');
 if(process.platform!=='darwin'){
  // Other platforms retain a bounded small-file fallback, never a course-sized read.
  if(candidate.bytes>8*1024*1024)fail('RELINK_PDF_METADATA_UNAVAILABLE');
  const h=await fs.open(candidate.full,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{if(!same(await h.stat(),candidate.stat))fail('CONFLICT');const bytes=await h.readFile();const pdf=await require('pdf-lib').PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});await candidate.revalidate();return{pageCount:pdf.getPageCount()};}finally{await h.close();}
 }
 try{await fs.access(runtimePath,constants.X_OK);}catch{fail('RELINK_PDF_METADATA_UNAVAILABLE');}
 const h=await fs.open(candidate.full,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  if(!same(await h.stat(),candidate.stat))fail('CONFLICT');
  const metadata=await new Promise((resolve,reject)=>{
   let child,timer,output='',errorBytes=0,finished=false;
   const complete=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);job.controller.signal.removeEventListener('abort',onAbort);if(error)reject(error);else resolve(value);};
   const error=code=>{try{fail(code);}catch(e){return e;}};
   const onAbort=()=>{child?.kill('SIGKILL');complete(error('CANCELLED'));};
   try{child=spawn(runtimePath,[],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe',h.fd]});}catch{return complete(error('RELINK_PDF_METADATA_UNAVAILABLE'));}
   timer=setTimeout(()=>{child.kill('SIGKILL');complete(error('FILE_SCAN_TIMEOUT'));},60000);
   job.controller.signal.addEventListener('abort',onAbort,{once:true});if(job.controller.signal.aborted)return onAbort();
   child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>4096){child.kill('SIGKILL');complete(error('INTEROP_INVALID_CONTENT'));}});
   child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes>65536){child.kill('SIGKILL');complete(error('INTEROP_INVALID_CONTENT'));}});
   child.on('error',()=>complete(error('RELINK_PDF_METADATA_UNAVAILABLE')));
   child.on('close',code=>{if(finished)return;try{const value=JSON.parse(output);if(value.error)fail(['INTEROP_ENCRYPTED','INTEROP_INVALID_CONTENT','RELINK_PAGE_MISSING'].includes(value.error)?value.error:'INTEROP_INVALID_CONTENT');if(code!==0||!Number.isInteger(value.pageCount)||value.pageCount<1)fail('INTEROP_INVALID_CONTENT');complete(null,value);}catch(e){complete(e);}});
  });
  await candidate.revalidate();return metadata;
 }finally{await h.close();}
}
module.exports={MAX_SOURCE,withJob,current,progress,cancel,snapshot,pdfInfo,abort};

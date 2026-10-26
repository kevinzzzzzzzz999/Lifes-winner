'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{constants}=require('node:fs');
const {fail}=require('./errors.cjs');
const {UUID,LIMITS}=require('./recognition-samples-model.cjs');
const SHA=/^[a-f0-9]{64}$/;
let globalLease=null;
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
class OCRSampleBridge{
 constructor({vaults,ocr,samples,runtimePath,dataDirectory,limits={},spawnProcess=spawn}){Object.assign(this,{vaults,ocr,samples,runtimePath,dataDirectory,spawnProcess});this.limits={timeoutMs:45000,outputBytes:65536,...limits};this.active=null;this.closed=false;this.completed=new Map();}
 check(run){if(this.closed||run.cancelled||this.active!==run)fail(run.cancelled||'CANCELLED');this.samples.alive(run.sampleRun);}
 stop(run,code='CANCELLED'){if(run.cancelled)return;run.cancelled=code;run.rejectStop?.(Object.assign(Error(code),{code}));if(run.child?.pid){run.child.kill('SIGTERM');run.killTimer=setTimeout(()=>{if(run.child.exitCode===null)run.child.kill('SIGKILL');},500);run.killTimer.unref?.();}}
 cancel({requestId}={}){if(!UUID.test(requestId||''))fail('INVALID_REQUEST');let cancelled=false;if(this.active?.requestId===requestId){this.stop(this.active);cancelled=true;}const made=this.completed.get(requestId);if(made){if(this.samples.pending?.token===made.token){this.samples.cancel();cancelled=true;}this.completed.delete(requestId);}return{cancelled};}
 cancelAll(){if(this.active)this.stop(this.active);for(const made of this.completed.values())if(this.samples.pending?.token===made.token)this.samples.cancel();this.completed.clear();}
 dispose(){this.closed=true;this.cancelAll();}
 async prepare(request){
  const {source,result}=this.ocr.result(request);const pdf=source.ext==='.pdf',requestId=request.requestId||crypto.randomUUID();
  if(!UUID.test(requestId)||pdf&&(!UUID.test(request.requestId||'')||!Number.isInteger(request.page)))fail('INVALID_REQUEST');
  let selected;if(pdf){if(result.cancelled||result.outputLimited)fail('LEARNING_OCR_PAGE');selected=result.pages.find(p=>p.page===request.page);if(!selected||selected.error||!selected.text.trim()||!result.requestedPages.includes(request.page))fail('LEARNING_OCR_PAGE');}
  if(this.closed)fail('CANCELLED');if(this.active||globalLease)fail('BUSY');
  const sampleRun=this.samples.begin(),run={requestId,sampleRun,cancelled:null,child:null,directory:null,draftToken:null};this.active=run;globalLease=run;
  const stopped=new Promise((_,reject)=>{run.rejectStop=reject;});const timer=setTimeout(()=>this.stop(run,'LEARNING_OCR_TIMEOUT'),this.limits.timeoutMs);timer.unref?.();
  const work=this.work(run,source,result,selected).finally(async()=>{
   clearTimeout(timer);clearTimeout(run.killTimer);
   try {
    if(run.directory)await fs.rm(run.directory,{recursive:true,force:true});
   } catch {
    if(run.draftToken&&this.samples.pending?.token===run.draftToken)this.samples.cancel();
    fail('LEARNING_OCR_CLEANUP');
   } finally {
    if(run.readSlot)this.samples.store.endRead(run.readSlot);
    if(run.sampleRun.lease&&this.samples.pending?.lease!==run.sampleRun.lease)this.samples.store.release(run.sampleRun.lease);
    if(this.samples.run===run.sampleRun)this.samples.run=null;
    if(this.active===run)this.active=null;if(globalLease===run)globalLease=null;
   }
  });
  // The caller can cancel promptly; the one underlying lease remains held until
  // its actual child/I/O and cleanup settle, preventing work accumulation.
  work.catch(()=>{});
  try{return await Promise.race([work,stopped]);}catch(error){if(run.draftToken&&this.samples.pending?.token===run.draftToken)this.samples.cancel();throw error;}
 }
 async work(run,source,result,selected){let success=false;
  try{
   let snapshot=await this.vaults.snapshot(source,source.ext==='.pdf'?256*1024*1024:12*1024*1024);this.check(run);if(snapshot.sha256!==result.sourceSHA256)fail('CONFLICT');
   let bytes,metadata;
   if(source.ext==='.pdf'){
    await fs.mkdir(path.join(this.dataDirectory,'ocr-learning-runs'),{recursive:true,mode:0o700});this.check(run);
    run.directory=await fs.mkdtemp(path.join(this.dataDirectory,'ocr-learning-runs','page-'));this.check(run);
    const input=path.join(run.directory,'source.pdf'),output=path.join(run.directory,'page.png');await fs.writeFile(input,snapshot.data,{flag:'wx',mode:0o600});snapshot=null;this.check(run);
    metadata=await this.execute(run,input,selected.page,output);this.check(run);
    if(!metadata||Object.keys(metadata).sort().join(',')!=='height,imageSHA256,page,sourceSHA256,width'||metadata.sourceSHA256!==result.sourceSHA256||metadata.page!==selected.page||!SHA.test(metadata.imageSHA256||'')||!Number.isInteger(metadata.width)||!Number.isInteger(metadata.height)||metadata.width<1||metadata.height<1||metadata.width>4096||metadata.height>4096||metadata.width*metadata.height>12000000)fail('LEARNING_OCR_FAILED');
    run.readSlot=this.samples.store.beginRead();bytes=await this.samples.store.readBounded(output,LIMITS.mediaBytes,{check:()=>this.check(run),onSize:size=>{this.check(run);run.sampleRun.lease=this.samples.store.reserve(size);}});this.check(run);if(hash(bytes)!==metadata.imageSHA256)fail('LEARNING_OCR_FAILED');
    const image=require('./image-import.cjs').imageInfo(bytes);if(image.width!==metadata.width||image.height!==metadata.height||image.mime!=='image/png'&&image.extension!=='png')fail('LEARNING_OCR_FAILED');
   }else bytes=snapshot.data;
   const after=await this.vaults.snapshot(source,source.ext==='.pdf'?256*1024*1024:12*1024*1024);this.check(run);if(after.sha256!==result.sourceSHA256)fail('CONFLICT');
   const suggestion=selected?selected.text:result.pages.map(p=>p.text).join('\n');
   const draft=this.samples.finish(run.sampleRun,'handwriting',bytes,'imported-image',suggestion);run.draftToken=draft.token;this.check(run);
   if(metadata&&(draft.width!==metadata.width||draft.height!==metadata.height||draft.sha256!==metadata.imageSHA256))fail('LEARNING_OCR_FAILED');
   const output=metadata?{...draft,temporaryProvenance:{kind:'pdf-page',page:selected.page,sourceSHA256:result.sourceSHA256,imageSHA256:metadata.imageSHA256,displayName:path.posix.basename(source.path),notPersisted:true}}:draft;
   for(const [id,v]of this.completed)if(Date.now()-v.createdAt>LIMITS.lifetimeMs)this.completed.delete(id);while(this.completed.size>=8)this.completed.delete(this.completed.keys().next().value);
   this.completed.set(run.requestId,{token:draft.token,createdAt:Date.now()});success=true;return output;
  }finally{
   if(!success&&this.samples.pending&&((run.draftToken&&this.samples.pending.token===run.draftToken)||(run.sampleRun.lease&&this.samples.pending.lease===run.sampleRun.lease)))this.samples.cancel();
  }
 }
 execute(run,input,page,output){return new Promise((resolve,reject)=>{
  let child;try{child=this.spawnProcess(this.runtimePath,['--learning-page',input,String(page),output],{cwd:run.directory,shell:false,stdio:['ignore','pipe','pipe'],env:{LANG:'en_US.UTF-8',TMPDIR:run.directory}});}catch{reject(Object.assign(Error('LEARNING_OCR_FAILED'),{code:'LEARNING_OCR_FAILED'}));return;}run.child=child;
  let bytes=0,chunks=[],spawnError=false;const collect=(data,keep)=>{bytes+=data.length;if(bytes>this.limits.outputBytes){this.stop(run,'LEARNING_OCR_LIMIT');return;}if(keep)chunks.push(data);};child.stdout.on('data',d=>collect(d,true));child.stderr.on('data',d=>collect(d,false));
  child.once('error',()=>{spawnError=true;if(child.pid)child.kill('SIGKILL');else reject(Object.assign(Error('LEARNING_OCR_FAILED'),{code:'LEARNING_OCR_FAILED'}));});
  child.once('close',code=>{clearTimeout(run.killTimer);if(run.cancelled)return reject(Object.assign(Error(run.cancelled),{code:run.cancelled}));if(spawnError||code!==0)return reject(Object.assign(Error('LEARNING_OCR_FAILED'),{code:'LEARNING_OCR_FAILED'}));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Object.assign(Error('LEARNING_OCR_FAILED'),{code:'LEARNING_OCR_FAILED'}));}});
 });}
}
module.exports={OCRSampleBridge};

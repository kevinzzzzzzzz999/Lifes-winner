'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {relativePath}=require('./vault-path.cjs'),{fail}=require('./errors.cjs');
const LIMITS={pdfBytes:256*1024*1024,imageBytes:64*1024*1024,maxPages:10,timeoutMs:90000,outputBytes:2*1024*1024,resultLifetimeMs:15*60*1000};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function target(request){
 if(typeof request?.vaultId!=='string')fail('INVALID_REQUEST');const rel=relativePath(request.path);
 if(rel.split('/').some(part=>part.startsWith('.')))fail('PATH_DENIED');
 const ext=path.extname(rel).toLowerCase();if(!['.pdf','.png','.jpg','.jpeg'].includes(ext))fail('UNSUPPORTED');
 return{vaultId:request.vaultId,path:rel,ext};
}
function validatedResult(value,start,end){
 if(!value||!Number.isSafeInteger(value.pageCount)||value.pageCount<1||!Array.isArray(value.requestedPages)||!Array.isArray(value.pages)||value.pages.length>LIMITS.maxPages||value.requestedPages.length>LIMITS.maxPages||typeof value.cancelled!=='boolean'||typeof value.outputLimited!=='boolean')fail('OCR_FAILED');
 const expected=Array.from({length:end-start+1},(_,i)=>start+i);if(JSON.stringify(value.requestedPages)!==JSON.stringify(expected)||end>value.pageCount)fail('OCR_FAILED');
 const seen=new Set();let chars=0;const pages=value.pages.map(page=>{
  if(!Number.isSafeInteger(page?.page)||!expected.includes(page.page)||seen.has(page.page)||typeof page.text!=='string'||page.text.includes('\0')||(page.error!=null&&typeof page.error!=='string'))fail('OCR_FAILED');
  seen.add(page.page);chars+=Array.from(page.text).length;if(chars>200000||Array.from(page.text).length>30000)fail('OCR_FAILED');
  const boxes=page.boxes??[];if(!Array.isArray(boxes)||boxes.length>30000)fail('OCR_FAILED');let boxChars=0;
  for(const box of boxes){if(!box||typeof box.text!=='string'||box.text.includes('\0')||!['x','y','width','height'].every(key=>typeof box[key]==='number'&&Number.isFinite(box[key]))||box.x<0||box.y<0||box.width<=0||box.height<=0||box.x+box.width>1.001||box.y+box.height>1.001||(box.rotation!=null&&![0,90,180,270].includes(box.rotation)))fail('OCR_FAILED');boxChars+=box.text.length;if(boxChars>60000)fail('OCR_FAILED');}
  if(boxes.length&&boxes.map(b=>b.text).join('\n')!==page.text)fail('OCR_FAILED');
  return{page:page.page,text:page.text,boxes:boxes.map(({text,x,y,width,height,rotation})=>({text,x,y,width,height,...(rotation?{rotation}:{})})),...(page.error?{error:page.error.slice(0,500)}:{})};
 });
 if(!value.cancelled&&!value.outputLimited&&pages.length!==expected.length)fail('OCR_FAILED');
 return{pageCount:value.pageCount,requestedPages:expected,pages,cancelled:value.cancelled,outputLimited:value.outputLimited};
}
// The bundled CLI historically uses a page message for both true no-text and
// failures. Normalize only its exact known no-text sentinel; unknown messages
// fail conservatively and never masquerade as an empty successful recognition.
const EMPTY_PAGE_MESSAGE='这一页未识别到文字；请检查清晰度、方向和原文内容。';
function boardTextResult(result){
 if(result.cancelled)fail('CANCELLED');
 if(result.outputLimited)fail('OCR_OUTPUT_LIMIT');
 const page=result.pages[0];if(!page)fail('OCR_FAILED');
 const empty=page.text===''&&page.boxes.length===0;
 if(page.error&&!(empty&&page.error===EMPTY_PAGE_MESSAGE))fail('OCR_FAILED');
 if(!empty&&!page.boxes.length)fail('OCR_FAILED');
 return page.error?{...result,pages:[{...page,error:undefined}]}:result;
}
const plainText=result=>result.pages.map(page=>`[${page.page}]\n${page.text}${page.error?'\n'+page.error:''}`).join('\n\n');
class LocalOCRService{
 constructor({vaults,runtimePath,dataDirectory,limits={}}){this.vaults=vaults;this.runtimePath=runtimePath;this.dataDirectory=dataDirectory;this.limits={...LIMITS,...limits};this.active=null;this.results=new Map();}
 async info(){let available=false;try{const stat=await fs.lstat(this.runtimePath);available=stat.isFile()&&!stat.isSymbolicLink();}catch{}return{available,maxPages:LIMITS.maxPages,pdfMiB:256,imageMiB:64,timeoutSeconds:Math.ceil(this.limits.timeoutMs/1000)};}
 prune(){for(const[id,result]of this.results)if(Date.now()-result.createdAt>this.limits.resultLifetimeMs)this.results.delete(id);}
 stop(run,code='CANCELLED'){if(run.stopped)return;run.stopped=code;run.reject?.(Object.assign(Error(code),{code}));if(run.child?.pid){run.child.kill('SIGTERM');run.killTimer=setTimeout(()=>{if(run.child.exitCode===null)run.child.kill('SIGKILL');},500);run.killTimer.unref?.();}}
 cancel(request){if(!UUID.test(request?.requestId||''))fail('INVALID_REQUEST');if(this.active?.requestId===request.requestId)this.stop(this.active);return{cancelled:true};}
 cancelAll(){if(this.active)this.stop(this.active);}
 async recognize(request){
  const source=target(request),start=request.startPage,end=request.endPage;
  if(!UUID.test(request.requestId||'')||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end-start+1>LIMITS.maxPages||end>100000||(source.ext!=='.pdf'&&(start!==1||end!==1)))fail('INVALID_REQUEST');
  return this.recognizeSnapshot(request,source,start,end,()=>this.vaults.snapshot(source,source.ext==='.pdf'?this.limits.pdfBytes:this.limits.imageBytes));
 }
 async recognizeBoardText(request,{nativeImage}){
  if(!UUID.test(request?.requestId||'')||typeof request.imageDataURL!=='string'||request.imageDataURL.length>8*1024*1024||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(request.imageDataURL))fail('INVALID_REQUEST');
  if(request.customWords!=null&&(!Array.isArray(request.customWords)||request.customWords.length>200||request.customWords.some(word=>typeof word!=='string'||Array.from(word).length>80||word.includes('\0'))))fail('INVALID_REQUEST');
  const encoded=request.imageDataURL.slice(22),data=Buffer.from(encoded,'base64');if(data.toString('base64')!==encoded)fail('INVALID_REQUEST');const size=require('./image-import.cjs').imageInfo(data);
  if(size.width>4096||size.height>4096||size.width*size.height>12000000)fail('TOO_LARGE');
  const image=nativeImage.createFromBuffer(data),decoded=image.getSize();if(image.isEmpty()||decoded.width!==size.width||decoded.height!==size.height)fail('INVALID_REQUEST');
  return boardTextResult(await this.recognizeSnapshot(request,{vaultId:'board-selection',path:'selection.png',ext:'.png'},1,1,async()=>({data,sha256:crypto.createHash('sha256').update(data).digest('hex')}),false));
 }
 async recognizeSnapshot(request,source,start,end,snapshotFactory,retain=true){
  if(this.active)fail('BUSY');if(!(await this.info()).available)fail('OCR_UNAVAILABLE');if(this.active)fail('BUSY');
  const run={requestId:request.requestId,child:null,stopped:null,killTimer:null};this.active=run;let directory,timer;
  // A single deadline includes iCloud materialization, staging and Vision work.
  const stopped=new Promise((_,reject)=>{run.reject=reject;});
  timer=setTimeout(()=>this.stop(run,'OCR_TIMEOUT'),this.limits.timeoutMs);timer.unref?.();
  const checked=async promise=>{const value=await Promise.race([promise,stopped]);if(run.stopped)fail(run.stopped);return value;};
  try{
   const snapshot=await checked(snapshotFactory());
   const staging=path.join(this.dataDirectory,'ocr-runs');await checked(fs.mkdir(staging,{recursive:true,mode:0o700}));
   directory=await fs.mkdtemp(path.join(staging,'recognize-'));if(run.stopped)fail(run.stopped);
   const input=path.join(directory,'source'+source.ext);await checked(fs.writeFile(input,snapshot.data,{flag:'wx',mode:0o600}));
   const wordsPath=path.join(directory,'words.json');if(request.customWords?.length)await checked(fs.writeFile(wordsPath,JSON.stringify(request.customWords),{flag:'wx',mode:0o600}));
   const output=await checked(new Promise((resolve,reject)=>{
    const child=spawn(this.runtimePath,[input,String(start),String(end),...(request.customWords?.length?[wordsPath]:[])],{cwd:directory,shell:false,stdio:['ignore','pipe','pipe'],env:{LANG:'en_US.UTF-8',TMPDIR:directory}});run.child=child;
    let bytes=0,chunks=[];const collect=(data,keep)=>{bytes+=data.length;if(bytes>this.limits.outputBytes){this.stop(run,'OCR_OUTPUT_LIMIT');return;}if(keep)chunks.push(data);};
    child.stdout.on('data',data=>collect(data,true));child.stderr.on('data',data=>collect(data,false));child.once('error',()=>reject(Object.assign(Error('OCR_FAILED'),{code:'OCR_FAILED'})));child.once('close',code=>{clearTimeout(run.killTimer);if(run.stopped)reject(Object.assign(Error(run.stopped),{code:run.stopped}));else if(code!==0){let errorCode='OCR_FAILED';try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(['OCR_PAGE_RANGE','OCR_LOCKED','TOO_LARGE','OCR_UNAVAILABLE','UNSUPPORTED'].includes(value.errorCode))errorCode=value.errorCode;}catch{}reject(Object.assign(Error(errorCode),{code:errorCode}));}else resolve(Buffer.concat(chunks).toString('utf8'));});
   }));
   let value;try{value=JSON.parse(output);}catch{fail('OCR_FAILED');}
   const result={id:crypto.randomUUID(),sourcePath:source.path,sourceSHA256:snapshot.sha256,...validatedResult(value,start,end)};
   this.prune();while(this.results.size>=8)this.results.delete(this.results.keys().next().value);if(retain)this.results.set(result.id,{...result,vaultId:source.vaultId,createdAt:Date.now()});return result;
  }finally{clearTimeout(timer);if(this.active===run)this.active=null;if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
 }
 result(request){const source=target(request);if(!UUID.test(request.resultId||''))fail('INVALID_REQUEST');this.prune();const result=this.results.get(request.resultId);if(!result||result.vaultId!==source.vaultId||result.sourcePath!==source.path)fail('OCR_RESULT_EXPIRED');return{source,result};}
 copy(request,clipboard){const{result}=this.result(request);clipboard.writeText(plainText(result));return{copied:true};}
 async save(request){
  const{source,result}=this.result(request);
  return this.vaults.locked(source.vaultId+':ocr:'+result.id,async()=>{
   let readTimer;const snapshot=await Promise.race([this.vaults.snapshot(source,source.ext==='.pdf'?this.limits.pdfBytes:this.limits.imageBytes),new Promise((_,reject)=>{readTimer=setTimeout(()=>reject(Object.assign(Error('OCR_TIMEOUT'),{code:'OCR_TIMEOUT'})),this.limits.timeoutMs);readTimer.unref?.();})]).finally(()=>clearTimeout(readTimer));if(snapshot.sha256!==result.sourceSHA256)fail('CONFLICT');
   const parent=path.posix.dirname(source.path)==='.'?'':path.posix.dirname(source.path),base=Array.from(path.posix.basename(source.path)).slice(0,120).join('');
   const content=`# OCR · ${base.replace(/[\r\n]/g,' ')}\n\n[Source / 原文件](${encodeURIComponent(path.posix.basename(source.path))})\n\n> Local OCR / 本机文字识别。请核对识别结果。\n> SHA-256: ${result.sourceSHA256}\n${result.outputLimited?'> Output was limited / 识别结果达到长度上限。\n':''}\n`+result.pages.map(page=>`## ${page.page}\n\n${page.text}${page.error?'\n\n> '+page.error:''}`).join('\n\n')+'\n';
   for(let attempt=0;attempt<3;attempt++){const name=base+(attempt?'.ocr-'+crypto.randomUUID().slice(0,8):'.ocr')+'.md';try{return await this.vaults.createTextFile({vaultId:source.vaultId,parentPath:parent,name,content});}catch(error){if(error.code!=='EXISTS'&&error.code!=='EEXIST')throw error;}}
   fail('EXISTS');
  });
 }
 dispose(){this.cancelAll();this.results.clear();}
}
module.exports={LocalOCRService,LIMITS,target,validatedResult,plainText,boardTextResult,EMPTY_PAGE_MESSAGE};

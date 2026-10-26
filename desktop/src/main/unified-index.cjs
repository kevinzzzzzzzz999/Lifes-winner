'use strict';
const fs=require('node:fs/promises'),fss=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Worker}=require('node:worker_threads'),{execFile}=require('node:child_process');
const {fail}=require('./errors.cjs'),{LocalOCRService,EMPTY_PAGE_MESSAGE}=require('./local-ocr-service.cjs');
const MiB=1024*1024,SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9-]{36}$/i;
const LIMITS={indexBytes:32*MiB,files:5000,dirs:1000,depth:16,pagesPerRound:100,ocrFiles:30,ms:600000,text:2*MiB,board:32*MiB,notebook:128*MiB,pdf:64*MiB,image:16*MiB,ioMs:8000};
const skip=new Set(['node_modules','backups','backup','local-backups','text-backups']);
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const safe=p=>typeof p==='string'&&p.length>0&&p.length<=4096&&!p.includes('\\')&&!p.includes('\0')&&!path.posix.isAbsolute(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..');
function typeOf(p){const low=p.toLowerCase();if(low.endsWith('.inkspace.json'))return'board';const ext=path.extname(low);return ext==='.ipynb'?'notebook':ext==='.pdf'?'pdf':['.png','.jpg','.jpeg'].includes(ext)?'image':['.md','.markdown','.txt','.tex','.py','.js','.ts','.html','.htm','.csv','.tsv'].includes(ext)?'text':null;}
const flags=full=>new Promise((resolve,reject)=>execFile('/usr/bin/stat',['-f','%f',full],{timeout:2000,maxBuffer:128,encoding:'utf8'},(e,out)=>e?reject(e):/^\d+\s*$/.test(out)?resolve(Number(out.trim())):reject(Error('flags'))));
function validIndex(v,key){
 if(!v||![1,2].includes(v.version)||v.key!==key||!UUID.test(v.generation||'')||!Array.isArray(v.documents)||v.documents.length>LIMITS.files||!v.coverage||typeof v.updatedAt!=='string')fail('SEARCH_PROTECTED');
 const seen=new Set();for(const d of v.documents){if(!safe(d.path)||seen.has(d.path)||!['text','board','notebook','pdf','image'].includes(d.kind)||!SHA.test(d.sha256||'')||!Array.isArray(d.segments)||d.segments.length>100000||(d.boardID!==undefined&&!UUID.test(d.boardID))||typeof d.complete!=='boolean'||!Number.isSafeInteger(d.nextPage)||d.nextPage<1)fail('SEARCH_PROTECTED');seen.add(d.path);for(const s of d.segments){if(s.stale!==undefined&&typeof s.stale!=='boolean')fail('SEARCH_PROTECTED');if(s.origin!==undefined&&(s.origin!=='board-image-ocr'||d.kind!=='board'||!UUID.test(d.boardID||'')||!UUID.test(s.nodeID||'')||!safe(s.imagePath)||!SHA.test(s.imageSHA256||'')))fail('SEARCH_PROTECTED');if(s.origin===undefined&&(s.imagePath!==undefined||s.imageSHA256!==undefined))fail('SEARCH_PROTECTED');if(typeof s.text!=='string'||s.text.length>32*MiB||(s.page!==undefined&&(!Number.isSafeInteger(s.page)||s.page<1))||(s.nodeID!==undefined&&!UUID.test(s.nodeID))||(s.cell!==undefined&&(!Number.isSafeInteger(s.cell)||s.cell<1||s.cell>1000))||(s.rect!==undefined&&(!s.rect||!['x','y','width','height'].every(k=>Number.isFinite(s.rect[k]))||s.rect.x<0||s.rect.y<0||s.rect.width<=0||s.rect.height<=0||s.rect.x+s.rect.width>1.001||s.rect.y+s.rect.height>1.001)))fail('SEARCH_PROTECTED');}}
 for(const d of v.documents)if(d.embeddedOCRVersion!==undefined){if(d.kind!=='board'||d.embeddedOCRVersion!==1||!Array.isArray(d.embeddedImages)||d.embeddedImages.length>50000)fail('SEARCH_PROTECTED');const seen=new Set();for(const image of d.embeddedImages){if(!UUID.test(image.nodeID||'')||seen.has(image.nodeID)||!safe(image.imagePath)||!['pending','complete','unavailable','not-downloaded','unsupported'].includes(image.state)||(image.state==='complete'&&!SHA.test(image.imageSHA256||''))||(image.imageSHA256!==undefined&&!SHA.test(image.imageSHA256)))fail('SEARCH_PROTECTED');seen.add(image.nodeID);}const bindings=new Set(d.embeddedImages.map(i=>i.nodeID+'\0'+i.imagePath));for(const seg of d.segments)if(seg.origin==='board-image-ocr'&&!bindings.has(seg.nodeID+'\0'+seg.imagePath))fail('SEARCH_PROTECTED');}
 return v;
}
class UnifiedIndex{
 constructor({vaults,dataDirectory,runtimePath,limits={},platform=process.platform,flagsGetter=flags,ocr,extractor}={}){
  Object.assign(this,{vaults,dataDirectory,platform,flagsGetter});this.limits={...LIMITS,...limits};this.directory=path.join(dataDirectory,'unified-search-v2');this.legacyDirectory=path.join(dataDirectory,'unified-search-v1');this.pendingIO=new Map();this.active=null;this.last=null;this.extractor=extractor;
  this.ocr=ocr||new LocalOCRService({vaults,dataDirectory,runtimePath});
 }
 async identity(vaultId){const root=await this.vaults.root(vaultId),g=this.vaults.vaults.get(vaultId);if(!g||g.root!==root)fail('NO_VAULT');return sha(JSON.stringify([root,g.dev,g.ino,g.birthtimeMs??null]));}
 async readLocation(directory,key,pending=false){try{const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())fail('SEARCH_PROTECTED');}catch(e){if(e.code==='ENOENT')return{value:null,revision:null};throw e;}const file=path.join(directory,key+(pending?'.pending':'')+'.json');let handle;try{handle=await fs.open(file,fss.constants.O_RDONLY|fss.constants.O_NOFOLLOW|fss.constants.O_NONBLOCK);const st=await handle.stat();if(!st.isFile()||st.size>this.limits.indexBytes||st.nlink!==1)fail('SEARCH_PROTECTED');const data=await handle.readFile();return{value:validIndex(JSON.parse(data.toString('utf8')),key),revision:sha(data)};}catch(e){if(e.code==='ENOENT')return{value:null,revision:null};fail('SEARCH_PROTECTED');}finally{await handle?.close();}}
 async read(key,pending=false){
  const current=await this.readLocation(this.directory,key,pending);if(current.value)return{...current,legacy:false};if(pending&&(await this.readLocation(this.directory,key,false)).value)return{value:null,revision:null,legacy:false};
  // Version1 remains byte-for-byte available to the retained137 application.
  // Only an absent138 file falls back; a corrupt/unsupported138 file is protected.
  const legacy=await this.readLocation(this.legacyDirectory,key,pending);return{...legacy,legacy:!!legacy.value};
 }

 async write(key,value,revision,run,pending=false){
  validIndex(value,key);const data=Buffer.from(JSON.stringify(value));if(data.length>this.limits.indexBytes)fail('SEARCH_CAPACITY');
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});const st=await fs.lstat(this.directory);if(st.isSymbolicLink()||!st.isDirectory())fail('SEARCH_PROTECTED');
  const file=path.join(this.directory,key+(pending?'.pending':'')+'.json'),tmp=path.join(this.directory,crypto.randomUUID()+'.tmp');let h;
  try{h=await fs.open(tmp,'wx',0o600);await h.writeFile(data);await h.sync();await h.close();h=null;
   if((await this.read(key,pending)).revision!==revision)fail('CONFLICT');if(run&&!pending)this.check(run);
   if(run&&!pending){run.committing=true;run.state='publishing';}await fs.rename(tmp,file);let dir;try{dir=await fs.open(this.directory,'r');await dir.sync();}catch{}finally{await dir?.close();}
  }finally{await h?.close();await fs.unlink(tmp).catch(()=>{});}
 }
 io(key,start){let work=this.pendingIO.get(key);if(!work){if(this.pendingIO.size>=2)fail('SEARCH_IO_PENDING');work=Promise.resolve().then(start);this.pendingIO.set(key,work);work.finally(()=>{if(this.pendingIO.get(key)===work)this.pendingIO.delete(key);}).catch(()=>{});}let timer;return Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('SEARCH_IO_TIMEOUT'),{code:'SEARCH_IO_TIMEOUT'})),this.limits.ioMs);})]).finally(()=>clearTimeout(timer));}
 async passive(vaultId,p,directory=false){const r=await this.vaults.resolve(vaultId,p,{directory});if(this.platform==='darwin'&&((await this.flagsGetter(r.full))&0x40000000))fail('SEARCH_NOT_DOWNLOADED');return r;}
 check(run){if(run.cancelled||this.active!==run)fail('CANCELLED');}
 cancel(owner){if(this.active?.owner===owner){if(this.active.committing)return{cancelled:false};this.active.cancelled=true;this.ocr.cancelAll();this.active.worker?.terminate();return{cancelled:true};}return{cancelled:false};}
 async status(vaultId){const key=await this.identity(vaultId);try{const s=await this.read(key),p=await this.read(key,true).catch(()=>({value:null}));return{exists:!!s.value,updatedAt:s.value?.updatedAt??null,coverage:s.value?.coverage??{},documents:s.value?.documents.length??0,bytes:s.value?Buffer.byteLength(JSON.stringify(s.value)):0,limitBytes:this.limits.indexBytes,canContinue:!!p.value||!!s.value?.documents.some(d=>(!d.complete&&!d.opaqueInk&&!d.stale)||(d.kind==='board'&&d.embeddedOCRVersion!==1)||(d.kind==='board'&&d.embeddedImages?.some(i=>i.state!=='complete'))),job:this.active?.key===key?this.progress(this.active):this.last?.key===key?this.last:null,readOnly:false};}catch(e){return{exists:false,updatedAt:null,coverage:{},documents:0,bytes:0,limitBytes:this.limits.indexBytes,canContinue:false,job:null,readOnly:true};}}
 progress(run){return{key:run.key,id:run.id,state:run.cancelled&&run.state!=='cancelled'?'cancelling':run.state,processed:run.processed,pages:run.pages,path:run.path||'',code:run.code||''};}
 async start({vaultId,continuePending=false},owner){if(this.active)fail('BUSY');const run={id:crypto.randomUUID(),owner,vaultId,key:null,state:'preparing',processed:0,pages:0,cancelled:false};this.active=run;
  try{run.key=await this.identity(vaultId);this.check(run);await this.read(run.key);void this.build(run,continuePending).catch(()=>{});return{started:true,id:run.id};}catch(e){if(this.active===run)this.active=null;throw e;}}
 extract(data,type,run){if(this.extractor)return this.extractor(data,type);return new Promise((resolve,reject)=>{const worker=new Worker(path.join(__dirname,'unified-index-worker.cjs'),{workerData:{data,type}});run.worker=worker;worker.once('message',v=>v.error?reject(Object.assign(Error(v.error),{code:v.error})):resolve(v.value));worker.once('error',()=>reject(Object.assign(Error('SEARCH_EXTRACT_FAILED'),{code:'SEARCH_EXTRACT_FAILED'})));worker.once('exit',code=>{if(run.worker===worker)run.worker=null;if(code)reject(Object.assign(Error(run.cancelled?'CANCELLED':'SEARCH_EXTRACT_FAILED'),{code:run.cancelled?'CANCELLED':'SEARCH_EXTRACT_FAILED'}));});});}
 async build(run,continuing){
  let value,original,pendingRevision,docs;const start=Date.now(),coverage={scanned:0,indexed:0,notDownloaded:0,unavailable:0,unsupported:0,limited:0,opaqueInk:0,boardImages:0,boardImagesIndexed:0,boardImagesUnavailable:0,boardImagesNotDownloaded:0,boardImagesLimited:0,boardImagesUnsupported:0,boardImagesExcluded:0,sharedImageOCRReused:0};
  try{original=await this.read(run.key);const pending=await this.read(run.key,true);pendingRevision=pending.revision;const base=continuing&&pending.value?pending.value:original.value;
   value={version:2,key:run.key,generation:crypto.randomUUID(),updatedAt:new Date().toISOString(),coverage,documents:structuredClone(base?.documents||[])};
   docs=new Map(value.documents.map(d=>[d.path,{...d,stale:true,issue:'not-seen'}]));const queue=[{path:'',depth:0}],files=[];let dirs=0;const budget={ocr:0},imageCache=this.imageCache(base?.documents||[]);
   run.state='scanning';let indexBytes=Buffer.byteLength(JSON.stringify([...docs.values()]));
   while(queue.length){this.check(run);if(++dirs>this.limits.dirs||Date.now()-start>this.limits.ms){coverage.limited++;break;}const folder=queue.shift();let list;
    try{await this.io(run.key+':flags:'+folder.path,()=>this.passive(run.vaultId,folder.path,true));list=await this.io(run.key+':list:'+folder.path,()=>this.vaults.listDirectory({vaultId:run.vaultId,path:folder.path}));}catch(e){coverage[e.code==='SEARCH_NOT_DOWNLOADED'?'notDownloaded':'unavailable']++;continue;}
    if(list.warnings?.length)coverage.unavailable+=list.warnings.length;for(const entry of list.entries){if(entry.name.startsWith('.')||skip.has(entry.name.toLowerCase())||entry.path!==(folder.path?folder.path+'/':'')+entry.name||!safe(entry.path))continue;
     if(entry.kind==='folder'){if(folder.depth<this.limits.depth)queue.push({path:entry.path,depth:folder.depth+1});else coverage.limited++;}
     else if(typeOf(entry.path)){if(files.length<this.limits.files)files.push(entry);else coverage.limited++;}else coverage.unsupported++;
    }
   }
   // Continue incomplete documents first, so a large PDF cannot starve behind completed files.
   files.sort((a,b)=>Number(!!docs.get(b.path)&&!docs.get(b.path).complete)-Number(!!docs.get(a.path)&&!docs.get(a.path).complete)||a.path.localeCompare(b.path));
   for(const entry of files){this.check(run);if(Date.now()-start>this.limits.ms){coverage.limited++;break;}run.path=entry.path;coverage.scanned++;if(!docs.has(entry.path)&&docs.size>=this.limits.files){coverage.limited++;continue;}const kind=typeOf(entry.path),cap=this.limits[kind];let snapshot;
    try{await this.io(run.key+':flags:'+entry.path,()=>this.passive(run.vaultId,entry.path));if(entry.bytes>cap)fail('TOO_LARGE');snapshot=await this.io(run.key+':read:'+entry.path,()=>this.vaults.snapshot({vaultId:run.vaultId,path:entry.path},cap));this.check(run);}catch(e){const old=docs.get(entry.path);if(old)docs.set(entry.path,{...old,stale:true,issue:e.code||'unavailable'});coverage[e.code==='SEARCH_NOT_DOWNLOADED'?'notDownloaded':e.code==='TOO_LARGE'?'limited':'unavailable']++;continue;}
    const prior=docs.get(entry.path),previousBytes=prior?Buffer.byteLength(JSON.stringify(prior)):0;let doc=prior?.sha256===snapshot.sha256?{...structuredClone(prior),stale:false,issue:''}:{path:entry.path,kind,sha256:snapshot.sha256,segments:[],complete:false,nextPage:1};
    docs.set(entry.path,doc);if(kind==='board'){
     try{run.state='extracting';if(doc.embeddedOCRVersion!==1){const parsed=await this.extract(snapshot.data,kind,run);this.check(run);Object.assign(doc,parsed);}await this.boardImages(run,doc,prior,imageCache,budget,coverage,start);}catch(e){this.check(run);doc.issue=e.code||'SEARCH_EXTRACT_FAILED';coverage.unavailable++;if(prior&&doc.sha256!==prior.sha256&&!doc.segments.length)doc={...prior,stale:true,issue:doc.issue};}
    }else if(kind==='image'&&imageCache.has(snapshot.sha256)){const cached=imageCache.get(snapshot.sha256);doc={...doc,segments:cached.map(seg=>({...seg,page:1})),pageCount:1,nextPage:2,complete:true,failedPages:[],issue:''};coverage.sharedImageOCRReused++;}
    if(kind!=='board'&&!doc.complete&&!doc.opaqueInk){
     try{run.state=kind==='pdf'||kind==='image'?'recognizing':'extracting';
      if(kind==='pdf'||kind==='image'){
       if(budget.ocr>=this.limits.ocrFiles||run.pages>=this.limits.pagesPerRound){coverage.limited++;docs.set(entry.path,doc);continue;}budget.ocr++;
       const attempted=new Set();while(!doc.complete&&run.pages<this.limits.pagesPerRound){this.check(run);if(Date.now()-start>this.limits.ms){coverage.limited++;break;}
        const first=doc.failedPages?.[0]||doc.nextPage;if(attempted.has(first))break;attempted.add(first);const last=kind==='image'?1:Math.min(first+9,first+this.limits.pagesPerRound-run.pages-1,doc.pageCount||100000);
        // First request is one page to discover actual pageCount; no out-of-range guesses.
        const end=doc.failedPages?.length?first:doc.pageCount?last:first;
        const result=await this.ocr.recognizeSnapshot({requestId:run.id},{vaultId:run.vaultId,path:entry.path,ext:path.extname(entry.path).toLowerCase()},first,end,async()=>snapshot,false);this.check(run);
        if(result.sourceSHA256!==snapshot.sha256)fail('CONFLICT');doc.pageCount=result.pageCount;
        doc.failedPages=doc.failedPages||[];
        for(const page of Array.from({length:end-first+1},(_,i)=>first+i)){
         const p=result.pages.find(p=>p.page===page),bad=!p||!!(p.error&&p.error!==EMPTY_PAGE_MESSAGE)||result.outputLimited;
         if(bad){if(!doc.failedPages.includes(page))doc.failedPages.push(page);doc.issue='OCR_PAGE_FAILED';coverage.limited++;continue;}
         doc.failedPages=doc.failedPages.filter(n=>n!==page);doc.segments=doc.segments.filter(s=>s.page!==page);
         doc.segments.push(...(p.boxes.length?p.boxes.filter(b=>b.text.trim()).map(b=>({text:b.text,page:p.page,rect:{x:b.x,y:b.y,width:b.width,height:b.height}})):p.text&&p.text!==EMPTY_PAGE_MESSAGE?[{text:p.text,page:p.page}]:[]));
        }
        run.pages+=end-first+1;doc.nextPage=Math.max(doc.nextPage,end+1);doc.complete=doc.nextPage>doc.pageCount&&!doc.failedPages.length;if(kind==='image')break;
       }
      }else{const parsed=await this.extract(snapshot.data,kind,run);this.check(run);Object.assign(doc,parsed);}
     }catch(e){this.check(run);doc.issue=e.code||'SEARCH_EXTRACT_FAILED';coverage.unavailable++;}
    }
    if(kind==='image'&&doc.complete&&!doc.issue)imageCache.set(snapshot.sha256,doc.segments.map(({text,rect})=>({text,...(rect?{rect}:{} )})));
    if(prior&&prior.sha256!==doc.sha256&&!doc.segments.length&&doc.issue){doc={...prior,stale:true,issue:doc.issue};}if(doc.opaqueInk)coverage.opaqueInk++;docs.set(entry.path,doc);run.processed++;coverage.indexed++;
    // A bounded index never silently drops a source or truncates its text.
    const nextBytes=Buffer.byteLength(JSON.stringify(doc)),estimate=indexBytes-previousBytes+nextBytes;if(estimate>this.limits.indexBytes-65536){docs.delete(entry.path);if(prior)docs.set(entry.path,prior);coverage.limited++;run.code='SEARCH_CAPACITY';break;}indexBytes=estimate;
   }
   this.check(run);if(await this.identity(run.vaultId)!==run.key)fail('CONFLICT');value.documents=[...docs.values()];for(const d of value.documents)if(d.stale)coverage.unavailable++;
   value.updatedAt=new Date().toISOString();await this.write(run.key,value,original.revision,run);await fs.unlink(path.join(this.directory,run.key+'.pending.json')).catch(()=>{});run.state='complete';
  }catch(e){run.code=e.code||'SEARCH_FAILED';run.state=run.cancelled?'cancelled':'failed';
   if(run.cancelled&&value){value.documents=docs?[...docs.values()]:value.documents||[];try{await this.write(run.key,value,pendingRevision,null,true);}catch{}}
  }finally{run.path='';this.last=this.progress(run);if(this.active===run)this.active=null;}
 }

 imageSegments(segments){const groups=new Map();for(const seg of segments)if(seg.origin==='board-image-ocr'){const key=seg.nodeID+'\0'+seg.imagePath;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(seg);}return groups;}
 imageCache(documents){const cache=new Map();for(const doc of documents){if(doc.kind==='image'&&doc.complete&&!doc.issue&&!doc.stale)cache.set(doc.sha256,doc.segments.map(({text,rect})=>({text,...(rect?{rect}:{})})));if(doc.kind==='board'&&doc.embeddedOCRVersion===1){const groups=this.imageSegments(doc.segments);for(const image of doc.embeddedImages)if(image.state==='complete'&&image.imageSHA256&&!cache.has(image.imageSHA256)){const segments=(groups.get(image.nodeID+'\0'+image.imagePath)||[]).filter(s=>s.imageSHA256===image.imageSHA256&&!s.stale).map(({text,rect})=>({text,...(rect?{rect}:{})}));cache.set(image.imageSHA256,segments);}}}return cache;}

 async boardImages(run,doc,prior,cache,budget,coverage,start){
  const images=doc.embeddedImages||[];coverage.boardImages+=images.length;coverage.boardImagesExcluded+=doc.embeddedImagesExcluded||0;const typed=doc.segments.filter(s=>s.origin!=='board-image-ocr'),segments=[];
  // Existing typed text/opaque ink flags never suppress the independently readable images.
  const currentGroups=this.imageSegments(doc.segments),priorGroups=prior?.boardID===doc.boardID?this.imageSegments(prior.segments):new Map();const refs=[...images].sort((a,b)=>Number(a.state==='complete')-Number(b.state==='complete'));let incomplete=false;
  for(const image of refs){this.check(run);const key=image.nodeID+'\0'+image.imagePath,old=currentGroups.get(key)||[],priorSegments=old.length?old:priorGroups.get(key)||[];
   const retain=()=>segments.push(...priorSegments.map(s=>({...s,stale:true})));
   if(Date.now()-start>this.limits.ms){image.state='pending';image.issue='SEARCH_CAPACITY';incomplete=true;coverage.limited++;coverage.boardImagesLimited++;retain();continue;}
   let snapshot;try{if(!safe(image.imagePath)||image.imagePath.split('/').some(p=>p.startsWith('.')))fail('PATH_DENIED');await this.io(run.key+':imageflags:'+image.imagePath,()=>this.passive(run.vaultId,image.imagePath));snapshot=await this.io(run.key+':imageread:'+image.imagePath,()=>this.vaults.snapshot({vaultId:run.vaultId,path:image.imagePath},this.limits.image));this.check(run);require('./image-import.cjs').imageInfo(snapshot.data);}catch(e){this.check(run);const unsupported=['TOO_LARGE','UNSUPPORTED','PATH_DENIED','INVALID_REQUEST'].includes(e.code);image.state=e.code==='SEARCH_NOT_DOWNLOADED'?'not-downloaded':unsupported?'unsupported':'unavailable';if(unsupported)coverage.boardImagesUnsupported++;image.issue=e.code||'SEARCH_EXTRACT_FAILED';incomplete=true;coverage[e.code==='SEARCH_NOT_DOWNLOADED'?'notDownloaded':e.code==='TOO_LARGE'?'limited':'unavailable']++;coverage[e.code==='SEARCH_NOT_DOWNLOADED'?'boardImagesNotDownloaded':'boardImagesUnavailable']++;retain();continue;}
   const previousSHA=image.imageSHA256;image.imageSHA256=snapshot.sha256;let recognized=cache.get(snapshot.sha256);
   if(recognized){coverage.sharedImageOCRReused++;}else if(previousSHA===snapshot.sha256&&image.state==='complete'&&!image.issue){recognized=priorSegments.filter(s=>!s.stale).map(({text,rect})=>({text,...(rect?{rect}:{})}));cache.set(snapshot.sha256,recognized);}
   if(!recognized){if(budget.ocr>=this.limits.ocrFiles||run.pages>=this.limits.pagesPerRound){image.state='pending';image.issue='SEARCH_CAPACITY';incomplete=true;coverage.limited++;coverage.boardImagesLimited++;retain();continue;}
    budget.ocr++;run.state='recognizing';try{const result=await this.ocr.recognizeSnapshot({requestId:run.id},{vaultId:run.vaultId,path:image.imagePath,ext:path.extname(image.imagePath).toLowerCase()},1,1,async()=>snapshot,false);this.check(run);if(result.sourceSHA256!==snapshot.sha256||result.cancelled||result.outputLimited||result.pageCount!==1)fail('OCR_FAILED');const page=result.pages.find(p=>p.page===1);if(!page||page.error&&page.error!==EMPTY_PAGE_MESSAGE)fail('OCR_FAILED');recognized=page.boxes?.length?page.boxes.filter(b=>b.text.trim()).map(b=>({text:b.text,rect:{x:b.x,y:b.y,width:b.width,height:b.height}})):page.text&&page.text!==EMPTY_PAGE_MESSAGE?[{text:page.text}]:[];cache.set(snapshot.sha256,recognized);run.pages++;}catch(e){this.check(run);image.state='unavailable';image.issue=e.code||'OCR_FAILED';incomplete=true;coverage.unavailable++;coverage.boardImagesUnavailable++;retain();continue;}
   }
   image.state='complete';delete image.issue;segments.push(...recognized.map(s=>({...s,nodeID:image.nodeID,origin:'board-image-ocr',imagePath:image.imagePath,imageSHA256:snapshot.sha256})));coverage.boardImagesIndexed++;
  }
  doc.segments=[...typed,...segments];doc.complete=!doc.opaqueInk&&!incomplete&&images.every(i=>i.state==='complete');doc.imagePassComplete=!incomplete&&images.every(i=>i.state==='complete');if(doc.imagePassComplete)delete doc.issue;else doc.issue='BOARD_IMAGES_PARTIAL';
 }

 async search({vaultId,query='',kind='all',offset=0}){if(typeof query!=='string'||query.length>500||!['all','text','notebook','board','pdf','image'].includes(kind)||!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('INVALID_REQUEST');const key=await this.identity(vaultId),s=await this.read(key);let count=0;const results=[],q=query.trim().toLocaleLowerCase();
  if(s.value)for(const d of s.value.documents){if(kind!=='all'&&kind!==d.kind)continue;for(const [i,segment]of d.segments.entries()){const text=segment.text,pos=text.toLocaleLowerCase().indexOf(q);if(q&&pos<0&&!d.path.toLocaleLowerCase().includes(q))continue;const n=count++;if(n<offset||results.length>=60)continue;results.push({id:sha(s.value.generation+'\0'+d.path+'\0'+i),path:d.path,kind:d.kind,snippet:text.slice(Math.max(0,pos-70),Math.max(0,pos-70)+240),...(segment.page?{page:segment.page}:{}),...(segment.nodeID?{nodeID:segment.nodeID}:{}),...(segment.cell?{cell:segment.cell}:{}),...(segment.rect?{rect:segment.rect}:{}),...(segment.origin?{origin:segment.origin,imagePath:segment.imagePath,imageSHA256:segment.imageSHA256}:{}),stale:!!d.stale||!!segment.stale,partial:!d.complete||!!d.limited});}}
  return{results,total:count,more:offset+results.length<count};
 }
 async resolve({vaultId,resultId}){if(!SHA.test(resultId||''))fail('INVALID_REQUEST');const key=await this.identity(vaultId),s=await this.read(key);if(!s.value)fail('SEARCH_STALE');for(const d of s.value.documents)for(const[i,seg]of d.segments.entries())if(sha(s.value.generation+'\0'+d.path+'\0'+i)===resultId){await this.io(key+':openflags:'+d.path,()=>this.passive(vaultId,d.path));const current=await this.io(key+':open:'+d.path,()=>this.vaults.snapshot({vaultId,path:d.path},this.limits[d.kind]));if(current.sha256!==d.sha256)fail('SEARCH_STALE');if(seg.origin==='board-image-ocr'){let board;try{board=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(current.data).replace(/^\uFEFF/,''));require('./board-validation.cjs').validateBoard(board);}catch{fail('SEARCH_STALE');}const node=board.items.find(n=>n.id===seg.nodeID);if(board.id!==d.boardID||!node||node.sourcePath!==seg.imagePath)fail('SEARCH_STALE');try{await this.io(key+':imageopenflags:'+seg.imagePath,()=>this.passive(vaultId,seg.imagePath));const image=await this.io(key+':imageopen:'+seg.imagePath,()=>this.vaults.snapshot({vaultId,path:seg.imagePath},this.limits.image));if(image.sha256!==seg.imageSHA256)fail('SEARCH_STALE');const final=await this.io(key+':boardopenfinal:'+d.path,()=>this.vaults.snapshot({vaultId,path:d.path},this.limits.board));if(final.sha256!==d.sha256)fail('SEARCH_STALE');}catch{fail('SEARCH_STALE');}}return{resultId,vaultId,path:d.path,kind:d.kind,sourceSHA256:d.sha256,...(seg.origin?{origin:seg.origin,imagePath:seg.imagePath,imageSHA256:seg.imageSHA256}:{}),...(d.boardID?{boardID:d.boardID}:{}),...(seg.nodeID?{nodeID:seg.nodeID}:{}),...(seg.page?{page:seg.page}:{}),...(seg.rect?{rect:seg.rect}:{}),quote:seg.text.slice(0,2000)};}fail('SEARCH_STALE');}
}
module.exports={UnifiedIndex,typeOf,validIndex,LIMITS};

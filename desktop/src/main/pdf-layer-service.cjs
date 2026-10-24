'use strict';
// Source-adjacent immutable events. PDF bytes and existing annotation formats
// are never edited. All public paths denote PDFs, never arbitrary hidden files.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {relativePath}=require('./vault-path.cjs'),{fail}=require('./errors.cjs');
const {validateNativeInk}=require('./pdf-native-ink.cjs');
const SUFFIX='.inkspace-pdf',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/;
const LIMITS={maxRecord:256*1024,maxFiles:20000,maxBytes:64*1024*1024,maxPDF:256*1024*1024};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink;
const fields=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))fail('INVALID_PDF_LAYER');};
const uid=v=>{if(typeof v!=='string'||!UUID.test(v))fail('INVALID_PDF_LAYER');return v.toLowerCase();};
const scalar=(v,max,min=0)=>{if(typeof v!=='string'||!v.isWellFormed()||v.includes('\0')||v.length>max*2||Array.from(v).length>max||Array.from(v).length<min)fail('INVALID_PDF_LAYER');return v;};
const fraction=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
function sourcePath(v){relativePath(v);if(v.split('/').some(p=>p.startsWith('.'))||!v.toLowerCase().endsWith('.pdf'))fail('PATH_DENIED');return v;}
function sidecarPath(pdf){sourcePath(pdf);const parent=path.posix.dirname(pdf);return(parent==='.'?'':parent+'/')+'.'+path.posix.basename(pdf)+SUFFIX;}
function sidecarPDF(rel){if(typeof rel!=='string')return null;const name=path.posix.basename(rel);if(!name.startsWith('.')||!name.endsWith(SUFFIX))return null;const pdf=name.slice(1,-SUFFIX.length),parent=path.posix.dirname(rel),result=(parent==='.'?'':parent+'/')+pdf;try{return sourcePath(result);}catch{return null;}}
function validateRecord(value){
 if(!value||!['layer','deleteLayer','annotation','deleteAnnotation'].includes(value.kind))fail('INVALID_PDF_LAYER');
 const payload=value.kind==='layer'?'layer':value.kind==='annotation'?'annotation':'targetID';fields(value,['schemaVersion','id','createdAt','kind',payload]);if(value.schemaVersion!==1)fail('INVALID_PDF_LAYER');
 const id=uid(value.id),date=value.createdAt;if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,19)!==date.slice(0,19))fail('INVALID_PDF_LAYER');
 const result={schemaVersion:1,id,createdAt:new Date(date).toISOString(),kind:value.kind};
 if(payload==='targetID')result.targetID=uid(value.targetID);
 else if(payload==='layer'){const v=value.layer;fields(v,['id','name','visible','locked','order']);if((typeof v.name!=='string'||!v.name.trim())||typeof v.visible!=='boolean'||typeof v.locked!=='boolean'||!Number.isSafeInteger(v.order))fail('INVALID_PDF_LAYER');result.layer={id:uid(v.id),name:scalar(v.name,120,1),visible:v.visible,locked:v.locked,order:v.order};}
 else{const v=value.annotation;fields(v,['id','layerID','sourceSHA256','page','kind','color','width','points','rect','text',...(v&&Object.hasOwn(v,'nativeInk')?['nativeInk']:[])]);if(!SHA.test(v.sourceSHA256)||typeof v.sourceSHA256!=='string'||!Number.isSafeInteger(v.page)||v.page<1||v.page>100000||!['ink','highlight','text'].includes(v.kind)||typeof v.color!=='string'||!/^#[a-f0-9]{6}$/i.test(v.color)||typeof v.width!=='number'||!Number.isFinite(v.width)||v.width<.0001||v.width>.05||!Array.isArray(v.points)||v.points.length>4096)fail('INVALID_PDF_LAYER');
  for(const p of v.points)if(!Array.isArray(p)||p.length!==2||!p.every(fraction))fail('INVALID_PDF_LAYER');
  fields(v.rect,['x','y','width','height']);const r=v.rect;if(!Object.values(r).every(fraction)||r.width<=0||r.height<=0||r.x+r.width>1+1e-9||r.y+r.height>1+1e-9)fail('INVALID_PDF_LAYER');
  if(v.kind==='ink'&&v.points.length<1)fail('INVALID_PDF_LAYER');
  result.annotation={id:uid(v.id),layerID:uid(v.layerID),sourceSHA256:v.sourceSHA256,page:v.page,kind:v.kind,color:v.color.toUpperCase(),width:v.width,points:v.points.map(p=>[...p]),rect:{...r},text:scalar(v.text,10000)};
  if(Object.hasOwn(v,'nativeInk')){if(v.kind!=='ink')fail('INVALID_PDF_LAYER');try{result.annotation.nativeInk=validateNativeInk(v.nativeInk);}catch{fail('INVALID_PDF_LAYER');}}
 }
 if(Buffer.byteLength(JSON.stringify(result))>LIMITS.maxRecord)fail('TOO_LARGE');return result;
}
function decodeRecord(bytes){if(bytes.length>LIMITS.maxRecord)fail('TOO_LARGE');try{return validateRecord(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch(e){if(e.code==='TOO_LARGE')throw e;fail('INVALID_PDF_LAYER');}}
function projectRecords(records,warnings=[]){const layers=new Map(),marks=new Map(),deletedLayers=new Set(),deletedMarks=new Set(),events=new Map(),conflicts=new Set();let invalid=0;
 const newer=(a,b)=>!b||Date.parse(a.createdAt)>Date.parse(b.createdAt)||Date.parse(a.createdAt)===Date.parse(b.createdAt)&&a.id>b.id;
 for(const raw of records){let r;try{r=validateRecord(raw);}catch{invalid++;continue;}if(conflicts.has(r.id))continue;const prior=events.get(r.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(r)){invalid++;conflicts.add(r.id);events.delete(r.id);continue;}events.set(r.id,r);}
 for(const r of events.values()){if(r.kind==='deleteLayer')deletedLayers.add(r.targetID);else if(r.kind==='deleteAnnotation')deletedMarks.add(r.targetID);else if(r.kind==='layer'){if(newer(r,layers.get(r.layer.id)))layers.set(r.layer.id,r);}else if(newer(r,marks.get(r.annotation.id)))marks.set(r.annotation.id,r);}
 const resultLayers=[...layers.values()].filter(r=>!deletedLayers.has(r.layer.id)).map(r=>r.layer).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));const validLayers=new Set(resultLayers.map(l=>l.id)),order=new Map(resultLayers.map((l,i)=>[l.id,i]));
 const annotations=[...marks.values()].filter(r=>!deletedMarks.has(r.annotation.id)&&validLayers.has(r.annotation.layerID)).map(r=>r.annotation).sort((a,b)=>(order.get(a.layerID)-order.get(b.layerID))||a.id.localeCompare(b.id));
 return{layers:resultLayers,annotations,annotationTimes:Object.fromEntries([...marks.values()].map(r=>[r.annotation.id,r.createdAt])),warnings:[...warnings,...(invalid?['Some invalid PDF layer records were preserved and omitted ('+invalid+').']:[])]};
}
async function syncDirectory(dir){let h;try{h=await fs.open(dir,constants.O_RDONLY);await h.sync();}catch(e){if(process.platform!=='win32'||!['EPERM','EINVAL','EISDIR','ENOTSUP'].includes(e.code))throw e;}finally{await h?.close();}}
async function durableNew(file,data){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}}
class PDFLayerService{
 constructor(vaults,options={}){this.vaults=vaults;this.limits={...LIMITS,...options};this.sources=new Map();}
 request(v,write=false){fields(v,write?['vaultId','path','expectedSourceSHA256','record']:['vaultId','path']);if(typeof v.vaultId!=='string')fail('INVALID_REQUEST');sourcePath(v.path);if(write&&(typeof v.expectedSourceSHA256!=='string'||!SHA.test(v.expectedSourceSHA256)))fail('INVALID_REQUEST');return{vaultId:v.vaultId,path:v.path};}
 async source(request,{fresh=false}={}){const current=await this.vaults.resolve(request.vaultId,request.path),key=request.vaultId+':'+request.path,cached=this.sources.get(key);if(current.stat.size>this.limits.maxPDF)fail('TOO_LARGE');if(!fresh&&cached&&same(cached.stat,current.stat))return{...current,sha256:cached.sha256};
  const handle=await fs.open(current.full,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const before=await handle.stat();if(!same(current.stat,before)||!before.isFile()||before.nlink!==1)fail('CONFLICT');const hash=crypto.createHash('sha256');let count=0;for(;;){const chunk=Buffer.allocUnsafe(65536),read=await handle.read(chunk,0,chunk.length,null);if(!read.bytesRead)break;if(count===0&&chunk.subarray(0,5).toString()!=='%PDF-')fail('INVALID_PDF_LAYER');count+=read.bytesRead;if(count>this.limits.maxPDF)fail('TOO_LARGE');hash.update(chunk.subarray(0,read.bytesRead));}if(count<5)fail('INVALID_PDF_LAYER');const after=await handle.stat(),last=await this.vaults.resolve(request.vaultId,request.path);if(!same(before,after)||!same(after,last.stat)||count!==after.size)fail('CONFLICT');const sha256=hash.digest('hex');if(this.sources.size>=128)this.sources.delete(this.sources.keys().next().value);this.sources.set(key,{stat:after,sha256});return{...last,sha256};}finally{await handle.close();}
 }
 async scan(request){const rel=sidecarPath(request.path);let dir;try{dir=await this.vaults.resolve(request.vaultId,rel,{directory:true});}catch(e){if(e.code==='ENOENT')return{records:[],warnings:[],bytes:0,count:0,rel,dir:null};throw e;}const records=[],warnings=[];let count=0,bytes=0,invalid=0;const entries=await fs.opendir(dir.full);try{for await(const entry of entries){if(++count>this.limits.maxFiles)fail('TOO_LARGE');const p=rel+'/'+entry.name,stat=await fs.lstat(path.join(dir.full,entry.name));if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1){invalid++;continue;}bytes+=stat.size;if(bytes>this.limits.maxBytes)fail('TOO_LARGE');if(!/^[a-f0-9-]+\.json$/.test(entry.name)||!UUID.test(entry.name.slice(0,-5))||stat.size>this.limits.maxRecord){invalid++;continue;}try{const snap=await this.vaults.snapshot({vaultId:request.vaultId,path:p},this.limits.maxRecord),record=decodeRecord(snap.data);if(record.id!==entry.name.slice(0,-5))fail('INVALID_PDF_LAYER');records.push(record);}catch(e){if(e.code==='NO_VAULT'||e.code==='PATH_DENIED')throw e;invalid++;}}}finally{await entries.close().catch(()=>{});}const after=await this.vaults.resolve(request.vaultId,rel,{directory:true});if(after.stat.dev!==dir.stat.dev||after.stat.ino!==dir.stat.ino)fail('CONFLICT');if(invalid)warnings.push('Some unavailable or invalid PDF layer files were preserved and omitted ('+invalid+').');return{records,warnings,bytes,count,rel,dir:after};}
 view(request,source,scan){return{sourceSHA256:source.sha256,assetUrl:this.vaults.assetToken(request,source.sha256),...projectRecords(scan.records,scan.warnings)};}
 async readPDFSourceInfo(v){const request=this.request(v),source=await this.source(request);return{sourceSHA256:source.sha256,assetUrl:this.vaults.assetToken(request,source.sha256)};}
 async readPDFLayers(v){const request=this.request(v),source=await this.source(request),scan=await this.scan(request),after=await this.source(request);if(!same(source.stat,after.stat)||source.sha256!==after.sha256)fail('CONFLICT');return this.view(request,after,scan);}
 async appendPDFLayerRecord(v){const request=this.request(v,true),record=validateRecord(v.record),data=Buffer.from(JSON.stringify(record)+'\n');if(data.length>this.limits.maxRecord)fail('TOO_LARGE');
  return this.vaults.locked(request.vaultId+':file-management',()=>this.vaults.locked(request.vaultId+':'+sidecarPath(request.path),async()=>{
   const source=await this.source(request);if(source.sha256!==v.expectedSourceSHA256)fail('CONFLICT');let scan=await this.scan(request);const old=scan.records.find(r=>r.id===record.id);if(old){if(JSON.stringify(old)!==JSON.stringify(record))fail('CONFLICT');return{record,projection:this.view(request,source,scan)};}
   if(scan.count>=this.limits.maxFiles||scan.bytes+data.length>this.limits.maxBytes)fail('TOO_LARGE');const projection=projectRecords(scan.records),layer=record.annotation&&projection.layers.find(l=>l.id===record.annotation.layerID);
   if(record.kind==='annotation'){if(record.annotation.sourceSHA256!==source.sha256){const comparable=a=>{const{id,layerID,...rest}=a;return JSON.stringify(rest);};if(!scan.records.some(r=>r.kind==='annotation'&&comparable(r.annotation)===comparable(record.annotation)))fail('CONFLICT');}if(!layer||!layer.visible||layer.locked)fail('PDF_LAYER_LOCKED');if(scan.records.some(r=>r.kind==='deleteAnnotation'&&r.targetID===record.annotation.id))fail('CONFLICT');}
   if(record.kind==='layer'&&scan.records.some(r=>r.kind==='deleteLayer'&&r.targetID===record.layer.id))fail('CONFLICT');
   if(record.kind==='deleteLayer'&&projection.layers.find(l=>l.id===record.targetID)?.locked)fail('PDF_LAYER_LOCKED');
   if(record.kind==='deleteAnnotation'){const annotation=projection.annotations.find(a=>a.id===record.targetID);if(annotation&&projection.layers.find(l=>l.id===annotation.layerID)?.locked)fail('PDF_LAYER_LOCKED');}
   const rel=scan.rel+'/'+record.id+'.json',backupId=await this.vaults.backup(rel,null,data),parent=path.dirname(source.full);if(!scan.dir){try{await fs.mkdir(path.join(parent,path.posix.basename(scan.rel)),{mode:0o700});await syncDirectory(parent);}catch(e){if(e.code!=='EEXIST')throw e;}}
   const dir=await this.vaults.resolve(request.vaultId,scan.rel,{directory:true}),temp=path.join(dir.full,'.inkspace-save-'+crypto.randomUUID()+'.tmp'),dest=path.join(dir.full,record.id+'.json');
   try{await durableNew(temp,data);const after=await this.source(request),dirAfter=await this.vaults.resolve(request.vaultId,scan.rel,{directory:true});if(after.sha256!==source.sha256||!same(source.stat,after.stat)||dirAfter.stat.ino!==dir.stat.ino||dirAfter.stat.dev!==dir.stat.dev)fail('CONFLICT');
    try{await fs.link(temp,dest);}catch(e){if(e.code!=='EEXIST')throw e;const existing=await this.vaults.snapshot({vaultId:request.vaultId,path:rel},this.limits.maxRecord);if(JSON.stringify(decodeRecord(existing.data))!==JSON.stringify(record))fail('CONFLICT');}await fs.unlink(temp);await syncDirectory(dir.full);
    scan=await this.scan(request);return{record,projection:this.view(request,after,scan),backupId};
   }finally{await fs.unlink(temp).catch(()=>{});}
  }));
 }
}
module.exports={PDFLayerService,validateRecord,decodeRecord,projectRecords,sourcePath,sidecarPath,sidecarPDF,LIMITS};

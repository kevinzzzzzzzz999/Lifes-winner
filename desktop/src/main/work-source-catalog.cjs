'use strict';
const {fail}=require('./errors.cjs');
const {civil,safePath,sameFolder}=require('./work-space-store.cjs');
const {execFile}=require('node:child_process');
const passiveFlags=full=>new Promise((resolve,reject)=>execFile('/usr/bin/stat',['-f','%f',full],{timeout:2000,maxBuffer:128,encoding:'utf8'},(error,stdout)=>{if(error)return reject(error);if(!/^\d+\s*$/.test(stdout))return reject(Error('Invalid file flags'));resolve(Number(stdout.trim()));}));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/i;
const boundedString=(s,max,required=false)=>typeof s==='string'&&s.length<=max&&!s.includes('\0')&&(!required||s.trim().length>0);
const utc=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19);
function parseSource(file){
 if(file.kind!=='text'||typeof file.text!=='string'||Buffer.byteLength(file.text)>1048576||!SHA.test(file.sha256))fail('INVALID_REQUEST');
 const doc=JSON.parse(file.text.replace(/^\uFEFF/,''));
 if(doc.schemaVersion!==1||doc.kind!=='course-checklist'||!UUID.test(doc.id||'')||!boundedString(doc.title,200,true)||!utc(doc.updatedAt)||!Array.isArray(doc.tasks)||doc.tasks.length>1000)fail('INVALID_REQUEST');
 const seen=new Set(),tasks=[];
 for(const task of doc.tasks){if(!UUID.test(task.id||'')||seen.has(task.id.toLowerCase())||!boundedString(task.text,1000,true)||!boundedString(task.section,200)||typeof task.done!=='boolean'||!utc(task.createdAt)||!utc(task.updatedAt)||(task.completedAt!==undefined&&(!task.done||!utc(task.completedAt)))||(task.archivedAt!==undefined&&!utc(task.archivedAt))||(task.dueDate!==undefined&&!civil(task.dueDate))||(task.sourcePath!==undefined&&!safePath(task.sourcePath))||(task.rewardId!==undefined&&!boundedString(task.rewardId,200,true)))fail('INVALID_REQUEST');seen.add(task.id.toLowerCase());
  if(!task.archivedAt)tasks.push({id:task.id,text:task.text,section:task.section,done:task.done,...(task.dueDate?{dueDate:task.dueDate}:{})});
 }
 return{path:file.path,id:doc.id,title:doc.title,sha256:file.sha256.toLowerCase(),tasks};
}
// Actual filesystem operations remain capped until their promises really settle;
// a UI timeout cannot release a slot and accumulate new cloud reads.
class WorkSourceCatalogue{
 constructor({store,vaults,resolveFolder,grant=value=>value,timeout=5000,scanMilliseconds=12000,platform=process.platform,flagsGetter=passiveFlags}={}){this.store=store;this.vaults=vaults;this.resolveFolder=resolveFolder;this.grant=grant;this.timeout=timeout;this.scanMilliseconds=scanMilliseconds;this.platform=platform;this.flagsGetter=flagsGetter;this.pending=new Map();this.refreshing=new Map();}
 async passive(vaultId,relative,directory=false){if(this.platform!=='darwin')return true;const resolved=await this.vaults.resolve(vaultId,relative,{directory});const flags=await this.flagsGetter(resolved.full);return Number.isSafeInteger(flags)&&(flags&0x40000000)===0;}
 operation(key,start,timeout=this.timeout){
  let work=this.pending.get(key);if(!work){if(this.pending.size>=2)return Promise.reject(Object.assign(Error('Pending source read'),{code:'WORK_PENDING'}));work=Promise.resolve().then(start);this.pending.set(key,work);work.finally(()=>{if(this.pending.get(key)===work)this.pending.delete(key);}).catch(()=>{});}
  let timer;return Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Source timeout'),{code:'WORK_SOURCE_TIMEOUT'})),timeout);})]).finally(()=>clearTimeout(timer));
 }
 async register(vaultId){
  if(typeof vaultId!=='string')fail('INVALID_REQUEST');const verifiedRoot=await this.vaults.root(vaultId);const value=this.vaults.vaults.get(vaultId);if(!value)fail('NO_VAULT');if(verifiedRoot!==value.root)fail('WORK_CONFLICT');
  const folder={root:value.root,dev:value.dev,ino:value.ino,...(value.birthtimeMs!==undefined?{birthtimeMs:value.birthtimeMs}:{}),...(value.recentId?{recentId:value.recentId}:{})};
  return this.store.register(folder,require('node:path').basename(value.root)||value.root);
 }
 async resolve(source){
  const vault=await this.operation(source.id+':grant',()=>this.resolveFolder?this.resolveFolder(source.folder):this.vaults.grantVault(source.folder.root,source.folder));
  const root=await this.operation(source.id+':root',()=>this.vaults.root(vault.id));const actual=this.vaults.vaults.get(vault.id);
  if(!actual||root!==actual.root||actual.dev!==source.folder.dev||actual.ino!==source.folder.ino||(source.folder.birthtimeMs!==undefined&&actual.birthtimeMs!==source.folder.birthtimeMs))fail('PATH_DENIED');
  return this.grant(vault);
 }
 refresh(sourceId){
  if(!UUID.test(sourceId||''))fail('INVALID_REQUEST');let work=this.refreshing.get(sourceId);if(work)return work;
  work=this.scan(sourceId);this.refreshing.set(sourceId,work);work.finally(()=>{if(this.refreshing.get(sourceId)===work)this.refreshing.delete(sourceId);}).catch(()=>{});return work;
 }
 async scan(sourceId){
  const source=await this.store.source(sourceId);let result={documents:[],partial:false,unavailable:false};
  try{
   const vault=await this.resolve(source),queue=[{path:'',depth:0}],seen=new Set(),files=[],deadline=Date.now()+this.scanMilliseconds;let directories=0,bytes=0,tasks=0;
   const run=(key,start)=>{const left=deadline-Date.now();if(left<=0)throw Object.assign(Error('Source scan limit'),{code:'WORK_SOURCE_TIMEOUT'});return this.operation(source.id+':'+key,start,Math.max(1,Math.min(this.timeout,left)));};
   while(queue.length){
    if(directories>=1024){result.partial=true;break;}const folder=queue.shift();if(seen.has(folder.path))continue;seen.add(folder.path);directories++;
    let listing;try{if(!await run('flags:'+folder.path,()=>this.passive(vault.id,folder.path,true))){result.partial=true;continue;}listing=await run('list:'+folder.path,()=>this.vaults.listDirectory({vaultId:vault.id,path:folder.path}));}catch{result.partial=true;break;}
    if(listing.path!==folder.path){result.partial=true;continue;}if(listing.warnings?.length)result.partial=true;
    for(const entry of listing.entries){
     const expected=folder.path?folder.path+'/'+entry.name:entry.name;
     if(entry.name.startsWith('.')||!safePath(entry.path)||entry.path!==expected||entry.name.includes('/')){result.partial=true;continue;}
     if(entry.kind==='folder'){if(folder.depth>=12||queue.length+directories>=1024)result.partial=true;else queue.push({path:entry.path,depth:folder.depth+1});}
     else if(entry.name.toLowerCase().endsWith('.inkcheck.json')){if(files.length>=128||entry.bytes>1048576){result.partial=true;continue;}files.push(entry);}
    }
   }
   for(const entry of files){
    if(bytes+entry.bytes>8*1024*1024){result.partial=true;break;}
    try{if(!await run('flags:'+entry.path,()=>this.passive(vault.id,entry.path))){result.partial=true;continue;}const file=await run('read:'+entry.path,()=>this.vaults.readFile({vaultId:vault.id,path:entry.path}));if(file.path!==entry.path)throw Error('Source path changed');bytes+=Buffer.byteLength(file.text||'');if(bytes>8*1024*1024)throw Error('Source limit');const doc=parseSource(file);tasks+=doc.tasks.length;if(tasks>10000)throw Error('Source limit');result.documents.push(doc);}
    catch{result.partial=true;if(Date.now()>=deadline||this.pending.size>=2)break;}
   }
   // Confirm the exact registered physical directory after asynchronous reads.
   await this.operation(source.id+':root',()=>this.vaults.root(vault.id));
  }catch{result={documents:[],partial:true,unavailable:true};}
  return this.store.refreshSource(source.id,source.folder,result);
 }
 async open(request){
  if(!request||Object.keys(request).some(k=>!['sourceId','path','documentID','taskId'].includes(k))||!UUID.test(request.sourceId||'')||!safePath(request.path)||!UUID.test(request.documentID||'')||!UUID.test(request.taskId||''))fail('INVALID_REQUEST');
  const source=await this.store.source(request.sourceId);
  if(!source.documents.some(doc=>doc.path===request.path&&doc.id===request.documentID&&doc.tasks.some(t=>t.id===request.taskId)))fail('NOT_FOUND');
  const vault=await this.resolve(source),file=await this.operation(source.id+':read:'+request.path,()=>this.vaults.readFile({vaultId:vault.id,path:request.path})),current=parseSource(file);
  if(current.path!==request.path||current.id!==request.documentID||!current.tasks.some(t=>t.id===request.taskId))fail('WORK_SOURCE_CHANGED');
  const latest=await this.store.source(source.id);if(!sameFolder(latest.folder,source.folder))fail('WORK_CONFLICT');
  return{sourceId:source.id,vault,path:request.path,documentID:request.documentID,taskId:request.taskId};
 }
}
module.exports={WorkSourceCatalogue,parseSource};

'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const {durableWrite,utf8}=require('./vault-service.cjs');
const CALENDAR_FILE='人生赢家日历.inkcalendar.json';
const MAX_BYTES=4*1024*1024,MAX_SCHEDULES=10000,CATCHUP_MS=5*60000,DAY=86400000;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('INVALID_REQUEST');}
function string(value,maximum){return typeof value==='string'&&value.length>0&&value.length<=maximum&&!/[\x00-\x1f\x7f]/.test(value);}
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function regular(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('PATH_DENIED');if(stat.size>MAX_BYTES)fail('TOO_LARGE');}
function bounded(promise,ms=15000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{try{fail('FILE_SCAN_TIMEOUT');}catch(e){reject(e);}},ms);})]).finally(()=>clearTimeout(timer));}
// Keep the original operation until it settles: a stalled cloud read cannot create
// a growing collection of outstanding file handles on repeated refreshes.
class CalendarFiles{
 constructor(vaults,{timeoutMs=15000}={}){this.vaults=vaults;this.timeoutMs=timeoutMs;this.reads=new Map();this.importing=null;this.exporting=null;}
 read(request){exact(request,['vaultId']);if(!string(request.vaultId,200))fail('INVALID_REQUEST');let work=this.reads.get(request.vaultId);if(!work){work=(async()=>{const target=await this.vaults.resolve(request.vaultId,CALENDAR_FILE,{allowMissing:true});if(!target.stat)return null;return this.vaults.readFile({vaultId:request.vaultId,path:CALENDAR_FILE});})();this.reads.set(request.vaultId,work);work.finally(()=>{if(this.reads.get(request.vaultId)===work)this.reads.delete(request.vaultId);}).catch(()=>{});}return bounded(work,this.timeoutMs);}
 async importICS({dialog,window}){if(this.importing)fail('BUSY');const result=await dialog.showOpenDialog(window,{title:'导入日历 / Import calendar',properties:['openFile'],filters:[{name:'iCalendar',extensions:['ics']}]});if(result.canceled||!result.filePaths?.length)return null;const work=readICSFile(result.filePaths[0]);this.importing=work;work.finally(()=>{this.importing=null;}).catch(()=>{});return bounded(work,this.timeoutMs);}
 async exportICS(request,{dialog,window}){exact(request,['name','text']);if(!string(request.name,180)||request.name!==path.basename(request.name)||!request.name.toLowerCase().endsWith('.ics')||typeof request.text!=='string'||request.text.includes('\0'))fail('INVALID_REQUEST');const data=Buffer.from(request.text,'utf8');if(data.length>MAX_BYTES)fail('TOO_LARGE');if(utf8(data).text!==request.text.replace(/^\uFEFF/,''))fail('INVALID_TEXT');if(this.exporting)fail('BUSY');const result=await dialog.showSaveDialog(window,{title:'导出日历 / Export calendar',defaultPath:request.name,filters:[{name:'iCalendar',extensions:['ics']}]});if(result.canceled||!result.filePath)return {saved:false};if(path.extname(result.filePath).toLowerCase()!=='.ics')fail('INVALID_REQUEST');const work=writeICSFile(result.filePath,data);this.exporting=work;work.finally(()=>{this.exporting=null;}).catch(()=>{});return bounded(work,this.timeoutMs);}
}
async function readICSFile(file){if(typeof file!=='string'||path.extname(file).toLowerCase()!=='.ics')fail('UNSUPPORTED');const before=await fs.lstat(file);regular(before);const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const opened=await handle.stat();regular(opened);if(!same(before,opened))fail('CONFLICT');const chunks=[];let total=0;while(total<=MAX_BYTES){const chunk=Buffer.allocUnsafe(Math.min(65536,MAX_BYTES+1-total));const {bytesRead}=await handle.read(chunk,0,chunk.length,total);if(!bytesRead)break;total+=bytesRead;chunks.push(chunk.subarray(0,bytesRead));}if(total>MAX_BYTES)fail('TOO_LARGE');const after=await handle.stat(),current=await fs.lstat(file);regular(current);if(!same(opened,after)||!same(after,current)||total!==after.size)fail('CONFLICT');return {name:path.basename(file),text:utf8(Buffer.concat(chunks,total)).text};}finally{await handle.close();}}
async function optionalStat(file){try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function writeICSFile(file,data){const parent=path.dirname(file),canonical=await fs.realpath(parent),parentStat=await fs.stat(parent);if(!parentStat.isDirectory())fail('PATH_DENIED');const prior=await optionalStat(file);if(prior)regular(prior);const temp=path.join(canonical,'.winner-calendar-export-'+crypto.randomUUID()+'.tmp');try{await durableWrite(temp,data,prior?prior.mode&0o777:0o600);if(await fs.realpath(parent)!==canonical)fail('CONFLICT');const current=await optionalStat(file);if(current)regular(current);if(Boolean(prior)!==Boolean(current)||(prior&&!same(prior,current)))fail('CONFLICT');if(current)await fs.rename(temp,file);else{await fs.link(temp,file);await fs.unlink(temp);}return {saved:true};}finally{await fs.unlink(temp).catch(()=>{});}}
function validateSchedules(request,now){exact(request,['vaultId','enabled','schedules']);if(!string(request.vaultId,200)||typeof request.enabled!=='boolean'||!Array.isArray(request.schedules)||request.schedules.length>MAX_SCHEDULES)fail('INVALID_REQUEST');const seen=new Set();return request.schedules.map(item=>{exact(item,['eventId','occurrenceStart','minutes','fireAt','title','body']);if(!string(item.eventId,512)||!string(item.occurrenceStart,64)||!Number.isFinite(Date.parse(item.occurrenceStart))||!Number.isInteger(item.minutes)||item.minutes<0||item.minutes>525600||!Number.isSafeInteger(item.fireAt)||item.fireAt!==Date.parse(item.occurrenceStart)-item.minutes*60000||item.fireAt<now-2*DAY||item.fireAt>now+62*DAY||!string(item.title,300)||typeof item.body!=='string'||item.body.length>1000||/[\x00-\x08\x0b-\x1f\x7f]/.test(item.body))fail('INVALID_REQUEST');const key=JSON.stringify([item.eventId,item.occurrenceStart,item.minutes]);if(seen.has(key))fail('INVALID_REQUEST');seen.add(key);return {...item};});}
class CalendarReminderScheduler{
 constructor({vaults,dataDirectory,notify,isSupported=()=>true,disabled=false,now=Date.now,timer=setInterval,clearTimer=clearInterval,onStatus=()=>{},persist,load}={}){this.vaults=vaults;this.dataDirectory=dataDirectory;this.notify=notify;this.isSupported=isSupported;this.disabled=disabled;this.now=now;this.onStatus=onStatus;this.persistOverride=persist;this.loadOverride=load;this.schedules=new Map();this.fired=new Map();this.owners=new Map();this.ownerEpochs=new Map();this.ownerTargets=new Map();this.running=null;this.lastError='';this.loaded=false;this.loadPending=null;this.disposed=false;this.clearTimer=clearTimer;this.timer=timer(()=>void this.tick(),15000);this.timer?.unref?.();}
 info(){return {status:this.lastError?'error':this.disabled?'suppressed':!this.isSupported()?'unsupported':this.schedules.size?'scheduled':'idle',scheduled:this.schedules.size,permission:'system-managed',...(this.lastError?{error:this.lastError}:{})};}
 publish(){this.onStatus(this.info());}
 async load(){if(this.loaded)return;if(this.loadPending)return this.loadPending;this.loadPending=(async()=>{let records;try{if(this.loadOverride)records=await this.loadOverride();else{const file=path.join(this.dataDirectory,'calendar-reminders-fired.json'),st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>2*1024*1024)throw Error('Invalid reminder history.');records=JSON.parse(await fs.readFile(file,'utf8'));}}catch(e){if(e.code!=='ENOENT')throw e;records=[];}if(!Array.isArray(records)||records.length>MAX_SCHEDULES||records.some(row=>!Array.isArray(row)||row.length!==2||! /^[a-f0-9]{64}$/.test(row[0])||!Number.isSafeInteger(row[1])))throw Error('Invalid reminder history.');this.fired=new Map(records.filter(([,at])=>at>=this.now()-45*DAY));this.loaded=true;})();try{await this.loadPending;}finally{this.loadPending=null;}}
 async persist(){const now=this.now();const records=[...this.fired].filter(([,at])=>at>=now-45*DAY).sort((a,b)=>b[1]-a[1]).slice(0,MAX_SCHEDULES);this.fired=new Map(records);if(this.persistOverride)return this.persistOverride(records);await fs.mkdir(this.dataDirectory,{recursive:true,mode:0o700});const file=path.join(this.dataDirectory,'calendar-reminders-fired.json'),existing=await optionalStat(file);if(existing&&(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1))throw Error('Unsafe reminder history.');const temp=path.join(this.dataDirectory,'.calendar-reminders-'+crypto.randomUUID()+'.tmp');try{await durableWrite(temp,Buffer.from(JSON.stringify(records)));await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}}
 // Registrations belong to a workspace window. A root/event shared by two
 // windows still has a single durable fired entry and a single notification.
 rebuild(){const next=new Map();for(const registration of this.owners.values())for(const [id,item] of registration.items)if(!this.fired.has(id))next.set(id,item);this.schedules=next;}
 registered(id){for(const registration of this.owners.values()){const item=registration.items.get(id);if(item)return item;}return null;}
 release(owner='default'){this.ownerEpochs.set(owner,(this.ownerEpochs.get(owner)||0)+1);this.owners.delete(owner);this.ownerTargets.delete(owner);this.rebuild();this.publish();return this.info();}
 async replace(request,owner='default'){
  const schedules=validateSchedules(request,this.now());
  if(!request.enabled&&this.ownerTargets.has(owner)&&this.ownerTargets.get(owner)!==request.vaultId)return this.info();
  const epoch=(this.ownerEpochs.get(owner)||0)+1;this.ownerEpochs.set(owner,epoch);this.ownerTargets.set(owner,request.vaultId);
  // A late cleanup from an old folder must not unregister a newly opened one.
  if(!request.enabled){const old=this.owners.get(owner);if(!old||old.vaultId===request.vaultId)this.owners.delete(owner);this.rebuild();this.publish();return this.info();}
  this.owners.delete(owner);this.rebuild();
  const root=await bounded(this.vaults.root(request.vaultId));
  if(this.ownerEpochs.get(owner)!==epoch||this.disposed)return this.info();
  const items=new Map();for(const item of schedules){const id=hash(JSON.stringify([root,item.eventId,item.occurrenceStart,item.minutes]));items.set(id,{...item,id,root,vaultId:request.vaultId});}
  this.owners.set(owner,{vaultId:request.vaultId,root,items});this.lastError='';
  try{await this.load();}catch{this.lastError='提醒记录无法读取，已暂停通知。 / Reminder history could not be read; notifications are paused.';}
  this.rebuild();this.publish();return this.info();
 }
 tick(){if(this.running)return this.running;this.running=this.runTick().finally(()=>{this.running=null;});return this.running;}
 async runTick(){
  if(this.disposed||!this.schedules.size||this.lastError||this.disabled||!this.isSupported()||!this.loaded)return;
  const now=this.now(),due=[...this.schedules.values()].filter(item=>item.fireAt<=now).sort((a,b)=>b.fireAt-a.fireAt),deliver=[];
  let changed=false;
  try{
   for(const candidate of due){
    let item=this.registered(candidate.id);if(!item||this.fired.has(item.id))continue;
    const root=await bounded(this.vaults.root(item.vaultId));
    item=this.registered(candidate.id);if(!item||item.root!==root||this.disposed)continue;
    this.fired.set(item.id,now);changed=true;
    if(now-item.fireAt<=CATCHUP_MS&&deliver.length<3)deliver.push(item.id);
   }
   if(changed)await this.persist();
   for(const id of deliver){const item=this.registered(id);if(this.disposed)return;if(item)await this.notify({title:item.title,body:item.body,vaultId:item.vaultId,eventId:item.eventId,occurrenceStart:item.occurrenceStart});}
   if(due.length){this.rebuild();this.publish();}
  }catch{if(this.disposed)return;this.lastError='提醒无法发送或记录，已暂停通知；请检查系统通知设置并重试。 / Notifications are paused; check system notification settings and retry.';this.publish();}
 }
 notificationFailed(){this.lastError='系统未能显示通知。请检查系统通知设置。 / The system could not show the notification. Check notification settings.';this.publish();}
 dispose(){this.disposed=true;this.owners.clear();this.ownerEpochs.clear();this.ownerTargets.clear();this.schedules.clear();this.clearTimer(this.timer);}
}
module.exports={CALENDAR_FILE,MAX_BYTES,MAX_SCHEDULES,CalendarFiles,CalendarReminderScheduler,readICSFile,writeICSFile,validateSchedules};

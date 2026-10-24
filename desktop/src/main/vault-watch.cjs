'use strict';
// A watcher is an invalidation hint, never a source of file contents or authority.
// Each directory is independently resolved beneath the user-granted root. No
// recursive OS watch may follow a symlink into another directory tree.
const {EventEmitter}=require('node:events');const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const {relativePath}=require('./vault-service.cjs');const {fail}=require('./errors.cjs');
const {sidecarPDF}=require('./pdf-layer-service.cjs');
const {companionPDF:extendPDF}=require('./pdf-extend-service.cjs');
function extendFolder(rel){const parts=rel.split('/');for(let i=0;i<parts.length;i++){const folder=parts.slice(0,i+1).join('/');if(extendPDF(folder))return folder;}return null;}
const SKIP=new Set(['node_modules','backup','backups','text-backups','local-backups']);
function ignored(rel){const parts=rel.split('/');return parts.some((p,index)=>(p.startsWith('.')&&!(index===0&&p==='.inkspace-reviews')&&!sidecarPDF(p)&&!extendPDF(p))||SKIP.has(p.toLowerCase()));}
function identity(a,b){return a.dev===b.dev&&a.ino===b.ino;}
class VaultWatcher extends EventEmitter{
 constructor(vaults,{debounceMs=250,rescanMs=400,healthMs=5000,maxDirectories=2048,maxEntries=20000,maxPaths=200,scanTimeoutMs=3000}={}){super();this.vaults=vaults;this.options={debounceMs,rescanMs,healthMs,maxDirectories,maxEntries,maxPaths,scanTimeoutMs};this.current=null;this.epoch=0;this.pendingScanIO=new Set();}
 active(s){return this.current===s&&!s.closed;}
 closeSession(s){if(!s||s.closed)return;s.closed=true;clearTimeout(s.batchTimer);clearTimeout(s.rescanTimer);clearInterval(s.healthTimer);for(const value of s.directories.values())value.watcher.close();s.directories.clear();s.paths.clear();}
 stop(watchId){const s=this.current;if(!s||s.id!==watchId)return {stopped:false};this.epoch++;this.closeSession(s);this.current=null;return {stopped:true};}
 dispose(){this.epoch++;this.closeSession(this.current);this.current=null;}
 // Wake/poll events contain no file contents. The same authorized session is
 // revalidated before emitting; the renderer only rereads its active document.
 invalidate(reason='poll'){if(!['poll','resume','unlock'].includes(reason))fail('INVALID_REQUEST');const s=this.current;if(!s||!this.active(s))return {scheduled:false};this.queue(s,null,{rescan:true,reviewsChanged:true,reason});this.scheduleScan(s);return {scheduled:true};}
 async watch(request){if(typeof request?.vaultId!=='string')fail('INVALID_REQUEST');const epoch=++this.epoch;const root=await this.vaults.root(request.vaultId);if(epoch!==this.epoch)fail('CANCELLED');this.closeSession(this.current);
  const s={id:crypto.randomUUID(),vaultId:request.vaultId,root,directories:new Map(),paths:new Set(),sequence:0,closed:false,rescan:false,reviewsChanged:false,reason:'change',limited:false,eventChecks:0,scanPromise:null,scanAgain:false};this.current=s;
  try{await this.scan(s);if(!this.active(s))fail('CANCELLED');s.healthTimer=setInterval(()=>{void this.health(s);},this.options.healthMs);s.healthTimer.unref?.();return {watchId:s.id,vaultId:s.vaultId,mode:s.directories.size?'native':'manual',limited:s.limited};}catch(error){if(this.active(s)){this.closeSession(s);this.current=null;}throw error;}
 }
 unavailable(s){if(!this.active(s))return;const event={watchId:s.id,vaultId:s.vaultId,sequence:++s.sequence,paths:[],rescan:true,reviewsChanged:false,reason:'unavailable'};this.closeSession(s);this.current=null;this.emit('change',event);}
 async health(s){if(!this.active(s)||s.healthPending)return;s.healthPending=true;try{await this.vaults.root(s.vaultId);}catch{this.unavailable(s);}finally{s.healthPending=false;}}
 queue(s,rel,{rescan=false,reviewsChanged=false,reason='change'}={}){if(!this.active(s))return;if(rel){if(s.paths.size<this.options.maxPaths)s.paths.add(rel);else{s.rescan=true;s.limited=true;s.reason='limit';}}s.rescan ||= rescan;s.reviewsChanged ||= reviewsChanged;const priorities={change:0,poll:1,unlock:2,resume:3,limit:4};if((priorities[reason]??0)>(priorities[s.reason]??0))s.reason=reason;if(reason==='limit')s.limited=true;if(!s.batchTimer){s.batchTimer=setTimeout(()=>{s.batchTimer=null;void this.flush(s);},this.options.debounceMs);s.batchTimer.unref?.();}}
 async flush(s){if(!this.active(s))return;try{await this.vaults.root(s.vaultId);}catch{this.unavailable(s);return;}if(!this.active(s))return;const event={watchId:s.id,vaultId:s.vaultId,sequence:++s.sequence,paths:[...s.paths].sort(),rescan:s.rescan,reviewsChanged:s.reviewsChanged,reason:s.reason};s.paths.clear();s.rescan=false;s.reviewsChanged=false;s.reason='change';this.emit('change',event);}
 scheduleScan(s){if(!this.active(s)||s.rescanTimer)return;s.rescanTimer=setTimeout(()=>{s.rescanTimer=null;void this.scan(s).catch(()=>this.unavailable(s));},this.options.rescanMs);s.rescanTimer.unref?.();}
 async changed(s,folder,watched,eventType,filename){if(!this.active(s))return;if(s.eventChecks>=32){this.queue(s,null,{rescan:true,reviewsChanged:folder==='.inkspace-reviews'});return;}s.eventChecks++;try{const current=await this.vaults.resolve(s.vaultId,folder,{directory:true});if(!this.active(s))return;if(!identity(current.stat,watched)){this.queue(s,null,{rescan:true,reviewsChanged:folder==='.inkspace-reviews'});this.scheduleScan(s);return;}
   // Node does not guarantee a filename in native watch callbacks. The known,
   // authorized directory alone is enough to invalidate reviews without names.
   const extend=extendFolder(folder);if(extend){this.queue(s,extend,{rescan:false});if(eventType==='rename')this.scheduleScan(s);return;}
   if(sidecarPDF(folder)){this.queue(s,folder,{rescan:false});return;}
   if(folder==='.inkspace-reviews'){this.queue(s,null,{reviewsChanged:true,rescan:filename==null});if(eventType==='rename')this.scheduleScan(s);return;}
   if(filename==null){this.queue(s,null,{rescan:true});this.scheduleScan(s);return;}const name=Buffer.isBuffer(filename)?filename.toString('utf8'):String(filename);if(!name||name.includes('/')||name.includes('\\')){this.queue(s,null,{rescan:true});return;}const rel=folder?folder+'/'+name:name;try{relativePath(rel);}catch{return;}if(rel==='.inkspace-folder-order.json'){this.queue(s,null,{rescan:true});return;}if(ignored(rel))return;
   if(sidecarPDF(rel)||extendPDF(rel)){try{await this.vaults.resolve(s.vaultId,sidecarPDF(rel)||extendPDF(rel));}catch{return;}this.queue(s,rel,{rescan:false});this.scheduleScan(s);return;}
   // A review event only signals that the dedicated review API should refresh.
   if(rel==='.inkspace-reviews'||rel.startsWith('.inkspace-reviews/')){this.queue(s,null,{reviewsChanged:true});if(eventType==='rename')this.scheduleScan(s);return;}
   let stat;try{stat=await fsp.lstat(path.join(s.root,rel));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(!this.active(s))return;if(stat&&(stat.isSymbolicLink()||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))))return;
   // Directory replacement is signalled as an invalidation; readers still
   // enforce their own path/identity/SHA checks before reading or saving.
   this.queue(s,rel,{rescan:eventType==='rename'||!!stat?.isDirectory()});if(eventType==='rename'||stat?.isDirectory())this.scheduleScan(s);
  }catch{if(folder==='')this.unavailable(s);else{this.queue(s,null,{rescan:true});this.scheduleScan(s);}}finally{s.eventChecks--;}
 }
 // A deadline limits the wait, not the underlying filesystem operation. Keep
 // that operation (including a late directory close) single-flight across sessions.
 trackScanIO(promise){const pending={};this.pendingScanIO.add(pending);const settled=()=>{this.pendingScanIO.delete(pending);this.resumeScan();};return Promise.resolve(promise).then(value=>{settled();return value;},error=>{settled();throw error;});}
 resumeScan(){const s=this.current;if(s&&this.active(s)&&s.scanAgain&&!s.scanPromise&&!this.pendingScanIO.size){s.scanAgain=false;this.scheduleScan(s);}}
 async scan(s){if(!this.active(s))return;if(s.scanPromise){s.scanAgain=true;return s.scanPromise;}if(this.pendingScanIO.size){s.scanAgain=true;s.limited=true;return;}s.scanPromise=this.scanOnce(s);try{await s.scanPromise;}finally{s.scanPromise=null;this.resumeScan();}}
 async scanOnce(s){const pending=[''],found=new Set();let entries=0,limited=false,incomplete=false,capacityDeferred=false;const deadline=Date.now()+this.options.scanTimeoutMs;
  const bounded=async promise=>{let timer;const work=this.trackScanIO(promise);try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{if(this.active(s))s.scanAgain=true;reject(Object.assign(Error('Watch scan limit'),{code:'WATCH_LIMIT'}));},Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}};
  while(pending.length&&this.active(s)){
   if(found.size>=this.options.maxDirectories||entries>=this.options.maxEntries||Date.now()>=deadline){limited=incomplete=true;break;}const rel=pending.shift();let resolved;
   try{resolved=await bounded(this.vaults.resolve(s.vaultId,rel,{directory:true}));}catch(error){if(rel===''&&error.code!=='WATCH_LIMIT')throw error;limited=incomplete=true;continue;}if(!this.active(s))return;found.add(rel);let old=s.directories.get(rel);
   if(old&&!identity(old.stat,resolved.stat)){old.watcher.close();s.directories.delete(rel);old=null;this.queue(s,null,{rescan:true});}
   if(!old){if(s.directories.size>=this.options.maxDirectories){limited=capacityDeferred=true;}else try{const watcher=fs.watch(resolved.full,{persistent:false,recursive:false},(eventType,filename)=>{void this.changed(s,rel,resolved.stat,eventType,filename);});watcher.on('error',()=>{if(!this.active(s))return;watcher.close();s.directories.delete(rel);s.limited=true;if(!s.watchFailureNotified){s.watchFailureNotified=true;this.queue(s,null,{rescan:true,reason:'limit'});this.scheduleScan(s);}});s.directories.set(rel,{watcher,stat:resolved.stat});}catch{limited=true;}}
   // The review directory has no legitimate subdirectories; no record contents
   // or names need to be enumerated for the dedicated directory watcher.
   if(rel==='.inkspace-reviews'||sidecarPDF(rel)||(extendFolder(rel)&&!extendPDF(rel)))continue;
   let dir;const opening=fsp.opendir(resolved.full);try{dir=await bounded(opening);}catch{void this.trackScanIO(opening.then(d=>d.close(),()=>{})).catch(()=>{});limited=incomplete=true;continue;}
   try{while(this.active(s)){if(entries>=this.options.maxEntries||Date.now()>=deadline){limited=incomplete=true;break;}let entry;try{entry=await bounded(dir.read());}catch{limited=incomplete=true;break;}if(!entry)break;entries++;if(!entry.isDirectory()||entry.isSymbolicLink())continue;const child=rel?rel+'/'+entry.name:entry.name;try{relativePath(child);}catch{continue;}if(ignored(child))continue;if(extendPDF(rel)&&!['events','assets'].includes(entry.name))continue;if(sidecarPDF(child)||extendPDF(child)){try{await bounded(this.vaults.resolve(s.vaultId,sidecarPDF(child)||extendPDF(child)));}catch{limited=incomplete=true;continue;}}if(pending.length+found.size>=this.options.maxDirectories){limited=incomplete=true;continue;}pending.push(child);}}finally{try{await bounded(Promise.resolve().then(()=>dir.close()));}catch{limited=true;}}
  }
  // Only a complete traversal proves that a previously watched directory is gone.
  if(!this.active(s))return;if(!incomplete&&!pending.length)for(const [rel,value]of s.directories){if(!found.has(rel)){value.watcher.close();s.directories.delete(rel);}}
  if(capacityDeferred&&!incomplete&&s.directories.size<this.options.maxDirectories)s.scanAgain=true;
  limited ||= [...found].some(rel=>!s.directories.has(rel));if(limited){const previous=s.limited;s.limited=true;if(!previous)this.queue(s,null,{rescan:true,reason:'limit'});}else s.limited=false;
 }
}
module.exports={VaultWatcher,ignored};

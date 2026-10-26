'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {StudyService}=require('./study-service.cjs');
const M=require('./study-layout-model.cjs');
const {relativePath}=require('./vault-path.cjs');
const {UUID}=require('./study-model.cjs');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const directory=boardID=>`.inkspace-study/${boardID}/layouts`;
const warning='Existing layout could not be safely applied; original bytes were preserved and card order was used.';
class StudyLayoutService {
 constructor(vaults,options={}){this.vaults=vaults;this.study=options.studyService||new StudyService(vaults);this.fs=options.fs||fs;}
 request(v,writing=false){const keys=writing?['vaultId','path','itemID','expectedRevision','layout','replaceStale']:['vaultId','path','itemID'];if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.filter(k=>k!=='replaceStale').some(k=>!Object.hasOwn(v,k))||typeof v.vaultId!=='string'||!UUID.test(v.itemID))M.failure();relativePath(v.path);if(!v.path.toLowerCase().endsWith('.inkspace.json'))M.failure();if(writing&&Object.hasOwn(v,'replaceStale')&&typeof v.replaceStale!=='boolean')M.failure();if(writing&&v.expectedRevision!==null&&!/^[a-f0-9]{64}$/.test(v.expectedRevision))M.failure();return{...v,itemID:v.itemID.toLowerCase()};}
 async structure(r){const projection=await this.study.read({vaultId:r.vaultId,path:r.path});if(projection.warnings.length)M.failure('STUDY_LAYOUT_CONFLICT');const card=projection.cards.find(c=>c.itemID===r.itemID);if(!card)M.failure('STUDY_LAYOUT_CONFLICT');return M.makeStructure(projection.boardID,r.itemID,card.card);}
 async bytes(r,structure){const rel=directory(structure.boardID)+'/'+structure.itemID+'.json';try{const snap=await this.vaults.snapshotForRead({vaultId:r.vaultId,path:rel},M.MAX_BYTES);return snap.data;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 snapshot(data,structure){
  if(data===null)return{structure,layout:null,revision:null,readOnly:false,canReplaceStale:false,warning:null};
  try{const stored=M.decodeStored(data,structure.boardID,structure.itemID);if(stored.structureSignature!==structure.signature)return{structure,layout:null,revision:M.revision(data),readOnly:true,canReplaceStale:true,warning:'Card structure changed; a new layout can be saved while retaining the old layout.'};return{structure,layout:M.validateLayout(stored,structure),revision:M.revision(data),readOnly:false,canReplaceStale:false,warning:null};}
  catch{return{structure,layout:null,revision:M.revision(data),readOnly:true,canReplaceStale:false,warning};}
 }
 async read(v){const r=this.request(v),structure=await this.structure(r),bytes=await this.bytes(r,structure);return this.snapshot(bytes,structure);}
 async save(v,{signal}={}){const r=this.request(v,true);const check=()=>{if(signal?.aborted)M.failure('STUDY_LAYOUT_CANCELLED');};check();return this.vaults.locked(r.vaultId+':file-management',async()=>{
  const first=await this.structure(r);return this.vaults.locked(r.vaultId+':study:'+first.boardID,async()=>{
   const structure=await this.structure(r),layout=M.validateLayout(r.layout,structure),prior=await this.bytes(r,structure);
   if(M.revision(prior)!==r.expectedRevision)M.failure('STUDY_LAYOUT_CONFLICT');const existing=this.snapshot(prior,structure);if(existing.readOnly&&!(r.replaceStale===true&&existing.canReplaceStale))M.failure('STUDY_LAYOUT_READ_ONLY');if(r.replaceStale===true&&!existing.canReplaceStale)M.failure('STUDY_LAYOUT_CONFLICT');check();
   const data=Buffer.from(JSON.stringify(layout)+'\n');if(data.length>M.MAX_BYTES)M.failure('STUDY_LAYOUT_LIMIT');
   const rel=directory(structure.boardID),dir=await this.ensure(r,rel),name=structure.itemID+'.json',temporary='.pending-layout-'+crypto.randomUUID();
   const temp=path.join(dir.full,temporary),dest=path.join(dir.full,name);let held,published=false,history=null;
   const cleanup=async()=>{if(!held)return;try{const parent=await this.vaults.resolve(r.vaultId,rel,{directory:true}),s=await this.fs.lstat(temp);if(same(parent.stat,dir.stat)&&same(held,s))await this.fs.unlink(temp);}catch{}};
   try{
    if(r.replaceStale===true)history=await this.backup(r,structure,prior,check);check();
    const h=await this.fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{held=await h.stat();await h.writeFile(data);await h.sync();}finally{await h.close();}
    const fresh=await this.structure(r);if(fresh.signature!==structure.signature)M.failure('STUDY_LAYOUT_CONFLICT');
    const parent=await this.vaults.resolve(r.vaultId,rel,{directory:true});if(!same(parent.stat,dir.stat)||M.revision(await this.bytes(r,structure))!==r.expectedRevision)M.failure('STUDY_LAYOUT_CONFLICT');
    check();try{await this.fs.rename(temp,dest);published=true;}catch(e){const actual=await this.bytes(r,structure);if(actual!==null&&actual.equals(data))published=true;else throw e;}
    try{const d=await this.fs.open(dir.full,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}}catch{
     const actual=await this.bytes(r,structure);if(actual===null||!actual.equals(data))M.failure('STUDY_LAYOUT_UNAVAILABLE');return{...this.snapshot(actual,structure),warning:'Layout was written; directory synchronization is not confirmed. Refresh to verify.'};
    }
    return this.snapshot(data,structure);
   }finally{if(!published){await cleanup();if(history)await history.cleanup();}}
  });
 });}
 async backup(r,structure,data,check){
  const rel=`.inkspace-study/${structure.boardID}/layout-history`,dir=await this.ensure(r,rel),prefix=structure.itemID+'-',name=prefix+M.revision(data)+'.json',destination=path.join(dir.full,name);
  const read=async()=>{try{return(await this.vaults.snapshotForRead({vaultId:r.vaultId,path:rel+'/'+name},M.MAX_BYTES)).data;}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  const sync=async()=>{const f=await this.fs.open(destination,constants.O_RDONLY|constants.O_NOFOLLOW);try{await f.sync();}finally{await f.close();}const d=await this.fs.open(dir.full,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}};
  const prior=await read();if(prior!==null){if(!prior.equals(data))M.failure('STUDY_LAYOUT_CONFLICT');await sync();return null;}
  const names=(await this.fs.readdir(dir.full)).filter(n=>n.startsWith(prefix));if(names.length>=M.MAX_HISTORY_COUNT)M.failure('STUDY_LAYOUT_HISTORY_LIMIT');let total=data.length;
  for(const n of names){check();total+=(await this.vaults.snapshotForRead({vaultId:r.vaultId,path:rel+'/'+n},M.MAX_BYTES)).data.length;}if(total>M.MAX_HISTORY_BYTES)M.failure('STUDY_LAYOUT_HISTORY_LIMIT');
  const temporary=path.join(dir.full,'.pending-layout-'+crypto.randomUUID());let held,owned=false;
  const cleanup=async()=>{if(!owned||!held)return;const parent=await this.vaults.resolve(r.vaultId,rel,{directory:true});if(!same(parent.stat,dir.stat))return;try{const s=await this.fs.lstat(destination);if(same(s,held))await this.fs.unlink(destination);}catch(e){if(e.code!=='ENOENT')throw e;}};
  try{
   const f=await this.fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{held=await f.stat();await f.writeFile(data);await f.sync();}finally{await f.close();}
   check();const parent=await this.vaults.resolve(r.vaultId,rel,{directory:true});if(!same(parent.stat,dir.stat))M.failure('STUDY_LAYOUT_CONFLICT');
   try{await this.fs.link(temporary,destination);owned=true;}catch(e){if(e.code!=='EEXIST')throw e;const existing=await read();if(existing===null||!existing.equals(data))M.failure('STUDY_LAYOUT_CONFLICT');}
   await this.fs.unlink(temporary);await sync();return owned?{cleanup}:null;
  }catch(e){await cleanup();throw e;}finally{try{const s=await this.fs.lstat(temporary);if(held&&same(s,held))await this.fs.unlink(temporary);}catch{}}
 }
 async ensure(r,rel){const parts=rel.split('/');for(let i=1;i<=parts.length;i++){const current=parts.slice(0,i).join('/');try{await this.vaults.resolve(r.vaultId,current,{directory:true});}catch(e){if(e.code!=='ENOENT')throw e;const parent=i===1?await this.vaults.root(r.vaultId):(await this.vaults.resolve(r.vaultId,parts.slice(0,i-1).join('/'),{directory:true})).full;try{await this.fs.mkdir(path.join(parent,parts[i-1]),{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await this.vaults.resolve(r.vaultId,current,{directory:true});}}return this.vaults.resolve(r.vaultId,rel,{directory:true});}
}
module.exports={StudyLayoutService,directory};

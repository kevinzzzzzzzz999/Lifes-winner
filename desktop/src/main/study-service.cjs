'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{constants}=require('node:fs');
const {validateEvent,projectEvents,canonical,LIMITS,UUID}=require('./study-model.cjs'),{validateBoard}=require('./board-validation.cjs'),{relativePath}=require('./vault-path.cjs'),{fail}=require('./errors.cjs');
const directory=boardID=>'.inkspace-study/'+boardID.toLowerCase()+'/events';
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('INVALID_REQUEST');}
const identity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
async function sync(full){const h=await fs.open(full,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}
class StudyService{
 constructor(vaults,options={}){this.vaults=vaults;this.limits={...LIMITS,...options};}
 request(v,append=false){exact(v,append?['vaultId','path','event']:['vaultId','path']);if(typeof v.vaultId!=='string')fail('INVALID_REQUEST');relativePath(v.path);if(!v.path.toLowerCase().endsWith('.inkspace.json'))fail('INVALID_REQUEST');return{vaultId:v.vaultId,path:v.path};}
 async bounded(work,deadline){if(Date.now()>deadline){void Promise.resolve(work).catch(()=>{});fail('STUDY_TIMEOUT');}let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Learning cards are still downloading.'),{code:'STUDY_TIMEOUT'})),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}}
 async source(request,deadline){const snap=await this.bounded(this.vaults.snapshotForRead(request,this.limits.maxBoard),deadline);let board;try{board=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(snap.data));}catch{fail('INVALID_BOARD');}validateBoard(board);return{boardID:board.id.toLowerCase(),nodeIDs:board.items.map(i=>i.id.toLowerCase()),sha256:snap.sha256,board};}
 async scan(request,boardID,deadline){
  const rel=directory(boardID);let dir;try{dir=await this.bounded(this.vaults.resolve(request.vaultId,rel,{directory:true}),deadline);}catch(e){if(e.code==='ENOENT')return{events:[],warnings:[],count:0,bytes:0,records:new Map(),unsafe:false};throw e;}
  const entries=await this.bounded(fs.readdir(dir.full,{withFileTypes:true}),deadline);if(entries.length>this.limits.maxFiles)fail('TOO_LARGE');
  const events=[],warnings=new Set(),records=new Map();let bytes=0,index=0,stopped=false,unsafe=false;
  const worker=async()=>{while(!stopped){const entry=entries[index++];if(!entry)return;if(!entry.isFile()||!/^([a-f0-9-]+)\.json$/i.test(entry.name)||!UUID.test(entry.name.slice(0,-5))){unsafe=true;warnings.add('Unrecognized learning event file was preserved.');continue;}
   let snap,event;try{snap=await this.bounded(this.vaults.snapshotForRead({vaultId:request.vaultId,path:rel+'/'+entry.name},this.limits.maxRecord),deadline);if(stopped)return;bytes+=snap.data.length;if(bytes>this.limits.maxBytes)fail('TOO_LARGE');event=validateEvent(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(snap.data)));if(event.id!==entry.name.slice(0,-5).toLowerCase()||event.boardID!==boardID)throw Error('Mismatched learning event identity');}
   catch(e){if(['TOO_LARGE','STUDY_TIMEOUT','NO_VAULT','PATH_DENIED','CONFLICT'].includes(e.code))throw e;unsafe=true;warnings.add('Invalid learning event was preserved without applying it.');continue;}
   events.push(event);const old=records.get(event.id);if(old&&old.canonical!==canonical(event)){old.conflict=true;unsafe=true;warnings.add('Conflicting learning event identifiers were preserved.');}else if(!old)records.set(event.id,{canonical:canonical(event),event,conflict:false});
  }};
  try{await Promise.all(Array.from({length:Math.min(4,this.limits.concurrency,entries.length)},worker));}catch(e){stopped=true;throw e;}
  const final=await this.bounded(this.vaults.resolve(request.vaultId,rel,{directory:true}),deadline);if(!identity(dir.stat,final.stat))fail('CONFLICT');return{events,warnings:[...warnings],count:entries.length,bytes,records,unsafe};
 }
 async read(value){const request=this.request(value),deadline=Date.now()+this.limits.timeoutMs,source=await this.source(request,deadline),scan=await this.scan(request,source.boardID,deadline),after=await this.source(request,deadline);if(after.boardID!==source.boardID)fail('CONFLICT');return projectEvents(source.boardID,scan.events,after.nodeIDs,scan.warnings);}
 async ensure(request,rel){const parts=rel.split('/');for(let i=1;i<=parts.length;i++){const current=parts.slice(0,i).join('/');try{await this.vaults.resolve(request.vaultId,current,{directory:true});}catch(e){if(e.code!=='ENOENT')throw e;const parent=i===1?await this.vaults.root(request.vaultId):(await this.vaults.resolve(request.vaultId,parts.slice(0,i-1).join('/'),{directory:true})).full;try{await fs.mkdir(path.join(parent,parts[i-1]),{mode:0o700});await sync(parent);}catch(e){if(e.code!=='EEXIST')throw e;}await this.vaults.resolve(request.vaultId,current,{directory:true});}}return this.vaults.resolve(request.vaultId,rel,{directory:true});}
 async publish(request,event,beforePublish){
  const rel=directory(event.boardID),dir=await this.ensure(request,rel),temp=path.join(dir.full,'.save-'+crypto.randomUUID()+'.tmp'),dest=path.join(dir.full,event.id+'.json'),data=Buffer.from(canonical(event)+'\n');let held;
  const cleanup=async()=>{if(!held)return;try{const parent=await this.vaults.resolve(request.vaultId,rel,{directory:true}),stat=await fs.lstat(temp);if(identity(dir.stat,parent.stat)&&identity(held,stat))await fs.unlink(temp);}catch{}};
  const handle=await fs.open(temp,'wx',0o600);let writeError;try{held=await handle.stat();await handle.writeFile(data);await handle.sync();}catch(e){writeError=e;}finally{await handle.close();}if(writeError){await cleanup();throw writeError;}
  try{await beforePublish();const current=await this.vaults.resolve(request.vaultId,rel,{directory:true});if(!identity(dir.stat,current.stat))fail('CONFLICT');try{await fs.link(temp,dest);}catch(e){if(e.code!=='EEXIST')throw e;const old=await this.vaults.snapshot({vaultId:request.vaultId,path:rel+'/'+event.id+'.json'},this.limits.maxRecord);let oldEvent;try{oldEvent=validateEvent(JSON.parse(old.data.toString('utf8')));}catch{fail('CONFLICT');}if(canonical(oldEvent)!==canonical(event))fail('CONFLICT');}await cleanup();await sync(dir.full);}finally{await cleanup();}
 }
 async append(value){const request=this.request(value,true),event=validateEvent(value.event);return this.vaults.locked(request.vaultId+':file-management',()=>this.vaults.locked(request.vaultId+':study:'+event.boardID,async()=>{
  const deadline=Date.now()+this.limits.timeoutMs,source=await this.source(request,deadline);if(source.boardID!==event.boardID)fail('CONFLICT');const scan=await this.scan(request,event.boardID,deadline),old=scan.records.get(event.id);
  if(old){if(old.conflict||old.canonical!==canonical(event))fail('CONFLICT');const current=await this.source(request,deadline);if(current.boardID!==event.boardID)fail('CONFLICT');return projectEvents(event.boardID,scan.events,current.nodeIDs,scan.warnings);}
  if(scan.unsafe)fail('STUDY_INCOMPLETE');
  if(event.kind!=='delete'&&!source.nodeIDs.includes(event.itemID))fail('STUDY_NODE_MISSING');
  if(event.kind==='grade'){const card=projectEvents(event.boardID,scan.events,source.nodeIDs).cards.find(c=>c.itemID===event.itemID);if(!card)fail('STUDY_CARD_MISSING');const node=source.board.items.find(n=>n.id.toLowerCase()===event.itemID);if(card.card.answerMode==='node'&&require('./study-image.cjs').imageNodePath(node))await require('./study-image.cjs').loadNodeImage(this.vaults,request,node,this.limits.nativeImage);}
  if(event.kind==='card'||event.kind==='grade'){const card=event.kind==='card'?event.card:projectEvents(event.boardID,scan.events,source.nodeIDs).cards.find(c=>c.itemID===event.itemID)?.card;const paths=new Set([...(card?.questionBlocks||[]),...(card?.answerBlocks||[])].filter(b=>b.kind==='image').map(b=>b.sourcePath));for(const sourcePath of paths)await require('./study-image.cjs').loadNodeImage(this.vaults,request,{kind:'document',sourcePath},this.limits.nativeImage);}
  const bytes=Buffer.byteLength(canonical(event)+'\n');if(scan.count>=this.limits.maxFiles||scan.bytes+bytes>this.limits.maxBytes)fail('TOO_LARGE');
  await this.publish(request,event,async()=>{const current=await this.source(request,deadline);if(current.boardID!==event.boardID)fail('CONFLICT');if(event.kind!=='delete'&&!current.nodeIDs.includes(event.itemID))fail('STUDY_NODE_MISSING');});
  return this.read(request);
 }));}
}
module.exports={StudyService,directory};

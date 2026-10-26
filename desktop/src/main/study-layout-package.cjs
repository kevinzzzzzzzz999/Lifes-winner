'use strict';
// Optional presentation-only transfer. It never creates cards, media or study events.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{constants}=require('node:fs');
const M=require('./study-layout-model.cjs'),{UUID,timestamp}=require('./study-model.cjs');
const {StudyLayoutService,directory}=require('./study-layout-service.cjs');
const MAX_BYTES=4*1024*1024,MAX_LAYOUTS=500;
const failure=(code='STUDY_LAYOUT_PACKAGE_INVALID')=>{throw Object.assign(Error(code),{code});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const identity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function decode(data){
 if(data.length>MAX_BYTES)failure('TOO_LARGE');let v;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{failure();}
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['version','kind','boardID','exportedAt','layouts'].includes(k))||v.version!==1||v.kind!=='study-layout-package'||!UUID.test(v.boardID||'')||v.boardID!==v.boardID.toLowerCase()||!Array.isArray(v.layouts)||!v.layouts.length||v.layouts.length>MAX_LAYOUTS)failure();
 timestamp(v.exportedAt);const seen=new Set();v.layouts=v.layouts.map(raw=>{if(!raw||!UUID.test(raw.itemID||'')||raw.itemID!==raw.itemID.toLowerCase()||seen.has(raw.itemID))failure();seen.add(raw.itemID);return M.decodeStored(Buffer.from(JSON.stringify(raw)),v.boardID,raw.itemID);});
 return v;
}
function encode(boardID,layouts){const value=decode(Buffer.from(JSON.stringify({version:1,kind:'study-layout-package',boardID,exportedAt:new Date().toISOString(),layouts})));return Buffer.from(JSON.stringify(value)+'\n');}
class StudyLayoutPackageService {
 constructor(vaults,study,options={}){this.vaults=vaults;this.study=study;this.layouts=new StudyLayoutService(vaults,{studyService:study});this.sessions=new Map();this.fs=options.fs||fs;}
 request(v,token=false){const keys=token?['vaultId','path','token']:['vaultId','path'];if(!v||Object.keys(v).some(k=>!keys.includes(k)))failure();return this.study.request({vaultId:v.vaultId,path:v.path});}
 session(v){const s=this.sessions.get(v.token);if(!s||s.vaultId!==v.vaultId||s.path!==v.path||Date.now()-s.created>3600000)failure('STUDY_IMPORT_EXPIRED');return s;}
 async plan(req,pack){const projection=await this.study.read(req);if(projection.warnings.length||projection.boardID!==pack.boardID)failure('STUDY_LAYOUT_CONFLICT');const cards=new Map(projection.cards.filter(c=>!c.missingNode).map(c=>[c.itemID,c]));const plans=[];for(const layout of pack.layouts){const card=cards.get(layout.itemID);if(!card)failure('STUDY_LAYOUT_CONFLICT');const structure=M.makeStructure(pack.boardID,layout.itemID,card.card);M.validateLayout(layout,structure);const prior=await this.layouts.bytes({...req,itemID:layout.itemID},structure);let duplicate=false,conflict=false;if(prior!==null){try{duplicate=equal(M.decode(prior,structure),layout);}catch{}conflict=!duplicate;}plans.push({layout,structure,prior,duplicate,conflict});}return plans;}
 async select(v,{dialog,window}){const req=this.request(v);const chosen=await dialog.showOpenDialog(window,{title:'Card layout package / 卡片排版包（不含题面和附件）',properties:['openFile'],filters:[{name:'Card layout JSON',extensions:['json']}]});if(chosen.canceled||!chosen.filePaths[0])return null;return this.selectFile(req,chosen.filePaths[0]);}
 async selectFile(req,filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let data;try{const a=await h.stat();if(!a.isFile()||a.nlink!==1||a.size>MAX_BYTES||a.size<1)failure();data=Buffer.alloc(a.size+1);let count=0;while(count<data.length){const r=await h.read(data,count,data.length-count,count);if(!r.bytesRead)break;count+=r.bytesRead;}data=data.subarray(0,count);const b=await h.stat(),n=await fs.lstat(filename);if(data.length!==a.size||!identity(a,b)||!identity(b,n)||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs||data.length>MAX_BYTES)failure('CONFLICT');}finally{await h.close();}
 const pack=decode(data),plans=await this.plan(req,pack),token=crypto.randomUUID();if(this.sessions.size>=4){const old=[...this.sessions].find(([,s])=>!s.busy);if(!old)failure('BUSY');this.sessions.delete(old[0]);}this.sessions.set(token,{...req,pack,created:Date.now(),busy:false,cancelled:false});return{token,name:path.basename(filename),boardID:pack.boardID,count:plans.length,ready:plans.filter(p=>!p.duplicate&&!p.conflict).length,duplicates:plans.filter(p=>p.duplicate).length,conflicts:plans.filter(p=>p.conflict).length,canCommit:!plans.some(p=>p.conflict)};
 }
 cancel(v){this.request(v,true);const s=this.session(v);s.cancelled=true;if(!s.busy)this.sessions.delete(v.token);return{cancelled:true};}
 async commit(v,{signal}={}){const req=this.request(v,true),s=this.session(v);if(s.busy)failure('BUSY');const check=()=>{if(s.cancelled||signal?.aborted)failure('STUDY_LAYOUT_CANCELLED');};check();s.busy=true;try{return await this.vaults.locked(v.vaultId+':file-management',()=>this.vaults.locked(v.vaultId+':study:'+s.pack.boardID,async()=>{
  check();const plans=await this.plan(req,s.pack);if(plans.some(p=>p.conflict))failure('STUDY_LAYOUT_CONFLICT');const fresh=plans.filter(p=>!p.duplicate);if(!fresh.length)return{imported:0,duplicates:plans.length};
  const rel=directory(s.pack.boardID),dir=await this.layouts.ensure(req,rel),owned=[],staged=[];let complete=false;
  try{
   for(const p of fresh){check();const temp=path.join(dir.full,'.package-'+crypto.randomUUID()),dest=path.join(dir.full,p.layout.itemID+'.json'),data=Buffer.from(JSON.stringify(p.layout)+'\n');let held;const h=await this.fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{held=await h.stat();staged.push({temp,dest,held,data,itemID:p.layout.itemID});await h.writeFile(data);await h.sync();}finally{await h.close();}}
   const again=await this.plan(req,s.pack);if(again.some(p=>p.conflict)||again.filter(p=>p.duplicate).length!==plans.filter(p=>p.duplicate).length)failure('STUDY_LAYOUT_CONFLICT');
   for(const p of staged){check();const parent=await this.vaults.resolve(req.vaultId,rel,{directory:true});if(!identity(parent.stat,dir.stat))failure('CONFLICT');await this.fs.link(p.temp,p.dest);owned.push(p);await this.fs.unlink(p.temp);}
   check();const final=await this.plan(req,s.pack);if(final.some(p=>!p.duplicate))failure('STUDY_LAYOUT_CONFLICT');const d=await this.fs.open(dir.full,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}complete=true;return{imported:owned.length,duplicates:plans.length-owned.length};
  }finally{
   let failed=false;if(!complete)for(const p of owned.reverse()){try{const parent=await this.vaults.resolve(req.vaultId,rel,{directory:true}),n=await this.fs.lstat(p.dest);if(!identity(parent.stat,dir.stat)||!identity(n,p.held)||(await fs.readFile(p.dest)).compare(p.data)!==0)failure();await this.fs.unlink(p.dest);}catch{failed=true;}}
   for(const p of staged){try{const parent=await this.vaults.resolve(req.vaultId,rel,{directory:true}),n=await this.fs.lstat(p.temp);if(!identity(parent.stat,dir.stat)||!identity(n,p.held))failure();await this.fs.unlink(p.temp);}catch(e){if(e.code!=='ENOENT')failed=true;}}
   if(failed)failure('FILE_OPERATION_RECOVERY');
  }
 }));}finally{s.busy=false;if(s.cancelled)this.sessions.delete(v.token);}}
 async exportData(v){const req=this.request(v);return this.vaults.lockedBoard(req,async()=>{const projection=await this.study.read(req);if(projection.warnings.length)failure('STUDY_INCOMPLETE');const layouts=[];for(const card of projection.cards){if(card.missingNode||!['qa','occlusion'].includes(card.card.mode))continue;const structure=M.makeStructure(projection.boardID,card.itemID,card.card),data=await this.layouts.bytes({...req,itemID:card.itemID},structure);if(data!==null)layouts.push(M.decode(data,structure));if(layouts.length>MAX_LAYOUTS)failure('TOO_LARGE');}if(!layouts.length)failure('STUDY_LAYOUT_PACKAGE_EMPTY');return{data:encode(projection.boardID,layouts),name:path.basename(v.path).replace(/\.inkspace\.json$/i,'')+'-card-layouts.json',count:layouts.length};});}
}
module.exports={StudyLayoutPackageService,decode,encode,MAX_BYTES,MAX_LAYOUTS};

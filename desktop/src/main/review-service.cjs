'use strict';
// Immutable, independent review records. Originals (including PKDrawing) are
// never a write target. Delete markers win regardless of arrival order.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {relativePath,durableWrite}=require('./vault-service.cjs');const {fail}=require('./errors.cjs');
const DIRECTORY='.inkspace-reviews';const MAX_RECORD_BYTES=128*1024,MAX_ENTRIES=10000,MAX_TOTAL_BYTES=32*1024*1024,MAX_CREATE_BYTES=28*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RECORD_NAME=/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/;
const DELETED_NAME=/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.deleted\.json$/i;
const W={unavailable:'Some review records are unavailable or invalid.',deleted:'An invalid delete marker was retained; its review stays hidden.',limit:'The review list is incomplete because a scan limit was reached.',unknown:'Unrecognized review files were omitted.'};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const ensure=v=>{if(!v)fail('INVALID_REVIEW');};
function safePath(value){relativePath(value);if(value.split('/').some(p=>p.toLowerCase()===DIRECTORY))fail('PATH_DENIED');return value;}
function uuid(value){ensure(typeof value==='string'&&UUID.test(value));return value.toLowerCase();}
function timestamp(value){ensure(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)&&Number.isFinite(Date.parse(value)));}
function rect(value,max){ensure(object(value)&&['x','y','width','height'].every(k=>typeof value[k]==='number'&&Number.isFinite(value[k]))&&value.x>=0&&value.y>=0&&value.width>0&&value.height>0&&value.x+value.width<=max+1e-9&&value.y+value.height<=max+1e-9);}
function validateReview(value,filenameID){ensure(object(value)&&value.schemaVersion===1);const id=uuid(value.id);if(filenameID)ensure(id===filenameID.toLowerCase());uuid(value.boardID);safePath(value.boardPath);ensure(value.boardPath.toLowerCase().endsWith('.inkspace.json'));timestamp(value.createdAt);ensure(typeof value.comment==='string'&&value.comment.length<=10000&&!value.comment.includes('\0'));ensure(typeof value.color==='string'&&/^#[a-f0-9]{6}$/i.test(value.color));rect(value.rect,8000000);ensure(Array.isArray(value.points)&&value.points.length<=2048);for(const point of value.points)ensure(Array.isArray(point)&&point.length===2&&point.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1));
 if(value.style!=null)ensure(['comment','highlight'].includes(value.style));
 if(value.strokeWidth!=null)ensure((value.style==null||['comment','highlight'].includes(value.style))&&typeof value.strokeWidth==='number'&&Number.isFinite(value.strokeWidth)&&value.strokeWidth>0&&value.strokeWidth<=1000000);
 if(value.anchor!=null){ensure(object(value.anchor));uuid(value.anchor.itemID);rect(value.anchor.rect,1);for(const field of ['sourcePath','originalSourcePath'])if(value.anchor[field]!=null)safePath(value.anchor[field]);if(value.anchor.page!=null)ensure(Number.isInteger(value.anchor.page)&&value.anchor.page>=1&&value.anchor.page<=100000);}
 if(value.sourceSHA256!=null)ensure(typeof value.sourceSHA256==='string'&&/^[a-f0-9]{64}$/i.test(value.sourceSHA256));return value;
}
function validateDeleted(value,id){ensure(object(value)&&value.schemaVersion===1&&uuid(value.id)===id.toLowerCase());timestamp(value.deletedAt);return value;}
function parse(data){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{fail('INVALID_REVIEW');}}
function now(){return new Date().toISOString().replace(/\.\d{3}Z$/,'Z');}
class ReviewService {
 constructor(vaultService,{maxEntries=MAX_ENTRIES,maxTotalBytes=MAX_TOTAL_BYTES,maxCreateBytes=MAX_CREATE_BYTES,timeoutMs=5000}={}){this.vaults=vaultService;this.limits={maxEntries,maxTotalBytes,maxCreateBytes,timeoutMs};this.active=0;}
 async directory(vaultId,create=false){const root=await this.vaults.root(vaultId);if(create){try{await fs.mkdir(path.join(root,DIRECTORY),{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}try{return await this.vaults.resolve(vaultId,DIRECTORY,{directory:true});}catch(error){if(!create&&error.code==='ENOENT')return null;throw error;}}
 async entries(vaultId,bounded=p=>p){const directory=await bounded(this.directory(vaultId));if(!directory)return null;const opening=fs.opendir(directory.full);let dir;try{dir=await bounded(opening);}catch(error){void opening.then(d=>d.close()).catch(()=>{});throw error;}const entries=[];try{for(;;){const item=await bounded(dir.read());if(!item)break;entries.push(item.name);if(entries.length>this.limits.maxEntries*2)return {entries:[],truncated:true};}}finally{void dir.close().catch(()=>{});}await bounded(this.directory(vaultId));return {entries,truncated:false};}
 async markerExists(vaultId,id){try{await this.vaults.resolve(vaultId,`${DIRECTORY}/${id}.deleted.json`);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
 async readMarker(vaultId,id){const snap=await this.vaults.snapshot({vaultId,path:`${DIRECTORY}/${id}.deleted.json`},MAX_RECORD_BYTES);validateDeleted(parse(snap.data),id);return snap;}
 async publish(vaultId,name,data){if(data.length>MAX_RECORD_BYTES)fail('TOO_LARGE');const initial=await this.directory(vaultId,true);const {full}=initial;const listing=await this.entries(vaultId);if(listing.truncated||listing.entries.length>=this.limits.maxEntries*2)fail('TOO_LARGE');if(!DELETED_NAME.test(name)&&listing.entries.filter(n=>RECORD_NAME.test(n)).length>=this.limits.maxEntries)fail('TOO_LARGE');let totalBytes=0;for(const child of listing.entries){const stat=await fs.lstat(path.join(full,child));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('PATH_DENIED');totalBytes+=stat.size;}const byteLimit=DELETED_NAME.test(name)?this.limits.maxTotalBytes:Math.min(this.limits.maxCreateBytes,this.limits.maxTotalBytes);if(totalBytes+data.length>byteLimit)fail('TOO_LARGE');const rel=`${DIRECTORY}/${name}`;const backupId=await this.vaults.backup(rel,null,data);const temp=path.join(full,'.inkspace-review-'+crypto.randomUUID()+'.tmp');try{await durableWrite(temp,data);const current=await this.directory(vaultId);if(!current||current.full!==full||current.stat.dev!==initial.stat.dev||current.stat.ino!==initial.stat.ino)fail('CONFLICT');const target=path.join(full,name);await fs.link(temp,target);await fs.unlink(temp);return {backupId};}finally{await fs.unlink(temp).catch(()=>{});}}
 async createReview(request){if(typeof request?.vaultId!=='string')fail('INVALID_REQUEST');const review=validateReview(request.review),id=uuid(review.id);const data=Buffer.from(JSON.stringify(review,null,2)+'\n');if(data.length>MAX_RECORD_BYTES)fail('TOO_LARGE');return this.vaults.locked(request.vaultId+':review:'+id,async()=>{await this.directory(request.vaultId,true);if(await this.markerExists(request.vaultId,id))fail('REVIEW_DELETED');
  // Verify the actual board identity without serializing or modifying its data.
  const opened=await this.vaults.readFile({vaultId:request.vaultId,path:review.boardPath});const board=opened.board;ensure(board&&board.id.toLowerCase()===review.boardID.toLowerCase());rect(review.rect,board.canvasWidth);
  if(review.anchor){const item=board.items.find(i=>i.id.toLowerCase()===review.anchor.itemID.toLowerCase());ensure(!!item);for(const key of ['sourcePath','originalSourcePath','page'])if(review.anchor[key]!=null)ensure(review.anchor[key]===item[key]);}
  const rel=`${DIRECTORY}/${id}.json`;try{await this.vaults.resolve(request.vaultId,rel);fail('EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  let result;try{result=await this.publish(request.vaultId,`${id}.json`,data);}catch(error){if(error.code==='EEXIST')fail('EXISTS');throw error;}return {review,...result};
 });}
 async deleteReview(request){if(typeof request?.vaultId!=='string')fail('INVALID_REQUEST');const id=uuid(request.id);return this.vaults.locked(request.vaultId+':review:'+id,async()=>{await this.directory(request.vaultId,true);if(await this.markerExists(request.vaultId,id)){await this.readMarker(request.vaultId,id);return {deleted:true,id};}const data=Buffer.from(JSON.stringify({schemaVersion:1,id,deletedAt:now()},null,2)+'\n');try{await this.publish(request.vaultId,`${id}.deleted.json`,data);}catch(error){if(error.code!=='EEXIST')throw error;await this.readMarker(request.vaultId,id);}return {deleted:true,id};});}
 async listReviews(request){if(typeof request?.vaultId!=='string')fail('INVALID_REQUEST');safePath(request.path);if(this.active>=2)fail('BUSY');this.active++;const warnings=new Set();const reviews=[];let bytes=0,truncated=false;const deadline=Date.now()+this.limits.timeoutMs;
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Review scan timeout'),{code:'REVIEW_TIMEOUT'})),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}};
  try{const listing=await this.entries(request.vaultId,bounded);if(!listing)return {reviews,warnings:[],truncated:false};if(listing.truncated)return {reviews,warnings:[W.limit],truncated:true};const deleted=new Set();
   // Read every marker before emitting records. Bad markers still hide their IDs.
   for(const name of listing.entries){const match=DELETED_NAME.exec(name);if(!match)continue;const id=match[1].toLowerCase();deleted.add(id);try{const snap=await bounded(this.vaults.snapshot({vaultId:request.vaultId,path:`${DIRECTORY}/${name}`},MAX_RECORD_BYTES));bytes+=snap.data.length;if(bytes>this.limits.maxTotalBytes)throw Object.assign(Error('Review budget'),{code:'REVIEW_TIMEOUT'});validateDeleted(parse(snap.data),id);}catch(error){if(error.code==='REVIEW_TIMEOUT')throw error;warnings.add(W.deleted);}}
   for(const name of listing.entries){if(DELETED_NAME.test(name)||name.startsWith('.inkspace-review-'))continue;const match=RECORD_NAME.exec(name);if(!match){warnings.add(W.unknown);continue;}const id=match[1];if(deleted.has(id))continue;if(Date.now()>=deadline||bytes>=this.limits.maxTotalBytes){truncated=true;warnings.add(W.limit);break;}
    try{const snap=await bounded(this.vaults.snapshot({vaultId:request.vaultId,path:`${DIRECTORY}/${name}`},MAX_RECORD_BYTES));bytes+=snap.data.length;if(bytes>this.limits.maxTotalBytes){truncated=true;warnings.add(W.limit);break;}const review=validateReview(parse(snap.data),id);
     if(review.boardPath!==request.path&&review.anchor?.sourcePath!==request.path&&review.anchor?.originalSourcePath!==request.path)continue;
     // Also notice a canonical tombstone that arrived after directory enumeration.
     if(await bounded(this.markerExists(request.vaultId,id)))continue;reviews.push(review);
    }catch(error){if(error.code==='REVIEW_TIMEOUT')throw error;warnings.add(W.unavailable);}
   }
   reviews.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));return {reviews,warnings:[...warnings],truncated};
  }catch(error){if(error.code==='REVIEW_TIMEOUT')return {reviews:[],warnings:[...warnings,W.limit],truncated:true};throw error;}finally{this.active--;}
 }
}
module.exports={ReviewService,validateReview,validateDeleted,DIRECTORY,MAX_RECORD_BYTES};

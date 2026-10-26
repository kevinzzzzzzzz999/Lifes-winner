'use strict';
const {relativePath}=require('./vault-path.cjs');
const {fail,AppError}=require('./errors.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function request(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('INVALID_REQUEST');}
function identity(value){if(typeof value!=='string'||!UUID.test(value))fail('INVALID_REQUEST');return value;}
async function boundedScope(promise,signal){
 let timer,abort;
 try{
  if(signal.aborted){void Promise.resolve(promise).catch(()=>{});throw new AppError('CANCELLED');}
  const stopped=new Promise((_,reject)=>{abort=()=>reject(new AppError('CANCELLED'));signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(new AppError('IO_FAILED')),5000);});
  return await Promise.race([promise,stopped]);
 }finally{clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);}
}
function reviewMatchesFolder(review,folderPath){
 const inside=path=>typeof path==='string'&&(!folderPath||path.startsWith(folderPath+'/'));
 return [review.boardPath,review.anchor?.sourcePath,review.anchor?.originalSourcePath].some(inside);
}
/** Per-window read-only aggregation. The original independent records and tombstones remain authoritative. */
class ReviewQueueService {
 constructor({vaults,reviews}){this.vaults=vaults;this.reviews=reviews;this.pending=new Map();this.closed=false;}
 async list(value){
  request(value,['vaultId','folderPath','requestId']);if(typeof value.vaultId!=='string'||typeof value.folderPath!=='string')fail('INVALID_REQUEST');
  const requestId=identity(value.requestId),folderPath=relativePath(value.folderPath,true);
  if(folderPath.split('/').some(part=>part.toLowerCase()==='.inkspace-reviews'))fail('PATH_DENIED');
  if(this.closed)fail('CANCELLED');if(this.pending.has(requestId)||this.pending.size>=2)fail('BUSY');
  // Cancellation is registered before authorization/file reads can yield.
  const controller=new AbortController();this.pending.set(requestId,controller);
  try{
   await boundedScope(this.vaults.resolve(value.vaultId,folderPath,{directory:true}),controller.signal);if(controller.signal.aborted||this.closed)fail('CANCELLED');
   const result=await this.reviews.scanReviews(value.vaultId,review=>reviewMatchesFolder(review,folderPath),{signal:controller.signal});
   if(controller.signal.aborted||this.closed)fail('CANCELLED');return{...result,folderPath};
  }finally{if(this.pending.get(requestId)===controller)this.pending.delete(requestId);}
 }
 cancel(value){request(value,['requestId']);const requestId=identity(value.requestId),controller=this.pending.get(requestId);controller?.abort();return{cancelled:!!controller};}
 dispose(){this.closed=true;for(const controller of this.pending.values())controller.abort();this.pending.clear();}
}
module.exports={ReviewQueueService,reviewMatchesFolder};

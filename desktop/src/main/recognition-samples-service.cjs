'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./errors.cjs');const {LIMITS,UUID,exact,inspectMedia}=require('./recognition-samples-model.cjs');
class RecognitionSamplesService{
 constructor(store,{now=()=>Date.now(),readTimeoutMs=15000}={}){this.store=store;this.now=now;this.readTimeoutMs=readTimeoutMs;this.pending=null;this.run=null;this.closed=false;this.expiry=null;this.committing=new Set();}
 cancel(){clearTimeout(this.expiry);this.run=null;const draft=this.pending;this.pending=null;if(draft&&!this.committing.has(draft))this.store.release(draft.lease);return{cancelled:true};}
 prune(){if(this.pending&&this.now()-this.pending.createdAt>LIMITS.lifetimeMs)this.cancel();}
 alive(run){if(this.closed||this.run!==run)fail('CANCELLED');}
 begin(){this.prune();if(this.closed)fail('CANCELLED');if(this.pending||this.run)fail('BUSY');const run={lease:null};this.run=run;return run;}
 finish(run,kind,data,source,suggestedText=''){
  this.alive(run);if(!run.lease)run.lease=this.store.reserve(data.length);const info=inspectMedia(data,kind,{decodeImage:this.store.decodeImage});this.alive(run);
  if(typeof suggestedText!=='string'||suggestedText.length>200000)fail('LEARNING_LABEL');const token=crypto.randomUUID();this.pending={token,kind,source,data:Buffer.from(data),...info,lease:run.lease,createdAt:this.now()};this.expiry=setTimeout(()=>{if(this.pending?.token===token)this.cancel();},LIMITS.lifetimeMs);this.expiry.unref?.();
  return{token,kind,source,sha256:info.sha256,byteCount:info.byteCount,...(info.durationSeconds?{durationSeconds:info.durationSeconds}:{}),...(info.width?{width:info.width,height:info.height}:{}),dataURL:'data:'+info.mime+';base64,'+data.toString('base64'),suggestedText};
 }
 async prepareBytes(kind,data,source,suggestedText=''){
  const run=this.begin();try{return this.finish(run,kind,data,source,suggestedText);}finally{if(run.lease&&this.pending?.lease!==run.lease)this.store.release(run.lease);if(this.run===run)this.run=null;}
 }
 async selectPath(kind,selectedPath){
  if(!['handwriting','speech'].includes(kind))fail('LEARNING_INVALID');const extension=path.extname(selectedPath).toLowerCase();if(!(kind==='handwriting'?['.png','.jpg','.jpeg']:['.wav']).includes(extension))fail('LEARNING_MEDIA');const run=this.begin();let slot;
  try{slot=this.store.beginRead();}catch(error){if(this.run===run)this.run=null;throw error;}
  const job=(async()=>{try{const data=await this.store.readBounded(selectedPath,LIMITS.mediaBytes,{check:()=>this.alive(run),onSize:size=>{this.alive(run);run.lease=this.store.reserve(size);}});this.alive(run);return this.finish(run,kind,data,kind==='speech'?'imported-audio':'imported-image');}finally{if(run.lease&&this.pending?.lease!==run.lease)this.store.release(run.lease);this.store.endRead(slot);if(this.run===run)this.run=null;}})();
  let timer;try{return await Promise.race([job,new Promise((_,reject)=>{timer=setTimeout(()=>{if(this.run===run)this.run=null;reject(Object.assign(Error('LEARNING_TIMEOUT'),{code:'LEARNING_TIMEOUT'}));},this.readTimeoutMs);timer.unref?.();})]);}finally{clearTimeout(timer);}
 }

 snapshot(){return this.store.snapshot();}
 async commit(request){exact(request,['token','sha256','revision','locale','confirmedText','enabled','confirmed']);this.prune();if(this.closed||!UUID.test(request.token||'')||this.pending?.token!==request.token||request.sha256!==this.pending.sha256)fail('LEARNING_DRAFT_EXPIRED');const draft=this.pending;if(this.committing.has(draft))fail('BUSY');this.committing.add(draft);try{const result=await this.store.add(draft,{revision:request.revision,locale:request.locale,confirmedText:request.confirmedText,enabled:request.enabled,confirmed:request.confirmed},()=>{if(this.closed||this.pending!==draft)fail('CANCELLED');});if(this.pending===draft){clearTimeout(this.expiry);this.pending=null;}return result;}finally{this.committing.delete(draft);if(this.pending!==draft||this.closed)this.store.release(draft.lease);}}

 update(request){return this.store.update(request);}readMedia(request){return this.store.readMedia(request);}clean(request){return this.store.clean(request);}
 dispose(){this.closed=true;this.cancel();}
}
module.exports={RecognitionSamplesService};

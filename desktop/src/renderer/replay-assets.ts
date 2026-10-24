import {REPLAY_BACKGROUND_LIMITS} from './ink-replay-camera';
type Request={key:string;path:string;pdf:boolean;resolve:(url:string)=>void;reject:(error:Error)=>void;promise:Promise<string>;users:number;started:boolean};
const cancelled=()=>new DOMException('Cancelled','AbortError');
/** Bounded read-only URL requests. PDF assets ALWAYS hide this board's own
 * writeback annotations, even when source hashes match, to avoid future ink. */
export class ReplayAssets{
 private cache=new Map<string,string>();private pending=new Map<string,Request>();private active=0;private closed=false;
 constructor(private vaultId:string,private boardID:string,private request=window.desktop.getAssetUrl,private ownerIDs?:string[]){}
 load(path:string,pdf:boolean,signal:AbortSignal):Promise<string>{
  if(this.closed||signal.aborted)return Promise.reject(cancelled());
  const key=JSON.stringify([path,pdf]),cached=this.cache.get(key);if(cached){this.cache.delete(key);this.cache.set(key,cached);return Promise.resolve(cached);}
  let job=this.pending.get(key);if(!job){let resolve!:(url:string)=>void,reject!:(error:Error)=>void;const promise=new Promise<string>((yes,no)=>{resolve=yes;reject=no;});job={key,path,pdf,resolve,reject,promise,users:0,started:false};this.pending.set(key,job);}
  const current=job;current.users++;
  const result=new Promise<string>((resolve,reject)=>{let settled=false;const finish=(fn:()=>void)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);current.users--;if(!current.users&&!current.started&&this.pending.get(key)===current){this.pending.delete(key);current.reject(cancelled());}fn();};const abort=()=>finish(()=>reject(cancelled()));signal.addEventListener('abort',abort,{once:true});current.promise.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));});
  this.pump();return result;
 }
 private pump(){
  if(this.closed)return;for(const job of this.pending.values()){
   if(this.active>=REPLAY_BACKGROUND_LIMITS.requests)break;if(job.started||!job.users)continue;job.started=true;this.active++;
   void this.request({vaultId:this.vaultId,path:job.path,...(job.pdf?{hideBoardIDs:this.ownerIDs?.length?this.ownerIDs:[this.boardID]}:{})}).then(result=>{
    if(!result.ok)throw Error(result.error.message);if(this.closed)throw cancelled();this.cache.set(job.key,result.value.url);while(this.cache.size>REPLAY_BACKGROUND_LIMITS.assets)this.cache.delete(this.cache.keys().next().value!);job.resolve(result.value.url);
   }).catch(error=>job.reject(error)).finally(()=>{this.pending.delete(job.key);this.active--;this.pump();});
  }
 }
 dispose(){this.closed=true;this.cache.clear();for(const job of this.pending.values())job.reject(cancelled());this.pending.clear();}
}

'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./errors.cjs');const {relativePath}=require('./vault-path.cjs');
const VIDEO=new Set(['.mp4','.mov','.m4v']);
const AUDIO=new Set(['.mp3','.m4a','.wav','.aif','.aiff','.caf']);
const mediaMime=value=>({'.mov':'video/quicktime','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.aif':'audio/aiff','.aiff':'audio/aiff','.caf':'audio/x-caf'}[path.extname(value).toLowerCase()]||'video/mp4');
const isVideoPath=value=>typeof value==='string'&&VIDEO.has(path.extname(value).toLowerCase());
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const fingerprint=stat=>'meta-v1-'+crypto.createHash('sha256').update(JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs])).digest('hex');
function rangeFor(header,size){
 if(header==null)return {start:0,end:size-1,status:200};
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||(!match[1]&&!match[2]))return null;
 const a=match[1]?Number(match[1]):null,b=match[2]?Number(match[2]):null;
 if((a!==null&&!Number.isSafeInteger(a))||(b!==null&&!Number.isSafeInteger(b))||a===null&&!(b>0))return null;
 const start=a===null?Math.max(0,size-b):a,end=a===null?size-1:b===null?size-1:Math.min(size-1,b);
 if(start<0||start>=size||end<start)return null;return {start,end,status:206};
}
class VideoService {
 constructor(vaultService,{maximumTokens=64,maximumStreams=4,readTimeoutMs=30000,chunkBytes=65536,allowAudio=false}={}){this.vaults=vaultService;this.allowAudio=allowAudio;this.tokens=new Map();this.streams=new Set();this.opening=0;this.maximumTokens=maximumTokens;this.maximumStreams=maximumStreams;this.readTimeoutMs=readTimeoutMs;this.chunkBytes=chunkBytes;}
 async opened(request){
  relativePath(request.path);if(!isVideoPath(request.path)&&!(this.allowAudio&&AUDIO.has(path.extname(request.path).toLowerCase())))fail('UNSUPPORTED');
  const before=await this.vaults.resolve(request.vaultId,request.path);let handle;
  try{
   handle=await fs.open(before.full,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
   const stat=await handle.stat();const current=await this.vaults.resolve(request.vaultId,request.path);
   if(!stat.isFile()||stat.nlink!==1||!Number.isSafeInteger(stat.size)||stat.size<=0)fail('UNSUPPORTED');
   if(!same(before.stat,stat)||!same(stat,current.stat))fail('CONFLICT');
   return {handle,stat};
  }catch(error){await handle?.close().catch(()=>{});throw error;}
 }
 async boundedOpen(request,signal){
  let cancelled=false,timer,onAbort;
  const work=this.opened(request).then(value=>{if(cancelled){void value.handle.close().catch(()=>{});fail('CANCELLED');}return value;});
  const interruption=new Promise((_,reject)=>{onAbort=()=>{cancelled=true;try{fail('CANCELLED');}catch(e){reject(e);}};timer=setTimeout(onAbort,this.readTimeoutMs);if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([work,interruption]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 }
 async getVideoUrl(request){
  const opened=await this.boundedOpen(request);await opened.handle.close();
  const version=fingerprint(opened.stat),token=crypto.randomUUID();
  while(this.tokens.size>=this.maximumTokens)this.releaseToken(this.tokens.keys().next().value);
  this.tokens.set(token,{vaultId:request.vaultId,path:request.path,stat:opened.stat,version});
  return {url:'vault-video://video/'+token,path:request.path,name:path.posix.basename(request.path),bytes:opened.stat.size,version,mime:mediaMime(request.path)};
 }
 tokenFromURL(url){let u;try{u=new URL(url);}catch{fail('PATH_DENIED');}if(u.protocol!=='vault-video:'||u.hostname!=='video'||u.search||u.hash||!/^\/[0-9a-f-]{36}$/.test(u.pathname))fail('PATH_DENIED');return u.pathname.slice(1);}
 releaseToken(token){this.tokens.delete(token);for(const stream of Array.from(this.streams))if(stream.token===token)stream.stop();}
 releaseVideoUrl({url}){this.releaseToken(this.tokenFromURL(url));return {released:true};}
 async response(url,{method='GET',range=null,signal}={}){
  if(!['GET','HEAD'].includes(method))fail('PERMISSION_DENIED');
  const token=this.tokenFromURL(url),entry=this.tokens.get(token);if(!entry)fail('PATH_DENIED');
  const base={'Content-Type':mediaMime(entry.path),'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  const part=rangeFor(range,entry.stat.size);if(!part)return {status:416,headers:{...base,'Content-Range':`bytes */${entry.stat.size}`},body:null};
  if(this.streams.size+this.opening>=this.maximumStreams)fail('BUSY');
  this.opening++;let opened;try{opened=await this.boundedOpen(entry,signal);}finally{this.opening--;}
  const {handle,stat}=opened;
  if(!this.tokens.has(token)||!same(stat,entry.stat)){await handle.close();fail('CONFLICT');}
  const headers={...base,'Content-Length':String(part.end-part.start+1),...(part.status===206?{'Content-Range':`bytes ${part.start}-${part.end}/${stat.size}`}:{})};
  if(method==='HEAD'){await handle.close();return {status:part.status,headers,body:null};}
  const service=this;let offset=part.start,closed=false,controller,timer;
  const stop=()=>{if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);service.streams.delete(record);void handle.close().catch(()=>{});};
  const onAbort=()=>{if(!closed){controller?.error(new Error('CANCELLED'));stop();}};
  const record={token,stop:onAbort};service.streams.add(record);
  const body=new ReadableStream({
   start(value){controller=value;if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});},
   async pull(value){
    if(closed)return;
    timer=setTimeout(onAbort,service.readTimeoutMs);
    try{
     if(!service.tokens.has(token))fail('CANCELLED');
     const buffer=Buffer.allocUnsafe(Math.min(service.chunkBytes,part.end-offset+1));
     const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
     const after=await handle.stat(),current=await service.vaults.resolve(entry.vaultId,entry.path);
     if(!same(after,entry.stat)||!same(after,current.stat))fail('CONFLICT');
     if(closed)return;if(bytesRead!==buffer.length)fail('CONFLICT');
     offset+=bytesRead;value.enqueue(new Uint8Array(buffer.buffer,buffer.byteOffset,bytesRead));
     if(offset>part.end){value.close();stop();}
    }catch(error){if(!closed){value.error(error);stop();}}finally{clearTimeout(timer);}
   },cancel(){stop();}
  },{highWaterMark:0});
  return {status:part.status,headers,body};
 }
 dispose(){for(const record of Array.from(this.streams))record.stop();this.tokens.clear();}
}
module.exports={VideoService,isVideoPath,rangeFor};

'use strict';
const path=require('node:path');
const {randomUUID}=require('node:crypto');

// Sessions persist across workspaces. Keep one guard per session and identify
// the exact originating WebContents; a URL or a numeric id is not ownership.
const sessions=new WeakMap();
function safeDownloadFilename(value){
 let name=path.basename(String(value||'').replace(/\\/g,'/'))
  .replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'_').replace(/^[. ]+|[. ]+$/g,'');
 if(!name)name='Download';
 const extension=path.extname(name),suffix=Buffer.byteLength(extension)<=32?extension:'';
 let stem=Array.from(suffix?name.slice(0,-suffix.length):name);
 while(stem.length&&Buffer.byteLength(stem.join('')+suffix)>220)stem.pop();
 return stem.join('')+suffix||'Download';
}
function sessionState(session){
 let state=sessions.get(session);if(state)return state;
 state={owners:new Map()};
 state.onDownload=(event,item,contents)=>{
  const owner=state.owners.get(contents);
  if(!owner||!owner.live()||!owner.isActive()){event.preventDefault();return;}
  let filename='Download';const id=randomUUID();
  const report=kind=>{if(owner.live())try{owner.onStatus({id,state:kind,filename});}catch{}};
  try{
   filename=safeDownloadFilename(item.getFilename());
   const zh=owner.app.getLocale?.().startsWith('zh');
   // Never setSavePath: Electron must present its normal system save dialog.
   item.setSaveDialogOptions({title:zh?'保存 AI 下载文件':'Save AI download',defaultPath:path.join(owner.app.getPath('downloads'),filename)});
   const job={item,done:null};
   job.done=(_event,result)=>{
    owner.jobs.delete(job);
    if(result==='completed')try{const saved=item.getSavePath();if(saved)filename=safeDownloadFilename(saved);}catch{}
    report(result==='completed'?'completed':result==='cancelled'?'cancelled':'failed');
   };
   owner.jobs.add(job);item.once('done',job.done);report('saving');
  }catch{
   // preventDefault cancels this DownloadItem; do not touch it afterward.
   event.preventDefault();report('failed');
  }
 };
 session.on('will-download',state.onDownload);sessions.set(session,state);return state;
}
function registerAIDownloadOwner({session,contents,window,app,isActive=()=>true,onStatus}){
 if(!contents||contents.session!==session||contents.isDestroyed()||!window||window.isDestroyed())throw Error('Invalid AI download owner');
 const state=sessionState(session);
 if(state.owners.has(contents))throw Error('AI download owner already registered');
 const owner={app,isActive,onStatus,jobs:new Set(),disposed:false,
  live:()=>!owner.disposed&&state.owners.get(contents)===owner&&!contents.isDestroyed()&&!window.isDestroyed()};
 const dispose=()=>{
  if(owner.disposed)return;owner.disposed=true;
  if(state.owners.get(contents)===owner)state.owners.delete(contents);
  contents.removeListener('destroyed',dispose);window.removeListener('closed',dispose);
  for(const job of owner.jobs){job.item.removeListener('done',job.done);try{job.item.cancel();}catch{}}
  owner.jobs.clear();
  // The empty session guard deliberately remains: late/unowned downloads
  // must not fall back to an unrestricted download after the last view closes.
 };
 state.owners.set(contents,owner);contents.once('destroyed',dispose);window.once('closed',dispose);
 return dispose;
}
module.exports={registerAIDownloadOwner,safeDownloadFilename};

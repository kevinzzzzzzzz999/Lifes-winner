import type {DesktopAPI,NotebookEvent,OpenedFile} from '../shared/desktop-api';

export type NotebookRunState={running:boolean;kernelAlive:boolean;restarting?:boolean;cellIndex?:number;reason?:string;error?:string};
export const notebookKey=(vaultId:string,path:string)=>vaultId+'\0'+path;
type Run={runId:string;source:string;phase:'preparing'|'submitted';pending:NotebookEvent[];timer?:ReturnType<typeof setTimeout>};
type Known={vaultId:string;path:string;runId?:string;kernelId?:string};
type Restart={promise?:Promise<void>};
type Options={api:DesktopAPI;prepare:(vaultId:string,path:string)=>Promise<OpenedFile>;apply:(vaultId:string,path:string,events:NotebookEvent[],source:string)=>void;changed:(key:string,state:NotebookRunState|undefined)=>void};
/** Runtime ownership outlives an editor pane. Restart never reads/replaces a draft. */
export class NotebookRunController{
 readonly states:Record<string,NotebookRunState>={};
 private active=new Map<string,Run>();private known=new Map<string,Known>();private restarts=new Map<string,Restart>();private unsubscribe?:()=>void;private disposed=false;
 private options:Options;
 constructor(options:Options){this.options=options;}
 private update=(key:string,patch:Partial<NotebookRunState>)=>{if(this.disposed)return;const state={...(this.states[key]||{running:false,kernelAlive:false}),...patch};this.states[key]=state;this.options.changed(key,state);};
 private flush=(key:string)=>{const run=this.active.get(key),file=this.known.get(key);if(!run||!file)return;clearTimeout(run.timer);run.timer=undefined;const events=run.pending.slice();if(events.length){this.options.apply(file.vaultId,file.path,events,run.source);run.pending.splice(0,events.length);}};
 private receive=(event:NotebookEvent)=>{
  if(this.disposed)return;const key=notebookKey(event.vaultId,event.path),run=this.active.get(key),file=this.known.get(key);
  if(!run){if(event.kind==='run-end'&&event.kernelAlive===false&&file?.runId===event.runId&&(!file.kernelId||file.kernelId===event.kernelId))this.update(key,{running:false,kernelAlive:false,cellIndex:undefined,reason:event.reason||'failed'});return;}
  if(run.runId!==event.runId)return;
  if(file){file.runId=event.runId;if(event.kernelId)file.kernelId=event.kernelId;}
  if(event.kind==='run-end'){this.flush(key);this.active.delete(key);this.update(key,{running:false,kernelAlive:event.kernelAlive===true,cellIndex:undefined,reason:event.reason||'completed'});return;}
  run.pending.push(event);if(event.kind==='cell-start')this.update(key,{cellIndex:event.cellIndex,kernelAlive:true});
  if(event.kind==='cell-end')this.flush(key);else if(!run.timer)run.timer=setTimeout(()=>this.flush(key),70);
 };
 connect=()=>{this.disposed=false;this.unsubscribe?.();this.unsubscribe=this.options.api.onNotebookEvent?.(this.receive);return this.dispose;};
 execute=async(vaultId:string,path:string,cellIndices:number[])=>{
  const key=notebookKey(vaultId,path);if(this.disposed||this.active.has(key)||this.restarts.has(key))return;
  const runId=crypto.randomUUID(),record:Run={runId,source:'',phase:'preparing',pending:[]};
  this.active.set(key,record);this.known.set(key,{...this.known.get(key),vaultId,path});this.update(key,{running:true,error:undefined,reason:undefined});
  try{const source=await this.options.prepare(vaultId,path);if(this.active.get(key)!==record||this.disposed)return;record.source=source.text||'';record.phase='submitted';const result=await this.options.api.runNotebookCells({vaultId,path,expectedSHA256:source.sha256,runId,cellIndices});if(!result.ok)throw Error(result.error.message);const file=this.known.get(key);if(file&&(this.active.get(key)===record||file.runId===runId)){file.runId=runId;file.kernelId=result.value.kernelId;}}
  catch(error){if(this.active.get(key)===record){this.flush(key);this.active.delete(key);this.update(key,{running:false,error:error instanceof Error?error.message:String(error),reason:'failed'});}}
 };
 interrupt=async(vaultId:string,path:string)=>{const key=notebookKey(vaultId,path);if(this.restarts.has(key))return;const run=this.active.get(key);if(run?.phase==='preparing'){clearTimeout(run.timer);this.active.delete(key);this.update(key,{running:false,cellIndex:undefined,reason:'cancelled'});return;}const result=await this.options.api.interruptNotebook({vaultId,path});if(!result.ok)throw Error(result.error.message);};
 restart=(vaultId:string,path:string):Promise<void>=>{
  const key=notebookKey(vaultId,path),existing=this.restarts.get(key);if(existing?.promise)return existing.promise;if(this.disposed)return Promise.resolve();
  const token:Restart={};this.restarts.set(key,token);this.update(key,{restarting:true,error:undefined});
  token.promise=(async()=>{
   try{
    this.flush(key);
    // A save/read still in preparation must never submit code after the reset.
    const run=this.active.get(key);if(run?.phase==='preparing'){clearTimeout(run.timer);this.active.delete(key);this.update(key,{running:false,cellIndex:undefined});}
    const result=await this.options.api.restartNotebook({vaultId,path});if(!result.ok)throw Error(result.error.message);
    if(this.disposed||this.restarts.get(key)!==token)return;
    this.flush(key);const current=this.active.get(key);if(current)clearTimeout(current.timer);this.active.delete(key);
    this.known.set(key,{vaultId,path});this.update(key,{running:false,restarting:false,kernelAlive:false,cellIndex:undefined,reason:'restarted',error:undefined});
   }catch(error){if(!this.disposed&&this.restarts.get(key)===token)this.update(key,{restarting:false,running:this.active.has(key),error:(error instanceof Error?error.message:String(error))+' · 代码和已有输出仍保留。 / Code and existing outputs are retained.'});throw error;}
   finally{if(this.restarts.get(key)===token)this.restarts.delete(key);}
  })();return token.promise;
 };
 close=async(vaultId:string,path:string)=>{const key=notebookKey(vaultId,path),restart=this.restarts.get(key)?.promise;if(restart)await restart.catch(()=>{});this.flush(key);const run=this.active.get(key);if(run)clearTimeout(run.timer);this.active.delete(key);this.known.delete(key);const result=await this.options.api.closeNotebook({vaultId,path});if(!result.ok)throw Error(result.error.message);delete this.states[key];if(!this.disposed)this.options.changed(key,undefined);};
 isRunning=(vaultId?:string,path?:string)=>vaultId&&path?this.active.has(notebookKey(vaultId,path))||this.restarts.has(notebookKey(vaultId,path)):this.active.size>0||this.restarts.size>0;
 dispose=()=>{if(this.disposed)return;this.disposed=true;this.unsubscribe?.();this.unsubscribe=undefined;for(const [key,file]of this.known){const run=this.active.get(key);if(run)clearTimeout(run.timer);void this.options.api.closeNotebook?.({vaultId:file.vaultId,path:file.path}).catch(()=>{});}this.active.clear();this.known.clear();this.restarts.clear();};
}

import type {ApiResult,BoardMutationResult,DesktopAPI,OpenedFile} from '../shared/desktop-api';
export type ChildSnapshot={file:OpenedFile|null;loading:boolean;busy:boolean;drafts:number;error:string;revision:number};
const unwrap=<T,>(result:ApiResult<T>):T=>{if(!result.ok)throw Error(result.error.message);return result.value;};
const allSessions=new Map<string,ChildBoardSession>();
const busyListeners=new Set<()=>void>();
const publishBusy=()=>{for(const listener of busyListeners)listener();};
export function childSessionsBusy(){return [...allSessions.values()].some(s=>s.snapshot().busy||s.snapshot().drafts>0);}
export function subscribeChildSessions(listener:()=>void){busyListeners.add(listener);return()=>{busyListeners.delete(listener);};}
export function childPathBusy(vaultId:string,path:string){const s=allSessions.get(JSON.stringify([vaultId,path]));return !!s&&(s.snapshot().busy||s.snapshot().drafts>0);}
export function childSession(vaultId:string,path:string):ChildBoardSession{const key=JSON.stringify([vaultId,path]);let value=allSessions.get(key);if(!value){value=new ChildBoardSession(window.desktop,vaultId,path,publishBusy);allSessions.set(key,value);const idle=[...allSessions.entries()].filter(([k,s])=>k!==key&&s.isIdle());for(const [k] of idle.slice(0,Math.max(0,idle.length-3)))allSessions.delete(k);}return value;}
/** Duplicate portals share the same latest SHA, write lock, watch and refresh queue. */
export class ChildBoardSession {
 private state:ChildSnapshot={file:null,loading:false,busy:false,drafts:0,error:'',revision:0};
 private listeners=new Set<()=>void>();private reading:Promise<void>|null=null;private refreshAfter=false;
 private writeEpoch=0;
 private stopWatch:(()=>void)|null=null;private interval:ReturnType<typeof setInterval>|null=null;private focus:(()=>void)|null=null;
 private api:Pick<DesktopAPI,'readFile'|'onVaultChange'>;readonly vaultId:string;readonly path:string;private changed:()=>void;
 constructor(api:Pick<DesktopAPI,'readFile'|'onVaultChange'>,vaultId:string,path:string,changed:()=>void=()=>{}){this.api=api;this.vaultId=vaultId;this.path=path;this.changed=changed;}
 snapshot=()=>this.state;
 isIdle=()=>this.listeners.size===0&&!this.state.busy&&!this.state.drafts&&!this.reading;
 private publish(patch:Partial<ChildSnapshot>){this.state={...this.state,...patch,revision:this.state.revision+1};for(const f of this.listeners)f();this.changed();}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);if(this.listeners.size===1)this.start();return()=>{this.listeners.delete(listener);if(!this.listeners.size)this.stop();};};
 private start(){this.stopWatch=this.api.onVaultChange(event=>{if(event.vaultId===this.vaultId&&(event.rescan||event.paths.includes(this.path)||['resume','unlock','poll'].includes(event.reason)))void this.refresh();});if(typeof window!=='undefined'){this.focus=()=>void this.refresh();window.addEventListener('focus',this.focus);this.interval=setInterval(()=>{if(!document.hidden)void this.refresh();},60_000);}void this.refresh();}
 private stop(){this.stopWatch?.();this.stopWatch=null;if(this.interval)clearInterval(this.interval);this.interval=null;if(this.focus&&typeof window!=='undefined')window.removeEventListener('focus',this.focus);this.focus=null;}
 setDraft(active:boolean){this.publish({drafts:Math.max(0,this.state.drafts+(active?1:-1))});if(!this.state.drafts&&this.refreshAfter){this.refreshAfter=false;void this.refresh();}}
 async refresh(){if(this.state.busy||this.state.drafts){this.refreshAfter=true;return;}if(this.reading)return this.reading;
  const previous=this.state.file?.sha256,epoch=this.writeEpoch;this.publish({loading:!this.state.file});
  this.reading=(async()=>{try{const file=unwrap(await this.api.readFile({vaultId:this.vaultId,path:this.path}));if(this.state.busy||this.state.drafts||epoch!==this.writeEpoch||this.state.file?.sha256!==previous){this.refreshAfter=true;return;}if(file.kind!=='board'||!file.board)throw Error('The linked file is not a board.');if(file.sha256!==previous)this.publish({file,error:''});else if(this.state.error)this.publish({error:''});}catch(e){this.publish({error:e instanceof Error?e.message:String(e)});}finally{this.reading=null;this.publish({loading:false});if(this.refreshAfter&&!this.state.busy&&!this.state.drafts){this.refreshAfter=false;queueMicrotask(()=>void this.refresh());}}})();return this.reading;
 }
 async mutate(write:(file:OpenedFile)=>Promise<ApiResult<BoardMutationResult|OpenedFile>>,before?:()=>Promise<void>){if(this.state.busy)throw Error('This child board is already saving.');if(!this.state.file)throw Error('The child board is not ready.');const current=this.state.file;this.writeEpoch++;this.publish({busy:true,error:''});
  try{await before?.();const saved=unwrap(await write(current));if(saved.kind!=='board'||!saved.board)throw Error('The child board response was invalid.');this.publish({file:saved,error:''});return saved;
  }catch(e){const error=e instanceof Error?e.message:String(e);this.publish({error});throw e;}finally{this.publish({busy:false});if(this.refreshAfter&&!this.state.drafts){this.refreshAfter=false;void this.refresh();}}
 }
}

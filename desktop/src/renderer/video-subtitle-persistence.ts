export type SubtitleAssociation={name:string;text:string;enabled:boolean};
export type SubtitleAssociationResult={subtitle:SubtitleAssociation|null;sha256:string|null;backupId?:string};
type Result={ok:true;value:SubtitleAssociationResult}|{ok:false;error:{code:string}};
export type SubtitleAssociationTransport={read:()=>Promise<Result>;save:(subtitle:SubtitleAssociation|null,expectedSHA256:string|null)=>Promise<Result>};
export type SubtitlePersistenceState={value:SubtitleAssociation|null|undefined;phase:'loading'|'saving'|'saved'|'idle'|'error'|'conflict'|'unavailable';dirty:boolean;error?:string};

/** One captured video identity, one ordered CAS writer. Pending user edits may
 * finish after their view disappears, but can never be retargeted to a new video. */
export class VideoSubtitlePersistence {
 private value:SubtitleAssociation|null|undefined;
 private sha256:string|null|undefined;
 private phase:SubtitlePersistenceState['phase'];
 private error:string|undefined;
 private dirty=false;
 private revision=0;
 private busy=false;
 private started=false;
 private listeners=new Set<(state:SubtitlePersistenceState)=>void>();
 private transport:SubtitleAssociationTransport|null;
 constructor(transport:SubtitleAssociationTransport|null){this.transport=transport;this.phase=transport?'loading':'unavailable';}
 snapshot():SubtitlePersistenceState{return{value:this.value,phase:this.phase,dirty:this.dirty,error:this.error};}
 subscribe(listener:(state:SubtitlePersistenceState)=>void){this.listeners.add(listener);listener(this.snapshot());return()=>{this.listeners.delete(listener);};}
 private emit(){const state=this.snapshot();for(const listener of this.listeners)listener(state);}
 start(){if(this.started)return;this.started=true;if(this.transport)void this.read();}
 edit(value:SubtitleAssociation|null){this.revision++;this.value=value;this.error=undefined;
  if(!this.transport){this.dirty=false;this.phase='unavailable';this.emit();return;}
  this.dirty=true;this.phase='saving';this.emit();this.start();void this.pump();
 }
 private async read(){if(!this.transport||this.busy)return;this.busy=true;let succeeded=false;this.phase=this.dirty?'saving':'loading';this.error=undefined;this.emit();
  try{const result=await this.transport.read();if(!result.ok)throw Error(result.error.code);this.sha256=result.value.sha256;
   // A late disk read supplies the CAS version, never overwrites a newer import.
   if(!this.dirty)this.value=result.value.subtitle;
   succeeded=true;this.phase=this.dirty?'saving':this.value?'saved':'idle';
  }catch(error){this.error=error instanceof Error?error.message:'SUBTITLE_READ_FAILED';this.phase=this.error==='CONFLICT'?'conflict':'error';}
  finally{this.busy=false;this.emit();if(succeeded&&this.dirty)void this.pump();}
 }
 private async pump(){if(!this.transport||this.busy||!this.dirty)return;if(this.sha256===undefined){if(this.phase!=='error'&&this.phase!=='conflict')void this.read();return;}
  this.busy=true;this.phase='saving';this.error=undefined;const revision=this.revision,value=this.value??null,expectedSHA256=this.sha256;this.emit();let succeeded=false;
  try{const result=await this.transport.save(value,expectedSHA256);if(!result.ok)throw Error(result.error.code);this.sha256=result.value.sha256;succeeded=true;
   if(revision===this.revision){this.value=result.value.subtitle;this.dirty=false;this.phase='saved';}
  }catch(error){this.error=error instanceof Error?error.message:'SUBTITLE_SAVE_FAILED';this.phase=this.error==='CONFLICT'?'conflict':'error';}
  finally{this.busy=false;this.emit();if(succeeded&&this.dirty)void this.pump();}
 }
 retry(){if(this.busy||!this.transport)return;if(this.sha256===undefined||!this.dirty)void this.read();else void this.pump();}
 refresh(){if(!this.busy&&!this.dirty&&this.phase!=='error'&&this.phase!=='conflict')void this.read();}
 /** The explicit Replace saved subtitles action authorizes using the newest
  * disk version. A second concurrent change still fails the following CAS. */
 replaceAfterConflict(){if(this.busy||!this.dirty)return;void this.read();}
 reloadSaved(){if(this.busy||!this.transport)return;this.revision++;this.dirty=false;void this.read();}
}

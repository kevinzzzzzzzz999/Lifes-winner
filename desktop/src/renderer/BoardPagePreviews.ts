// One bounded raster queue for the visible board, independent of React page nodes.
export type PreviewRequest={key:string;sourcePath:string;page:number;edge:number;priority:number};
export type PreviewTile={canvas:HTMLCanvasElement;matched:boolean;sha256:string;edge:number};
export type PreviewStats={active:number;peakActive:number;queued:number;tiles:number;bytes:number;peakBytes:number;completed:number;cancelled:number;failed:number;evicted:number};
export const PREVIEW_LIMITS={concurrency:2,bytes:32*1024*1024,entries:4096} as const;
export function previewEdge(width:number,height:number,zoom:number):number|null {
 const short=Math.min(width,height)*zoom,long=Math.max(width,height)*zoom;
 if(!Number.isFinite(short)||!Number.isFinite(long)||short<2||long<3)return null;
 return long<=24?32:long<=56?64:long<=112?128:192;
}
export function previewAwait<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
 return new Promise((resolve,reject)=>{const abort=()=>reject(new DOMException('Cancelled','AbortError'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
export function previewKey(sourcePath:string,page:number){return JSON.stringify([sourcePath,page]);}
export function planPreviewRequests(requests:PreviewRequest[],limits:{bytes:number;entries:number}){
 const unique=new Map<string,PreviewRequest>();for(const request of requests){const old=unique.get(request.key);if(!old||old.edge<request.edge)unique.set(request.key,{...request});}
 let planned=[...unique.values()].sort((a,b)=>a.priority-b.priority).slice(0,limits.entries);
 // Conservative square-byte estimate also covers unusual page aspect ratios.
 while(planned.reduce((n,r)=>n+r.edge*r.edge*4,0)>limits.bytes&&planned.some(r=>r.edge>16))planned=planned.map(r=>({...r,edge:Math.max(16,r.edge/2)}));
 let bytes=0;return planned.filter(r=>{bytes+=r.edge*r.edge*4;return bytes<=limits.bytes;});
}
export class BoardPagePreviews {
 private tiles=new Map<string,PreviewTile>();private desired=new Map<string,PreviewRequest>();
 private active=new Map<string,{request:PreviewRequest;abort:AbortController}>();private errors=new Set<string>();
 private listeners=new Set<()=>void>();private timer:ReturnType<typeof setTimeout>|undefined;private closed=false;
 private stats:PreviewStats={active:0,peakActive:0,queued:0,tiles:0,bytes:0,peakBytes:0,completed:0,cancelled:0,failed:0,evicted:0};
 constructor(private render:(request:PreviewRequest,signal:AbortSignal)=>Promise<PreviewTile>,private limits:{concurrency:number;bytes:number;entries:number}=PREVIEW_LIMITS){}
 subscribe(callback:()=>void){this.listeners.add(callback);return()=>{this.listeners.delete(callback);};}
 snapshot(){return{...this.stats,active:this.active.size,queued:this.pending().length,tiles:this.tiles.size};}
 peek(key:string){return this.closed?undefined:this.tiles.get(key);}
 update(requests:PreviewRequest[]){
  if(this.closed)return;this.desired=new Map();for(const request of planPreviewRequests(requests,this.limits)){const old=this.desired.get(request.key);if(!old||old.edge<request.edge)this.desired.set(request.key,request);}
  for(const[key,job]of this.active)if(!this.desired.has(key)&&!job.abort.signal.aborted){job.abort.abort();this.stats.cancelled++;}
  // Touch visible cached tiles once per camera change, never on every canvas paint.
  for(const key of this.desired.keys()){const tile=this.tiles.get(key);if(tile){this.tiles.delete(key);this.tiles.set(key,tile);}}
  this.pump();this.notify();
 }
 private pending(){return [...this.desired.values()].filter(r=>!this.active.has(r.key)&&!this.errors.has(r.key)&&(this.tiles.get(r.key)?.edge||0)<r.edge).sort((a,b)=>a.priority-b.priority);}
 private notify(){if(this.closed||this.timer)return;this.timer=setTimeout(()=>{this.timer=undefined;if(!this.closed)for(const fn of this.listeners)fn();},64);}
 private discard(tile:PreviewTile){tile.canvas.width=0;tile.canvas.height=0;}
 private store(key:string,tile:PreviewTile){
  const bytes=tile.canvas.width*tile.canvas.height*4,old=this.tiles.get(key);if(old){this.stats.bytes-=old.canvas.width*old.canvas.height*4;this.tiles.delete(key);this.discard(old);}
  if(bytes>this.limits.bytes){this.discard(tile);this.errors.add(key);this.stats.failed++;return;}
  while(this.tiles.size&&(this.stats.bytes+bytes>this.limits.bytes||this.tiles.size>=this.limits.entries)){const oldest=this.tiles.keys().next().value!,value=this.tiles.get(oldest)!;this.stats.bytes-=value.canvas.width*value.canvas.height*4;this.tiles.delete(oldest);this.discard(value);this.stats.evicted++;}
  this.tiles.set(key,tile);this.stats.bytes+=bytes;this.stats.peakBytes=Math.max(this.stats.peakBytes,this.stats.bytes);this.stats.completed++;
 }
 private pump(){
  if(this.closed)return;for(const request of this.pending()){
   if(this.active.size>=this.limits.concurrency)break;
   const job={request,abort:new AbortController()};this.active.set(request.key,job);this.stats.peakActive=Math.max(this.stats.peakActive,this.active.size);
   void this.render(request,job.abort.signal).then(tile=>{
    if(this.closed||job.abort.signal.aborted||!this.desired.has(request.key)){this.discard(tile);return;}
    this.store(request.key,tile);
   }).catch(error=>{if(!this.closed&&!job.abort.signal.aborted){this.errors.add(request.key);this.stats.failed++;}}).finally(()=>{this.active.delete(request.key);this.notify();
    // Yield between raster jobs so 2000 tiny pages do not monopolize input/rendering.
    if(!this.closed)setTimeout(()=>this.pump(),0);
   });
  }
 }
 dispose(){if(this.closed)return;this.closed=true;if(this.timer)clearTimeout(this.timer);for(const job of this.active.values())job.abort.abort();for(const tile of this.tiles.values())this.discard(tile);this.tiles.clear();this.desired.clear();this.listeners.clear();this.stats.bytes=0;}
}

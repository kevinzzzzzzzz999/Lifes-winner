import type {BoardChildLink} from '../shared/desktop-api';
import {boardInkStrokeBounds} from './board-ink-clip';
export type ChildCamera={x:number;y:number;zoom:number};
export type ChildRect={x:number;y:number;width:number;height:number};
export type ChildPresentation=ChildRect&{expanded:boolean;viewport?:ChildCamera};
export type ChildEntry={itemID:string;owner:ChildRect;link:BoardChildLink};
export const CHILD_HEADER=44,MAX_CHILD_DEPTH=3,MAX_VISIBLE_CHILDREN=8;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
export function safeChildPath(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=4096&&!/^[\\/]|[\\:\u0000-\u001f\u007f]/.test(value)&&value.split('/').every(p=>p!==''&&p!=='.'&&p!=='..')&&value.toLowerCase().endsWith('.inkspace.json');}
export function validChildPresentation(value:unknown):value is ChildPresentation{const p=value as ChildPresentation;return !!p&&typeof p.expanded==='boolean'&&[p.x,p.y,p.width,p.height].every(finite)&&p.x>=0&&p.y>=0&&p.width>=360&&p.height>=240;}
export function childEntries(items:unknown):ChildEntry[]{if(!Array.isArray(items))return[];return items.flatMap(item=>{if(!item||typeof item.id!=='string'||![item.x,item.y,item.width,item.height].every(finite)||!Array.isArray(item.childBoards))return[];return item.childBoards.filter((link:BoardChildLink)=>link&&typeof link.id==='string'&&typeof link.title==='string'&&safeChildPath(link.path)).map((link:BoardChildLink)=>({itemID:item.id,owner:{x:item.x,y:item.y,width:item.width,height:item.height},link}));});}
export function childCanExpand(path:string,ancestors:string[]):boolean{return safeChildPath(path)&&ancestors.length<MAX_CHILD_DEPTH&&!ancestors.includes(path);}
export function childBounds(raw:Record<string,unknown>):ChildRect {
 const rects:ChildRect[]=Array.isArray(raw.items)?raw.items.filter(r=>r&&[r.x,r.y,r.width,r.height].every(finite)&&r.width>0&&r.height>0):[];
 for(const entry of childEntries(raw.items)){if(validChildPresentation(entry.link.presentation)&&entry.link.presentation.expanded)rects.push(entry.link.presentation);}
 const strokes=(raw.webInk as {strokes?:Array<{points:number[][];clipPath?:number[][];opacity?:number}>}|undefined)?.strokes||[];
 let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
 for(const rect of rects){x=Math.min(x,rect.x);y=Math.min(y,rect.y);right=Math.max(right,rect.x+rect.width);bottom=Math.max(bottom,rect.y+rect.height);}
 for(const stroke of strokes){if(stroke.clipPath!==undefined){const b=boardInkStrokeBounds(stroke);if(b){x=Math.min(x,b.x);y=Math.min(y,b.y);right=Math.max(right,b.x+b.width);bottom=Math.max(bottom,b.y+b.height);}}else for(const p of stroke.points||[]){if(![p[0],p[1],p[2]].every(finite))continue;x=Math.min(x,p[0]-p[2]);y=Math.min(y,p[1]-p[2]);right=Math.max(right,p[0]+p[2]);bottom=Math.max(bottom,p[1]+p[2]);}}
 if(Number.isFinite(x))return{x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)};
 const viewport=raw.viewport as ChildCamera|undefined;if(viewport&&[viewport.x,viewport.y,viewport.zoom].every(finite)&&viewport.zoom>0)return{x:Math.max(0,viewport.x-600/viewport.zoom),y:Math.max(0,viewport.y-400/viewport.zoom),width:1200/viewport.zoom,height:800/viewport.zoom};
 return{x:0,y:0,width:600,height:400};
}
export function childViewport(bounds:ChildRect,width:number,height:number):ChildCamera{return{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,zoom:Math.max(.00001,Math.min(1.2,(width-64)/Math.max(1,bounds.width),(height-CHILD_HEADER-80)/Math.max(1,bounds.height))) };}
export function childPortalSize(bounds?:ChildRect):{width:number;height:number}{return{width:Math.ceil(Math.max(720,bounds?bounds.width+160:960)),height:Math.ceil(Math.max(520,bounds?bounds.height+160:680)+CHILD_HEADER)};}
const overlaps=(a:ChildRect,b:ChildRect)=>a.x<b.x+b.width+48&&a.x+a.width+48>b.x&&a.y<b.y+b.height+48&&a.y+a.height+48>b.y;
/** Allocate empty parent space without moving any child content or parent notes. */
export function layoutChildPortals(entries:ChildEntry[],items:ChildRect[],world:{width:number;height:number},bounds:Map<string,ChildRect>=new Map(),fullContents=false):Array<{id:string;childID:string;presentation:ChildPresentation}>{
 if(!entries.length)return[];
 const occupied:ChildRect[]=[...items];const result:Array<{id:string;childID:string;presentation:ChildPresentation}>=[];
 const limit={width:finite(world.width)&&world.width>0?world.width:8_000_000,height:finite(world.height)&&world.height>0?world.height:8_000_000};
 const startX=Math.max(0,Math.min(...entries.map(e=>e.owner.x)));
 let cursorX=startX,cursorY=Math.max(0,...items.map(r=>r.y+r.height))+96,rowHeight=0;
 for(const entry of entries){const extent=bounds.get(entry.link.path),old=validChildPresentation(entry.link.presentation)?entry.link.presentation:undefined,size=old&&!fullContents?{width:old.width,height:old.height}:childPortalSize(extent);if(size.width>limit.width||size.height>limit.height)throw Error('The board is too small for a child canvas.');
  if(cursorX>startX&&cursorX+size.width>Math.min(limit.width,startX+4000)){cursorX=startX;cursorY+=rowHeight+96;rowHeight=0;}
  let rect={x:cursorX,y:cursorY,...size};let tries=0;while(occupied.some(r=>overlaps(rect,r))&&tries++<1000)rect.y+=96;
  if(rect.x+rect.width>limit.width||rect.y+rect.height>limit.height)throw Error('There is no free space for this child canvas.');
  const saved=!fullContents?entry.link.presentation?.viewport:undefined;
  const viewport=saved&&[saved.x,saved.y,saved.zoom].every(finite)&&saved.zoom>0?{...saved}:extent?{x:extent.x+extent.width/2,y:extent.y+extent.height/2,zoom:1}:undefined;
  const presentation:ChildPresentation={...rect,expanded:true,...(viewport?{viewport}:{})};
  result.push({id:entry.itemID,childID:entry.link.id,presentation});occupied.push(rect);cursorX=rect.x+rect.width+96;rowHeight=Math.max(rowHeight,rect.height);
 }
 return result;
}
export function childTextSignature(item:Record<string,unknown>):string{return JSON.stringify([item.id,item.kind,item.title,item.text||'',item.textFormat||'',item.richTextHTML||'']);}

/** Header controls keep a readable screen size while the child canvas continues to scale. */
export function childHeaderMetrics(width:number,height:number,displayScale:number){
 const scale=Number.isFinite(displayScale)&&displayScale>0?displayScale:1;
 const screenWidth=width*scale,screenHeight=height*scale;
 const readable=screenWidth>=40&&screenHeight>=40;
 const factor=readable?Math.max(1,1/scale):1;
 return{height:Math.min(height,readable?Math.max(CHILD_HEADER,32/scale):CHILD_HEADER),fontSize:12*factor,buttonSize:28*factor,iconSize:15*factor,gap:4*factor,padding:6*factor,title:screenWidth>=180,status:screenWidth>=560,fit:screenWidth>=340,refresh:screenWidth>=430,collapse:screenWidth>=76,controls:readable};
}

/** Bound each embedded backing store to 2048² pixels, matching its displayed scale. */
export function childCanvasDPR(size:{width:number;height:number},devicePixelRatio:number,displayScale:number):number{
 const ratio=finite(devicePixelRatio)&&devicePixelRatio>0?devicePixelRatio:1,scale=finite(displayScale)&&displayScale>0?displayScale:1;
 const width=finite(size.width)?Math.max(1,size.width):1,height=finite(size.height)?Math.max(1,size.height):1;
 return Math.max(Number.MIN_VALUE,Math.min(2,ratio*scale,2048/width,2048/height));
}

/** Clip in the parent stage, then express the visible window in full child-frame coordinates. */
export function clipChildPortal(full:ChildRect,parent:{width:number;height:number},scale:number):{frame:ChildRect;window:ChildRect}|null{
 if(!finite(scale)||scale<=0)return null;
 const x=Math.max(0,full.x),y=Math.max(0,full.y),right=Math.min(parent.width,full.x+full.width),bottom=Math.min(parent.height,full.y+full.height);
 if(right<=x||bottom<=y)return null;
 return{frame:{x,y,width:right-x,height:bottom-y},window:{x:(x-full.x)/scale,y:(y-full.y)/scale,width:(right-x)/scale,height:(bottom-y)/scale}};
}
export function childVisibleCamera(camera:ChildCamera,fullBody:ChildRect,visibleBody:ChildRect):ChildCamera{return{x:camera.x+(visibleBody.x+visibleBody.width/2-fullBody.x-fullBody.width/2)/camera.zoom,y:camera.y+(visibleBody.y+visibleBody.height/2-fullBody.y-fullBody.height/2)/camera.zoom,zoom:camera.zoom};}
export function childFullCamera(camera:ChildCamera,fullBody:ChildRect,visibleBody:ChildRect):ChildCamera{return{x:camera.x-(visibleBody.x+visibleBody.width/2-fullBody.x-fullBody.width/2)/camera.zoom,y:camera.y-(visibleBody.y+visibleBody.height/2-fullBody.y-fullBody.height/2)/camera.zoom,zoom:camera.zoom};}
export function boundedChildCamera(camera:ChildCamera):ChildCamera{return{x:Math.max(-1e12,Math.min(1e12,camera.x)),y:Math.max(-1e12,Math.min(1e12,camera.y)),zoom:camera.zoom};}
export function sameChildCamera(a:ChildCamera|null|undefined,b:ChildCamera|null|undefined):boolean{return !!a&&!!b&&Math.abs(a.x-b.x)<1e-6&&Math.abs(a.y-b.y)<1e-6&&Math.abs(a.zoom-b.zoom)<1e-10;}

/** An external saved camera supersedes pending local work; our own acknowledgement keeps later gestures. */
export function reconcileChildCamera(incoming:ChildCamera|null|undefined,draft:ChildCamera|null,submitted:ChildCamera|null):{camera:ChildCamera|null;cancelPending:boolean}{
 const acknowledged=sameChildCamera(incoming,submitted);
 return{camera:acknowledged&&draft?draft:incoming||null,cancelPending:!acknowledged};
}

/** Editing/saving subtrees stay mounted; the visibility budget applies only to other candidates. */
export function selectChildPortals<T>(entries:T[],protectedEntry:(entry:T)=>boolean,distance:(entry:T)=>number,limit=MAX_VISIBLE_CHILDREN):T[]{
 const protectedEntries=entries.filter(protectedEntry),others=entries.filter(entry=>!protectedEntry(entry)).sort((a,b)=>distance(a)-distance(b));
 return[...protectedEntries,...others.slice(0,Math.max(0,limit-protectedEntries.length))];
}

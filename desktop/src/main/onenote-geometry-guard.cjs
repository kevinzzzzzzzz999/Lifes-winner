'use strict';
// Conservative, bounded geometry proof for the supported OneNote print stream.
// Unproved layouts keep the ordinary PDF route; source ink is never discarded.
const crypto=require('node:crypto');
const n='[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)';
const fail=message=>{throw Object.assign(Error(message),{code:'ONENOTE_LAYOUT_UNSUPPORTED'});};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const intersect=(a,b)=>{const r=[Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];return r[0]<=r[2]&&r[1]<=r[3]?r:null;};
const contains=(a,b)=>a[0]<=b[0]+1e-7&&a[1]<=b[1]+1e-7&&a[2]>=b[2]-1e-7&&a[3]>=b[3]-1e-7;
const translate=(a,x,y)=>[a[0]+x,a[1]+y,a[2]+x,a[3]+y];
const identity=t=>t[0]===1&&t[1]===0&&t[2]===0&&t[3]===1&&t[4]===0&&t[5]===0;
function matrix(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
function scanPathClips(raw,graphicsStates={}){
 let state={clip:[-Infinity,-Infinity,Infinity,Infinity],matrix:[1,0,0,1,0,0],fill:'g:0',alpha:1},mcid=null;
 const stack=[],marked=[],result=new Map(),imageClips=new Map();
 // Millions of l/c coordinate lines do not change clip, transform or paint
 // state. The main parser still validates and retains every one of them.
 const structural=raw.replace(/BT\b[\s\S]*?\bET/g,'').replace(new RegExp(`^[ \t]*(?:${n}[ \t]+){1,5}${n}[ \t]+[lc][ \t]*\\r?$`,'gm'),'');
 const pattern=new RegExp(`BT\\b[\\s\\S]*?\\bET|\\/P\\s*<<\\s*\\/MCID\\s+(\\d+)\\s*>>\\s*BDC|\\bEMC\\b|((?:${n}\\s+){5}${n})\\s+cm\\b|(${n})\\s+(${n})\\s+(${n})\\s+(${n})\\s+re\\s+W\\*?\\s+n|((?:${n}\\s+){0,3}${n})\\s+(rg|g|k)\\b|\\/(\\w+)\\s+gs\\b|(${n})\\s+(${n})\\s+m\\b|(?:^|\\s)(q|Q|f\\*?|F|S|s|B\\*?|b\\*?)(?=\\s|$)|(?:^|\\s)(W\\*?|cs|CS|sc|SC|scn|SCN|sh|BI)(?=\\s|$)`,'g');
 for(const m of structural.matchAll(pattern)){
  if(m[0].startsWith('BT'))continue;
  if(m[1]!==undefined){marked.push(mcid);mcid=Number(m[1]);continue;}
  if(m[0]==='EMC'){if(!marked.length)fail('Unbalanced OneNote marked content.');mcid=marked.pop();continue;}
  if(m[2]!==undefined){
   const image=structural.slice(m.index+m[0].length).match(/^\s*\/(\w+)\s+Do\b/);if(!image||mcid===null)fail('Unmarked OneNote image transform.');
   const key=mcid+'|'+image[1],list=imageClips.get(key)||[];list.push([...state.clip]);imageClips.set(key,list);
   state={...state,matrix:matrix(state.matrix,m[2].trim().split(/\s+/).map(Number))};continue;
  }
  if(m[3]!==undefined){
   if(!identity(state.matrix))fail('A transformed OneNote clip cannot be safely joined. Use ordinary PDF import.');
   const [x,y,w,h]=m.slice(3,7).map(Number);if(w<0||h<0)fail('Unsupported OneNote clipping rectangle.');
   state={...state,clip:intersect(state.clip,[x,y,x+w,y+h])||[0,0,-1,-1]};continue;
  }
  if(m[7]!==undefined){const values=m[7].trim().split(/\s+/).map(Number);if(values.length!==({rg:3,g:1,k:4})[m[8]])fail('Unsupported OneNote fill color.');state={...state,fill:m[8]+':'+values.join(',')};continue;}
  if(m[9]!==undefined){const gs=graphicsStates[m[9]];if(!gs)fail('Unknown OneNote graphics state. Use ordinary PDF import.');state={...state,alpha:gs.alpha===undefined?state.alpha:gs.alpha};continue;}
  if(m[10]!==undefined){
   if(mcid===null)fail('Unmarked OneNote ink cannot be safely joined.');
   if(!identity(state.matrix))fail('Transformed OneNote ink cannot be safely joined. Use ordinary PDF import.');
   const key=state.fill+'|'+state.alpha,old=result.get(mcid);
   if(old&&(old.painted||old.paintKey!==key||old.clip.some((v,i)=>v!==state.clip[i])))fail('A OneNote ink group changes geometry or paint state. Use ordinary PDF import.');
   if(!old)result.set(mcid,{clip:[...state.clip],paintKey:key,painted:false});continue;
  }
  if(m[13]!==undefined)fail('Unsupported OneNote clip, color space or inline paint. Use ordinary PDF import.');
  const op=m[12];
  if(op==='q'){stack.push({...state,clip:[...state.clip],matrix:[...state.matrix]});continue;}
  if(op==='Q'){if(!stack.length)fail('Unbalanced OneNote graphics state.');state=stack.pop();continue;}
  if(op&&mcid!==null&&result.has(mcid)){const p=result.get(mcid);if(p.painted)fail('A OneNote group paints its path more than once.');if(p.paintKey!==state.fill+'|'+state.alpha||p.clip.some((v,i)=>v!==state.clip[i]))fail('A OneNote ink group changes fill or clipping before paint. Use ordinary PDF import.');p.painted=true;p.stroked=['S','s','B','B*','b','b*'].includes(op);p.paintKey+='|'+op;}
 }
 if(stack.length||marked.length)fail('Unbalanced OneNote print stream.');
 return {paths:result,imageClips};
}
// Subtract retained rectangles from the target. A bounding union is not enough:
// a hole between two owners must not count as preserved content.
function coveredByRectangles(target,rectangles){
 let remaining=[target];
 for(const cover of rectangles){if(!cover)continue;const next=[];
  for(const r of remaining){const v=intersect(r,cover);if(!v){next.push(r);continue;}
   if(v[0]>r[0]+1e-7)next.push([r[0],r[1],v[0],r[3]]);
   if(v[2]<r[2]-1e-7)next.push([v[2],r[1],r[2],r[3]]);
   if(v[1]>r[1]+1e-7)next.push([v[0],r[1],v[2],v[1]]);
   if(v[3]<r[3]-1e-7)next.push([v[0],v[3],v[2],r[3]]);
  }
  remaining=next;if(!remaining.length)return true;
  if(remaining.length>1024)fail('OneNote ink ownership is too fragmented to verify.');
 }
 return !remaining.length;
}
function sameWorldPath(p,a,q,b){
 if(p.guardShape!==q.guardShape||p.coords.length!==q.coords.length)return false;
 for(let i=0;i<p.coords.length;i+=2)if(Math.abs(p.coords[i]+a.x-q.coords[i]-b.x)>.085||Math.abs(p.coords[i+1]+a.y-q.coords[i+1]-b.y)>.085)return false;
 return true;
}
function validateInkOwnership(tiles,placements){
 const byShape=new Map();let pathCount=0,needsCounterpart=0;
 for(const tile of tiles)for(const p of tile.paths){
  if(!p.guardClip||!p.guardShape)fail('OneNote ink has no verified graphics clip.');
  const entry={tile,path:p,place:placements[tile.index]};const list=byShape.get(p.guardShape)||[];list.push(entry);byShape.set(p.guardShape,list);pathCount++;
 }
 for(const tile of tiles)for(const p of tile.paths){
  const a=placements[tile.index],originalClip=intersect(p.guardClip,[0,0,tile.width,tile.height]);
  // A retained whole inherited clip preserves every cap/join regardless of
  // stroke width. Partial clip ownership is not proved by centerline bounds.
  if(p.guardStroked){if(originalClip&&!contains(a.owner,originalClip))fail('A stroked OneNote clip crosses this join and cannot be safely deduplicated. Use ordinary PDF import.');continue;}
  const sourceVisible=originalClip&&intersect(p.bbox,originalClip);if(!sourceVisible)continue;
  const own=intersect(a.owner,p.guardClip);if(own&&contains(own,sourceVisible))continue;
  const covers=own?[own]:[];
  for(const entry of byShape.get(p.guardShape)||[]){const q=entry.path,b=entry.place;if(entry.tile===tile||!sameWorldPath(p,a,q,b))continue;
   let clip=q.guardClip;
   // This is the same explicitly recorded source-clip extension used when the
   // form is written, not a geometry-proof tolerance or a change to source ink.
   if(b.extension&&entry.tile.body&&clip[0]===0&&clip[1]>=entry.tile.body[1]-1e-7&&clip[3]<=entry.tile.body[1]+entry.tile.body[3]+1e-7)clip=[-b.extension,clip[1],clip[2],clip[3]];
   const retained=intersect(b.owner,clip);if(retained)covers.push(translate(retained,b.x-a.x,b.y-a.y));
  }
  if(!coveredByRectangles(sourceVisible,covers))fail(`Page ${tile.index+1} contains unique visible ink across this join. Use ordinary PDF import.`);
  needsCounterpart++;
 }
 return {verifiedPaths:pathCount,pathsRequiringCorrespondingOwner:needsCounterpart,coordinateCorrespondenceTolerance:.085,unprovedVisibleInk:0};
}
function cubic(t){t=Math.abs(t);return t<=1?(1.5*t-2.5)*t*t+1:t<2?((-0.5*t+2.5)*t-4)*t+2:0;}
function rasterSimilarity(a,b){
 if(a.complex||b.complex||a.width!==b.width||Math.abs(a.height-b.height)!==1||a.bits!==8||b.bits!==8||a.space!==b.space||!['/DeviceRGB','/DeviceGray'].includes(a.space))return null;
 const channels=a.space==='/DeviceRGB'?3:1,w=a.width,h=Math.max(a.height,b.height);
 if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w*h*channels>16*1024*1024)return null;
 const decoded=d=>{if(!d.pixels){const p=d.decode();if(p.length!==d.width*d.height*channels)return null;d.pixels=p;}return d.pixels;};
 let aa,bb;try{aa=decoded(a);bb=decoded(b);}catch{return null;}if(!aa||!bb)return null;
 const coefficients=d=>Array.from({length:h},(_,y)=>{const center=(y+.5)*d.height/h-.5,base=Math.floor(center),v=[];let sum=0;for(let k=-1;k<=2;k++){const row=base+k;if(row<0||row>=d.height)continue;const weight=cubic(center-row);v.push([row,weight]);sum+=weight;}return v.map(([row,weight])=>[row,weight/sum]);});
 const ca=coefficients(a),cb=coefficients(b),sums=Array(channels).fill(0),na=new Uint8Array(w*h*channels),nb=new Uint8Array(w*h*channels);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<channels;c++){
  const value=(data,weights)=>Math.max(0,Math.min(255,Math.round(weights.reduce((sum,[row,weight])=>sum+data[(row*w+x)*channels+c]*weight,0))));
  const k=(y*w+x)*channels+c;na[k]=value(aa,ca[y]);nb[k]=value(bb,cb[y]);const delta=na[k]-nb[k];sums[c]+=delta*delta;
 }
 const rms=sums.map(v=>Math.sqrt(v/(w*h))),mean=rms.reduce((s,v)=>s+v,0)/channels;
 if(mean>5||Math.max(...rms)>6)return null;
 // A tiny unique mark can have almost zero page-wide RMS. Require local
 // correspondence in both directions too, including white holes in dark
 // content. A one-pixel neighborhood and bounded color difference allow the
 // source's observed one-row resampling/antialiasing, never a missing mark
 // against a uniformly white counterpart. This remains approximate matching.
 let checkedPixels=0,nonBackgroundPixels=0,maximumLocalChannelDelta=0;
 for(const [source,target] of [[na,nb],[nb,na]])for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const k=(y*w+x)*channels;let contrast=0;for(let c=0;c<channels;c++)contrast=Math.max(contrast,255-source[k+c]);
  const salient=contrast>=64;let best=256;
  for(let yy=Math.max(0,y-1);yy<=Math.min(h-1,y+1);yy++)for(let xx=Math.max(0,x-1);xx<=Math.min(w-1,x+1);xx++){
   const j=(yy*w+xx)*channels;let delta=0,targetContrast=0;for(let c=0;c<channels;c++){delta=Math.max(delta,Math.abs(source[k+c]-target[j+c]));targetContrast=Math.max(targetContrast,255-target[j+c]);}
   if(!salient||targetContrast>=16)best=Math.min(best,delta);
  }
  if(best>80)return null;
  checkedPixels++;if(salient)nonBackgroundPixels++;maximumLocalChannelDelta=Math.max(maximumLocalChannelDelta,best);
 }
 return {meanRMS:mean,maxChannelRMS:Math.max(...rms),localCheckedPixels:checkedPixels,localNonBackgroundPixels:nonBackgroundPixels,maximumLocalChannelDelta};
}
function validateImageOwnership(tiles,placements){
 let images=0,needsCounterpart=0;const approximatePairs=new Map(),similarityCache=new Map();
 for(const tile of tiles)for(const image of tile.images){images++;const a=placements[tile.index];
  const visible=intersect(intersect(image.bbox,image.guardClip)||[0,0,-1,-1],[0,0,tile.width,tile.height]);if(!visible)continue;
  const own=intersect(a.owner,image.guardClip);if(own&&contains(own,visible))continue;
  const covers=own?[own]:[];
  for(const other of tiles)for(const candidate of other.images){if(other===tile)continue;const b=placements[other.index];
   const otherBounds=translate(candidate.bbox,b.x-a.x,b.y-a.y);if(otherBounds.some((v,i)=>Math.abs(v-image.bbox[i])>.15))continue;
   const p=image.descriptor,q=candidate.descriptor;if(!p||!q)fail('OneNote image has no verified resource.');let approximate=null;
   if(p!==q&&p.identity!==q.identity){const key=[p.identity,q.identity].sort().join('|');if(!similarityCache.has(key))similarityCache.set(key,rasterSimilarity(p,q));approximate=similarityCache.get(key);if(!approximate)continue;approximatePairs.set(key,approximate);}
   const retained=intersect(b.owner,candidate.guardClip);if(retained)covers.push(translate(retained,b.x-a.x,b.y-a.y));
  }
  if(!coveredByRectangles(visible,covers))fail(`Page ${tile.index+1} contains a unique visible image across this join. Use ordinary PDF import.`);
  needsCounterpart++;
 }
 const approximate=[...approximatePairs.values()];
 return {verifiedImages:images,imagesRequiringCorrespondingOwner:needsCounterpart,approximateImagePairs:approximatePairs.size,maximumApproximateMeanRMS:Math.max(0,...approximate.map(v=>v.meanRMS)),localImageCorrespondence:{checkedPixels:approximate.reduce((s,v)=>s+v.localCheckedPixels,0),nonBackgroundPixels:approximate.reduce((s,v)=>s+v.localNonBackgroundPixels,0),unmatchedPixels:0,neighborhoodRadiusPixels:1,maximumObservedChannelDelta:Math.max(0,...approximate.map(v=>v.maximumLocalChannelDelta)),maximumAllowedChannelDelta:80,significantWhiteContrast:64,minimumCounterpartWhiteContrast:16},unprovedVisibleImages:0,approximation:'Only unmasked 8-bit RGB/Gray images with equal width, one-pixel height difference and registered bounds within 0.15pt; bicubic normalized mean RMS<=5 and channel RMS<=6, plus bidirectional per-pixel local color/foreground correspondence. This is approximate source-raster matching, not pixel identity. Original source PDF is retained.'};
}
module.exports={scanPathClips,validateInkOwnership,validateImageOwnership,coveredByRectangles,hash};

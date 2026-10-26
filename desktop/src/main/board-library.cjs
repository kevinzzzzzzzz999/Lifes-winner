'use strict';
const {isDeepStrictEqual}=require('node:util'),M=require('./board-library-model.cjs');
const near=(a,b)=>Math.abs(a-b)<=1e-6;
const geom=['x','y','width','height'];
function group(board,id){M.id(id);const g=M.inspect(board).find(g=>g.groupID===id);if(!g||!g.valid)M.fail('BOARD_LIBRARY_READ_ONLY');return g;}
function expandIDs(board,ids){const result=new Set(ids.map(id=>id.toLowerCase()));for(const g of M.inspect(board))if(g.itemIDs.some(id=>result.has(id))){if(!g.valid)M.fail('BOARD_LIBRARY_READ_ONLY');g.itemIDs.forEach(id=>result.add(id));}return [...result];}
function insert(board,next,op){const spec=M.spec(op,board),p=M.preset(spec.presetID),sig=M.signature(spec),existing=M.inspect(board).find(g=>g.groupID===op.groupID);
 if(existing){if(!existing.valid||existing.metadata.placementSignature!==sig)M.fail('BOARD_LIBRARY_CONFLICT');return{board:next,selectedIDs:existing.itemIDs};}
 if([...board.pins,...board.printFrames||[]].some(i=>i.libraryGroup?.groupID===op.groupID))M.fail('BOARD_LIBRARY_READ_ONLY');
 const memberIDs=p.parts.map(part=>M.stableID(op.groupID,part.role)),pinIDs=spec.addPin?[M.stableID(op.groupID,'pin')]:[],printFrameIDs=spec.addPrintFrame?[M.stableID(op.groupID,'printFrame')]:[],all=[...memberIDs,...pinIDs,...printFrameIDs],prior=[...board.items,...board.pins,...(board.printFrames||[])].map(i=>i.id.toLowerCase());if(new Set(all).size!==all.length||all.some(id=>prior.includes(id)))M.fail('BOARD_LIBRARY_CONFLICT');
 const metadata={version:1,groupID:op.groupID,presetID:p.id,memberIDs,pinIDs,printFrameIDs,placementSignature:sig};
 const parts=p.parts.map((part,i)=>{const text=part.text==='title'?spec.title:part.text||'',fill=spec.colors[part.fill];return{id:memberIDs[i],kind:'text',title:text,text,x:spec.rect.x+part.x*spec.rect.width,y:spec.rect.y+part.y*spec.rect.height,width:part.width*spec.rect.width,height:part.height*spec.rect.height,style:{fillColor:fill,strokeColor:fill,textColor:spec.colors.text,fontSize:part.fontSize||18,shape:part.shape,strokeWidth:1},libraryGroup:{...metadata,role:part.role}};});
 const pins=spec.addPin?[{id:pinIDs[0],title:spec.title||p.nameZh,x:spec.rect.x+spec.rect.width/2,y:spec.rect.y+spec.rect.height/2,zoom:Math.min(6,Math.max(.00005,720/Math.max(spec.rect.width,spec.rect.height))),libraryGroup:{...metadata,role:'pin'}}]:[];
 let frames=[];if(spec.addPrintFrame){const orientation=spec.rect.width>=spec.rect.height?'landscape':'portrait',ratio=orientation==='landscape'?720/540:540/720,width=Math.max(spec.rect.width,spec.rect.height*ratio),height=width/ratio,x=spec.rect.x-(width-spec.rect.width)/2,y=spec.rect.y-(height-spec.rect.height)/2;if(x<0||y<0||x+width>board.canvasWidth||y+height>board.canvasHeight)M.fail('BOARD_SPACE_INSUFFICIENT');frames=[{id:printFrameIDs[0],x,y,width,height,orientation,libraryGroup:{...metadata,role:'printFrame'}}];}
 return{board:{...next,items:p.category==='section'?[...parts,...board.items]:[...board.items,...parts],pins:[...board.pins,...pins],...(frames.length?{printFrames:[...(board.printFrames||[]),...frames]}:{})},selectedIDs:memberIDs};
}
function transform(board,next,op){M.exact(op,['type','groupID','rect']);const g=group(board,op.groupID),r=M.rect(op.rect,board),sx=r.width/g.rect.width,sy=r.height/g.rect.height;if(g.printFrameIDs.length&&!near(sx,sy))M.fail('BOARD_LIBRARY_FRAME_RATIO');const ids=new Set(g.itemIDs);return{board:{...next,items:board.items.map(i=>ids.has(i.id.toLowerCase())?{...i,x:r.x+(i.x-g.rect.x)*sx,y:r.y+(i.y-g.rect.y)*sy,width:i.width*sx,height:i.height*sy}:i)},selectedIDs:g.itemIDs};}
function remove(board,next,op){M.exact(op,['type','groupID']);const g=group(board,op.groupID),ids=new Set(g.itemIDs);return{board:{...next,items:next.items.filter(i=>!ids.has(i.id.toLowerCase())),edges:next.edges.filter(e=>!ids.has(e.from.toLowerCase())&&!ids.has(e.to.toLowerCase()))},selectedIDs:[]};}
function reconcile(board,next){let out=next;for(const g of M.inspect(board)){
 const old=g.members,after=old.map(i=>out.items.find(n=>n.id.toLowerCase()===i.id.toLowerCase()));const touched=old.some((i,n)=>!isDeepStrictEqual(i,after[n]));if(!touched)continue;if(!g.valid)M.fail('BOARD_LIBRARY_READ_ONLY');
 const remaining=after.filter(Boolean);if(!remaining.length){const pins=new Set(g.pinIDs),frames=new Set(g.printFrameIDs);out={...out,pins:out.pins.filter(i=>!pins.has(i.id.toLowerCase())),...(out.printFrames?{printFrames:out.printFrames.filter(i=>!frames.has(i.id.toLowerCase()))}:{})};continue;}
 if(remaining.length!==old.length)M.fail('BOARD_LIBRARY_GROUP_REQUIRED');for(let i=0;i<old.length;i++)if(!isDeepStrictEqual(old[i].libraryGroup,after[i].libraryGroup))M.fail('BOARD_LIBRARY_READ_ONLY');
 if(!old.some((i,n)=>geom.some(k=>i[k]!==after[n][k])))continue;
 const r=M.bounds(remaining);M.rect(r,board);const sx=r.width/g.rect.width,sy=r.height/g.rect.height;
 if(!old.every((i,n)=>near(after[n].x,r.x+(i.x-g.rect.x)*sx)&&near(after[n].y,r.y+(i.y-g.rect.y)*sy)&&near(after[n].width,i.width*sx)&&near(after[n].height,i.height*sy)))M.fail('BOARD_LIBRARY_GROUP_REQUIRED');
 if(g.printFrameIDs.length&&!near(sx,sy))M.fail('BOARD_LIBRARY_FRAME_RATIO');
 const pinIDs=new Set(g.pinIDs),frameIDs=new Set(g.printFrameIDs),memberIDs=new Set(g.itemIDs),fontScale=Math.sqrt(sx*sy);
 out={...out,items:out.items.map(i=>memberIDs.has(i.id.toLowerCase())?{...i,style:{...i.style,fontSize:Math.min(72,Math.max(8,(board.items.find(n=>n.id.toLowerCase()===i.id.toLowerCase()).style?.fontSize||18)*fontScale))}}:i),pins:out.pins.map(i=>{if(!pinIDs.has(i.id.toLowerCase()))return i;const original=board.pins.find(n=>n.id.toLowerCase()===i.id.toLowerCase());return{...i,x:r.x+(original.x-g.rect.x)*sx,y:r.y+(original.y-g.rect.y)*sy,zoom:original.zoom/Math.max(sx,sy)};}),...(out.printFrames?{printFrames:out.printFrames.map(i=>{if(!frameIDs.has(i.id.toLowerCase()))return i;const original=board.printFrames.find(n=>n.id.toLowerCase()===i.id.toLowerCase());return{...i,x:r.x+(original.x-g.rect.x)*sx,y:r.y+(original.y-g.rect.y)*sy,width:original.width*sx,height:original.height*sy};})}:{})};
 }
 for(const g of M.inspect(board))if(g.valid)for(const id of g.printFrameIDs){const f=out.printFrames?.find(n=>n.id.toLowerCase()===id);if(f&&(f.x<0||f.y<0||f.x+f.width>board.canvasWidth||f.y+f.height>board.canvasHeight))M.fail('BOARD_SPACE_INSUFFICIENT');}
 return out;}
module.exports={insert,transform,remove,reconcile,expandIDs};

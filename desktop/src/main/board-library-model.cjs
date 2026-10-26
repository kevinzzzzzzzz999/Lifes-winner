'use strict';
const crypto=require('node:crypto'),{isDeepStrictEqual}=require('node:util'),PRESETS=require('../shared/board-library-presets.json');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEYS=['version','groupID','presetID','memberIDs','pinIDs','printFrameIDs','placementSignature','role'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(code='BOARD_LIBRARY_INVALID'){throw Object.assign(new Error(code),{code});}
function exact(v,keys){if(!object(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))fail();}
function id(v){if(typeof v!=='string'||!UUID.test(v))fail();return v;}
function preset(v){const p=PRESETS.find(p=>p.id===v);if(!p)fail();return p;}
function rect(v,board){exact(v,['x','y','width','height']);if(!Object.values(v).every(Number.isFinite)||v.x<0||v.y<0||v.width<160||v.height<120||v.width>100000||v.height>100000||v.x+v.width>board.canvasWidth||v.y+v.height>board.canvasHeight)fail('BOARD_LIBRARY_BOUNDS');return{...v};}
function colors(v){exact(v,['background','accent','text']);if(!Object.values(v).every(x=>typeof x==='string'&&/^#[a-f0-9]{6}$/i.test(x)))fail();return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,x.toUpperCase()]));}
function spec(op,board){exact(op,['type','groupID','presetID','rect','title','colors','addPin','addPrintFrame']);id(op.groupID);preset(op.presetID);if(typeof op.title!=='string'||!op.title.isWellFormed()||op.title.includes('\0')||op.title.length>120||typeof op.addPin!=='boolean'||typeof op.addPrintFrame!=='boolean')fail();return{presetID:op.presetID,rect:rect(op.rect,board),title:op.title,colors:colors(op.colors),addPin:op.addPin,addPrintFrame:op.addPrintFrame};}
function stableID(groupID,role){const b=crypto.createHash('sha256').update('lifes-winner.board-library.v1\n'+groupID+'\n'+role).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
function signature(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function validMeta(m){return object(m)&&Object.keys(m).length===KEYS.length&&Object.keys(m).every(k=>KEYS.includes(k))&&m.version===1&&typeof m.groupID==='string'&&UUID.test(m.groupID)&&PRESETS.some(p=>p.id===m.presetID)&&typeof m.placementSignature==='string'&&/^[a-f0-9]{64}$/.test(m.placementSignature)&&typeof m.role==='string'&&m.pinIDs?.length<=1&&m.printFrameIDs?.length<=1&&['memberIDs','pinIDs','printFrameIDs'].every(k=>Array.isArray(m[k])&&m[k].length<25&&m[k].every(x=>typeof x==='string'&&UUID.test(x))&&new Set(m[k]).size===m[k].length);}
function bounds(items){return{x:Math.min(...items.map(i=>i.x)),y:Math.min(...items.map(i=>i.y)),width:Math.max(...items.map(i=>i.x+i.width))-Math.min(...items.map(i=>i.x)),height:Math.max(...items.map(i=>i.y+i.height))-Math.min(...items.map(i=>i.y))};}
function inspect(board){const items=board.items||[],pins=board.pins||[],frames=board.printFrames||[],grouped=new Map();for(const item of items)if(Object.hasOwn(item,'libraryGroup')){const m=item.libraryGroup,key=object(m)&&typeof m.groupID==='string'?m.groupID:item.id;grouped.set(key,[...(grouped.get(key)||[]),item]);}
 return [...grouped].map(([groupID,entries])=>{const m=entries[0].libraryGroup;let valid=validMeta(m),members=entries;if(valid){members=m.memberIDs.map(id=>items.find(i=>i.id.toLowerCase()===id));const p=preset(m.presetID);valid=entries.length===m.memberIDs.length&&members.length===p.parts.length&&members.every((item,n)=>item&&item.kind==='text'&&validMeta(item.libraryGroup)&&isDeepStrictEqual({...item.libraryGroup,role:''},{...m,role:''})&&item.libraryGroup.role===p.parts[n].role);for(const [list,ids,role]of [[pins,m.pinIDs,'pin'],[frames,m.printFrameIDs,'printFrame']]){if(list.filter(i=>object(i.libraryGroup)&&i.libraryGroup.groupID===m.groupID).length!==ids.length)valid=false;for(const id of ids){const e=list.find(i=>i.id.toLowerCase()===id);valid=valid&&!!e&&validMeta(e.libraryGroup)&&isDeepStrictEqual({...e.libraryGroup,role:''},{...m,role:''})&&e.libraryGroup.role===role;}}}
  return{groupID,presetID:object(m)?m.presetID:'',itemIDs:valid?m.memberIDs:entries.map(i=>i.id.toLowerCase()),pinIDs:validMeta(m)?m.pinIDs:[],printFrameIDs:validMeta(m)?m.printFrameIDs:[],rect:bounds(entries),valid,members:valid?members.filter(Boolean):entries,metadata:m};
 });}
module.exports={PRESETS,UUID,exact,id,preset,rect,colors,spec,stableID,signature,validMeta,bounds,inspect,fail};

function remapMergedGroups(source,out,map,fresh,targetPinCount,targetFrameCount){
 if(!source.items.some(i=>Object.hasOwn(i,'libraryGroup'))&&!source.pins.some(i=>Object.hasOwn(i,'libraryGroup'))&&!(source.printFrames||[]).some(i=>Object.hasOwn(i,'libraryGroup')))return;
 const groups=inspect(source);if(groups.some(g=>!g.valid))fail('BOARD_LIBRARY_READ_ONLY');
 const pinMap=new Map(source.pins.map((p,i)=>[p.id.toLowerCase(),out.pins[targetPinCount+i]?.id])),frameMap=new Map((source.printFrames||[]).map((p,i)=>[p.id.toLowerCase(),out.printFrames[targetFrameCount+i]?.id]));
 const knownGroups=new Set(groups.map(g=>g.groupID));for(const p of [...source.pins,...source.printFrames||[]])if(Object.hasOwn(p,'libraryGroup')&&(!validMeta(p.libraryGroup)||!knownGroups.has(p.libraryGroup.groupID)))fail('BOARD_LIBRARY_READ_ONLY');
 const used=new Set(out.items.map(i=>i.libraryGroup?.groupID).filter(Boolean));
 for(const g of groups){let groupID;do{groupID=fresh();}while(used.has(groupID));used.add(groupID);
  const memberIDs=g.itemIDs.map(id=>map.get(id)),pinIDs=g.pinIDs.map(id=>pinMap.get(id)),printFrameIDs=g.printFrameIDs.map(id=>frameMap.get(id));if([...memberIDs,...pinIDs,...printFrameIDs].some(id=>!id))fail('BOARD_LIBRARY_READ_ONLY');
  for(const [list,oldIDs,newIDs]of [[out.items,g.itemIDs,memberIDs],[out.pins,g.pinIDs,pinIDs],[out.printFrames||[],g.printFrameIDs,printFrameIDs]])for(let i=0;i<oldIDs.length;i++){const value=list.find(p=>p.id.toLowerCase()===newIDs[i].toLowerCase());if(!value||!validMeta(value.libraryGroup))fail('BOARD_LIBRARY_READ_ONLY');value.libraryGroup={...value.libraryGroup,groupID,memberIDs,pinIDs,printFrameIDs};}
 }
}
module.exports.remapMergedGroups=remapMergedGroups;

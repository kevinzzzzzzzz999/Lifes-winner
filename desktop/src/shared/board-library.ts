import rawCatalog from './board-library-presets.json?raw';
export type BoardLibraryCategory='material'|'cover'|'section';
export type BoardLibraryColors={background:string;accent:string;text:string};
export type BoardLibraryRect={x:number;y:number;width:number;height:number};
export type BoardLibraryPart={role:string;shape:'rectangle'|'rounded'|'ellipse';x:number;y:number;width:number;height:number;fill:keyof BoardLibraryColors;text?:string;fontSize?:number};
export type BoardLibraryPreset={id:string;category:BoardLibraryCategory;nameZh:string;nameEn:string;width:number;height:number;colors:BoardLibraryColors;parts:BoardLibraryPart[]};
export type BoardLibraryPreviewPart=BoardLibraryPart&{title:string;text:string;fillColor:string;strokeColor:string;textColor:string};
export type BoardLibraryGroup={groupID:string;presetID:string;itemIDs:string[];pinIDs:string[];printFrameIDs:string[];rect:BoardLibraryRect;valid:boolean;warning?:string};
export const LIBRARY_PRESETS=JSON.parse(rawCatalog) as BoardLibraryPreset[];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=['version','groupID','presetID','memberIDs','pinIDs','printFrameIDs','placementSignature','role'];
function meta(v:unknown):v is Record<string,unknown>&{version:1;groupID:string;presetID:string;memberIDs:string[];pinIDs:string[];printFrameIDs:string[];placementSignature:string;role:string}{if(!object(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))||v.version!==1||typeof v.groupID!=='string'||(!uuid.test(v.groupID)||v.groupID!==v.groupID.toLowerCase())||typeof v.presetID!=='string'||!LIBRARY_PRESETS.some(p=>p.id===v.presetID)||typeof v.placementSignature!=='string'||!/^[a-f0-9]{64}$/.test(v.placementSignature)||typeof v.role!=='string')return false;if(!Array.isArray(v.pinIDs)||v.pinIDs.length>1||!Array.isArray(v.printFrameIDs)||v.printFrameIDs.length>1)return false;return ['memberIDs','pinIDs','printFrameIDs'].every(k=>{const a=v[k];return Array.isArray(a)&&a.length<25&&a.every(x=>typeof x==='string'&&uuid.test(x)&&x===x.toLowerCase())&&new Set(a).size===a.length;});}
export function libraryPreviewParts(presetID:string,title:string,colors:BoardLibraryColors):BoardLibraryPreviewPart[]{const p=LIBRARY_PRESETS.find(p=>p.id===presetID);if(!p)return[];return p.parts.map(part=>({...part,title:part.text==='title'?title:part.text||'',text:part.text==='title'?title:part.text||'',fillColor:colors[part.fill],strokeColor:colors[part.fill],textColor:colors.text}));}
export function inspectLibraryGroups(raw:Record<string,unknown>):BoardLibraryGroup[]{
 const items=(Array.isArray(raw.items)?raw.items:[]).filter(object),pins=(Array.isArray(raw.pins)?raw.pins:[]).filter(object),frames=(Array.isArray(raw.printFrames)?raw.printFrames:[]).filter(object);
 const itemMap=new Map(items.map(i=>[String(i.id).toLowerCase(),i])),pinMap=new Map(pins.map(i=>[String(i.id).toLowerCase(),i])),frameMap=new Map(frames.map(i=>[String(i.id).toLowerCase(),i]));
 const grouped=new Map<string,Record<string,unknown>[]>();
 for(const i of items)if(Object.hasOwn(i,'libraryGroup')){const m=i.libraryGroup,k=object(m)&&typeof m.groupID==='string'?m.groupID.toLowerCase():String(i.id);grouped.set(k,[...(grouped.get(k)||[]),i]);}
 return [...grouped].map(([groupID,entries])=>{
  const m=entries[0].libraryGroup,known=meta(m),ids:string[]=known?m.memberIDs:entries.map(i=>String(i.id).toLowerCase());let valid=known;
  const rect={x:Math.min(...entries.map(i=>Number(i.x))),y:Math.min(...entries.map(i=>Number(i.y))),width:0,height:0};rect.width=Math.max(...entries.map(i=>Number(i.x)+Number(i.width)))-rect.x;rect.height=Math.max(...entries.map(i=>Number(i.y)+Number(i.height)))-rect.y;
  if(meta(m)){
   const p=LIBRARY_PRESETS.find(p=>p.id===m.presetID)!;
   const same=(q:typeof m)=>q.groupID===m.groupID&&q.presetID===m.presetID&&q.placementSignature===m.placementSignature&&JSON.stringify([q.memberIDs,q.pinIDs,q.printFrameIDs])===JSON.stringify([m.memberIDs,m.pinIDs,m.printFrameIDs]);
   valid=ids.length===p.parts.length&&entries.length===ids.length&&ids.every((id,index)=>{const i=itemMap.get(id);return !!i&&i.kind==='text'&&meta(i.libraryGroup)&&same(i.libraryGroup)&&i.libraryGroup.role===p.parts[index].role;});
   for(const [list,lookup,values,role]of [[pins,pinMap,m.pinIDs,'pin'],[frames,frameMap,m.printFrameIDs,'printFrame']] as const){
    if(list.filter(i=>object(i.libraryGroup)&&i.libraryGroup.groupID===m.groupID).length!==values.length)valid=false;
    for(const id of values){const i=lookup.get(id);valid=valid&&!!i&&meta(i.libraryGroup)&&same(i.libraryGroup)&&i.libraryGroup.role===role;}
   }
  }
  return{groupID,presetID:object(m)&&typeof m.presetID==='string'?m.presetID:'',itemIDs:valid?ids:entries.map(i=>String(i.id).toLowerCase()),pinIDs:meta(m)?m.pinIDs:[],printFrameIDs:meta(m)?m.printFrameIDs:[],rect,valid,warning:valid?undefined:'This group metadata is unsupported or incomplete. Original data is retained.'};
 });
}
export function isLibraryDecoration(item:Record<string,unknown>,board:Record<string,unknown>,groups?:BoardLibraryGroup[]):boolean {if(typeof item.title!=='string'||item.title.trim()||typeof item.text!=='string'||item.text.trim()||!meta(item.libraryGroup)||['title','caption'].includes(item.libraryGroup.role))return false;const m=item.libraryGroup;return (groups??inspectLibraryGroups(board)).some(g=>g.valid&&g.groupID===m.groupID&&g.itemIDs.includes(String(item.id).toLowerCase()));}

export function libraryPrintFrame(rect:BoardLibraryRect):BoardLibraryRect&{orientation:'portrait'|'landscape'} {const orientation=rect.width>=rect.height?'landscape':'portrait',ratio=orientation==='landscape'?4/3:3/4,width=Math.max(rect.width,rect.height*ratio),height=width/ratio;return{x:rect.x-(width-rect.width)/2,y:rect.y-(height-rect.height)/2,width,height,orientation};}

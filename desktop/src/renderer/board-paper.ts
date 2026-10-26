import type {CSSProperties} from 'react';
import type {BoardPaperBackground} from '../shared/desktop-api';

export const DEFAULT_PAPER:BoardPaperBackground={version:1,kind:'plain',color:'#F6F4EF',lineColor:'#789087',spacing:40,lineWidth:1,opacity:.2};
export const PAPER_PRESETS:Array<{name:string;nameEn:string;value:BoardPaperBackground}>=[
 {name:'米白纸',nameEn:'Warm paper',value:{...DEFAULT_PAPER}},
 {name:'纯白纸',nameEn:'White paper',value:{...DEFAULT_PAPER,color:'#FFFFFF'}},
 {name:'横线纸',nameEn:'Ruled paper',value:{...DEFAULT_PAPER,kind:'ruled',spacing:32}},
 {name:'方格纸',nameEn:'Grid paper',value:{...DEFAULT_PAPER,kind:'grid'}},
 {name:'点阵纸',nameEn:'Dotted paper',value:{...DEFAULT_PAPER,kind:'dots'}},
];
export function validPaper(value:unknown):value is BoardPaperBackground{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const b=value as BoardPaperBackground;
 return b.version===1&&['plain','ruled','grid','dots'].includes(b.kind)&&/^#[\da-f]{6}$/i.test(b.color)&&/^#[\da-f]{6}$/i.test(b.lineColor)&&Number.isFinite(b.spacing)&&b.spacing>=8&&b.spacing<=240&&Number.isFinite(b.lineWidth)&&b.lineWidth>=.25&&b.lineWidth<=4&&Number.isFinite(b.opacity)&&b.opacity>=0&&b.opacity<=1;
}
export function cleanPaper(value:BoardPaperBackground):BoardPaperBackground{
 if(!validPaper(value))throw Error('纸张参数无效 / Invalid paper settings');
 return{version:1,kind:value.kind,color:value.color.toUpperCase(),lineColor:value.lineColor.toUpperCase(),spacing:value.spacing,lineWidth:value.lineWidth,opacity:value.opacity};
}
const modulo=(n:number,d:number)=>((n%d)+d)%d;
export function paperScreenStyle(value:unknown,camera:{x:number;y:number;zoom:number},size:{width:number;height:number}):CSSProperties{
 if(!validPaper(value)||![camera.x,camera.y,camera.zoom,size.width,size.height].every(Number.isFinite)||camera.zoom<=0)return {};
 const base:CSSProperties={backgroundColor:value.color,backgroundImage:'none'};
 if(value.kind==='plain'||value.opacity===0)return base;
 let step=value.spacing*camera.zoom;
 // World-anchored level of detail bounds visible lines even at the full-board scale.
 for(let level=0;step<12&&level<64;level++)step*=2;
 if(!Number.isFinite(step)||step<=0)return base;
 const width=Math.min(4,Math.max(.5,value.lineWidth*camera.zoom));
 const components=[1,3,5].map(i=>parseInt(value.lineColor.slice(i,i+2),16));
 const ink=`rgba(${components.join(',')},${value.opacity})`;
 const line=`linear-gradient(to bottom,${ink} ${width}px,transparent ${width}px)`;
 const vertical=`linear-gradient(to right,${ink} ${width}px,transparent ${width}px)`;
 return{...base,backgroundImage:value.kind==='dots'?`radial-gradient(circle at ${width}px ${width}px,${ink} ${Math.max(.7,width)}px,transparent ${Math.max(.7,width)+.25}px)`:value.kind==='grid'?`${line},${vertical}`:line,backgroundSize:`${step}px ${step}px`,backgroundPosition:`${modulo(size.width/2-camera.x*camera.zoom,step)}px ${modulo(size.height/2-camera.y*camera.zoom,step)}px`};
}
export function paperExportSVG(value:unknown,bounds:{x:number;y:number;width:number;height:number},id:string):string{
 if(!validPaper(value))return '';
 if(!/^[a-z][a-z0-9-]*$/i.test(id)||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)||bounds.width<=0||bounds.height<=0)throw Error('Invalid paper export');
 const plain=`<rect width="${bounds.width}" height="${bounds.height}" fill="${value.color}"/>`;
 let pattern='';
 if(value.kind!=='plain'&&value.opacity>0){
  const s=value.spacing,w=value.lineWidth;
  const mid=s/2;
  const shape=value.kind==='dots'?`<circle cx="${mid}" cy="${mid}" r="${Math.max(.5,w)}" fill="${value.lineColor}"/>`:`<path d="M0 ${mid} H${s}${value.kind==='grid'?` M${mid} 0 V${s}`:''}" fill="none" stroke="${value.lineColor}" stroke-width="${w}"/>`;
  pattern=`<defs><pattern id="${id}" patternUnits="userSpaceOnUse" x="${modulo(-bounds.x-mid,s)}" y="${modulo(-bounds.y-mid,s)}" width="${s}" height="${s}">${shape}</pattern></defs><rect width="${bounds.width}" height="${bounds.height}" fill="url(#${id})" opacity="${value.opacity}"/>`;
 }
 return `<svg aria-hidden="true" style="position:absolute;inset:0;pointer-events:none" width="${bounds.width}" height="${bounds.height}" viewBox="0 0 ${bounds.width} ${bounds.height}">${plain}${pattern}</svg>`;
}
export type PaperFavorite={id:string;name:string;background:BoardPaperBackground};
export type PaperLibrary={version:1;favorites:PaperFavorite[]};
export const PAPER_LIBRARY_KEY='inkspace.paper.favorites.v1';
export function parsePaperLibrary(text:string|null):PaperLibrary{
 if(text===null)return{version:1,favorites:[]};
 if(text.length>128*1024)throw Error('纸张收藏数据过大，已保留原数据。 / Paper library is too large.');
 const value=JSON.parse(text) as PaperLibrary;
 if(value?.version!==1||!Array.isArray(value.favorites)||value.favorites.length>50)throw Error('无法读取纸张收藏，已保留原数据。 / Paper library unavailable.');
 const ids=new Set<string>();
 for(const entry of value.favorites){if(!entry||typeof entry.id!=='string'||!/^[a-z0-9-]{1,64}$/i.test(entry.id)||ids.has(entry.id)||typeof entry.name!=='string'||!entry.name.trim()||entry.name.length>60||!validPaper(entry.background))throw Error('纸张收藏内容无效，已保留原数据。 / Invalid paper library.');ids.add(entry.id);}
 return value;
}

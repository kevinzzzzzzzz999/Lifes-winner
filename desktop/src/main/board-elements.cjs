'use strict';
const {isDeepStrictEqual}=require('node:util');const crypto=require('node:crypto');const {fail}=require('./errors.cjs');
const ITEM_FIELDS=['id','kind','x','y','width','height','title','text','style','textFormat','richTextHTML','url','sourceReference','sourcePath','page'];
const TEXT_FORMATS=new Set(['richText','markdown','latex','python','web']);
const NODE_STYLE_FIELDS=['fillColor','strokeColor','textColor','fontSize','shape','strokeWidth'];
const EDGE_STYLE_FIELDS=['strokeColor','strokeWidth','arrow','dash','opacity'];
const nativeTimestamp=()=>new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
const editable=item=>item&&['text','formula'].includes(item.kind);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const color=v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v);

function validateSourceReference(r){
 if(!object(r)||Object.keys(r).some(k=>!['schemaVersion','path','sourceSHA256','page','rect','quote','extendBlockID'].includes(k))||r.schemaVersion!==1||typeof r.path!=='string'||typeof r.sourceSHA256!=='string'||!/^[a-f0-9]{64}$/.test(r.sourceSHA256)||!Number.isInteger(r.page)||r.page<1||r.page>100000||typeof r.quote!=='string'||r.quote.length>200000||!r.quote.isWellFormed()||r.quote.includes('\0'))fail('INVALID_BOARD');
 require('./pdf-layer-service.cjs').sourcePath(r.path);const b=r.rect;if(!object(b)||Object.keys(b).length!==4||!['x','y','width','height'].every(k=>typeof b[k]==='number'&&Number.isFinite(b[k])&&b[k]>=0&&b[k]<=1)||b.width<=0||b.height<=0||b.x+b.width>1.000000001||b.y+b.height>1.000000001)fail('INVALID_BOARD');
 if(r.extendBlockID!==undefined&&(typeof r.extendBlockID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.extendBlockID)))fail('INVALID_BOARD');
}

function validateItemStyle(s){if(!object(s))fail('INVALID_BOARD');for(const k of ['fillColor','strokeColor','textColor'])if(s[k]!=null&&!color(s[k]))fail('INVALID_BOARD');if(s.fontSize!=null&&(!Number.isFinite(s.fontSize)||s.fontSize<8||s.fontSize>72))fail('INVALID_BOARD');if(s.strokeWidth!=null&&(!Number.isFinite(s.strokeWidth)||s.strokeWidth<1||s.strokeWidth>8))fail('INVALID_BOARD');if(s.shape!=null&&!['rectangle','rounded','ellipse'].includes(s.shape))fail('INVALID_BOARD');}
function validateEdgeStyle(s){if(!object(s))fail('INVALID_BOARD');if(s.strokeColor!=null&&!color(s.strokeColor))fail('INVALID_BOARD');if(s.strokeWidth!=null&&(!Number.isFinite(s.strokeWidth)||s.strokeWidth<1||s.strokeWidth>12))fail('INVALID_BOARD');if(s.arrow!=null&&!['none','end','both'].includes(s.arrow))fail('INVALID_BOARD');if(s.dash!=null&&!['solid','dashed','dotted','dashDot'].includes(s.dash))fail('INVALID_BOARD');if(s.opacity!=null&&(!Number.isFinite(s.opacity)||s.opacity<0.1||s.opacity>1))fail('INVALID_BOARD');}
function mergeStyle(oldStyle,style,fields,validate,isNew){if(style==null)return style;if(!object(style))fail('INVALID_BOARD');if(isNew&&Object.keys(style).some(k=>!fields.includes(k)))fail('INVALID_BOARD');const result=object(oldStyle)?{...oldStyle}:{};for(const key of fields)if(Object.hasOwn(style,key))result[key]=style[key];validate(result);return result;}
function applyElements(board,items,edges,writerID,{manageProtected=false}={}){
 if(!Array.isArray(items)||!Array.isArray(edges)||items.length>100000||edges.length>100000)fail('INVALID_BOARD');
 const oldItems=new Map(board.items.map(item=>[item.id.toLowerCase(),item])),seen=new Set();
 const nextItems=items.map(item=>{if(!object(item)||typeof item.id!=='string')fail('INVALID_BOARD');const key=item.id.toLowerCase();if(seen.has(key))fail('INVALID_BOARD');seen.add(key);const old=oldItems.get(key);
  if(old&&!editable(old)){
   if(!manageProtected){if(!isDeepStrictEqual(item,old))fail('PERMISSION_DENIED');return old;}
   const fields=['x','y','width','height','title','style'];
   // Protected content is never accepted from the client. Only these display
   // changes are permitted; native drawing transforms are derived by the service.
   for(const field of Object.keys(item))if(!fields.includes(field)&&!isDeepStrictEqual(item[field],old[field]))fail('PERMISSION_DENIED');
   const result={...old};for(const field of fields)if(field!=='style'&&Object.hasOwn(item,field))result[field]=item[field];
   if(Object.hasOwn(item,'style'))result.style=mergeStyle(old.style,item.style,NODE_STYLE_FIELDS,validateItemStyle,false);
   return result;
  }
  if(!editable(item))fail('PERMISSION_DENIED');if(!old&&Object.keys(item).some(k=>!ITEM_FIELDS.includes(k)))fail('PERMISSION_DENIED');
  // Future native format strings survive unrelated edits; only known modes can
  // be newly written here. HTML remains data and is sanitized by each renderer.
  if(Object.hasOwn(item,'textFormat')&&item.textFormat!=null&&!TEXT_FORMATS.has(item.textFormat)&&item.textFormat!==old?.textFormat)fail('INVALID_BOARD');
  const merged=old?{...old}:{};for(const field of ITEM_FIELDS)if(Object.hasOwn(item,field)&&field!=='style'&&field!=='id')merged[field]=item[field];merged.id=old?.id||item.id;
  if(merged.textFormat==='web'&&(!old||old.textFormat!==merged.textFormat||old.url!==merged.url||old.text!==merged.text)){merged.url=require('./board-web-url.cjs').webCardURL(merged.url||merged.text);merged.text=merged.url;}
  else if(Object.hasOwn(item,'url')&&item.url!==old?.url&&item.url!=null)merged.url=require('./board-web-url.cjs').webCardURL(item.url);
  if(Object.hasOwn(item,'sourceReference')&&item.sourceReference!=null){validateSourceReference(item.sourceReference);if(merged.sourcePath!==item.sourceReference.path||merged.page!==item.sourceReference.page)fail('INVALID_BOARD');}
  if(TEXT_FORMATS.has(merged.textFormat)&&typeof merged.text!=='string')fail('INVALID_BOARD');
  if(Object.hasOwn(item,'style'))merged.style=mergeStyle(old?.style,item.style,NODE_STYLE_FIELDS,validateItemStyle,!old);
  return merged;
 });
 const oldProtected=board.items.filter(item=>!editable(item));const nextProtected=nextItems.filter(item=>!editable(item));if(!isDeepStrictEqual(oldProtected.map(i=>i.id),nextProtected.map(i=>i.id)))fail('PERMISSION_DENIED');if(!manageProtected&&!isDeepStrictEqual(oldProtected,nextProtected))fail('PERMISSION_DENIED');
 const oldEdges=new Map(board.edges.map(edge=>[edge.id.toLowerCase(),edge]));const edgeIDs=new Set();const nextEdges=edges.map(edge=>{if(!object(edge)||typeof edge.id!=='string'||edgeIDs.has(edge.id.toLowerCase()))fail('INVALID_BOARD');edgeIDs.add(edge.id.toLowerCase());const old=oldEdges.get(edge.id.toLowerCase());if(!old&&Object.keys(edge).some(k=>!['id','from','to','style','relation'].includes(k)))fail('PERMISSION_DENIED');const merged=old?{...old}:{};for(const field of ['from','to','relation'])if(Object.hasOwn(edge,field))merged[field]=edge[field];merged.id=old?.id||edge.id;if(Object.hasOwn(edge,'style'))merged.style=mergeStyle(old?.style,edge.style,EDGE_STYLE_FIELDS,validateEdgeStyle,!old);return merged;});
 if(!Number.isSafeInteger(board.revision+1))fail('INVALID_BOARD');const result={...board,items:nextItems,edges:nextEdges,revision:board.revision+1,writerID,updatedAt:nativeTimestamp()};require('./board-validation.cjs').validateBoard(result);return result;
}
function newBoard(title,writerID){const now=nativeTimestamp();const board={schemaVersion:1,id:crypto.randomUUID(),title,writerID,revision:0,createdAt:now,updatedAt:now,canvasWidth:8000000,canvasHeight:8000000,viewport:{x:4000000,y:4000000,zoom:1},items:[{id:crypto.randomUUID(),kind:'text',title,text:title,x:3999840,y:3999930,width:320,height:140,style:{fillColor:'#ffffff',strokeColor:'#202020',textColor:'#202020',fontSize:24,shape:'rounded',strokeWidth:2}}],edges:[],pins:[],webInk:{version:1,strokes:[]}};require('./board-validation.cjs').validateBoard(board);return board;}
module.exports={applyElements,newBoard,validateItemStyle,validateEdgeStyle,validateSourceReference};

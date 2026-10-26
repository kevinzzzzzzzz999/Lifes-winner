'use strict';
const {parentPort,workerData}=require('node:worker_threads');
function extract(data,type){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(data).replace(/^\uFEFF/,'');
 if(text.includes('\0'))throw Error('INVALID_CONTENT');
 if(type==='text')return{segments:[{text}],complete:true};
 const doc=JSON.parse(text);
 if(type==='notebook'){
  if(doc.nbformat!==4||!Array.isArray(doc.cells)||doc.cells.length>1000)throw Error('INVALID_NOTEBOOK');
  let size=0;const segments=[];
  for(const [cellIndex,c] of doc.cells.entries())if(c.cell_type==='code'||c.cell_type==='markdown'){
   const source=Array.isArray(c.source)&&c.source.every(x=>typeof x==='string')?c.source.join(''):c.source;
   if(typeof source!=='string'||Buffer.byteLength(source)>8*1024*1024||(size+=Buffer.byteLength(source))>32*1024*1024)throw Error('NOTEBOOK_SOURCE_LIMIT');
   if(source.trim())segments.push({text:source,cell:cellIndex+1});
  }
  return{segments,complete:true};
 }
 require('./board-validation.cjs').validateBoard(doc);
 const segments=[{text:doc.title||''}];
 for(const i of doc.items){const text=[i.title,i.text].filter(x=>typeof x==='string'&&x.trim()).join('\n');if(text)segments.push({text,nodeID:i.id});}
 const opaque=Boolean(doc.drawing)||doc.items.some(i=>Boolean(i.inkData))||Boolean(doc.webInk?.length)||Boolean(doc.webInk?.strokes?.length);
 return{segments,boardID:doc.id,complete:!opaque,opaqueInk:opaque};
}
if(parentPort){try{parentPort.postMessage({value:extract(workerData.data,workerData.type)});}catch(error){parentPort.postMessage({error:['INVALID_NOTEBOOK','NOTEBOOK_SOURCE_LIMIT'].includes(error.message)?error.message:'INVALID_CONTENT'});}}
module.exports={extract};

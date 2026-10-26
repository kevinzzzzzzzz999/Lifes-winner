'use strict';
const crypto=require('node:crypto');
const {validateCard,UUID,timestamp}=require('./study-model.cjs');
const MAX_BYTES=65536,MAX_HISTORY_COUNT=128,MAX_HISTORY_BYTES=1024*1024;
function failure(code='STUDY_LAYOUT_INVALID'){throw Object.assign(new Error(code),{code});}
function object(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function exact(v,keys,required=keys){if(!object(v)||Object.keys(v).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(v,k)))failure();}
function id(v){if(typeof v!=='string'||!UUID.test(v))failure();return v.toLowerCase();}
function makeStructure(boardID,itemID,rawCard){
 const card=validateCard(rawCard),board=id(boardID),item=id(itemID);
 if(!['qa','occlusion'].includes(card.mode))failure('STUDY_LAYOUT_UNSUPPORTED');
 const slots=blocks=>{const result=[{id:'body',kind:'text'},...(blocks||[]).map(b=>({id:id(b.id),kind:b.kind}))];if(result.length>17||new Set(result.map(s=>s.id)).size!==result.length)failure();return result;};
 const questionSlots=slots(card.questionBlocks),answerSlots=slots(card.answerBlocks);
 let wire=`study-card-layout-structure-v1\n${board}\n${item}\n${card.mode}\n${card.answerMode}\n`;
 for(const [side,values] of [['question',questionSlots],['answer',answerSlots]]){wire+=side+'\n'+values.length+'\n';for(const slot of values)wire+=slot.id+':'+slot.kind+'\n';}
 return {boardID:board,itemID:item,signature:crypto.createHash('sha256').update(wire,'ascii').digest('hex'),mode:card.mode,answerMode:card.answerMode,questionSlots,answerSlots};
}
function defaultLayout(structure){return{version:1,kind:'study-card-layout',boardID:structure.boardID,itemID:structure.itemID,structureSignature:structure.signature,question:{aspectRatio:.8,slots:structure.questionSlots.map(s=>({...s}))},answer:{aspectRatio:.8,slots:structure.answerSlots.map(s=>({...s}))},updatedAt:new Date().toISOString()};}
function validateLayout(v,structure){
 exact(v,['version','kind','boardID','itemID','structureSignature','question','answer','updatedAt']);
 if(v.version!==1||v.kind!=='study-card-layout')failure();
 if(v.boardID!==structure.boardID||v.itemID!==structure.itemID||v.structureSignature!==structure.signature)failure('STUDY_LAYOUT_CONFLICT');
 timestamp(v.updatedAt);
 const result={version:1,kind:'study-card-layout',boardID:v.boardID,itemID:v.itemID,structureSignature:v.structureSignature};
 for(const [name,expected] of [['question',structure.questionSlots],['answer',structure.answerSlots]]){
  const face=v[name];exact(face,['aspectRatio','slots']);
  if(typeof face.aspectRatio!=='number'||!Number.isFinite(face.aspectRatio)||face.aspectRatio<.25||face.aspectRatio>4||!Array.isArray(face.slots)||face.slots.length!==expected.length||face.slots.length>17)failure();
  const kinds=new Map(expected.map(s=>[s.id,s.kind]));if(kinds.size!==expected.length)failure();const seen=new Set();
  result[name]={aspectRatio:face.aspectRatio,slots:face.slots.map(slot=>{
   exact(slot,['id','kind','frame'],['id','kind']);if(seen.has(slot.id)||kinds.get(slot.id)!==slot.kind)failure('STUDY_LAYOUT_CONFLICT');seen.add(slot.id);
   const value={id:slot.id,kind:slot.kind};
   if(Object.hasOwn(slot,'frame')){const f=slot.frame;exact(f,['x','y','width','height']);if(!['x','y','width','height'].every(k=>typeof f[k]==='number'&&Number.isFinite(f[k]))||f.x<0||f.y<0||f.width<.05||f.height<.03||f.x+f.width>1.000000001||f.y+f.height>1.000000001)failure();value.frame={x:f.x,y:f.y,width:f.width,height:f.height};}
   return value;
  })};
 }
 result.updatedAt=v.updatedAt;if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_BYTES)failure('STUDY_LAYOUT_LIMIT');return result;
}
function decodeStored(data,boardID,itemID){
 if(!Buffer.isBuffer(data))data=Buffer.from(data);if(data.length>MAX_BYTES)failure('STUDY_LAYOUT_LIMIT');let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{failure();}
 if(!object(raw)||raw.boardID!==boardID||raw.itemID!==itemID||typeof raw.structureSignature!=='string'||!/^[a-f0-9]{64}$/.test(raw.structureSignature))failure();
 for(const side of ['question','answer']){const slots=raw[side]?.slots;if(!Array.isArray(slots)||slots.length<1||slots.length>17||slots.filter(v=>v?.id==='body'&&v?.kind==='text').length!==1)failure();for(const slot of slots){if(!object(slot)||!['text','image'].includes(slot.kind)||(slot.id!=='body'&&id(slot.id)!==slot.id))failure();}}
 const structure={boardID,itemID,signature:raw.structureSignature,questionSlots:raw.question.slots.map(s=>({id:s.id,kind:s.kind})),answerSlots:raw.answer.slots.map(s=>({id:s.id,kind:s.kind}))};
 return validateLayout(raw,structure);
}
function decode(data,structure){if(!Buffer.isBuffer(data))data=Buffer.from(data);if(data.length>MAX_BYTES)failure('STUDY_LAYOUT_LIMIT');let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{failure();}return validateLayout(raw,structure);}
function revision(data){return data==null?null:crypto.createHash('sha256').update(data).digest('hex');}
module.exports={MAX_BYTES,MAX_HISTORY_COUNT,MAX_HISTORY_BYTES,makeStructure,defaultLayout,validateLayout,decodeStored,decode,revision,failure};

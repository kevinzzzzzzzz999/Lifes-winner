'use strict';
const {validateCard,UUID}=require('./study-model.cjs'),{stableID}=require('./study-transfer-model.cjs');
function fail(code='STUDY_DRAFT_INVALID'){throw Object.assign(new Error(code),{code});}
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))fail();}
function text(value,max){if(typeof value!=='string'||!value.isWellFormed()||value.includes('\0')||!value.trim()||Array.from(value).length>max)fail('STUDY_DRAFT_LIMIT');return value;}
function nodeText(node){return typeof node.text==='string'&&node.text.trim()?node.text:typeof node.sourceReference?.quote==='string'?node.sourceReference.quote:'';}
function edited(kind,question,answer){text(question,4000);text(answer,20000);if(kind!=='summary'){const card=validateCard({mode:kind,answerMode:'custom',question,answer}),zero='00000000-0000-0000-0000-000000000000';if(Buffer.byteLength(JSON.stringify({schemaVersion:1,id:zero,deviceID:zero,createdAt:'2026-10-25T00:00:00.000Z',boardID:zero,itemID:zero,kind:'card',card}))>65536)fail('STUDY_DRAFT_LIMIT');}return{question,answer};}
function generate(board,nodeIDs,kind,token){
 if(!['summary','qa','cloze'].includes(kind)||!Array.isArray(nodeIDs)||nodeIDs.length<1||nodeIDs.length>10||new Set(nodeIDs.map(v=>String(v).toLowerCase())).size!==nodeIDs.length||nodeIDs.some(v=>typeof v!=='string'||!UUID.test(v)))fail();
 const nodes=new Map();for(const node of board.items){const id=node.id.toLowerCase();if(nodes.has(id))fail('STUDY_DRAFT_SOURCE_CHANGED');nodes.set(id,node);}
 return nodeIDs.map((id,index)=>{
  const n=nodes.get(id.toLowerCase());if(!n)fail('STUDY_DRAFT_SOURCE_CHANGED');
  const quote=nodeText(n);text(quote,20000);const title=typeof n.title==='string'&&n.title.trim()?n.title:'Untitled';text(title,1000);
  const source={nodeID:n.id.toLowerCase(),title,quote,...(typeof n.sourcePath==='string'?{sourcePath:n.sourcePath}:{}),...(Number.isInteger(n.page)&&n.page>0?{page:n.page}:{})};
  let question=kind==='summary'?'来源摘录 · '+title:'请对照来源，说明“'+title+'”这段内容。',answer=quote,status='ready',reason;
  if(kind==='cloze'){
   const word=[...quote.matchAll(/[\p{L}\p{N}]+/gu)].find(m=>Array.from(m[0]).length>=2&&Array.from(m[0]).length<=30);
   if(!word||quote.includes('{{')||quote.includes('}}')){status='unsupported';reason='No safe automatic cloze was found. Choose another source or edit a valid {{cloze}}.';question=quote;}
   else question=quote.slice(0,word.index)+'{{'+word[0]+'}}'+quote.slice(word.index+word[0].length);
  }
  if(status==='ready'){try{edited(kind,question,answer);}catch{status='unsupported';reason='The complete source exceeds card limits. Choose a smaller source or edit the draft explicitly.';}}
  return{id:stableID(board.id,token+':'+index,'draft-row'),index,source,question,answer,status,...(reason?{reason}:{})};
 });
}
module.exports={fail,exact,text,nodeText,edited,generate,stableID};

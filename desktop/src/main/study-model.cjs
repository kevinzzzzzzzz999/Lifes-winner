'use strict';
const {fail}=require('./errors.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LIMITS=Object.freeze({maxFiles:10000,maxBytes:32*1024*1024,maxRecord:64*1024,maxQuestion:4000,maxAnswer:20000,maxBoard:64*1024*1024,concurrency:4,timeoutMs:30000});
const DAY=86400000,GRADES=new Set(['again','hard','good','easy']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function ensure(ok){if(!ok)fail('STUDY_INVALID_EVENT');}
function uuid(v){ensure(typeof v==='string'&&UUID.test(v));return v.toLowerCase();}
function exact(v,allowed,required=allowed){ensure(object(v)&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k)));}
function text(v,maximum,nonempty=true){ensure(typeof v==='string'&&v.isWellFormed()&&!v.includes('\0')&&Array.from(v).length<=maximum&&(!nonempty||v.trim().length>0));return v;}
function timestamp(v){
 ensure(typeof v==='string');const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(v);ensure(m);
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];ensure(year>=1&&year<=9998&&month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<=23&&minute<=59&&second<=59);
 if(m[8]!=='Z'){ensure(Number(m[8].slice(1,3))<=23&&Number(m[8].slice(4))<=59);}
 const date=new Date(v);ensure(Number.isFinite(date.getTime())&&date.getUTCFullYear()>=1&&date.getUTCFullYear()<=9998);return date.toISOString();
}
function clozes(value){
 const result=[];let cursor=0;while(cursor<value.length){const open=value.indexOf('{{',cursor),close=value.indexOf('}}',cursor);if(open<0){ensure(close<0);break;}ensure(close>=open+2);const nested=value.indexOf('{{',open+2);ensure(nested<0||nested>close);const hidden=value.slice(open+2,close);ensure(close>=0&&hidden.trim().length>0&&!hidden.includes('{{')&&!hidden.includes('}}'));result.push(hidden);cursor=close+2;}ensure(result.length>0);return result;
}
function validateBlocks(value,allowRegions=false){
 ensure(Array.isArray(value)&&value.length<=16);const ids=new Set();return value.map(v=>{exact(v,['id','kind','text','sourcePath','regions'],['id','kind']);const id=uuid(v.id);ensure(!ids.has(id));ids.add(id);ensure(['text','image'].includes(v.kind));
  if(v.kind==='text'){ensure(!Object.hasOwn(v,'sourcePath')&&!Object.hasOwn(v,'regions'));return{id,kind:'text',text:text(v.text,4000)};}
  ensure(!Object.hasOwn(v,'text')&&typeof v.sourcePath==='string'&&/\.(png|jpe?g)$/i.test(v.sourcePath));require('./vault-path.cjs').relativePath(v.sourcePath);ensure(!v.sourcePath.split('/').some(p=>p.startsWith('.')));
  const result={id,kind:'image',sourcePath:v.sourcePath};if(v.regions!==undefined){ensure(allowRegions&&Array.isArray(v.regions)&&v.regions.length<=32);const regions=new Set();result.regions=v.regions.map(r=>{exact(r,['id','x','y','width','height']);const id=uuid(r.id);ensure(!regions.has(id));regions.add(id);ensure(['x','y','width','height'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k]))&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=1.000000001&&r.y+r.height<=1.000000001);return{id,x:r.x,y:r.y,width:r.width,height:r.height};});}return result;
 });
}
function validateCard(v){exact(v,['question','answer','mode','answerMode','questionBlocks','answerBlocks'],['question','answer','mode']);ensure(['qa','cloze','occlusion'].includes(v.mode)&&[undefined,'custom','node'].includes(v.answerMode));const mode=v.mode,answerMode=v.answerMode??'custom';ensure(mode==='qa'||answerMode==='custom');const question=text(v.question,LIMITS.maxQuestion),answer=text(v.answer,LIMITS.maxAnswer,false),result={question,answer,mode,answerMode};
 if(mode==='cloze'){ensure(v.questionBlocks===undefined&&v.answerBlocks===undefined);clozes(question);}else{if(v.questionBlocks!==undefined)result.questionBlocks=validateBlocks(v.questionBlocks,mode==='occlusion');if(v.answerBlocks!==undefined)result.answerBlocks=validateBlocks(v.answerBlocks,false);ensure(answerMode==='node'||answer.trim().length>0||result.answerBlocks?.length>0);if(mode==='occlusion')ensure(result.questionBlocks?.some(b=>b.kind==='image'&&b.regions?.length));}return result;}

function validateEvent(v){
 exact(v,['schemaVersion','id','deviceID','createdAt','boardID','itemID','kind','card','grade'],['schemaVersion','id','deviceID','createdAt','boardID','itemID','kind']);ensure(v.schemaVersion===1&&['card','grade','delete'].includes(v.kind));
 const event={schemaVersion:1,id:uuid(v.id),deviceID:uuid(v.deviceID),createdAt:timestamp(v.createdAt),boardID:uuid(v.boardID),itemID:uuid(v.itemID),kind:v.kind};
 if(v.kind==='card'){ensure(Object.hasOwn(v,'card')&&!Object.hasOwn(v,'grade'));event.card=validateCard(v.card);}else if(v.kind==='grade'){ensure(!Object.hasOwn(v,'card')&&GRADES.has(v.grade));event.grade=v.grade;}else ensure(!Object.hasOwn(v,'card')&&!Object.hasOwn(v,'grade'));
 ensure(Buffer.byteLength(JSON.stringify(event),'utf8')<=LIMITS.maxRecord);return event;
}
function canonical(v){return JSON.stringify(validateEvent(v));}
function projectEvents(boardID,events,nodeIDs,warnings=[]){
 const id=uuid(boardID),present=new Set([...nodeIDs].map(uuid)),cards=new Map(),unique=new Map(),conflicted=new Set(),messages=new Set(warnings);
 for(const raw of events){let e;try{e=validateEvent(raw);}catch{messages.add('Invalid learning event was preserved.');continue;}if(e.boardID!==id){messages.add('Learning event for another whiteboard was preserved.');continue;}const prior=unique.get(e.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(e)){conflicted.add(e.id);messages.add('Conflicting event identifiers were preserved without applying either version.');}else unique.set(e.id,e);}
 const ordered=[...unique.values()].filter(e=>!conflicted.has(e.id)).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||(a.id<b.id?-1:a.id>b.id?1:0));
 for(const e of ordered){const prior=cards.get(e.itemID);if(e.kind==='delete'){cards.delete(e.itemID);continue;}if(e.kind==='card'){cards.set(e.itemID,prior?{...prior,card:e.card,eventID:e.id}:{itemID:e.itemID,card:e.card,eventID:e.id,dueAt:e.createdAt,intervalDays:0,reviewCount:0,missingNode:!present.has(e.itemID)});continue;}if(!prior)continue;
  const days=e.grade==='again'?0:Math.min(365,e.grade==='hard'?Math.max(1,Math.round(prior.intervalDays*1.2)):e.grade==='good'?(prior.intervalDays?Math.max(1,Math.round(prior.intervalDays*2.5)):1):(prior.intervalDays?Math.max(4,Math.round(prior.intervalDays*3.5)):4));
  cards.set(e.itemID,{...prior,eventID:e.id,dueAt:new Date(Date.parse(e.createdAt)+(e.grade==='again'?600000:days*DAY)).toISOString(),intervalDays:days,reviewCount:prior.reviewCount+1,lastGrade:e.grade});
 }
 return{boardID:id,cards:[...cards.values()].sort((a,b)=>a.itemID<b.itemID?-1:a.itemID>b.itemID?1:0),warnings:[...messages]};
}
module.exports={validateBlocks,LIMITS,UUID,validateEvent,validateCard,projectEvents,canonical,clozes,timestamp};

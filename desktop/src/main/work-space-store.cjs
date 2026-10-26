'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/;
const LIMITS=Object.freeze({bytes:8*1024*1024,items:2000,sources:64,documents:512,tasks:10000,text:4000});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const id=value=>typeof value==='string'&&UUID.test(value);
const text=(value,max=LIMITS.text)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!value.includes('\0');
const stamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19);
function civil(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value))return false;const d=new Date(value+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value&&value>='0001-01-01';}
function safePath(value){return typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\\:\x00-\x1f\x7f]/.test(value)&&!value.startsWith('/')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..');}
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('INVALID_REQUEST');}
function sameFolder(a,b){return a.root===b.root&&a.dev===b.dev&&a.ino===b.ino&&a.birthtimeMs===b.birthtimeMs;}
function folderIdentity(a){return JSON.stringify([a.dev,a.ino,a.birthtimeMs??null]);}
function validFolder(folder){return folder&&typeof folder.root==='string'&&path.isAbsolute(folder.root)&&folder.root.length<=16384&&Number.isSafeInteger(folder.dev)&&Number.isSafeInteger(folder.ino)&&(folder.birthtimeMs===undefined||Number.isFinite(folder.birthtimeMs));}
function validEvent(value){exact(value,['startAt','endAt']);if(!stamp(value.startAt)||!stamp(value.endAt)||Date.parse(value.endAt)<=Date.parse(value.startAt))fail('INVALID_REQUEST');return value;}
function validMail(value){
 exact(value,['accountID','accountAddress','provider','uidValidity','uid','subject','sender','receivedAt','messageID','excerpt']);
 const uid=v=>typeof v==='string'&&/^[1-9]\d{0,9}$/.test(v)&&BigInt(v)<=4294967295n;
 const string=(v,max)=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
 if((value.accountAddress!==undefined&&(!string(value.accountAddress,320)||!value.accountAddress.trim()))||!id(value.accountID)||!['gmail','icloud','qq'].includes(value.provider)||!uid(value.uidValidity)||!uid(value.uid)||!string(value.subject,4000)||!string(value.sender,4000)||!string(value.excerpt,8000)||(value.messageID!==undefined&&!string(value.messageID,4000))||(value.receivedAt!==undefined&&!stamp(value.receivedAt)))fail('INVALID_REQUEST');return value;
}
const mailKey=value=>JSON.stringify([value.accountID.toLowerCase(),value.uidValidity,value.uid]);
function validStudy(value){exact(value,['sourceID','path','kind','title','category','excerpt','boardID','nodeID','page','pdfAnnotation','wordAnnotation']);if(!id(value.sourceID)||!safePath(value.path)||!['file','board','pdf'].includes(value.kind)||!text(value.title,1000)||!['focus','question'].includes(value.category)||(value.excerpt!==undefined&&(typeof value.excerpt!=='string'||value.excerpt.length>4000||value.excerpt.includes('\0')))||(value.boardID!==undefined&&!id(value.boardID))||(value.nodeID!==undefined&&(!id(value.nodeID)||!value.boardID||value.kind!=='board'))||(value.page!==undefined&&(!Number.isInteger(value.page)||value.page<1||value.page>100000||value.kind!=='pdf')))fail('INVALID_REQUEST');if(value.pdfAnnotation!==undefined){const a=value.pdfAnnotation;exact(a,['sourceSHA256','index','fingerprint','subtype','rect']);if(value.kind!=='pdf'||!value.page||!SHA.test(a.sourceSHA256||'')||!SHA.test(a.fingerprint||'')||!Number.isSafeInteger(a.index)||a.index<0||a.index>100000||!['Text','FreeText','Highlight','Underline','StrikeOut','Squiggly'].includes(a.subtype))fail('INVALID_REQUEST');if(a.rect!==undefined){exact(a.rect,['x','y','width','height']);if(!['x','y','width','height'].every(k=>Number.isFinite(a.rect[k]))||a.rect.x<0||a.rect.y<0||a.rect.width<=0||a.rect.height<=0||a.rect.x+a.rect.width>1.000001||a.rect.y+a.rect.height>1.000001)fail('INVALID_REQUEST');}}if(value.wordAnnotation!==undefined){const a=value.wordAnnotation;exact(a,['sourceSHA256','part','kind','annotationID','fingerprint']);if(value.kind!=='file'||!value.path.toLowerCase().endsWith('.docx')||value.pdfAnnotation||value.boardID||value.nodeID||value.page||a.part!=='word/document.xml'||!['comment','insertion','deletion'].includes(a.kind)||!/^[0-9]{1,20}$/.test(a.annotationID||'')||!SHA.test(a.sourceSHA256||'')||!SHA.test(a.fingerprint||''))fail('INVALID_REQUEST');}return value;}
function validateItems(items,version=1){
 if(!Array.isArray(items)||items.length>LIMITS.items)fail('TOO_LARGE');const ids=new Set(),orders=new Set();
 for(const item of items){
  exact(item,['id','text','noteOrder','isTask','done','dueDate','createdAt','updatedAt','completedAt','archivedAt',...(version>=2?['mailReference','event','reminderAt']:[]),...(version>=3?['studyReference']:[])]);
  if(!id(item.id)||ids.has(item.id.toLowerCase())||!text(item.text)||typeof item.isTask!=='boolean'||typeof item.done!=='boolean'||!stamp(item.createdAt)||!stamp(item.updatedAt))fail('INVALID_REQUEST');ids.add(item.id.toLowerCase());
  if(item.noteOrder!==undefined){if(!Number.isSafeInteger(item.noteOrder)||item.noteOrder<0||orders.has(item.noteOrder))fail('INVALID_REQUEST');orders.add(item.noteOrder);}
  if(item.dueDate!==undefined&&!civil(item.dueDate))fail('INVALID_REQUEST');
  if(item.completedAt!==undefined&&(!item.done||!stamp(item.completedAt)))fail('INVALID_REQUEST');
  if(item.archivedAt!==undefined&&!stamp(item.archivedAt))fail('INVALID_REQUEST');if(item.mailReference!==undefined){validMail(item.mailReference);if(item.mailReference.provider==='qq'&&version<3)fail('WORK_PROTECTED');}if(item.studyReference!==undefined){validStudy(item.studyReference);if(item.studyReference.wordAnnotation&&version<5)fail('WORK_PROTECTED');if(item.studyReference.pdfAnnotation&&version<4)fail('WORK_PROTECTED');if(item.mailReference)fail('INVALID_REQUEST');}if(item.event!==undefined){validEvent(item.event);if(!item.isTask)fail('INVALID_REQUEST');}if(item.reminderAt!==undefined&&(!item.isTask||!stamp(item.reminderAt)))fail('INVALID_REQUEST');
  if(!item.isTask&&(item.done||item.dueDate!==undefined))fail('INVALID_REQUEST');
 }
 return items;
}
function validateDocuments(documents){
 if(!Array.isArray(documents)||documents.length>LIMITS.documents)fail('TOO_LARGE');let tasks=0;const paths=new Set();
 for(const doc of documents){
  exact(doc,['path','id','title','sha256','tasks','available']);if(doc.available!==undefined&&typeof doc.available!=='boolean')fail('INVALID_REQUEST');
  if(!safePath(doc.path)||!doc.path.toLowerCase().endsWith('.inkcheck.json')||paths.has(doc.path)||!id(doc.id)||!text(doc.title,200)||!SHA.test(doc.sha256)||!Array.isArray(doc.tasks))fail('INVALID_REQUEST');paths.add(doc.path);
  tasks+=doc.tasks.length;if(tasks>LIMITS.tasks)fail('TOO_LARGE');const ids=new Set();
  for(const task of doc.tasks){exact(task,['id','text','section','done','dueDate']);if(!id(task.id)||ids.has(task.id.toLowerCase())||!text(task.text,1000)||typeof task.section!=='string'||task.section.length>200||task.section.includes('\0')||typeof task.done!=='boolean'||(task.dueDate!==undefined&&!civil(task.dueDate)))fail('INVALID_REQUEST');ids.add(task.id.toLowerCase());}
 }
 return documents;
}
function validateDocument(doc){
 exact(doc,['version','kind','items','sources']);if(![1,2,3,4,5].includes(doc.version)||doc.kind!=='work-space')fail('WORK_PROTECTED');validateItems(doc.items,doc.version);const mailIDs=new Set();for(const item of doc.items)if(item.mailReference){const key=mailKey(item.mailReference);if(mailIDs.has(key))fail('WORK_PROTECTED');mailIDs.add(key);}
 if(!Array.isArray(doc.sources)||doc.sources.length>LIMITS.sources)fail('TOO_LARGE');const ids=new Set(),roots=new Set();let totalTasks=0;
 for(const source of doc.sources){
  exact(source,['id','name','folder','status','createdAt','checkedAt','updatedAt','issue','documents']);
  if(!id(source.id)||ids.has(source.id.toLowerCase())||!text(source.name,500)||!validFolder(source.folder)||roots.has(folderIdentity(source.folder))||!['cached','ready','partial','unavailable'].includes(source.status)||!stamp(source.createdAt)||(source.checkedAt!==undefined&&!stamp(source.checkedAt))||(source.updatedAt!==undefined&&!stamp(source.updatedAt))||(source.issue!==undefined&&(!text(source.issue,100)||!/^[A-Z_]+$/.test(source.issue))))fail('WORK_PROTECTED');
  ids.add(source.id.toLowerCase());roots.add(folderIdentity(source.folder));validateDocuments(source.documents);
  totalTasks+=source.documents.reduce((n,d)=>n+d.tasks.length,0);if(totalTasks>20000)fail('TOO_LARGE');
 }
 for(const item of doc.items)if(item.studyReference&&!doc.sources.some(source=>source.id.toLowerCase()===item.studyReference.sourceID.toLowerCase()))fail('WORK_PROTECTED');
 return doc;
}
const empty=()=>({version:1,kind:'work-space',items:[],sources:[]});
class WorkSpaceStore{
 constructor({dataDirectory,fsAPI=fs,now=()=>new Date()}={}){this.fs=fsAPI;this.root=path.join(dataDirectory,'work-space');this.file=path.join(this.root,'index-v1.json');this.now=now;this.queue=Promise.resolve();this.warning='';}
 locked(work){const run=this.queue.catch(()=>{}).then(work);this.queue=run.catch(()=>{});return run;}
 async directory(create=false){try{const info=await this.fs.lstat(this.root);if(!info.isDirectory()||info.isSymbolicLink())fail('WORK_PROTECTED');}catch(e){if(e.code!=='ENOENT')throw e;if(!create)return false;await this.fs.mkdir(this.root,{mode:0o700});return this.directory();}return true;}
 async read(){
  let handle;try{if(!await this.directory())return{document:empty(),revision:null,bytes:null,readOnly:false};handle=await this.fs.open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size<1||before.size>LIMITS.bytes)fail('WORK_PROTECTED');
   const chunks=[];let total=0;while(true){const buffer=Buffer.allocUnsafe(Math.min(65536,LIMITS.bytes+1-total));const {bytesRead}=await handle.read(buffer,0,buffer.length,total);if(!bytesRead)break;total+=bytesRead;if(total>LIMITS.bytes)fail('TOO_LARGE');chunks.push(buffer.subarray(0,bytesRead));}const bytes=Buffer.concat(chunks,total);const after=await handle.stat();if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('WORK_CONFLICT');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return{document:validateDocument(value),revision:hash(bytes),bytes,readOnly:false};
  }catch(e){if(e.code==='ENOENT')return{document:empty(),revision:null,bytes:null,readOnly:false};return{document:empty(),revision:null,bytes:null,readOnly:true,issue:'WORK_PROTECTED'};}finally{await handle?.close();}
 }
 public(value){return{version:value.document.version,items:structuredClone(value.document.items),sources:value.document.sources.map(({folder,...source})=>structuredClone(source)),revision:value.revision,readOnly:value.readOnly,...(value.issue?{issue:value.issue}:{}),...(this.warning?{warning:this.warning}:{})};}
 snapshot(){return this.locked(async()=>this.public(await this.read()));}
 async backupVersion(before,target){
  if(before.document.version>=target||!before.bytes)return;
  const dest=path.join(this.root,'pre-v'+target+'-'+before.revision+'.json');let handle;
  try{handle=await this.fs.open(dest,'wx',0o600);await handle.writeFile(before.bytes);await handle.sync();await handle.close();handle=null;}
  catch(error){if(error.code!=='EEXIST')throw error;handle=await this.fs.open(dest,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size!==before.bytes.length)fail('WORK_PROTECTED');const data=Buffer.alloc(info.size);let at=0;while(at<data.length){const {bytesRead}=await handle.read(data,at,data.length-at,at);if(!bytesRead)break;at+=bytesRead;}if(at!==data.length||hash(data)!==before.revision)fail('WORK_PROTECTED');await handle.sync();}
  finally{await handle?.close();}
  const directory=await this.fs.open(this.root,'r');try{await directory.sync();}finally{await directory.close();}
 }
 async commit(before,document,finalPreflight){
  validateDocument(document);const bytes=Buffer.from(JSON.stringify(document,null,2)+'\n');if(bytes.length>LIMITS.bytes)fail('TOO_LARGE');
  if(before.readOnly)fail('WORK_PROTECTED');await this.directory(true);const current=await this.read();if(current.readOnly)fail('WORK_PROTECTED');if(current.revision!==before.revision)fail('WORK_CONFLICT');if(before.document.version<document.version)await this.backupVersion(before,document.version);
  const temp=path.join(this.root,'.work-'+crypto.randomUUID()+'.tmp');let handle,renamed=false;
  try{handle=await this.fs.open(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;if(finalPreflight)await finalPreflight();const last=await this.read();if(last.readOnly||last.revision!==before.revision)fail('WORK_CONFLICT');await this.fs.rename(temp,this.file);renamed=true;
   try{const dir=await this.fs.open(this.root,'r');try{await dir.sync();}finally{await dir.close();}this.warning='';}catch{const actual=await this.read();if(actual.revision!==hash(bytes))fail('WORK_WRITE_UNCERTAIN');this.warning='WORK_DIRECTORY_SYNC_UNCONFIRMED';}
  }finally{await handle?.close();if(!renamed)await this.fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  return this.public({document,revision:hash(bytes),readOnly:false});
 }
 mutate(request){return this.locked(async()=>{
  exact(request,['revision','operation']);if(!(request.revision===null||SHA.test(request.revision||'')))fail('INVALID_REQUEST');const before=await this.read();if(before.readOnly)fail('WORK_PROTECTED');if(before.revision!==request.revision)fail('WORK_CONFLICT');const next=structuredClone(before.document),op=request.operation,now=this.now().toISOString();
  exact(op,['type','id','text','dueDate','done','direction','expectedUpdatedAt','event','reminderAt']);if(!id(op.id))fail('INVALID_REQUEST');let item=next.items.find(x=>x.id.toLowerCase()===op.id.toLowerCase());
  if(op.type==='addNote'||op.type==='addTask'){
   if(item){if(item.text===op.text&&item.isTask===(op.type==='addTask'))return this.public(before);fail('WORK_CONFLICT');}if(!text(op.text))fail('INVALID_REQUEST');
   item={id:op.id,text:op.text,isTask:op.type==='addTask',done:false,createdAt:now,updatedAt:now};if(op.type==='addNote')item.noteOrder=Math.max(-1,...next.items.filter(x=>x.noteOrder!==undefined).map(x=>x.noteOrder))+1;else if(op.dueDate!==undefined)item.dueDate=op.dueDate;next.items.push(item);
  }else{
   if(!item)fail('NOT_FOUND');if(['toTask','update','archive','restore','setSchedule'].includes(op.type)&&(!stamp(op.expectedUpdatedAt)||item.updatedAt!==op.expectedUpdatedAt))fail('WORK_CONFLICT');if(op.type==='toTask'){if(!civil(op.dueDate)||item.archivedAt)fail('INVALID_REQUEST');item.isTask=true;item.dueDate=op.dueDate;}
   else if(op.type==='update'){
    if(op.text!==undefined){if(!text(op.text))fail('INVALID_REQUEST');item.text=op.text;}
    if(op.done!==undefined){if(!item.isTask||typeof op.done!=='boolean')fail('INVALID_REQUEST');item.done=op.done;if(op.done)item.completedAt=now;else delete item.completedAt;}
    if(op.dueDate!==undefined){if(!item.isTask)fail('INVALID_REQUEST');if(op.dueDate===null)delete item.dueDate;else{if(!civil(op.dueDate))fail('INVALID_REQUEST');item.dueDate=op.dueDate;}}
   }else if(op.type==='setSchedule'){if(!item.isTask)fail('INVALID_REQUEST');if(op.event===null)delete item.event;else item.event=structuredClone(validEvent(op.event));if(op.reminderAt===null)delete item.reminderAt;else{if(!stamp(op.reminderAt))fail('INVALID_REQUEST');item.reminderAt=op.reminderAt;}if(op.dueDate!==undefined){if(op.dueDate===null)delete item.dueDate;else{if(!civil(op.dueDate))fail('INVALID_REQUEST');item.dueDate=op.dueDate;}}next.version=Math.max(next.version,2);}else if(op.type==='archive'){item.archivedAt=now;}
   else if(op.type==='restore'){delete item.archivedAt;}
   else if(op.type==='moveNote'){
    if(![-1,1].includes(op.direction)||item.noteOrder===undefined||item.archivedAt)fail('INVALID_REQUEST');const notes=next.items.filter(x=>x.noteOrder!==undefined&&!x.archivedAt).sort((a,b)=>a.noteOrder-b.noteOrder),at=notes.indexOf(item),other=notes[at+op.direction];if(!other)return this.public(before);[item.noteOrder,other.noteOrder]=[other.noteOrder,item.noteOrder];
   }else fail('INVALID_REQUEST');item.updatedAt=new Date(Math.max(Date.parse(now),Date.parse(item.updatedAt)+1)).toISOString();
  }
  return this.commit(before,next);
 });}
 importMail(request){return this.locked(async()=>{
  exact(request,['revision','id','text','role','reference','event','reminderAt','dueDate']);if(!(request.revision===null||SHA.test(request.revision||''))||!id(request.id)||!text(request.text)||!['note','task','event'].includes(request.role))fail('INVALID_REQUEST');validMail(request.reference);if(request.event!==undefined)validEvent(request.event);if(request.reminderAt!==undefined&&!stamp(request.reminderAt))fail('INVALID_REQUEST');if(request.dueDate!==undefined&&!civil(request.dueDate))fail('INVALID_REQUEST');if(request.role==='event'&&!request.event)fail('INVALID_REQUEST');
  const before=await this.read();if(before.readOnly)fail('WORK_PROTECTED');if(before.revision!==request.revision)fail('WORK_CONFLICT');const next=structuredClone(before.document),now=this.now().toISOString();let item=next.items.find(item=>item.mailReference&&mailKey(item.mailReference)===mailKey(request.reference));const reused=!!item,original=item?JSON.stringify(item):null;
  if(!item){if(next.items.some(item=>item.id.toLowerCase()===request.id.toLowerCase()))fail('WORK_CONFLICT');item={id:request.id,text:request.text,isTask:request.role!=='note',done:false,createdAt:now,updatedAt:now,mailReference:structuredClone(request.reference)};if(request.role==='note')item.noteOrder=Math.max(-1,...next.items.filter(x=>x.noteOrder!==undefined).map(x=>x.noteOrder))+1;if(request.dueDate&&item.isTask)item.dueDate=request.dueDate;next.items.push(item);}
  else if(request.role==='note'){if(item.noteOrder===undefined)item.noteOrder=Math.max(-1,...next.items.filter(x=>x.noteOrder!==undefined).map(x=>x.noteOrder))+1;}else if(!item.isTask){item.isTask=true;if(item.dueDate===undefined&&request.dueDate)item.dueDate=request.dueDate;}
  if(request.event&&!item.event){item.event=structuredClone(request.event);item.isTask=true;}if(request.reminderAt&&!item.reminderAt&&item.isTask)item.reminderAt=request.reminderAt;
  if(reused&&JSON.stringify(item)===original)return{snapshot:this.public(before),itemId:item.id,reused:true};item.updatedAt=reused?new Date(Math.max(Date.parse(now),Date.parse(item.updatedAt)+1)).toISOString():now;next.version=Math.max(next.version,request.reference.provider==='qq'?3:2);return{snapshot:await this.commit(before,next),itemId:item.id,reused};
 });}
 captureStudy(request,finalPreflight){return this.locked(async()=>{
  exact(request,['revision','id','text','reference','asTask','dueDate']);if(!(request.revision===null||SHA.test(request.revision||''))||!id(request.id)||!text(request.text)||(request.asTask!==undefined&&typeof request.asTask!=='boolean')||(request.dueDate!==undefined&&(!request.asTask||!civil(request.dueDate))))fail('INVALID_REQUEST');validStudy(request.reference);const before=await this.read();if(before.readOnly)fail('WORK_PROTECTED');if(before.revision!==request.revision)fail('WORK_CONFLICT');if(!before.document.sources.some(source=>source.id===request.reference.sourceID))fail('WORK_STUDY_UNAVAILABLE');
  const annotationKey=r=>r?.wordAnnotation?JSON.stringify(['word',r.sourceID.toLowerCase(),r.path,r.wordAnnotation.part,r.wordAnnotation.kind,r.wordAnnotation.annotationID,r.wordAnnotation.fingerprint]):r?.pdfAnnotation?JSON.stringify([r.sourceID.toLowerCase(),r.path,r.page,r.pdfAnnotation.index,r.pdfAnnotation.fingerprint]):null,key=annotationKey(request.reference),existing=before.document.items.find(item=>key?annotationKey(item.studyReference)===key:item.id.toLowerCase()===request.id.toLowerCase());
  if(existing){if(!key){if(existing.text===request.text&&JSON.stringify(existing.studyReference)===JSON.stringify(request.reference))return{snapshot:this.public(before),itemId:existing.id};fail('WORK_CONFLICT');}
   if(finalPreflight)await finalPreflight();const annotationField=request.reference.wordAnnotation?'wordAnnotation':'pdfAnnotation',refreshed=existing.studyReference[annotationField].sourceSHA256!==request.reference[annotationField].sourceSHA256,upgrade=request.asTask&&!existing.isTask;if(refreshed||upgrade){const next=structuredClone(before.document),item=next.items.find(i=>i.id===existing.id);if(refreshed)item.studyReference[annotationField]=structuredClone(request.reference[annotationField]);if(upgrade){item.isTask=true;if(request.dueDate&&item.dueDate===undefined)item.dueDate=request.dueDate;}item.updatedAt=new Date(Math.max(this.now().getTime(),Date.parse(item.updatedAt)+1)).toISOString();next.version=Math.max(next.version,request.reference.wordAnnotation?5:4);return{snapshot:await this.commit(before,next,finalPreflight),itemId:item.id,reused:true};}
   return{snapshot:this.public(before),itemId:existing.id,reused:true};
  }
  if(before.document.items.some(item=>item.id.toLowerCase()===request.id.toLowerCase()))fail('WORK_CONFLICT');const next=structuredClone(before.document),now=this.now().toISOString();next.items.push({id:request.id,text:request.text,noteOrder:Math.max(-1,...next.items.filter(x=>x.noteOrder!==undefined).map(x=>x.noteOrder))+1,isTask:!!request.asTask,done:false,...(request.dueDate?{dueDate:request.dueDate}:{}),createdAt:now,updatedAt:now,studyReference:structuredClone(request.reference)});next.version=Math.max(next.version,request.reference.wordAnnotation?5:request.reference.pdfAnnotation?4:3);return{snapshot:await this.commit(before,next,finalPreflight),itemId:request.id,...(key?{reused:false}:{})};
 });}
 registeredSource(folder){return this.locked(async()=>{const value=await this.read();if(value.readOnly)fail('WORK_PROTECTED');const source=value.document.sources.find(source=>folderIdentity(source.folder)===folderIdentity(folder));if(!source)fail('WORK_STUDY_UNAVAILABLE');return structuredClone(source);});}
 register(folder,name){return this.locked(async()=>{
  if(!validFolder(folder)||!text(name,500))fail('INVALID_REQUEST');const before=await this.read();if(before.readOnly)fail('WORK_PROTECTED');const next=structuredClone(before.document);let source=next.sources.find(s=>folderIdentity(s.folder)===folderIdentity(folder));
  if(source){if(sameFolder(source.folder,folder)&&source.name===name)return{sourceId:source.id,snapshot:this.public(before)};source.folder={...folder};source.name=name;}
  else{source={id:crypto.randomUUID(),name,folder:{...folder},status:'cached',createdAt:this.now().toISOString(),documents:[]};next.sources.push(source);}
  return{sourceId:source.id,snapshot:await this.commit(before,next)};
 });}
 source(idValue){return this.locked(async()=>{if(!id(idValue))fail('INVALID_REQUEST');const loaded=await this.read();if(loaded.readOnly)fail('WORK_PROTECTED');const source=loaded.document.sources.find(s=>s.id===idValue);if(!source)fail('NOT_FOUND');return structuredClone(source);});}
 refreshSource(sourceId,folder,result){return this.locked(async()=>{
  const before=await this.read();if(before.readOnly)fail('WORK_PROTECTED');const next=structuredClone(before.document),source=next.sources.find(s=>s.id===sourceId);if(!source||!sameFolder(source.folder,folder))fail('WORK_CONFLICT');
  validateDocuments(result.documents);source.checkedAt=this.now().toISOString();if(result.unavailable){source.documents=source.documents.map(doc=>({...doc,available:false}));source.status='unavailable';source.issue='SOURCE_UNAVAILABLE';}
  else{const readPaths=new Set(result.documents.map(doc=>doc.path)),retained=source.documents.filter(doc=>!readPaths.has(doc.path)).map(doc=>({...doc,available:false}));source.documents=[...retained,...result.documents.map(doc=>({...doc,available:true}))];source.status=result.partial||retained.length?'partial':'ready';if(source.status==='partial')source.issue='SOURCE_PARTIAL';else delete source.issue;source.updatedAt=this.now().toISOString();}
  return this.commit(before,next);
 });}
}
module.exports={WorkSpaceStore,LIMITS,validateDocument,validateDocuments,civil,safePath,folderIdentity,sameFolder,validMail,validEvent,mailKey,validStudy};

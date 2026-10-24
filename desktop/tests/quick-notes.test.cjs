const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createChecklist,serializeChecklist,parseChecklist,updateTask}=require('../src/renderer/course-checklist.ts');
const {QUICK_NOTES_PATH,quickNoteLocalDate,newQuickNoteDraft,parseQuickNoteDraft,quickNoteDraftKey,quickNoteIsDirty,addQuickNote,editQuickNote,moveQuickNote,readQuickNotes,writeQuickNotes,recordQuickNote}=require('../src/renderer/quick-notes.ts');
const stamp=new Date('2026-10-23T18:30:00.000Z');
const note=text=>({...newQuickNoteDraft(),text});
const checklist=()=>createChecklist('Quick notes',undefined,stamp.toISOString());
const failure=code=>({ok:false,error:{code,message:code}});
function fakeIO(initial=null){
 let body=initial?serializeChecklist(initial):null,version=body?'v1':null,counter=1;
 const calls=[];
 const io={
  mode:'normal',calls,
  get body(){return body;},get sha(){return version;},
  external(doc){body=serializeChecklist(doc);version='v'+(++counter);},
  async readFile(request){calls.push(['read',request]);if(io.mode==='read-fail')return failure('UNAVAILABLE');return body===null?failure('NOT_FOUND'):{ok:true,value:{path:QUICK_NOTES_PATH,name:QUICK_NOTES_PATH,kind:'text',text:body,sha256:version,bytes:Buffer.byteLength(body)}};},
  async createTextFile(request){calls.push(['create',request]);if(body!==null)return failure('EXISTS');if(io.mode==='create-fail')return failure('DISK_FULL');body=request.content;version='v'+(++counter);if(io.mode==='uncertain-create'){io.mode='normal';return failure('UNKNOWN_WRITE_RESULT');}return {ok:true,value:{path:request.name,name:request.name,kind:'text',text:body,sha256:version,bytes:Buffer.byteLength(body),backupId:'create-backup'}};},
  async saveText(request){calls.push(['save',request]);if(request.expectedSHA256!==version||io.mode==='conflict')return failure('CONFLICT');if(io.mode==='save-fail')return failure('DISK_FULL');body=request.text;version='v'+(++counter);if(io.mode==='uncertain-save'){io.mode='normal';return failure('UNKNOWN_WRITE_RESULT');}return {ok:true,value:{sha256:version,backupId:'save-backup',bytes:Buffer.byteLength(body)}};}
 };return io;
}
test('default due day uses local calendar at midnight, across DST and UTC boundary',()=>{
 const previous=process.env.TZ;process.env.TZ='America/Toronto';
 try{
  assert.equal(quickNoteLocalDate(new Date('2026-10-24T03:59:59Z')),'2026-10-23');
  assert.equal(quickNoteLocalDate(new Date('2026-10-24T04:00:00Z')),'2026-10-24');
  assert.equal(quickNoteLocalDate(new Date('2026-03-08T06:59:59Z')),'2026-03-08');
  assert.equal(quickNoteLocalDate(new Date('2026-03-08T07:00:00Z')),'2026-03-08');
  assert.equal(quickNoteLocalDate(new Date('2026-11-01T05:30:00Z')),'2026-11-01');
  assert.equal(quickNoteLocalDate(new Date('2026-11-01T06:30:00Z')),'2026-11-01');
  const result=addQuickNote(checklist(),note('midnight note'),new Date('2026-10-24T03:59:59Z'));
  assert.equal(result.task.dueDate,'2026-10-23');assert.equal(result.task.quickNote.defaultDeadline,'end-of-local-day');
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('adding is one existing-contract task with origin metadata and full original text',()=>{
 const original=checklist(),draft=note('  important\nsecond line  '),before=serializeChecklist(original);
 const result=addQuickNote(original,draft,stamp);
 assert.equal(result.doc.tasks.length,1);assert.equal(result.task.text,draft.text);assert.equal(result.task.id,draft.id);
 assert.equal(result.task.quickNote.feature,'quick-notes');assert.equal(result.task.quickNote.requestId,draft.id);
 assert.equal(serializeChecklist(original),before);assert.equal(parseChecklist(serializeChecklist(result.doc)).tasks[0].text,draft.text);
});
test('array order supplies 1/2/3 order and moving keeps hidden archived items and unknown fields',()=>{
 let doc=checklist();doc.custom={keep:['unknown']};
 for(const text of ['a','hidden','b','c'])doc=addQuickNote(doc,note(text),stamp).doc;
 doc.tasks[1].archivedAt=stamp.toISOString();doc.tasks[2].extra={keep:true};
 const original=serializeChecklist(doc),visible=doc.tasks.filter(t=>!t.archivedAt).map(t=>t.id),next=moveQuickNote(doc,visible[2],-1,visible,stamp);
 assert.deepEqual(next.tasks.map(t=>t.text),['a','hidden','c','b']);
 assert.deepEqual(next.tasks.filter(t=>!t.archivedAt).map((t,i)=>[i+1,t.text]),[[1,'a'],[2,'c'],[3,'b']]);
 assert.deepEqual(next.custom,{keep:['unknown']});assert.deepEqual(next.tasks[3].extra,{keep:true});assert.equal(serializeChecklist(doc),original);
 assert.throws(()=>moveQuickNote(doc,visible[0],1,[visible[0],visible[0]],stamp),e=>e.code==='CONFLICT');
 assert.deepEqual(moveQuickNote(doc,visible[0],-1,visible,stamp),doc);
});
test('edit/complete/archive preserve the custom due date, origin and extension fields',()=>{
 let doc=addQuickNote(checklist(),note('old'),stamp).doc;doc.tasks[0].extra={retained:1};
 doc=updateTask(doc,doc.tasks[0].id,{dueDate:'2027-01-12'},{now:stamp.toISOString()});
 const next=editQuickNote(doc,{...note('new'),editingId:doc.tasks[0].id,baseText:'old'},stamp);
 const final=updateTask(updateTask(next,next.tasks[0].id,{done:true},{now:stamp.toISOString()}),next.tasks[0].id,{archived:true},{now:stamp.toISOString()});
 assert.equal(final.tasks[0].text,'new');assert.equal(final.tasks[0].dueDate,'2027-01-12');assert.equal(final.tasks[0].done,true);
 assert.equal(final.tasks[0].archivedAt,stamp.toISOString());assert.deepEqual(final.tasks[0].extra,{retained:1});assert.deepEqual(final.tasks[0].quickNote,doc.tasks[0].quickNote);
 assert.throws(()=>editQuickNote(doc,{...note('new'),editingId:doc.tasks[0].id,baseText:'different'},stamp),e=>e.code==='CONFLICT');
});
test('valid draft serialization keeps long text without truncation, editing base and vault separation',()=>{
 const draft={...note('x'.repeat(5000)),editingId:crypto.randomUUID(),baseText:'original'};
 assert.deepEqual(parseQuickNoteDraft(JSON.stringify(draft)),draft);assert.equal(quickNoteIsDirty(draft),true);
 assert.equal(quickNoteIsDirty({...draft,text:'original'}),false);assert.equal(quickNoteIsDirty(note('')),false);
 assert.notEqual(quickNoteDraftKey('vault-a'),quickNoteDraftKey('vault-b'));assert.equal(parseQuickNoteDraft(null),null);
 assert.throws(()=>parseQuickNoteDraft('{broken'));assert.throws(()=>parseQuickNoteDraft(JSON.stringify({...draft,schemaVersion:2})));
 assert.throws(()=>addQuickNote(checklist(),draft,stamp));assert.equal(draft.text.length,5000);
});
test('first record only creates in library root; later record CAS saves same file',async()=>{
 const io=fakeIO(),a=note('a'),first=await recordQuickNote(io,'v',a,stamp);
 assert.equal(io.calls.filter(c=>c[0]==='create').length,1);assert.equal(io.calls.filter(c=>c[0]==='save').length,0);
 assert.deepEqual(io.calls.find(c=>c[0]==='create')[1],{vaultId:'v',parentPath:'',name:QUICK_NOTES_PATH,content:serializeChecklist(first.snapshot.doc)});
 const previous=io.sha;await recordQuickNote(io,'v',note('b'),stamp);
 assert.equal(io.calls.filter(c=>c[0]==='create').length,1);assert.equal(io.calls.find(c=>c[0]==='save')[1].expectedSHA256,previous);
 assert.deepEqual(parseChecklist(io.body).tasks.map(t=>t.text),['a','b']);
});
test('uncertain first creation then retry reuses draft ID without duplicate or changing prior date',async()=>{
 const io=fakeIO(),draft=note('one');io.mode='uncertain-create';
 await assert.rejects(recordQuickNote(io,'v',draft,stamp),e=>e.code==='UNKNOWN_WRITE_RESULT');
 assert.equal(draft.text,'one');const retry=await recordQuickNote(io,'v',draft,new Date('2026-10-25T18:30:00Z'));
 assert.equal(retry.added,false);assert.equal(retry.snapshot.doc.tasks.length,1);assert.equal(retry.task.createdAt,stamp.toISOString());
 assert.equal(io.calls.filter(c=>c[0]==='create').length,1);assert.equal(io.calls.filter(c=>c[0]==='save').length,0);
});
test('uncertain append then retry stays single and retains all other tasks',async()=>{
 const io=fakeIO(addQuickNote(checklist(),note('original'),stamp).doc),draft=note('append');io.mode='uncertain-save';
 await assert.rejects(recordQuickNote(io,'v',draft,stamp));
 const result=await recordQuickNote(io,'v',draft,stamp);assert.equal(result.added,false);
 assert.deepEqual(result.snapshot.doc.tasks.map(t=>t.text),['original','append']);assert.equal(io.calls.filter(c=>c[0]==='save').length,1);
});
test('failed creation or append leaves both draft and prior file intact, with no automatic retry',async()=>{
 for(const mode of ['create-fail','save-fail','conflict']){
  const io=fakeIO(mode==='create-fail'?null:checklist()),draft=note('unsaved'),before=io.body,original=JSON.stringify(draft);io.mode=mode;
  await assert.rejects(recordQuickNote(io,'v',draft,stamp));assert.equal(io.body,before);assert.equal(JSON.stringify(draft),original);
  assert.equal(io.calls.filter(c=>c[0]==='save'||c[0]==='create').length,1);
 }
});
test('append reads fresh external content; existing edit/reorder use expected SHA and cannot overwrite changed data',async()=>{
 const io=fakeIO(addQuickNote(checklist(),note('a'),stamp).doc),before=await readQuickNotes(io,'v');
 const external=addQuickNote(before.doc,note('external'),stamp).doc;io.external(external);
 await assert.rejects(writeQuickNotes(io,'v',moveQuickNote(before.doc,before.doc.tasks[0].id,-1,[before.doc.tasks[0].id],stamp),before),e=>e.code==='CONFLICT');
 const result=await recordQuickNote(io,'v',note('new'),stamp);assert.deepEqual(result.snapshot.doc.tasks.map(t=>t.text),['a','external','new']);
});
test('already recorded text edited elsewhere refuses destructive retry while retaining draft',()=>{
 const draft=note('one'),result=addQuickNote(checklist(),draft,stamp),changed=updateTask(result.doc,draft.id,{text:'external edit'},{now:stamp.toISOString()});
 assert.throws(()=>addQuickNote(changed,draft,stamp),e=>e.code==='ALREADY_RECORDED');assert.equal(draft.text,'one');assert.equal(changed.tasks[0].text,'external edit');
});
test('unavailable or invalid existing file never becomes a new empty checklist',async()=>{
 const io=fakeIO();io.mode='read-fail';await assert.rejects(recordQuickNote(io,'v',note('kept'),stamp));assert.equal(io.calls.filter(c=>c[0]==='create').length,0);
 const corrupt={...fakeIO(),async readFile(){return {ok:true,value:{text:'{broken',sha256:'original'}};}};
 await assert.rejects(recordQuickNote(corrupt,'v',note('kept'),stamp));assert.equal(corrupt.calls.length,0);
});

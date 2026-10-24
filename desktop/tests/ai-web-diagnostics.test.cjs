'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Diagnostics,aiWebStage}=require('../src/main/diagnostics.cjs');

const base={provider:'chatgpt',phase:'status',state:'ready'};
async function temporary(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-ai-web-diagnostics-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}

test('AI web lifecycle diagnostics accept only the published non-content contract',()=>{
 const value={...base,webContentsId:7,mainFrame:true,inPlace:false,shown:true,x:-120,y:350,width:640,height:900,errorCode:-105,reason:'unknown',popups:0,navigations:2,loads:3,pageRevision:2,loadGeneration:1,attached:true,topmost:true,windowVisible:true,windowMinimized:false,windowFocused:true,contentFocused:false,backgroundThrottling:false,readyState:'complete',visibilityState:'visible',assistantNodes:4,visibleAssistantNodes:2,bodyChildren:15};
 assert.deepEqual(aiWebStage(value),value);
 for(const provider of ['chatgpt','deepseek','claude','gemini'])assert.equal(aiWebStage({...base,provider}).provider,provider);
 for(const phase of ['created','navigation','load','visibility','popup','closed','crashed','unresponsive','responsive','status','page'])assert.equal(aiWebStage({...base,phase}).phase,phase);
 for(const state of ['idle','loading','ready','failed','closed','crashed','hidden','visible'])assert.equal(aiWebStage({...base,state}).state,state);
 for(const reason of ['crashed','oom','killed','clean-exit','abnormal-exit','launch-failed','integrity-failure','unknown'])assert.equal(aiWebStage({...base,reason}).reason,reason);
 for(const readyState of ['loading','interactive','complete'])assert.equal(aiWebStage({...base,readyState}).readyState,readyState);
 for(const visibilityState of ['visible','hidden'])assert.equal(aiWebStage({...base,visibilityState}).visibilityState,visibilityState);
});

test('unknown and private fields reject the entire AI stage instead of retaining or silently trimming them',()=>{
 for(const key of ['url','URL','origin','title','text','html','HTML','message','prompt','answer','cookie','token','nonce','selector','path','file','dataURL','at','extra'])assert.equal(aiWebStage({...base,[key]:'PRIVATE_CONTENT'}),null,key);
 for(const value of [null,undefined,[],new Date(),Object.create({provider:'chatgpt'}),'PRIVATE_CONTENT'])assert.equal(aiWebStage(value),null);
 assert.equal(aiWebStage({...base,[Symbol('private')]:'PRIVATE_CONTENT'}),null);
 const value={...base};let invoked=false;Object.defineProperty(value,'title',{get(){invoked=true;return 'PRIVATE_CONTENT';}});
 assert.equal(aiWebStage(value),null);assert.equal(invoked,false);
 const enumGetter={phase:'status',state:'ready'};Object.defineProperty(enumGetter,'provider',{get(){invoked=true;return 'chatgpt';}});
 assert.equal(aiWebStage(enumGetter),null);assert.equal(invoked,false);
});

test('invalid enums, absent required values and coercible types are rejected',()=>{
 for(const key of ['provider','phase','state']){const value={...base};delete value[key];assert.equal(aiWebStage(value),null);assert.equal(aiWebStage({...base,[key]:'PRIVATE_CONTENT'}),null);}
 for(const key of ['mainFrame','inPlace','shown','attached','topmost','windowVisible','windowMinimized','windowFocused','contentFocused','backgroundThrottling','generating']){
  for(const value of [true,false])assert.equal(aiWebStage({...base,[key]:value})[key],value);
  for(const value of ['true','false',1,0,null,undefined])assert.equal(aiWebStage({...base,[key]:value}),null);
 }
 for(const key of ['reason','readyState','visibilityState'])for(const value of [null,1,'PRIVATE_CONTENT',undefined])assert.equal(aiWebStage({...base,[key]:value}),null);
});

test('integer ranges bound dimensions, counters, IDs and error codes without accepting strings or nonfinite values',()=>{
 const ranges={webContentsId:[1,Number.MAX_SAFE_INTEGER],x:[-50000,50000],y:[-50000,50000],width:[0,50000],height:[0,50000],errorCode:[-2147483648,2147483647],popups:[0,1000000],navigations:[0,1000000],loads:[0,1000000],pageRevision:[0,1000000],loadGeneration:[0,1000000],assistantNodes:[0,1000000],visibleAssistantNodes:[0,1000000],bodyChildren:[0,1000000],userNodes:[0,1000000]};
 for(const [key,[minimum,maximum]]of Object.entries(ranges)){
  assert.equal(aiWebStage({...base,[key]:minimum})[key],minimum);assert.equal(aiWebStage({...base,[key]:maximum})[key],maximum);
  for(const value of [minimum-1,maximum+1,0.5,NaN,Infinity,'1',null,undefined])assert.equal(aiWebStage({...base,[key]:value}),null,`${key}: ${value}`);
 }
 assert.equal(aiWebStage({...base,assistantNodes:2,visibleAssistantNodes:3}),null);
});

test('recordAIWebStage adds its own timestamp, returns acceptance and exposes independent copies',()=>{
 const diagnostics=new Diagnostics('/unused');let persists=0;diagnostics.persist=()=>{persists++;};
 const value={...base,width:640};assert.equal(diagnostics.recordAIWebStage(value),true);value.width=999;
 const first=diagnostics.get();assert.match(first.aiWebStages[0].at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);assert.equal(first.aiWebStages[0].width,640);
 first.aiWebStages[0].width=1;first.aiWebStages.length=0;assert.equal(diagnostics.get().aiWebStages[0].width,640);
 assert.equal(diagnostics.recordAIWebStage({...base,text:'PRIVATE_CONTENT'}),false);assert.equal(persists,1);
});

test('AI lifecycle history stays bounded to the most recent 40 valid stages',()=>{
 const diagnostics=new Diagnostics('/unused');diagnostics.persist=()=>{};
 for(let i=0;i<55;i++)assert.equal(diagnostics.recordAIWebStage({...base,phase:'navigation',navigations:i}),true);
 for(let i=0;i<20;i++)assert.equal(diagnostics.recordAIWebStage({...base,url:'PRIVATE_CONTENT'}),false);
 const stages=diagnostics.get().aiWebStages;assert.equal(stages.length,40);assert.equal(stages[0].navigations,15);assert.equal(stages.at(-1).navigations,54);
});

test('polling identical status does not persist again, even across other events or providers',()=>{
 const diagnostics=new Diagnostics('/unused');let persists=0;diagnostics.persist=()=>{persists++;};
 assert.equal(diagnostics.recordAIWebStage({...base,shown:true}),true);
 for(let i=0;i<20;i++)assert.equal(diagnostics.recordAIWebStage({state:'ready',shown:true,phase:'status',provider:'chatgpt'}),false);
 assert.equal(diagnostics.recordAIWebStage({...base,phase:'popup'}),true);
 assert.equal(diagnostics.recordAIWebStage({...base,provider:'claude',shown:true}),true);
 assert.equal(diagnostics.recordAIWebStage({...base,shown:true}),false);
 assert.equal(diagnostics.recordAIWebStage({...base,state:'failed',shown:true}),true);
 assert.equal(diagnostics.recordAIWebStage({...base,shown:true}),true);
 assert.equal(persists,5);
});

test('duplicate consecutive lifecycle signals are coalesced without hiding subsequent transitions',()=>{
 const diagnostics=new Diagnostics('/unused');let persists=0;diagnostics.persist=()=>{persists++;};
 const value={...base,phase:'load',state:'loading'};
 assert.equal(diagnostics.recordAIWebStage(value),true);assert.equal(diagnostics.recordAIWebStage(value),false);
 assert.equal(diagnostics.recordAIWebStage({...value,state:'ready'}),true);assert.equal(diagnostics.recordAIWebStage(value),true);assert.equal(persists,3);
});

test('AI stages persist, reload and coexist with existing error and OCR diagnostics',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory);
 diagnostics.record('ai_web_load',{code:'NETWORK_ERROR'});diagnostics.recordOCRStage({phase:'recognition',status:'recognized',durationMs:24,boxes:3});
 diagnostics.recordAIWebStage({...base,phase:'crashed',state:'crashed',reason:'oom',webContentsId:9});await diagnostics.settled();
 const disk=JSON.parse(await fs.readFile(diagnostics.file,'utf8'));assert.equal(disk.schemaVersion,1);assert.equal(disk.aiWebStages.length,1);assert.equal((await fs.stat(diagnostics.file)).mode&0o777,0o600);
 const loaded=new Diagnostics(directory);await loaded.load();assert.deepEqual(loaded.get(),diagnostics.get());assert.equal(loaded.get().storageIssue,false);
});

test('loading accepts older diagnostic files without an AI history',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory);
 await fs.writeFile(diagnostics.file,JSON.stringify({schemaVersion:1,events:[],ocrStages:[]}));await diagnostics.load();
 assert.deepEqual(diagnostics.get().aiWebStages,[]);assert.equal(diagnostics.get().storageIssue,false);
});

test('loading validates private fields and bounds again rather than trusting a stored AI stage',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory),at=new Date().toISOString();
 const aiWebStages=Array.from({length:48},(_,navigations)=>({at,...base,navigations}));
 aiWebStages.push({at,...base,url:'PRIVATE_CONTENT'},{at:'not a timestamp',...base},{at,...base,assistantNodes:1000001},{at,...base,reason:'PRIVATE_CONTENT'});
 await fs.writeFile(diagnostics.file,JSON.stringify({schemaVersion:1,events:[],ocrStages:[],aiWebStages}));await diagnostics.load();
 const loaded=diagnostics.get().aiWebStages;assert.equal(loaded.length,36);assert.equal(loaded[0].navigations,12);assert.equal(loaded.at(-1).navigations,47);assert.equal(JSON.stringify(diagnostics.get()).includes('PRIVATE_CONTENT'),false);
 diagnostics.recordAIWebStage({...base,phase:'visibility',state:'hidden'});await diagnostics.settled();assert.equal((await fs.readFile(diagnostics.file,'utf8')).includes('PRIVATE_CONTENT'),false);
});

test('unchanged loaded status also avoids a write on the next process poll',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory);
 diagnostics.recordAIWebStage(base);await diagnostics.settled();
 const loaded=new Diagnostics(directory);await loaded.load();let persists=0;loaded.persist=()=>{persists++;};
 assert.equal(loaded.recordAIWebStage({...base,phase:'popup'}),true);assert.equal(loaded.recordAIWebStage(base),false);assert.equal(persists,1);
});

test('stored timestamps accept only generated ISO dates and cannot carry private strings',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory),at=new Date().toISOString();
 const aiWebStages=[{at,...base},...['October 16, 2026 (PRIVATE_CONTENT)','2026-02-30T00:00:00.000Z','2026-10-16T00:00:00.000Z (PRIVATE_CONTENT)'].map(at=>({at,...base}))];
 await fs.writeFile(diagnostics.file,JSON.stringify({schemaVersion:1,events:[],ocrStages:[],aiWebStages}));await diagnostics.load();
 assert.deepEqual(diagnostics.get().aiWebStages,[{at,...base}]);
});

test('fresh page samples persist native geometry and exact boolean flags without permitting content fields',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory);
 const page={...base,phase:'page',x:-50000,y:50000,pageRevision:1000000,loadGeneration:0,attached:true,topmost:false,windowVisible:true,windowMinimized:false,windowFocused:false,contentFocused:true,backgroundThrottling:false,readyState:'complete',visibilityState:'hidden',assistantNodes:2,visibleAssistantNodes:0};
 assert.equal(diagnostics.recordAIWebStage(page),true);
 for(const key of ['url','message','answer','html','text'])assert.equal(diagnostics.recordAIWebStage({...page,[key]:'PRIVATE_CONTENT'}),false);
 await diagnostics.settled();
 const loaded=new Diagnostics(directory);await loaded.load();const stage=loaded.get().aiWebStages[0];const {at,...data}=stage;
 assert.deepEqual(data,page);assert.equal(JSON.stringify(loaded.get()).includes('PRIVATE_CONTENT'),false);
 for(const key of ['x','pageRevision','attached','backgroundThrottling','generating']){
  let invoked=false;const getter={...base,phase:'page'};Object.defineProperty(getter,key,{enumerable:true,get(){invoked=true;return key==='attached';}});
  assert.equal(aiWebStage(getter),null);assert.equal(invoked,false);
 }
});

test('loading rejects out-of-bounds native coordinates, revisions and nonboolean page flags',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory),at=new Date().toISOString();
 const valid={at,...base,phase:'page',x:0,y:-50000,pageRevision:0,loadGeneration:1000000,attached:false,backgroundThrottling:true};
 const bad=[{x:-50001},{y:50001},{pageRevision:-1},{loadGeneration:1000001},{topmost:'false'},{windowVisible:1},{windowMinimized:null},{windowFocused:0},{contentFocused:'true'},{backgroundThrottling:'false'},{answer:'PRIVATE_CONTENT'}];
 await fs.writeFile(diagnostics.file,JSON.stringify({schemaVersion:1,events:[],ocrStages:[],aiWebStages:[valid,...bad.map(extra=>({...valid,...extra}))]}));
 await diagnostics.load();assert.deepEqual(diagnostics.get().aiWebStages,[valid]);assert.equal(diagnostics.get().storageIssue,false);
});


test('page polling preserves lifecycle history by coalescing unchanged structural samples across status events and restart',async t=>{
 const directory=await temporary(t),diagnostics=new Diagnostics(directory),page={...base,phase:'page',userNodes:7,assistantNodes:6,visibleAssistantNodes:6,generating:true};
 assert.equal(diagnostics.recordAIWebStage(page),true);
 for(let n=0;n<20;n++){diagnostics.recordAIWebStage({...base,width:500+n});assert.equal(diagnostics.recordAIWebStage(page),false);}
 assert.equal(diagnostics.get().aiWebStages.filter(v=>v.phase==='page').length,1);
 assert.equal(diagnostics.recordAIWebStage({...page,assistantNodes:7,visibleAssistantNodes:7,generating:false}),true);await diagnostics.settled();
 const loaded=new Diagnostics(directory);await loaded.load();assert.equal(loaded.recordAIWebStage({...page,assistantNodes:7,visibleAssistantNodes:7,generating:false}),false);
 assert.equal(loaded.recordAIWebStage({...page,assistantNodes:6}),true);await loaded.settled();
});

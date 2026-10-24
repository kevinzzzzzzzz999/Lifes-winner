'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {registerAIMicrophoneOwner,hasMacMicrophoneUsage,MICROPHONE_USAGE_DESCRIPTION}=require('../src/main/ai-media-permissions.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
function fixture(t,{session,systemPreferences,provider='chatgpt'}={}){
 const origin={chatgpt:'https://chatgpt.com',claude:'https://claude.ai',gemini:'https://gemini.google.com',deepseek:'https://chat.deepseek.com'}[provider];
 session??={setPermissionRequestHandler(fn){this.request=fn;},setPermissionCheckHandler(fn){this.check=fn;}};
 const contents=new EventEmitter(),window=new EventEmitter();contents.session=session;contents.destroyed=false;contents.url=origin+'/c/synthetic';contents.isDestroyed=()=>contents.destroyed;contents.getURL=()=>contents.url;window.isDestroyed=()=>false;
 const state={active:true,revision:1,os:'not-determined',configuration:true,answer:1,dialogCalls:0,systemCalls:0,statusCalls:0,status:[],dialogHook:null};
 const preferences=systemPreferences||{getMediaAccessStatus(type){assert.equal(type,'microphone');state.statusCalls++;return state.os;},async askForMediaAccess(type){assert.equal(type,'microphone');state.systemCalls++;state.os='granted';return true;}};
 const dispose=registerAIMicrophoneOwner({session,contents,window,provider,label:provider,app:{getLocale:()=> 'zh-CN'},dialog:{async showMessageBox(owner,options){assert.equal(owner,window);state.dialogCalls++;assert(!JSON.stringify(options).includes(contents.url));return state.dialogHook?state.dialogHook():{response:state.answer};}},systemPreferences:preferences,isActive:()=>state.active,revision:()=>state.revision,onStatus:value=>state.status.push(value),platform:'darwin',configurationReady:()=>state.configuration});t.after(dispose);
 const details={requestingUrl:contents.url,securityOrigin:origin,isMainFrame:true,mediaTypes:['audio']};
 const request=(changes={},permission='media',requester=contents)=>new Promise(resolve=>session.request(requester,permission,resolve,{...details,...changes}));
 const check=(changes={},permission='media',requester=contents,requestOrigin=origin)=>session.check(requester,permission,requestOrigin,{...details,mediaType:'audio',...changes});
 return{session,contents,window,state,details,request,check,dispose,preferences};
}

test('registering and checking audio permission never proactively prompts or records',async t=>{
 const f=fixture(t);assert.equal(f.check(),false);assert.equal(f.state.dialogCalls,0);assert.equal(f.state.systemCalls,0);assert.deepEqual(f.state.status,[]);
});
test('an exact active provider audio request asks once and reuses explicit runtime consent',async t=>{
 const f=fixture(t);assert.equal(await f.request(),true);assert.equal(f.state.dialogCalls,1);assert.equal(f.state.systemCalls,1);assert.equal(f.check(),true);
 assert.equal(await f.request(),true);assert.equal(f.state.dialogCalls,1);assert.equal(f.state.systemCalls,1);assert.equal(f.state.status.at(-1),'granted');
});
test('already granted macOS permission still requires explicit provider confirmation once',async t=>{
 const f=fixture(t);f.state.os='granted';assert.equal(f.check(),false);assert.equal(await f.request(),true);assert.equal(f.state.dialogCalls,1);assert.equal(f.state.systemCalls,0);
});
test('camera, mixed capture, unknown media and unrelated permissions never prompt or pass',async t=>{
 const f=fixture(t);
 for(const mediaTypes of [undefined,[],['video'],['audio','video'],['audio','audio'],['unknown']])assert.equal(await f.request({mediaTypes}),false);
 for(const permission of ['display-capture','speaker-selection','clipboard-read','notifications','mediaKeySystem','unknown'])assert.equal(await f.request({},permission),false);
 for(const mediaType of ['video','unknown',undefined])assert.equal(f.check({mediaType}),false);
 assert.equal(f.state.dialogCalls,0);assert.equal(f.state.systemCalls,0);
});
test('subframes, missing frame metadata and mismatched origins cannot obtain permission',async t=>{
 const f=fixture(t);
 for(const change of [{isMainFrame:false},{isMainFrame:undefined},{requestingUrl:undefined},{requestingUrl:'https://evil.example/'},{securityOrigin:'https://evil.example'},{embeddingOrigin:'https://evil.example'},{requestingUrl:'https://user:pass@chatgpt.com/'},{requestingUrl:'http://chatgpt.com/'}]){assert.equal(await f.request(change),false);assert.equal(f.check(change),false);}
 assert.equal(f.check({},'media',f.contents,'https://evil.example'),false);assert.equal(await f.request({},'media',null),false);assert.equal(f.state.dialogCalls,0);
});
test('hidden, retired, non-provider and disposed owners never prompt or inherit access',async t=>{
 const f=fixture(t);assert.equal(await f.request(),true);f.state.active=false;assert.equal(await f.request(),false);assert.equal(f.check(),false);
 f.state.active=true;f.contents.url='https://auth.openai.com/authorize';assert.equal(await f.request(),false);f.contents.url=f.details.requestingUrl;f.dispose();assert.equal(await f.request(),false);assert.equal(f.check(),false);assert.equal(f.state.dialogCalls,1);
});
test('system denied and restricted states return usable enums without repeated OS prompts',async t=>{
 for(const osState of ['denied','restricted']){const f=fixture(t);f.state.os=osState;for(let i=0;i<3;i++)assert.equal(await f.request(),false);assert.equal(f.state.systemCalls,0);assert.equal(f.state.dialogCalls,0);assert.equal(f.state.status.at(-1),osState==='denied'?'system-denied':'system-restricted');}
});
test('user declining the provider confirmation never invokes system authorization',async t=>{
 const f=fixture(t);f.state.answer=0;assert.equal(await f.request(),false);assert.equal(f.state.systemCalls,0);assert.equal(f.check(),false);assert.equal(f.state.status.at(-1),'cancelled');
});
test('permission is revalidated after the app confirmation and after the system prompt',async t=>{
 for(const boundary of ['app','system'])for(const change of ['hidden','navigation','destroyed']){
  const gate=deferred();let f;
  const prefs={getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:()=>gate.promise};
  f=fixture(t,{...(boundary==='system'?{systemPreferences:prefs}:{})});if(boundary==='app')f.state.dialogHook=()=>gate.promise;
  const pending=f.request();await tick();if(change==='hidden')f.state.active=false;else if(change==='navigation')f.state.revision++;else{f.contents.destroyed=true;f.contents.emit('destroyed');}
  gate.resolve(boundary==='app'?{response:1}:true);assert.equal(await pending,false);assert.equal(f.check(),false);
 }
});
test('duplicate concurrent requests do not multiply native confirmations',async t=>{
 const f=fixture(t),gate=deferred();f.state.dialogHook=()=>gate.promise;const first=f.request();assert.equal(await f.request(),false);assert.equal(f.state.dialogCalls,1);gate.resolve({response:1});assert.equal(await first,true);
});
test('shared session routing identifies the exact requesting view and keeps consent local',async t=>{
 const first=fixture(t),second=fixture(t,{session:first.session});assert.equal(await first.request(),true);assert.equal(second.check(),false);assert.equal(await second.request(),true);assert.equal(second.state.dialogCalls,1);first.dispose();assert.equal(await first.request(),false);assert.equal(second.check(),true);
});
test('simultaneous authorized views share one in-flight macOS prompt but retain separate consent',async t=>{
 const gate=deferred();let os='not-determined',calls=0;
 const preferences={getMediaAccessStatus:()=>os,askForMediaAccess(){calls++;return gate.promise;}};
 const first=fixture(t,{systemPreferences:preferences}),second=fixture(t,{session:first.session,systemPreferences:preferences});
 const a=first.request(),b=second.request();await tick();assert.equal(calls,1);assert.equal(first.state.dialogCalls,1);assert.equal(second.state.dialogCalls,1);os='granted';gate.resolve(true);assert.equal(await a,true);assert.equal(await b,true);
});
test('system rejection, missing usage metadata and unavailable APIs fail closed',async t=>{
 const no=fixture(t,{systemPreferences:{getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:async()=>false}});assert.equal(await no.request(),false);assert.equal(no.state.status.at(-1),'system-denied');
 const broken=fixture(t,{systemPreferences:{getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:async()=>{throw Error('private error');}}});assert.equal(await broken.request(),false);assert.equal(broken.state.status.at(-1),'unavailable');assert(!JSON.stringify(broken.state.status).includes('private'));
 const missing=fixture(t);missing.state.configuration=false;assert.equal(await missing.request(),false);assert.equal(missing.state.dialogCalls,0);assert.equal(missing.state.systemCalls,0);assert.equal(missing.state.status.at(-1),'unavailable');
});
test('revoking macOS permission overrides an earlier explicit provider grant',async t=>{
 const f=fixture(t);assert.equal(await f.request(),true);f.state.os='denied';assert.equal(f.check(),false);assert.equal(await f.request(),false);assert.equal(f.state.dialogCalls,1);assert.equal(f.state.systemCalls,1);
});
test('macOS package privacy configuration supplies only the requested microphone purpose',async()=>{
 const {macInfoPlist}=require('../scripts/packaging/macos-privacy.cjs');assert.deepEqual(Object.keys(macInfoPlist),['NSMicrophoneUsageDescription']);assert.equal(macInfoPlist.NSMicrophoneUsageDescription,MICROPHONE_USAGE_DESCRIPTION);assert(MICROPHONE_USAGE_DESCRIPTION.includes('语音'));assert(MICROPHONE_USAGE_DESCRIPTION.includes('听写'));
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-microphone-plist-'));try{const contents=path.join(temporary,'Sample.app/Contents');await fs.mkdir(path.join(contents,'MacOS'),{recursive:true});const executable=path.join(contents,'MacOS/Sample');assert.equal(hasMacMicrophoneUsage(executable),false);await fs.writeFile(path.join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>NSMicrophoneUsageDescription</key><string>Voice and dictation</string></dict></plist>');assert.equal(hasMacMicrophoneUsage(executable),true);}finally{await fs.rm(temporary,{recursive:true,force:true});}
});

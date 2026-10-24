'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{createRequire}=require('node:module'),{createHash}=require('node:crypto');
const {createPNGDragCache,composerScripts,clipboardHasPNG,imageFingerprint}=require('../src/main/ai-image-transfer.cjs');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=','base64');
const OTHER=Buffer.concat([PNG,Buffer.from('different fixture pixels')]);
const dataURL=bytes=>'data:image/png;base64,'+bytes.toString('base64');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
class Image{
 constructor(bytes){this.bytes=bytes;}
 isEmpty(){return !this.bytes?.length;}
 getSize(){return{width:1,height:1};}
 toPNG(){return this.bytes;}
 toBitmap(){return Buffer.from(this.bytes.equals(PNG)||this.bytes.equals(Buffer.concat([PNG,Buffer.from('reencoded')]))?[0,0,0,255]:[1,1,1,255]);}
 resize(){return this;}
}
const nativeImage={createFromDataURL:value=>new Image(Buffer.from(value.split(',')[1]||'','base64')),createFromBuffer:value=>new Image(value)};
class ClipboardItem{
 constructor(data){this.data=data;this.types=Object.keys(data);}
 async getType(type){if(!this.types.includes(type))throw Error('not present');return this.data[type];}
}
async function harness(t,{provider='chatgpt',packaged=true,qaURL,loadHook,now}={}){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-transfer77-test-'));t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
 const created=[],sessions=new Map(),writes=[],dragged=[],externalURLs=[],diagnostics=[],stages=[];
 const state={clipboard:[],writeHook:null,readHook:null,externalHook:null,writeCount:0,readCount:0,mediaConfirmations:0,mediaOSRequests:0};
 class Contents extends EventEmitter{
  constructor(){super();this.destroyed=false;this.url='';this.scripts=[];this.pastes=0;this.images=[];this.focused=false;this.rejectPaste=false;this.scriptHook=null;this.resetDocument();}
  resetDocument(){const document={},contents=this;const form={querySelectorAll:()=>contents.images.map((_,index)=>({getClientRects:()=>[{}],getAttribute:name=>name==='src'?'blob:image-'+index:null,tagName:'IMG'}))};const el={tagName:'TEXTAREA',isConnected:true,getAttribute:()=>null,matches:()=>false,querySelectorAll:()=>[],getClientRects:()=>this.hiddenComposer?[]:[{}],focus:()=>{document.activeElement=el;},contains:value=>value===el,closest:selector=>selector==='form'?form:null};document.querySelector=selector=>selector==='#prompt-textarea'?el:null;document.querySelectorAll=selector=>selector==='#prompt-textarea'?[el]:[];this.document=document;}
  isDestroyed(){return this.destroyed;}isLoading(){return false;}getURL(){return this.url;}
  setBackgroundThrottling(value){this.backgroundThrottling=value;}getBackgroundThrottling(){return this.backgroundThrottling;}
  async loadURL(url){this.url=url;this.loadCount=(this.loadCount||0)+1;if(loadHook)return loadHook(this,url);this.emit('did-finish-load');}reload(){this.reloadCount=(this.reloadCount||0)+1;this.emit('did-start-navigation',{},this.url,false,true);this.resetDocument();}
  invalidate(){this.repaints=(this.repaints||0)+1;}setWindowOpenHandler(handler){this.popup=handler;}close(){this.destroyed=true;this.emit('destroyed');}
  focus(){this.focusRequests=(this.focusRequests||0)+1;this.focused=true;this.emit('focus');}isFocused(){return this.focused;}
  async executeJavaScript(script){this.scripts.push(script);if(this.scriptHook)await this.scriptHook(script);return vm.runInNewContext(script,{URL,location:{href:this.url,origin:new URL(this.url).origin},document:this.document,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})});}
  paste(){this.pastes++;if(!this.rejectPaste)this.images.push(state.clipboard[0]?.data['image/png']);}
 }
 class View{
  constructor(options){this.options=options;this.webContents=new Contents();this.webContents.session=options.webPreferences.session;created.push(this);}
  setBackgroundColor(){}setVisible(value){(this.visibilityChanges||(this.visibilityChanges=[])).push(value);this.visible=value;if(!value&&this.webContents.focused){this.webContents.focused=false;this.webContents.emit('blur');}}setBounds(value){this.bounds=value;}getBounds(){return this.bounds;}getVisible(){return this.visible;}
 }
 const electron={WebContentsView:View,nativeImage,ClipboardItem,dialog:{async showMessageBox(){state.mediaConfirmations++;return{response:1};}},systemPreferences:{getMediaAccessStatus:()=> 'granted',async askForMediaAccess(){state.mediaOSRequests++;return true;}},shell:{openExternal(url){externalURLs.push(url);return state.externalHook?state.externalHook(url):Promise.resolve();}},clipboard:{
  async write(items){writes.push(items);state.clipboard=items;state.writeCount++;if(state.writeHook)await state.writeHook(state.writeCount);},
  async read(){state.readCount++;if(state.readHook)await state.readHook(state.readCount);return state.clipboard;}
 },session:{fromPartition(partition){if(!sessions.has(partition)){const s=new EventEmitter();s.setPermissionRequestHandler=fn=>s.permissions=fn;s.setPermissionCheckHandler=fn=>s.check=fn;s.webRequest={onBeforeRequest:fn=>s.request=fn};sessions.set(partition,s);}return sessions.get(partition);}}};
 const file=path.resolve(__dirname,'../src/main/ai-panel.cjs'),req=createRequire(file),mod={exports:{}};
 vm.runInNewContext('(function(require,module,exports,process,URL,Blob,setTimeout,clearTimeout){'+await fs.readFile(file,'utf8')+'\n})',{Buffer,...(now?{Date:class extends Date{static now(){return now();}}}:{})})(name=>name==='electron'?electron:req(name),mod,mod.exports,{env:{INKSPACE_QA_AI_URL:qaURL}},URL,Blob,(callback,delay)=>delay<=25?setTimeout(callback,delay):queueMicrotask(callback),clearTimeout);
 function makeWindow(){const win=new EventEmitter();win.destroyed=false;win.focused=false;win.webContents={getZoomFactor:()=>1,isDestroyed:()=>win.destroyed,send:()=>{},startDrag:item=>dragged.push(item)};win.contentView={children:[],addChildView(view){this.children=this.children.filter(child=>child!==view);this.children.push(view);},removeChildView(view){this.children=this.children.filter(child=>child!==view);}};win.isDestroyed=()=>win.destroyed;win.isFocused=()=>win.focused;win.isVisible=()=>true;win.isMinimized=()=>false;win.getContentBounds=()=>({width:1200,height:900});win.focus=()=>{win.focusRequests=(win.focusRequests||0)+1;win.focused=true;win.emit('focus');};return win;}
 let current=makeWindow();const win=current,app={isPackaged:packaged,getPath:()=>temporary},handlers=new Map();
 const panel=mod.exports.createAIPanel({app,getWindow:()=>current,handler:(name,action)=>handlers.set(name,action),initialProvider:provider,diagnostics:{record:(...args)=>diagnostics.push(args),recordAIWebStage:stage=>stages.push(stage)}});
 t.after(()=>panel.close());
 return{mod:mod.exports,app,win,makeWindow,panel,created,sessions,writes,dragged,externalURLs,state,temporary,diagnostics,stages,
 call:(name,arg)=>handlers.get(name)(arg),show:()=>handlers.get('aiSetVisible')({visible:true,bounds:{x:700,y:100,width:400,height:650}}),replaceWindow:()=>{current=makeWindow();},replaceClipboard:bytes=>{state.clipboard=[new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})];}};
}
function paste(h,bytes=PNG,extra={}){return h.call('aiPasteImage',{provider:'chatgpt',dataURL:dataURL(bytes),...extra});}

test('native trusted paste delivers only the validated PNG and observes an attachment without sending',async t=>{
 const h=await harness(t);await h.show();const result=await paste(h),c=h.created[0].webContents;
 assert.equal(result.pasteAttempted,true);assert.equal(result.attachmentConfirmed,true);assert.equal(c.pastes,1);
 assert.deepEqual(Buffer.from(await c.images[0].arrayBuffer()),PNG);assert.equal(h.state.readCount,1);
 assert(c.scripts.every(script=>!script.includes('dispatchEvent')&&!script.includes('.click(')&&!script.includes('.submit(')&&!script.includes('innerText')));
});
test('explicit copy never creates a view, reads the clipboard, or focuses an AI page',async t=>{
 const h=await harness(t),r=await paste(h,PNG,{copyOnly:true});assert.equal(r.copied,true);assert.equal(r.pasteAttempted,false);assert.equal(h.created.length,0);assert.equal(h.state.readCount,0);assert.equal(h.win.focused,false);
});
test('manual providers retain copy-only behavior without composer inspection',async t=>{
 for(const provider of ['deepseek','claude','gemini']){const h=await harness(t,{provider});await h.show();const r=await h.call('aiPasteImage',{provider,dataURL:dataURL(PNG)});assert.equal(r.pasteAttempted,false);assert.equal(h.created[0].webContents.scripts.length,0);assert.equal(h.state.readCount,0);}
});
test('stale provider requests fail before changing the clipboard',async t=>{
 const h=await harness(t,{provider:'claude'});await assert.rejects(paste(h),{code:'CANCELLED'});assert.equal(h.writes.length,0);
});
test('the exact selected official origin is required; login and lookalike origins get copy only',async t=>{
 for(const url of ['https://auth.openai.com/','https://chatgpt.com.evil.test/','https://evil.chatgpt.com/','https://chatgpt.com:8443/','https://user@chatgpt.com/']){const h=await harness(t);await h.show();h.created[0].webContents.url=url;assert.equal((await paste(h)).pasteAttempted,false);assert.equal(h.created[0].webContents.scripts.length,0);}
});
test('a changed clipboard PNG, unrelated text, or unreadable clipboard cancels native paste',async t=>{
 for(const replacement of ['image','text','failure']){const h=await harness(t);await h.show();h.state.readHook=()=>{if(replacement==='failure')throw Error('clipboard inaccessible');if(replacement==='image')h.replaceClipboard(OTHER);else h.state.clipboard=[new ClipboardItem({'text/plain':new Blob(['private unrelated text'])})];};const r=await paste(h);assert.equal(r.pasteAttempted,false);assert.equal(h.created[0].webContents.pastes,0);}
});
test('a lossless PNG re-encoding with identical pixels passes canonical image hash validation',async t=>{
 const h=await harness(t);await h.show();h.state.readHook=()=>h.replaceClipboard(Buffer.concat([PNG,Buffer.from('reencoded')]));assert.equal((await paste(h)).attachmentConfirmed,true);
});
test('provider switching away and back during clipboard work invalidates delivery',async t=>{
 const h=await harness(t);await h.show();h.state.writeHook=count=>{if(count===2){h.panel.selectProvider('claude');h.panel.selectProvider('chatgpt');}};assert.equal((await paste(h)).pasteAttempted,false);assert.equal(h.created[0].webContents.pastes,0);
});
test('hiding and showing the AI panel during readback invalidates delivery',async t=>{
 const h=await harness(t);await h.show();h.state.readHook=async()=>{await h.call('aiSetVisible',{visible:false});await h.show();};assert.equal((await paste(h)).pasteAttempted,false);assert.equal(h.created[0].webContents.pastes,0);
});
test('same-origin navigation, same-URL reload, owner replacement, and closing cancel pending delivery',async t=>{
 for(const change of ['conversation','reload','window','close']){const h=await harness(t);await h.show();const c=h.created[0].webContents;h.state.readHook=()=>{if(change==='conversation'){c.url='https://chatgpt.com/c/new';c.emit('did-start-navigation',{},c.url,true,true);}else if(change==='reload')c.reload();else if(change==='window')h.replaceWindow();else h.panel.close();};assert.equal((await paste(h)).pasteAttempted,false);assert.equal(c.pastes,0);}
});
test('changing document nonce while final verification is queued prevents native paste',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.scriptHook=script=>{if(script.includes('inkspace-ai-image-verify'))c.resetDocument();};assert.equal((await paste(h)).pasteAttempted,false);assert.equal(c.pastes,0);
});
test('a hidden composer or focus moving away during clipboard verification prevents native paste',async t=>{
 for(const hidden of [true,false]){const h=await harness(t);await h.show();const c=h.created[0].webContents;if(hidden)c.hiddenComposer=true;else h.state.readHook=()=>{c.focused=false;};assert.equal((await paste(h)).pasteAttempted,false);assert.equal(c.pastes,0);}
});
test('a hash-only in-page navigation retains the same composer document',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;h.state.writeHook=count=>{if(count===2){c.url='https://chatgpt.com/#composer';c.emit('did-start-navigation',{},c.url,true,true);}};assert.equal((await paste(h)).attachmentConfirmed,true);
});
test('a newer explicit copy invalidates an earlier pending paste in the same workspace',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents,gate=deferred();let once=true;c.scriptHook=async script=>{if(once&&script.includes('inkspace-ai-image-focus')){once=false;await gate.promise;}};const first=paste(h);await tick();await paste(h,OTHER,{copyOnly:true});gate.resolve();assert.equal((await first).pasteAttempted,false);assert.equal(c.pastes,0);
});
test('different workspaces deliver their own PNG bytes even if composer focus resolves out of order',async t=>{
 const h=await harness(t);await h.show();const other=h.makeWindow(),ops=new Map();h.mod.createAIPanel({app:h.app,getWindow:()=>other,handler:(n,f)=>ops.set(n,f)});await ops.get('aiSetVisible')({visible:true,bounds:{x:700,y:100,width:400,height:650}});const a=h.created[0].webContents,b=h.created[1].webContents,gate=deferred();let once=true;a.scriptHook=async script=>{if(once&&script.includes('inkspace-ai-image-focus')){once=false;await gate.promise;}};const first=paste(h);await tick();assert.equal((await ops.get('aiPasteImage')({provider:'chatgpt',dataURL:dataURL(OTHER)})).attachmentConfirmed,true);gate.resolve();assert.equal((await first).attachmentConfirmed,true);assert.deepEqual(Buffer.from(await a.images[0].arrayBuffer()),PNG);assert.deepEqual(Buffer.from(await b.images[0].arrayBuffer()),OTHER);
});
test('an unchanged composer is unconfirmed even when native paste was attempted',async t=>{
 const h=await harness(t);await h.show();h.created[0].webContents.rejectPaste=true;const r=await paste(h);assert.equal(r.pasteAttempted,true);assert.equal(r.attachmentConfirmed,false);assert.equal(h.created[0].webContents.images.length,0);
});
test('remote views retain sandboxing, denied permissions, no preload bridge and restricted navigations',async t=>{
 const h=await harness(t);await h.show();const v=h.created[0],p=v.options.webPreferences;assert.equal(p.preload,undefined);assert.equal(p.sandbox,true);assert.equal(p.nodeIntegration,false);assert.equal(p.contextIsolation,true);assert.equal(p.webSecurity,true);assert.equal(p.allowRunningInsecureContent,false);assert.equal(h.sessions.get('persist:inkspace-chatgpt').check(),false);let prevented=false;v.webContents.emit('will-navigate',{preventDefault:()=>{prevented=true;}},'file:///secret');assert.equal(prevented,true);assert.equal(v.webContents.popup({url:'javascript:alert(1)'}).action,'deny');
});
test('loopback QA origin works only in development and cannot redirect a packaged adapter',async t=>{
 const h=await harness(t,{packaged:false,qaURL:'http://127.0.0.1:5432/fixture'});await h.show();assert.equal((await paste(h)).attachmentConfirmed,true);const p=await harness(t,{qaURL:'http://127.0.0.1:5432/fixture'});await p.show();assert.equal(p.created[0].webContents.getURL(),'https://chatgpt.com/');
});
test('native dragging exposes a private PNG file to the OS, never a text URL or arbitrary path',async t=>{
 const h=await harness(t);await h.show();const r=await h.call('aiDragImage',{provider:'chatgpt',dataURL:dataURL(PNG)});assert.equal(r.dragStarted,true);assert.equal(h.dragged.length,1);const item=h.dragged[0];assert.equal(path.extname(item.file),'.png');assert.equal(path.basename(path.dirname(item.file)).startsWith('inkspace-ai-capture-'),true);assert.deepEqual(await fs.readFile(item.file),PNG);assert.equal((await fs.stat(item.file)).mode&0o077,0);assert.equal((await fs.stat(path.dirname(item.file))).mode&0o077,0);assert(item.icon instanceof Image);assert.equal(h.state.readCount,0);
});
test('stale or hidden-provider drag requests cannot start a native drag',async t=>{
 const h=await harness(t);await h.show();await assert.rejects(h.call('aiDragImage',{provider:'claude',dataURL:dataURL(PNG)}),{code:'CANCELLED'});await h.call('aiSetVisible',{visible:false});await assert.rejects(h.call('aiDragImage',{provider:'chatgpt',dataURL:dataURL(PNG)}),{code:'CANCELLED'});assert.equal(h.dragged.length,0);
});
test('drag cache is bounded and close removes only files and directory created by this cache',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-transfer-cache77-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const marker=path.join(dir,'keep.txt');await fs.writeFile(marker,'user content');const cache=createPNGDragCache({temporaryDirectory:()=>dir,maxFiles:2});const files=[];for(let i=0;i<3;i++)files.push(await cache.create(PNG,()=>true));await assert.rejects(fs.stat(files[0]),{code:'ENOENT'});assert.equal((await fs.readdir(path.dirname(files[1]))).length,2);await cache.close();await assert.rejects(fs.stat(path.dirname(files[1])),{code:'ENOENT'});assert.equal(await fs.readFile(marker,'utf8'),'user content');await assert.rejects(cache.create(PNG,()=>true),{code:'CANCELLED'});
});
test('close or ownership cancellation during asynchronous drag preparation leaves no orphan image',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-transfer-cancel77-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const cache=createPNGDragCache({temporaryDirectory:()=>dir});let current=true;const pending=cache.create(PNG,()=>current);current=false;await assert.rejects(pending,{code:'CANCELLED'});await cache.close();assert.deepEqual(await fs.readdir(dir),[]);
});
test('readback rejects multiple clipboard items and oversized blobs without reading their bytes',async()=>{
 let touched=false;const expected=imageFingerprint(new Image(PNG));const item={types:['image/png'],getType:async()=>({size:25*1024*1024,arrayBuffer:async()=>{touched=true;return PNG;}})};assert.equal(await clipboardHasPNG({read:async()=>[item]},nativeImage,expected,()=>true),false);assert.equal(await clipboardHasPNG({read:async()=>[item,item]},nativeImage,expected,()=>true),false);assert.equal(touched,false);
});
test('composer scripts never contain image bytes, submit actions, arbitrary selectors or conversation text',()=>{
 const scripts=composerScripts({origin:'https://chatgpt.com',pageURL:'https://chatgpt.com/c/test',nonce:'test-nonce'});for(const script of Object.values(scripts)){assert(!script.includes('dispatchEvent'));assert(!script.includes('atob('));assert(!script.includes('.submit('));assert(!script.includes('.click('));assert(!script.includes('innerText'));assert(script.includes('https://chatgpt.com'));}
});

test('diagnostics distinguish unsupported adapters from an intentional successful copy',async t=>{
 const h=await harness(t,{provider:'claude'});await h.show();const r=await h.call('aiPasteImage',{provider:'claude',dataURL:dataURL(PNG)});assert.equal(r.reason,'unsupported');assert.equal(r.copied,true);const copy=await h.call('aiPasteImage',{provider:'claude',dataURL:dataURL(PNG),copyOnly:true});assert.equal(Object.hasOwn(copy,'reason'),false);assert.equal(copy.copied,true);
});
test('diagnostics distinguish an absent or hidden native AI view',async t=>{
 const h=await harness(t);assert.equal((await paste(h)).reason,'notVisible');await h.show();await h.call('aiSetVisible',{visible:false});assert.equal((await paste(h)).reason,'notVisible');
});
test('diagnostics distinguish a changed provider during clipboard work',async t=>{
 const h=await harness(t);await h.show();h.state.writeHook=count=>{if(count===2)h.panel.selectProvider('claude');};const r=await paste(h);assert.equal(r.reason,'providerChanged');assert.equal(r.pasteAttempted,false);
});
test('diagnostics distinguish cancelled operations from provider changes',async t=>{
 const h=await harness(t);await h.show();h.state.writeHook=async count=>{if(count===2){await h.call('aiSetVisible',{visible:false});await h.show();}};const r=await paste(h);assert.equal(r.reason,'cancelled');assert.equal(r.pasteAttempted,false);
});
test('diagnostics distinguish navigation and stale document nonce without disclosing URLs',async t=>{
 for(const nonce of [false,true]){const h=await harness(t);await h.show();const c=h.created[0].webContents;if(nonce)c.scriptHook=script=>{if(script.includes('inkspace-ai-image-verify'))c.resetDocument();};else c.url='https://auth.openai.com/';const r=await paste(h);assert.equal(r.reason,'navigation');assert.equal(JSON.stringify(r).includes('https:'),false);}
});
test('diagnostics distinguish a missing or hidden composer from failed focus',async t=>{
 const h=await harness(t);await h.show();h.created[0].webContents.hiddenComposer=true;const r=await paste(h);assert.equal(r.reason,'composerMissing');assert.equal(r.pasteAttempted,false);
});
test('diagnostics distinguish DOM composer focus rejection or page script failure',async t=>{
 for(const scriptError of [false,true]){const h=await harness(t);await h.show();const c=h.created[0].webContents;if(scriptError)c.scriptHook=()=>{throw Error('private page detail must not leak');};else c.document.querySelector('#prompt-textarea').focus=()=>{};const r=await paste(h);assert.equal(r.reason,'composerFocus');assert.equal(JSON.stringify(r).includes('private'),false);assert.equal(r.pasteAttempted,false);}
});
test('diagnostics distinguish loss of native child-view focus from DOM focus',async t=>{
 const h=await harness(t);await h.show();h.state.readHook=()=>{h.created[0].webContents.focused=false;};const r=await paste(h);assert.equal(r.reason,'nativeFocus');assert.equal(r.pasteAttempted,false);
});
test('diagnostics distinguish PNG verification and write failures without claiming a successful copy',async t=>{
 const h=await harness(t);await h.show();h.state.readHook=()=>h.replaceClipboard(OTHER);const r=await paste(h);assert.equal(r.reason,'clipboardMismatch');assert.equal(r.copied,true);assert.equal(r.pasteAttempted,false);
 const writeFailure=await harness(t);await writeFailure.show();writeFailure.state.writeHook=()=>{throw Error('private clipboard detail must not leak');};const failed=await paste(writeFailure);assert.equal(failed.reason,'clipboardMismatch');assert.equal(failed.copied,false);assert.equal(JSON.stringify(failed).includes('private'),false);
});
test('diagnostics distinguish the native paste command throwing from an unconfirmed attachment',async t=>{
 const h=await harness(t);await h.show();h.created[0].webContents.paste=()=>{throw Error('private native detail');};const failed=await paste(h);assert.equal(failed.reason,'pasteFailed');assert.equal(failed.pasteAttempted,false);
 const unconfirmed=await harness(t);await unconfirmed.show();unconfirmed.created[0].webContents.rejectPaste=true;const pending=await paste(unconfirmed);assert.equal(pending.pasteAttempted,true);assert.equal(pending.attachmentConfirmed,false);assert.equal(Object.hasOwn(pending,'reason'),false);
});
test('diagnostic payloads contain only the existing booleans and an allowlisted reason code',async t=>{
 const allowed=['unsupported','providerChanged','notVisible','navigation','composerMissing','composerFocus','nativeFocus','clipboardMismatch','pasteFailed','cancelled'];
 const h=await harness(t);await h.show();h.created[0].webContents.hiddenComposer=true;const r=await paste(h);assert.deepEqual(Object.keys(r).sort(),['attachmentConfirmed','copied','pasteAttempted','reason']);assert(allowed.includes(r.reason));assert.equal(typeof r.copied,'boolean');assert.equal(typeof r.pasteAttempted,'boolean');assert.equal(typeof r.attachmentConfirmed,'boolean');
 const successful=await harness(t);await successful.show();assert.equal(Object.hasOwn(await paste(successful),'reason'),false);
});

// These fixtures execute composerScripts themselves in a VM against a small
// structural DOM. Queries match CSS tags/ids/attributes and traverse actual
// parent/child trees; no executeJavaScript result is stubbed for these cases.
function domFixture(specs,{url='https://chatgpt.com/c/fixture'}={}){
 const document={roots:[],activeElement:null};
 const split=selector=>selector.split(',').map(value=>value.trim());
 function matches(node,selector){
  if(selector===':disabled')return !!node.disabled||!!node.closest('fieldset[disabled]');
  let rest=selector;const tag=rest.match(/^[A-Za-z][\w-]*/);if(tag){if(node.tagName!==tag[0].toUpperCase())return false;rest=rest.slice(tag[0].length);}
  const id=rest.match(/^#([\w-]+)/);if(id){if(node.getAttribute('id')!==id[1])return false;rest=rest.slice(id[0].length);}
  while(rest){const attribute=rest.match(/^\[([\w-]+)(?:(\*=|\^=|=)(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/);if(!attribute)throw Error('Unsupported fixture selector: '+selector);const actual=node.getAttribute(attribute[1]),wanted=attribute[3]??attribute[4]??attribute[5];if(actual===null)return false;if(attribute[2]==='='&&actual!==wanted)return false;if(attribute[2]==='*='&&!actual.includes(wanted))return false;if(attribute[2]==='^='&&!actual.startsWith(wanted))return false;rest=rest.slice(attribute[0].length);}
  return true;
 }
 class Element{
  constructor(spec){this.tagName=(spec.tag||'div').toUpperCase();this.attributes={...(spec.attrs||{})};this.styles={...(spec.style||{})};this.children=[];this.parentElement=null;this.blockFocus=false;for(const child of spec.children||[])this.append(new Element(child));}
  get disabled(){return Object.hasOwn(this.attributes,'disabled');}get readOnly(){return Object.hasOwn(this.attributes,'readonly');}get hidden(){return Object.hasOwn(this.attributes,'hidden');}
  get isContentEditable(){const value=this.getAttribute('contenteditable');if(value==='true'||value==='plaintext-only')return true;if(value==='false')return false;return !!this.parentElement?.isContentEditable;}
  get isConnected(){let root=this;while(root.parentElement)root=root.parentElement;return document.roots.includes(root);}
  getAttribute(name){return Object.hasOwn(this.attributes,name)?String(this.attributes[name]):null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  append(child){if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(value=>value!==child);child.parentElement=this;this.children.push(child);return child;}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(value=>value!==this);this.parentElement=null;}else document.roots=document.roots.filter(value=>value!==this);}
  descendants(){return this.children.flatMap(child=>[child,...child.descendants()]);}
  querySelectorAll(selector){return this.descendants().filter(node=>split(selector).some(part=>matches(node,part)));}
  matches(selector){return split(selector).some(part=>matches(this,part));}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  contains(target){for(let node=target;node;node=node.parentElement)if(node===this)return true;return false;}
  getClientRects(){for(let node=this;node;node=node.parentElement)if(node.hidden||node.styles.display==='none')return [];return[{x:0,y:0,width:200,height:80}];}
  focus(){if(!this.blockFocus&&!this.disabled&&this.isConnected)document.activeElement=this;}
 }
 document.roots=specs.map(spec=>new Element(spec));
 document.querySelectorAll=selector=>document.roots.flatMap(root=>[root,...root.descendants()]).filter(node=>split(selector).some(part=>matches(node,part)));
 document.querySelector=selector=>document.querySelectorAll(selector)[0]||null;
 const location={href:url,origin:new URL(url).origin};
 return{document,location,Element,run:script=>vm.runInNewContext(script,{URL,location,document,getComputedStyle:node=>({display:'block',visibility:'visible',opacity:'1',...node.styles})})};
}
function directScripts(nonce='dom-fixture-nonce'){return composerScripts({origin:'https://chatgpt.com',pageURL:'https://chatgpt.com/c/fixture',nonce});}
function normalized(value){return JSON.parse(JSON.stringify(value));}

test('actual composer scripts accept the legacy textarea id and bind its element with nonce',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{id:'prompt-textarea'}}]}]),scripts=directScripts(),el=dom.document.querySelector('#prompt-textarea');
 assert.deepEqual(normalized(dom.run(scripts.focus)),{ready:true});assert.equal(dom.document[Symbol.for('inkspace.aiImagePaste')].element,el);assert.equal(dom.document[Symbol.for('inkspace.aiImagePaste')].nonce,'dom-fixture-nonce');assert.deepEqual(normalized(dom.run(scripts.verify)),{ready:true});assert.equal(dom.document.activeElement,el);
});
test('actual composer scripts accept an editable node nested inside the legacy id wrapper',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'div',attrs:{id:'prompt-textarea'},children:[{tag:'div',attrs:{contenteditable:'true'}}]}]}]),scripts=directScripts();assert.equal(dom.run(scripts.focus).ready,true);assert.equal(dom.document[Symbol.for('inkspace.aiImagePaste')].element.tagName,'DIV');assert.equal(dom.run(scripts.verify).ready,true);
});
test('actual composer scripts accept the exact Ask ChatGPT placeholder and deduplicate the same aria-labelled node',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT','aria-label':'Ask ChatGPT'}}]}]),scripts=directScripts();assert.equal(dom.run(scripts.focus).ready,true);assert.equal(dom.run(scripts.verify).ready,true);
});
test('actual composer scripts accept exact accessible labels on textarea or contenteditable nodes',()=>{
 for(const spec of [{tag:'textarea',attrs:{'aria-label':'Ask ChatGPT'}},{tag:'div',attrs:{contenteditable:'true','aria-label':'Ask ChatGPT'}},{tag:'div',attrs:{contenteditable:'true','data-placeholder':'Ask ChatGPT'}},{tag:'textarea',attrs:{placeholder:'向 ChatGPT 发送消息'}},{tag:'div',attrs:{contenteditable:'true','aria-label':'询问 ChatGPT'}}]){const dom=domFixture([{tag:'form',children:[spec]}]),scripts=directScripts();assert.equal(dom.run(scripts.focus).ready,true);assert.equal(dom.run(scripts.verify).ready,true);}
});
test('actual composer scripts ignore a hidden legacy id and bind the unique visible new textarea',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{id:'prompt-textarea',hidden:''}},{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]),scripts=directScripts();assert.equal(dom.run(scripts.focus).ready,true);assert.equal(dom.document[Symbol.for('inkspace.aiImagePaste')].element.getAttribute('placeholder'),'Ask ChatGPT');assert.equal(dom.run(scripts.verify).ready,true);
});
test('actual composer scripts refuse ambiguous visible matches even when one has the legacy id',()=>{
 for(const children of [[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}},{tag:'div',attrs:{contenteditable:'true','aria-label':'Ask ChatGPT'}}],[{tag:'textarea',attrs:{id:'prompt-textarea'}},{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]]){const dom=domFixture([{tag:'form',children}]);assert.deepEqual(normalized(dom.run(directScripts().focus)),{ready:false,reason:'composerMissing'});assert.equal(dom.document.activeElement,null);}
});
test('actual composer scripts reject disabled, readonly, aria-disabled, aria-readonly and inert targets',()=>{
 for(const attrs of [{disabled:''},{readonly:''},{'aria-disabled':'true'},{'aria-readonly':'true'},{inert:''}]){const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT',...attrs}}]}]);assert.equal(dom.run(directScripts().focus).reason,'composerMissing');}
 const fieldset=domFixture([{tag:'form',children:[{tag:'fieldset',attrs:{disabled:''},children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]}]);assert.equal(fieldset.run(directScripts().focus).reason,'composerMissing');
});
test('actual composer scripts reject hidden ancestors and targets with invisible computed style',()=>{
 for(const style of [{display:'none'},{visibility:'hidden'},{opacity:'0'}]){const dom=domFixture([{tag:'form',children:[{tag:'div',style,children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]}]);assert.equal(dom.run(directScripts().focus).reason,'composerMissing');}
 const ariaHidden=domFixture([{tag:'form',children:[{tag:'div',attrs:{'aria-hidden':'true'},children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]}]);assert.equal(ariaHidden.run(directScripts().focus).reason,'composerMissing');
});
test('actual composer scripts never fall back to arbitrary textareas, search boxes or partial labels',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'textarea'},{tag:'input',attrs:{placeholder:'Ask ChatGPT'}},{tag:'textarea',attrs:{placeholder:'Ask ChatGPT something'}},{tag:'div',attrs:{contenteditable:'true','aria-label':'Search conversations'}}]}]);assert.equal(dom.run(directScripts().focus).reason,'composerMissing');assert.equal(dom.document.activeElement,null);
});
test('actual composer verification refuses a same-URL replacement node rather than selecting the new input',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]),scripts=directScripts(),old=dom.document.querySelector('textarea');assert.equal(dom.run(scripts.focus).ready,true);old.remove();dom.document.querySelector('form').append(new dom.Element({tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}));assert.equal(old.isConnected,false);assert.equal(dom.run(scripts.verify).reason,'composerFocus');assert.deepEqual(normalized(dom.run(scripts.attachments)),[]);
});
test('actual composer verification rejects nonce changes, route changes and hostile origins',()=>{
 for(const change of ['nonce','route','origin']){const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]),scripts=directScripts();assert.equal(dom.run(scripts.focus).ready,true);if(change==='nonce')dom.document[Symbol.for('inkspace.aiImagePaste')].nonce='new-request';else if(change==='route')dom.location.href='https://chatgpt.com/c/another';else{dom.location.href='https://evil.chatgpt.com/c/fixture';dom.location.origin='https://evil.chatgpt.com';}assert.equal(dom.run(scripts.verify).reason,'navigation');assert.deepEqual(normalized(dom.run(scripts.attachments)),[]);}
});
test('actual composer verification permits a same-page hash but rejects becoming ambiguous or readonly',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]),scripts=directScripts();assert.equal(dom.run(scripts.focus).ready,true);dom.location.href+=''+ '#same-composer';assert.equal(dom.run(scripts.verify).ready,true);dom.document.querySelector('form').append(new dom.Element({tag:'textarea',attrs:{'aria-label':'Ask ChatGPT'}}));assert.equal(dom.run(scripts.verify).reason,'composerMissing');
 const readOnly=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]);assert.equal(readOnly.run(scripts.focus).ready,true);readOnly.document.querySelector('textarea').setAttribute('readonly','');assert.equal(readOnly.run(scripts.verify).reason,'composerMissing');
});
test('actual attachment inspection follows the bound modern composer form rather than a fixed id or unrelated form',()=>{
 const dom=domFixture([{tag:'form',attrs:{id:'target'},children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]},{tag:'form',attrs:{id:'unrelated'},children:[{tag:'img',attrs:{src:'blob:unrelated','data-testid':'file-thumbnail-other'}}]}]),scripts=directScripts();assert.equal(dom.run(scripts.focus).ready,true);assert.deepEqual(normalized(dom.run(scripts.attachments)),[]);dom.document.querySelector('#target').append(new dom.Element({tag:'img',attrs:{src:'blob:current-capture','data-testid':'file-thumbnail-current'}}));assert.deepEqual(normalized(dom.run(scripts.attachments)),['blob:current-capture']);
});
test('actual script diagnostics never expose DOM text, labels, URLs, nonce, or selected element references',()=>{
 const dom=domFixture([{tag:'form',children:[{tag:'textarea',attrs:{placeholder:'Ask ChatGPT'}}]}]),scripts=directScripts('private-nonce');const ready=normalized(dom.run(scripts.focus));assert.deepEqual(Object.keys(ready),['ready']);dom.document.querySelector('textarea').blockFocus=true;dom.document.activeElement=null;const failure=normalized(dom.run(scripts.verify));assert.deepEqual(failure,{ready:false,reason:'composerFocus'});assert(!JSON.stringify(failure).includes('private'));assert(!JSON.stringify(failure).includes('ChatGPT'));assert(!JSON.stringify(failure).includes('https:'));
});

test('native focus confirmation waits for a delayed child acknowledgment and requests focus only once',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.focus=function(){this.focusRequests=(this.focusRequests||0)+1;setTimeout(()=>{if(!this.destroyed){this.focused=true;this.emit('focus');}},45);};const started=Date.now(),r=await paste(h);assert.equal(r.attachmentConfirmed,true);assert(Date.now()-started>=30);assert.equal(c.focusRequests,1);assert.equal(h.win.focusRequests,1);assert.equal(c.listenerCount('focus'),0);assert.equal(c.listenerCount('blur'),0);assert.equal(h.win.listenerCount('focus'),1);
});
test('native focus confirmation also waits for the parent window acknowledgment without refocusing',async t=>{
 const h=await harness(t);await h.show();h.win.focus=()=>{h.win.focusRequests=(h.win.focusRequests||0)+1;setTimeout(()=>{h.win.focused=true;h.win.emit('focus');},35);};const r=await paste(h);assert.equal(r.attachmentConfirmed,true);assert.equal(h.win.focusRequests,1);assert.equal(h.created[0].webContents.focusRequests,1);
});
test('native bounds refresh never hides the current view or interrupts pending focus acknowledgment',async t=>{
 const h=await harness(t);await h.show();const view=h.created[0],c=view.webContents;c.focus=function(){this.focusRequests=(this.focusRequests||0)+1;setTimeout(()=>{if(!this.destroyed){this.focused=true;this.emit('focus');}},65);};const pending=paste(h);setTimeout(()=>{void h.call('aiSetVisible',{visible:true,bounds:{x:701,y:101,width:399,height:649}});},15);setTimeout(()=>{void h.call('aiSetVisible',{visible:true,bounds:{x:700,y:100,width:400,height:648}});},30);assert.equal((await pending).attachmentConfirmed,true);assert.deepEqual(view.visibilityChanges,[false,true]);assert.equal(c.focusRequests,1);assert.equal(c.focused,true);
});
test('ordinary status/layout bounds updates retain an already focused current provider view',async t=>{
 const h=await harness(t);await h.show();const view=h.created[0];view.webContents.focus();await h.call('aiSetVisible',{visible:true,bounds:{x:700,y:100,width:400,height:620}});await h.call('aiSetVisible',{visible:true,bounds:{x:700,y:100,width:400,height:630}});assert.equal(view.webContents.isFocused(),true);assert.deepEqual(view.visibilityChanges,[false,true]);h.panel.selectProvider('claude');assert.equal(view.visible,false);assert.deepEqual(view.visibilityChanges,[false,true,false]);
});
test('user leaving during pending focus aborts without a second focus request or later paste',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.focus=function(){this.focusRequests=(this.focusRequests||0)+1;};const pending=paste(h);setTimeout(()=>{h.win.focused=false;h.win.emit('blur');},20);const r=await pending;assert.equal(r.reason,'nativeFocus');assert.equal(r.pasteAttempted,false);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(c.focusRequests,1);assert.equal(h.win.focusRequests,1);assert.equal(c.pastes,0);assert.equal(h.win.focused,false);assert.equal(c.listenerCount('blur'),0);
});
test('native focus confirmation has a short upper bound when the OS never acknowledges focus',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.focus=function(){this.focusRequests=(this.focusRequests||0)+1;};const started=Date.now(),r=await paste(h),elapsed=Date.now()-started;assert.equal(r.reason,'nativeFocus');assert(elapsed>=250&&elapsed<1500,'focus wait '+elapsed+' ms');assert.equal(c.focusRequests,1);assert.equal(c.pastes,0);assert.equal(c.listenerCount('focus'),0);
});
test('navigation, hide, provider changes and newer copies cancel focus waits before native paste',async t=>{
 for(const change of ['navigation','hide','provider','copy']){const h=await harness(t);await h.show();const c=h.created[0].webContents;c.focus=function(){this.focusRequests=(this.focusRequests||0)+1;};const pending=paste(h);setTimeout(()=>{if(change==='navigation'){c.url='https://chatgpt.com/c/new-route';c.emit('did-start-navigation',{},c.url,true,true);}else if(change==='hide')void h.call('aiSetVisible',{visible:false});else if(change==='provider')h.panel.selectProvider('claude');else void paste(h,OTHER,{copyOnly:true});},15);const r=await pending;assert.equal(r.reason,{navigation:'navigation',hide:'notVisible',provider:'providerChanged',copy:'cancelled'}[change]);assert.equal(r.pasteAttempted,false);assert.equal(c.pastes,0);assert.equal(c.focusRequests,1);assert.equal(c.listenerCount('focus'),0);}
});


test('AI pages keep background execution enabled without weakening their sandbox',async t=>{
 const h=await harness(t);await h.show();const p=h.created[0].options.webPreferences;
 assert.equal(p.backgroundThrottling,false);assert.equal(p.sandbox,true);assert.equal(p.nodeIntegration,false);assert.equal(p.webSecurity,true);
});
test('streamed page state survives repeated layout, collapse, and provider round trips without reload',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 c.streamedMessages=[{id:'synthetic-1',chunks:8,completed:true}];
 for(let i=0;i<8;i++)await h.call('aiSetVisible',{visible:true,bounds:{x:700,y:100,width:400-i,height:650}});
 await h.call('aiSetVisible',{visible:false});await h.show();h.panel.selectProvider('claude');h.panel.selectProvider('chatgpt');
 assert.equal(h.created.length,2);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert.equal(c.streamedMessages[0].completed,true);assert.equal(c.streamedMessages[0].chunks,8);
});
test('destroyed AI pages report an error instead of falsely claiming the empty panel is healthy',async t=>{
 const h=await harness(t);await h.show();h.created[0].webContents.close();const status=await h.call('aiStatus');
 assert.equal(status.loadError,true);assert.equal(status.loading,false);assert.equal(status.pageState,'closed');
});
test('explicit recovery rebuilds a destroyed page at its last conversation rather than its home',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 c.url='https://chatgpt.com/c/synthetic-conversation';c.emit('did-start-navigation',{url:c.url,isMainFrame:true,isSameDocument:true});c.close();
 await h.call('aiReload');const next=h.created[1].webContents;assert.equal(next.url,c.url);assert.equal(next.loadCount,1);assert.equal(next.pastes,0);assert.equal((await h.call('aiStatus')).loadError,false);
});
test('crashed AI pages remain identifiable until an explicit reload, and restore their ready state',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.emit('render-process-gone',{}, {reason:'oom'});
 const crashed=await h.call('aiStatus');assert.equal(crashed.pageState,'crashed');assert.equal(crashed.loadError,true);assert.equal(c.reloadCount||0,0);
 await h.call('aiReload');assert.equal(c.reloadCount,1);c.emit('did-finish-load');assert.equal((await h.call('aiStatus')).pageState,'ready');
});
test('navigation gates accept modern Electron event details and still reject local files',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;let blocked=false;
 c.emit('will-navigate',{url:'https://chatgpt.com/c/synthetic',preventDefault(){blocked=true;}});assert.equal(blocked,false);
 c.emit('will-redirect',{url:'file:///private-note',preventDefault(){blocked=true;}});assert.equal(blocked,true);
});
test('modern same-document navigation invalidates pending image delivery without reloading the page',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 h.state.readHook=()=>c.emit('did-start-navigation',{url:'https://chatgpt.com/c/synthetic-new',isMainFrame:true,isSameDocument:true});
 assert.equal((await paste(h)).reason,'navigation');assert.equal(c.reloadCount||0,0);assert.equal(c.pastes,0);
});
test('status polling never navigates or focuses and samples only non-content structural counts',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;for(let i=0;i<10;i++)assert.equal((await h.call('aiStatus')).pageState,'ready');
 assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert.equal(c.scripts.length,1);assert(!c.scripts[0].includes('innerText'));assert(!c.scripts[0].includes('body.textContent'));assert(!c.scripts[0].includes('document.textContent'));assert(!c.scripts[0].includes('innerHTML'));assert(!c.scripts[0].includes('.click('));assert.equal(c.focusRequests||0,0);
});
test('subframe failures and cancelled main-frame navigation do not discard a healthy conversation',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 c.emit('did-fail-load',{},-105,'private error','https://private/path',false);c.emit('did-fail-load',{},-3,'private error','https://private/path',true);
 assert.equal((await h.call('aiStatus')).loadError,false);assert.equal(c.reloadCount||0,0);assert.equal(h.diagnostics.length,0);
});

test('a synchronous reload error retains failure state instead of hanging in healthy loading',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.emit('render-process-gone',{}, {reason:'oom'});c.reload=()=>{throw Error('private details');};
 await assert.rejects(h.call('aiReload'),{code:'NETWORK_ERROR'});const state=await h.call('aiStatus');assert.equal(state.pageState,'crashed');assert.equal(state.loadError,true);assert.equal(state.loading,false);
});
test('a successful reload clears an earlier unresponsive state',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.emit('unresponsive');assert.equal((await h.call('aiStatus')).pageState,'unresponsive');
 await h.call('aiReload');c.emit('did-finish-load');assert.equal((await h.call('aiStatus')).pageState,'ready');
});

test('an older initial load rejection cannot overwrite a successfully refreshed conversation',async t=>{
 for(const aborted of [false,true]){let reject;const h=await harness(t,{loadHook:()=>new Promise((_,fail)=>{reject=fail;})});await h.show();const c=h.created[0].webContents;
 await h.call('aiReload');c.emit('did-finish-load');reject(aborted?{code:'ERR_ABORTED',errno:-3}:Error('stale private error'));await tick();assert.equal((await h.call('aiStatus')).pageState,'ready');assert.equal((await h.call('aiStatus')).loadError,false);}
});
test('current main-frame load failures remain errors rather than automatically retrying or deleting messages',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;c.streamedMessages=['synthetic-kept'];c.emit('did-fail-load',{},-105,'private failure','https://private.invalid/path',true);
 assert.equal((await h.call('aiStatus')).pageState,'failed');assert.equal(c.reloadCount||0,0);assert.deepEqual(c.streamedMessages,['synthetic-kept']);
});

test('showing an existing page requests paint without detaching, navigating or stealing focus',async t=>{
 const h=await harness(t);await h.show();const view=h.created[0],c=view.webContents;const before=c.repaints;
 await h.call('aiSetVisible',{visible:false});await h.show();assert.equal(c.repaints,before+1);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert.equal(c.focusRequests||0,0);
 c.emit('did-finish-load');assert.equal(c.repaints,before+2);assert.equal(c.loadCount,1);
});
test('native visibility drift is repaired without replacing the conversation document',async t=>{
 const h=await harness(t);await h.show();const view=h.created[0],c=view.webContents;view.getVisible=()=>false;
 await h.show();assert.equal(h.created.length,1);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert.equal(view.visibilityChanges.at(-1),true);
});
test('first navigation starts on a visible, bounded native surface with background throttling disabled',async t=>{
 let h;h=await harness(t,{loadHook:contents=>{const view=h.created.find(view=>view.webContents===contents);assert.equal(h.win.contentView.children.at(-1),view);assert.equal(view.visible,true);assert.equal(view.bounds.width,400);assert.equal(view.bounds.height,650);assert.equal(contents.getBackgroundThrottling(),false);contents.emit('did-finish-load');}});
 await h.show();assert.equal(h.created[0].webContents.loadCount,1);
});
test('window restoration repairs the native surface without reloading, losing messages or taking focus',async t=>{
 const h=await harness(t);await h.show();const view=h.created[0],contents=view.webContents;contents.streamedMessages=['completed answer','follow-up answer'];
 for(const event of ['show','restore','focus','enter-full-screen','leave-full-screen']){h.win.contentView.children.push({otherNativeView:true});view.visible=false;h.win.emit(event);assert.equal(h.win.contentView.children.at(-1),view);assert.equal(view.visible,true);}
 assert.equal(contents.loadCount,1);assert.equal(contents.reloadCount||0,0);assert.equal(contents.focusRequests||0,0);assert.deepEqual(contents.streamedMessages,['completed answer','follow-up answer']);
 await h.call('aiSetVisible',{visible:false});const paints=contents.repaints;h.win.emit('focus');assert.equal(view.visible,false);assert.equal(contents.repaints,paints);
 h.panel.close();for(const event of ['show','restore','focus','enter-full-screen','leave-full-screen'])assert.equal(h.win.listenerCount(event),0);
});
test('fresh asynchronous page samples have their own stage and never masquerade as current status',async t=>{
 const h=await harness(t);await h.show();const contents=h.created[0].webContents;Object.assign(contents.document,{readyState:'complete',visibilityState:'visible',body:{children:[{},{}]}});
 await h.call('aiStatus');await tick();const page=h.stages.find(stage=>stage.phase==='page');assert(page);assert.equal(page.bodyChildren,2);assert.equal(page.attached,true);assert.equal(page.topmost,true);assert.equal(page.backgroundThrottling,false);assert.equal(page.windowVisible,true);
 await h.call('aiStatus');const status=h.stages.filter(stage=>stage.phase==='status').at(-1);assert.equal(Object.hasOwn(status,'bodyChildren'),false);assert.equal(Object.hasOwn(status,'visibilityState'),false);assert.equal(status.x,700);assert.equal(status.y,100);assert.equal(status.loadGeneration,1);
});

test('status polling repairs hidden, detached and covered native surfaces without renderer layout IPC',async t=>{
 for(const drift of ['hidden','detached','covered']){
  const h=await harness(t);await h.show();const view=h.created[0],c=view.webContents;
  c.streamedMessages=['completed first answer','completed follow-up'];
  if(drift==='hidden')view.visible=false;
  else if(drift==='detached')h.win.contentView.removeChildView(view);
  else h.win.contentView.children.push({otherNativeView:true});
  const status=await h.call('aiStatus');
  assert.equal(view.visible,true,drift);assert.equal(h.win.contentView.children.at(-1),view,drift);
  assert.equal(status.pageState,'ready');assert.equal(h.created.length,1);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert.equal(c.focusRequests||0,0);assert.equal(h.win.focusRequests||0,0);
  assert.deepEqual(c.streamedMessages,['completed first answer','completed follow-up']);
 }
});

test('status polling leaves collapsed, hidden-window and minimized-window surfaces alone',async t=>{
 for(const condition of ['collapsed','hidden-window','minimized']){
  const h=await harness(t);await h.show();const view=h.created[0],c=view.webContents;
  if(condition==='collapsed')await h.call('aiSetVisible',{visible:false});
  else if(condition==='hidden-window')h.win.isVisible=()=>false;
  else h.win.isMinimized=()=>true;
  view.visible=false;const changes=view.visibilityChanges.length,paints=c.repaints;
  for(let i=0;i<3;i++)await h.call('aiStatus');
  assert.equal(view.visible,false,condition);assert.equal(view.visibilityChanges.length,changes);assert.equal(c.repaints,paints);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);
 }
});

test('polling and wake events never recreate or autoreload destroyed and crashed pages',async t=>{
 for(const failure of ['destroyed','crashed']){
  const h=await harness(t);await h.show();const view=h.created[0],c=view.webContents;
  if(failure==='destroyed')c.close();else c.emit('render-process-gone',{}, {reason:'oom'});
  view.visible=false;const changes=view.visibilityChanges.length,paints=c.repaints;
  await h.call('aiStatus');h.win.emit('focus');h.win.emit('restore');
  assert.equal(view.visible,false);assert.equal(view.visibilityChanges.length,changes);assert.equal(c.repaints,paints);assert.equal(h.created.length,1);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);
 }
});

test('owner invalidation during native wake or polling cannot throw or reparent the old view',async t=>{
 for(const failure of ['replacement','destroyed']){
  const h=await harness(t);await h.show();const view=h.created[0],c=view.webContents;
  if(failure==='replacement')h.replaceWindow();else h.win.destroyed=true;
  view.visible=false;const changes=view.visibilityChanges.length,paints=c.repaints;
  assert.doesNotThrow(()=>h.win.emit('focus'));assert.doesNotThrow(()=>h.win.emit('restore'));await assert.doesNotReject(h.call('aiStatus'));
  assert.equal(view.visible,false);assert.equal(view.visibilityChanges.length,changes);assert.equal(c.repaints,paints);assert.equal(c.loadCount,1);
 }
});

test('ordinary HTTPS popups open externally and preserve the current conversation and follow-up',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 c.streamedMessages=['first answer','follow-up answer'];const currentURL=c.url;
 for(const url of ['https://example.com/reference','https://chatgpt.com/c/another-conversation'])assert.equal(c.popup({url}).action,'deny');
 await tick();assert.deepEqual(h.externalURLs,['https://example.com/reference','https://chatgpt.com/c/another-conversation']);
 assert.equal(c.url,currentURL);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert.deepEqual(c.streamedMessages,['first answer','follow-up answer']);
});

test('external-open failures cannot leak an exception or replace the conversation',async t=>{
 for(const failure of ['throw','reject']){
  const h=await harness(t);await h.show();const c=h.created[0].webContents,currentURL=c.url;
  h.state.externalHook=()=>{if(failure==='throw')throw Error('private native failure');return Promise.reject(Error('private native failure'));};
  assert.doesNotThrow(()=>c.popup({url:'https://example.com/reference'}));await tick();
  assert.equal(c.url,currentURL);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert(!JSON.stringify(h.diagnostics).includes('private native failure'));
 }
});

test('only safe authentication popups retain the isolated same-view login route',async t=>{
 const routes={chatgpt:['https://auth.openai.com/authorize','https://accounts.google.com/o/oauth2/v2/auth','https://chatgpt.com/auth/login'],claude:['https://claude.ai/login','https://accounts.google.com/o/oauth2/v2/auth'],gemini:['https://accounts.google.com/ServiceLogin'],deepseek:['https://chat.deepseek.com/sign_in']};
 for(const [provider,urls]of Object.entries(routes)){
  const h=await harness(t,{provider});await h.show();const c=h.created[0].webContents;
  for(const url of urls){assert.equal(c.popup({url}).action,'deny');assert.equal(c.url,url);}
  assert.equal(c.loadCount,1+urls.length);assert.deepEqual(h.externalURLs,[]);assert.equal(h.created.length,1);
 }
});

test('restricted schemes, credential URLs and stale hidden-provider popups never navigate or open externally',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents,currentURL=c.url;
 for(const url of ['http://example.com/','javascript:alert(1)','file:///private-note','data:text/html,private','https://user:password@example.com/'])assert.equal(c.popup({url}).action,'deny');
 await h.call('aiSetVisible',{visible:false});c.popup({url:'https://example.com/hidden'});c.popup({url:'https://auth.openai.com/authorize'});
 await h.show();h.panel.selectProvider('claude');c.popup({url:'https://example.com/retired'});c.popup({url:'https://auth.openai.com/authorize'});
 await tick();assert.equal(c.url,currentURL);assert.equal(c.loadCount,1);assert.deepEqual(h.externalURLs,[]);
});

test('lookalike authentication hosts and non-login provider pages never replace the conversation',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents,currentURL=c.url;
 const urls=['https://auth.openai.com.evil.invalid/authorize','https://accounts.google.com.evil.invalid/signin','https://auth.openai.com:444/authorize','https://chatgpt.com/auth/logout','https://chatgpt.com/c/another'];
 for(const url of urls)assert.equal(c.popup({url}).action,'deny');await tick();
 assert.deepEqual(h.externalURLs,urls);assert.equal(c.url,currentURL);assert.equal(c.loadCount,1);
});

function requestNavigation(contents,eventName,url,{modern=true,mainFrame=true,legacyURL=url,legacyMainFrame=mainFrame}={}){
 let prevented=false;const event={preventDefault(){prevented=true;}};
 if(modern)Object.assign(event,{url,isMainFrame:mainFrame,isSameDocument:false});
 contents.emit(eventName,event,legacyURL,false,legacyMainFrame);
 return prevented;
}

test('ChatGPT same-tab external navigation and redirects open externally without replacing answers',async t=>{
 for(const eventName of ['will-navigate','will-redirect'])for(const modern of [true,false]){
  const h=await harness(t);await h.show();const c=h.created[0].webContents,currentURL=c.url;
  c.streamedMessages=['first answer','follow-up answer'];const url='https://example.com/synthetic-reference';
  assert.equal(requestNavigation(c,eventName,url,{modern}),true,eventName+':'+modern);await tick();
  assert.deepEqual(h.externalURLs,[url]);assert.equal(c.url,currentURL);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);assert.equal(c.focusRequests||0,0);assert.deepEqual(c.streamedMessages,['first answer','follow-up answer']);
  const stage=h.stages.filter(stage=>stage.phase==='navigation').at(-1);assert(stage);assert.equal(stage.mainFrame,true);assert(!JSON.stringify(stage).includes('https:'));assert(!JSON.stringify(stage).includes('synthetic-reference'));
 }
});

test('ChatGPT same-tab internal conversations and exact authentication redirects remain in the isolated page',async t=>{
 const urls=['https://chatgpt.com/c/synthetic-followup','https://chatgpt.com/?q=synthetic#composer','https://chatgpt.com/auth/login','https://auth.openai.com/authorize','https://auth0.openai.com/authorize','https://accounts.google.com/o/oauth2/v2/auth','https://appleid.apple.com/auth/authorize','https://login.microsoftonline.com/common/oauth2/authorize','https://login.live.com/oauth20_authorize.srf'];
 for(const eventName of ['will-navigate','will-redirect'])for(const modern of [true,false]){
  const h=await harness(t);await h.show();const c=h.created[0].webContents;
  for(const url of urls)assert.equal(requestNavigation(c,eventName,url,{modern}),false,url);await tick();
  assert.deepEqual(h.externalURLs,[]);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);
 }
});

test('ChatGPT subframe HTTPS requests never open the system browser',async t=>{
 for(const eventName of ['will-navigate','will-redirect'])for(const modern of [true,false]){
  const h=await harness(t);await h.show();const c=h.created[0].webContents;
  assert.equal(requestNavigation(c,eventName,'https://example.com/synthetic-frame',{modern,mainFrame:false}),false);await tick();assert.deepEqual(h.externalURLs,[]);assert.equal(c.loadCount,1);
 }
});

test('ChatGPT same-tab restricted schemes and embedded credentials are blocked without external dispatch',async t=>{
 const urls=['http://example.com/','file:///private-note','javascript:alert(1)','data:text/html,private','https://user:password@example.com/'];
 for(const eventName of ['will-navigate','will-redirect'])for(const modern of [true,false]){
  const h=await harness(t);await h.show();const c=h.created[0].webContents;
  for(const url of urls)assert.equal(requestNavigation(c,eventName,url,{modern}),true);await tick();assert.deepEqual(h.externalURLs,[]);assert.equal(c.loadCount,1);
 }
});

test('late same-tab external requests from hidden, retired, closed or invalid owners cannot open anything',async t=>{
 for(const condition of ['hidden','retired','closed','owner-replaced','owner-destroyed','contents-destroyed','crashed'])for(const eventName of ['will-navigate','will-redirect']){
  const h=await harness(t);await h.show();const c=h.created[0].webContents;
  if(condition==='hidden')await h.call('aiSetVisible',{visible:false});
  else if(condition==='retired')h.panel.selectProvider('claude');
  else if(condition==='closed')h.panel.close();
  else if(condition==='owner-replaced')h.replaceWindow();
  else if(condition==='owner-destroyed')h.win.destroyed=true;
  else if(condition==='contents-destroyed')c.close();
  else c.emit('render-process-gone',{}, {reason:'oom'});
  assert.equal(requestNavigation(c,eventName,'https://example.com/late'),true,condition);await tick();assert.deepEqual(h.externalURLs,[]);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);
 }
});

test('same-tab external-open rejection and synchronous failure retain the page without private diagnostics',async t=>{
 for(const eventName of ['will-navigate','will-redirect'])for(const failure of ['throw','reject']){
  const h=await harness(t);await h.show();const c=h.created[0].webContents,currentURL=c.url;
  h.state.externalHook=()=>{if(failure==='throw')throw Error('private system failure');return Promise.reject(Error('private system failure'));};
  assert.equal(requestNavigation(c,eventName,'https://example.com/private-reference'),true);await tick();assert.equal(c.url,currentURL);assert.equal(c.loadCount,1);assert.equal(c.reloadCount||0,0);
  const recorded=JSON.stringify({stages:h.stages,events:h.diagnostics});assert(!recorded.includes('private system failure'));assert(!recorded.includes('private-reference'));assert(!recorded.includes('https:'));
 }
});

test('same-tab HTTPS navigation behavior of other providers remains unchanged',async t=>{
 for(const provider of ['claude','deepseek','gemini'])for(const eventName of ['will-navigate','will-redirect'])for(const modern of [true,false]){
  const h=await harness(t,{provider});await h.show();const c=h.created[0].webContents;
  assert.equal(requestNavigation(c,eventName,'https://example.com/reference',{modern}),false);await tick();assert.deepEqual(h.externalURLs,[]);assert.equal(c.loadCount,1);
 }
});

test('modern navigation URL and frame metadata take precedence over legacy positional arguments',async t=>{
 for(const eventName of ['will-navigate','will-redirect']){
  const h=await harness(t);await h.show();const c=h.created[0].webContents;
  assert.equal(requestNavigation(c,eventName,'https://chatgpt.com/c/internal',{legacyURL:'https://example.com/ignored'}),false);
  assert.equal(requestNavigation(c,eventName,'https://example.com/frame',{mainFrame:false,legacyMainFrame:true}),false);
  assert.equal(requestNavigation(c,eventName,'https://example.com/selected',{legacyURL:'https://chatgpt.com/c/ignored'}),true);await tick();assert.deepEqual(h.externalURLs,['https://example.com/selected']);
 }
});

test('ChatGPT same-tab lookalike authentication hosts stay outside the conversation',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 const urls=['https://auth.openai.com.evil.invalid/authorize','https://accounts.google.com.evil.invalid/signin','https://auth.openai.com:444/authorize'];
 for(const url of urls)assert.equal(requestNavigation(c,'will-redirect',url),true);await tick();assert.deepEqual(h.externalURLs,urls);assert.equal(c.loadCount,1);
});

function commitNavigation(contents,url,{modern=true,inPage=false}={}){
 contents.url=url;
 if(inPage)contents.emit('did-navigate-in-page',modern?{url,isMainFrame:true}:{},url,true);
 else contents.emit('did-navigate',modern?{url,httpResponseCode:200}:{},url,200);
}

test('an exact ChatGPT authentication entry preserves multi-hop school and enterprise SSO until return',async t=>{
 for(const modern of [true,false]){
  const h=await harness(t);await h.show();const c=h.created[0].webContents;
  const auth='https://auth.openai.com/authorize',school='https://sso.school.example/saml',enterprise='https://tenant.okta.example/login',callback='https://chatgpt.com/auth/callback',conversation='https://chatgpt.com/c/synthetic-after-login';
  assert.equal(requestNavigation(c,'will-navigate',auth,{modern}),false);commitNavigation(c,auth,{modern});
  assert.equal(requestNavigation(c,'will-redirect',school,{modern}),false);commitNavigation(c,school,{modern});
  assert.equal(requestNavigation(c,'will-navigate',enterprise,{modern}),false);commitNavigation(c,enterprise,{modern});
  assert.equal(requestNavigation(c,'will-redirect',callback,{modern}),false);commitNavigation(c,callback,{modern});
  assert.equal(requestNavigation(c,'will-redirect',school,{modern}),false);
  assert.equal(requestNavigation(c,'will-redirect',conversation,{modern}),false);commitNavigation(c,conversation,{modern});
  assert.deepEqual(h.externalURLs,[]);
  assert.equal(requestNavigation(c,'will-navigate','https://example.com/reference',{modern}),true);await tick();assert.deepEqual(h.externalURLs,['https://example.com/reference']);assert.equal(c.url,conversation);assert.equal(c.reloadCount||0,0);
 }
});

test('a supported authentication popup also starts its isolated SSO chain',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 c.popup({url:'https://accounts.google.com/o/oauth2/v2/auth'});
 assert.equal(requestNavigation(c,'will-redirect','https://sso.school.example/google-login'),false);
 assert.equal(c.loadCount,2);assert.deepEqual(h.externalURLs,[]);
});

test('unrecognized IdP navigation cannot start an authentication chain by itself',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 const urls=['https://sso.school.example/saml','https://tenant.okta.example/login','https://auth.openai.com.evil.invalid/authorize'];
 for(const url of urls)assert.equal(requestNavigation(c,'will-redirect',url),true);await tick();assert.deepEqual(h.externalURLs,urls);assert.equal(c.loadCount,1);
});

test('SSO has a fixed thirty-minute limit that unknown intermediate hops do not extend',async t=>{
 let now=1000;const h=await harness(t,{now:()=>now});await h.show();const c=h.created[0].webContents;
 assert.equal(requestNavigation(c,'will-navigate','https://auth.openai.com/authorize'),false);
 now+=29*60*1000;assert.equal(requestNavigation(c,'will-redirect','https://sso.school.example/saml'),false);
 now+=60*1000+1;assert.equal(requestNavigation(c,'will-redirect','https://tenant.okta.example/login'),true);
 assert.equal(requestNavigation(c,'will-navigate','https://auth.openai.com/authorize'),false);
 assert.equal(requestNavigation(c,'will-redirect','https://sso.school.example/new-session'),false);await tick();assert.deepEqual(h.externalURLs,['https://tenant.okta.example/login']);
});

test('an active SSO chain never bypasses protocol or credential restrictions',async t=>{
 const h=await harness(t);await h.show();const c=h.created[0].webContents;
 assert.equal(requestNavigation(c,'will-navigate','https://auth.openai.com/authorize'),false);
 const unsafe=['http://sso.school.example/saml','https://user:password@sso.school.example/saml','file:///private-note','data:text/html,private','javascript:alert(1)'];
 for(const eventName of ['will-navigate','will-redirect'])for(const url of unsafe)assert.equal(requestNavigation(c,eventName,url),true);await tick();assert.deepEqual(h.externalURLs,[]);
});

test('SSO state is local to its exact workspace and clears on an in-page return to ChatGPT',async t=>{
 const first=await harness(t),second=await harness(t);await first.show();await second.show();const a=first.created[0].webContents,b=second.created[0].webContents;
 assert.equal(requestNavigation(a,'will-navigate','https://auth.openai.com/authorize'),false);
 assert.equal(requestNavigation(b,'will-redirect','https://sso.school.example/saml'),true);
 commitNavigation(a,'https://chatgpt.com/c/synthetic-return',{inPage:true});
 assert.equal(requestNavigation(a,'will-redirect','https://sso.school.example/saml'),true);await tick();assert.deepEqual(first.externalURLs,['https://sso.school.example/saml']);assert.deepEqual(second.externalURLs,['https://sso.school.example/saml']);
});

test('the actual AI controller exposes audio permission status and hides grants with its native surface',async t=>{
 const h=await harness(t),bundle=path.join(h.temporary,'Microphone.app/Contents');await fs.mkdir(path.join(bundle,'MacOS'),{recursive:true});
 await fs.writeFile(path.join(bundle,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>NSMicrophoneUsageDescription</key><string>Voice and dictation</string></dict></plist>');
 h.app.getPath=name=>name==='exe'?path.join(bundle,'MacOS/Microphone'):h.temporary;
 await h.show();const c=h.created[0].webContents,s=h.sessions.get('persist:inkspace-chatgpt'),details={requestingUrl:c.url,securityOrigin:'https://chatgpt.com',isMainFrame:true,mediaTypes:['audio']};
 const request=()=>new Promise(resolve=>s.permissions(c,'media',resolve,details));
 assert.equal(await request(),true);assert.equal(h.state.mediaConfirmations,1);assert.equal(h.state.mediaOSRequests,0);assert.equal((await h.call('aiStatus')).audioPermission,'granted');
 assert.equal(s.check(c,'media','https://chatgpt.com',{...details,mediaType:'audio'}),true);
 await h.call('aiSetVisible',{visible:false});assert.equal(await request(),false);assert.equal(s.check(c,'media','https://chatgpt.com',{...details,mediaType:'audio'}),false);assert.equal(h.state.mediaConfirmations,1);
});

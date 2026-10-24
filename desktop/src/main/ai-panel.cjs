'use strict';
const {WebContentsView,session,clipboard,ClipboardItem,nativeImage,shell,dialog,systemPreferences}=require('electron');
const {fail}=require('./errors.cjs');
const {randomUUID}=require('node:crypto');
const {pngImage,imageFingerprint,writePNG,clipboardHasPNG,withClipboardImage,composerScripts,createPNGDragCache}=require('./ai-image-transfer.cjs');
const {pageHealthScript}=require('./ai-page-health.cjs');
const {registerAIMicrophoneOwner}=require('./ai-media-permissions.cjs');
function safeHTTPS(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}
// Keep identity-provider popups in the isolated website session. Ordinary
// citations, shared conversations and other links must not replace that page.
const authenticationHosts={
 chatgpt:new Set(['auth.openai.com','auth0.openai.com','accounts.google.com','appleid.apple.com','login.microsoftonline.com','login.live.com']),
 claude:new Set(['accounts.google.com','appleid.apple.com']),
 gemini:new Set(['accounts.google.com']),
 deepseek:new Set(),
};
const AUTHENTICATION_WINDOW_MS=30*60*1000;
function authenticationPopup(provider,value){
 if(!safeHTTPS(value))return false;const url=new URL(value);
 if(url.port&&url.port!=='443')return false;
 if(authenticationHosts[provider]?.has(url.hostname))return true;
 return isProviderOrigin(provider,value)&&/^\/(?:login|signin|sign_in|auth|oauth|oauth2)(?:\/|$)/i.test(url.pathname)&&!/(?:^|\/)(?:logout|signout|sign_out)(?:\/|$)/i.test(url.pathname);
}
function localQAURL(value){try{const u=new URL(value);return u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function validateRect(rect,bounds){if(!rect||!['x','y','width','height'].every(k=>Number.isFinite(rect[k])))fail('INVALID_REQUEST');const r={x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.ceil(rect.width),height:Math.ceil(rect.height)};if(r.x<0||r.y<0||r.width<2||r.height<2||r.x+r.width>bounds.width+1||r.y+r.height>bounds.height+1||r.width*r.height>12_000_000)fail('INVALID_REQUEST');return r;}
// Renderer DOM rectangles are CSS pixels; native view/capture rectangles are DIP.
// Page zoom supplies this conversion. Display scale (devicePixelRatio) must not
// be applied again: Electron handles Retina/HiDPI when rendering and capturing.
function cssRectToDIP(rect,bounds,zoom){if(!rect||!Number.isFinite(zoom)||zoom<=0||!['x','y','width','height'].every(k=>Number.isFinite(rect[k])))fail('INVALID_REQUEST');return validateRect({x:rect.x*zoom,y:rect.y*zoom,width:rect.width*zoom,height:rect.height*zoom},bounds);}
const {AIWebProviderStore,providerFor,isProviderOrigin}=require('./ai-web-providers.cjs');
const {registerAIDownloadOwner}=require('./ai-downloads.cjs');
// Every workspace keeps one view per provider. Cookies persist per service;
// page contents/drafts never move between workspaces and have no app preload.
const configuredSessions=new WeakSet();
// Native window/WebContents focus is not necessarily acknowledged in the same
// turn as focus(). Request once, then only observe a short, cancellable window.
// A real blur aborts rather than repeatedly taking focus back from the user.
async function confirmNativeFocus(win,contents,blockReason){
 let interrupted=false,resume=null;const listeners=[];
 const wake=()=>resume?.();
 const blur=()=>{interrupted=true;wake();};
 const listen=(target,event,action)=>{target.on(event,action);listeners.push([target,event,action]);};
 try{
  let blocked=blockReason();if(blocked)return blocked;
  for(const target of [win,contents]){listen(target,'focus',wake);listen(target,'blur',blur);}
  listen(win,'closed',wake);listen(contents,'destroyed',wake);listen(contents,'did-start-navigation',wake);
  const deadline=Date.now()+350;
  try{win.focus();contents.focus();}catch{return blockReason()||'nativeFocus';}
  for(;;){
   blocked=blockReason();if(blocked)return blocked;
   if(interrupted)return 'nativeFocus';
   if(win.isFocused?.()!==false&&contents.isFocused?.()!==false)return null;
   const remaining=deadline-Date.now();if(remaining<=0)return 'nativeFocus';
   await new Promise(resolve=>{
    let finished=false,timer;
    const done=()=>{if(finished)return;finished=true;if(timer!==undefined)clearTimeout(timer);resume=null;resolve();};
    resume=done;timer=setTimeout(done,Math.min(20,remaining));
   });
  }
 }finally{resume=null;for(const [target,event,action] of listeners)target.removeListener(event,action);}
}
function createAIPanel({app,getWindow,handler,diagnostics,initialProvider='chatgpt'}){
 const views=new Map();let selected=providerFor(initialProvider).id,lastBounds=null,visible=false,closed=false,selectionRevision=0,pasteRevision=0,dragRevision=0;
 const dragCache=createPNGDragCache({temporaryDirectory:()=>app.getPath('temp')});
 const qaURL=!app.isPackaged?localQAURL(process.env.INKSPACE_QA_AI_URL):null;
 const qaOrigin=qaURL?new URL(qaURL).origin:null;
 const windowOwner=getWindow();
 function owner(){const win=getWindow();if(closed||!win||win!==windowOwner||win.isDestroyed())fail('BUSY');return win;}
 function allowedNavigation(url){try{return safeHTTPS(url)||!!(qaOrigin&&new URL(url).origin===qaOrigin);}catch{return false;}}
 function live(entry){return !!entry&&!entry.view.webContents.isDestroyed();}
 function existing(){const entry=views.get(selected);return live(entry)?entry:null;}
 function stage(entry,phase,extra={}){diagnostics?.recordAIWebStage?.({provider:entry.provider.id,phase,state:!live(entry)?'closed':entry.crashed?'crashed':entry.loadError?'failed':entry.loading?'loading':'ready',...(entry.webContentsId?{webContentsId:entry.webContentsId}:{}),...extra});}
 function nativeState(entry){
  const result={pageRevision:entry.pageRevision,loadGeneration:entry.loadGeneration};
  try{const win=owner(),contents=entry.view.webContents,bounds=entry.view.getBounds?.(),children=win.contentView.children;
   Object.assign(result,{shown:entry.view.getVisible?.()??!!entry.shown,attached:children?children.includes(entry.view):!!entry.attached,topmost:children?children.at(-1)===entry.view:!!entry.attached});
   if(bounds)Object.assign(result,{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height});
   for(const [key,target,method]of [['windowVisible',win,'isVisible'],['windowMinimized',win,'isMinimized'],['windowFocused',win,'isFocused'],['contentFocused',contents,'isFocused'],['backgroundThrottling',contents,'getBackgroundThrottling']])if(typeof target[method]==='function')result[key]=target[method]();
  }catch{}return result;
 }
 function hideAll(except=null){for(const entry of views.values())if(entry!==except&&live(entry)&&entry.shown!==false){entry.view.setVisible(false);entry.shown=false;stage(entry,'visibility',{state:'hidden',shown:false});}}
 function authenticationActive(entry){
  if(entry.provider.id!=='chatgpt'||entry.authenticationStartedAt===null)return false;
  const elapsed=Date.now()-entry.authenticationStartedAt;
  if(elapsed>=0&&elapsed<AUTHENTICATION_WINDOW_MS)return true;
  entry.authenticationStartedAt=null;return false;
 }
 function noteAuthenticationEntry(entry,url){
  if(entry.provider.id==='chatgpt'&&authenticationPopup(entry.provider.id,url)&&!authenticationActive(entry))entry.authenticationStartedAt=Date.now();
 }
 function finishAuthentication(entry,url){
  if(entry.provider.id==='chatgpt'&&isProviderOrigin(entry.provider.id,url)&&!authenticationPopup(entry.provider.id,url))entry.authenticationStartedAt=null;
 }
 function loadPage(entry,url){
  noteAuthenticationEntry(entry,url);
  const generation=++entry.loadGeneration;
  try{void entry.view.webContents.loadURL(url).catch(error=>{
   if(closed||!live(entry)||views.get(entry.provider.id)!==entry||generation!==entry.loadGeneration||error?.errno===-3||error?.code==='ERR_ABORTED')return;
   entry.loadError=true;entry.loading=false;stage(entry,'load');
  });}catch{entry.loadError=true;entry.loading=false;stage(entry,'load');}
 }
 function samplePage(entry){
  if(entry.sampling||entry.loading||!live(entry)||Date.now()-(entry.sampledAt||0)<10000)return;
  const contents=entry.view.webContents;let originAllowed=false;
  try{originAllowed=isProviderOrigin(entry.provider.id,contents.getURL())||!!(qaOrigin&&new URL(contents.getURL()).origin===qaOrigin);}catch{}
  if(!originAllowed)return;entry.sampling=true;entry.sampledAt=Date.now();const revision=entry.pageRevision;
  // Count page structure only: no conversation text, URLs, HTML or drafts leave
  // this isolated page. This distinguishes a blank document from a lost view.
  void contents.executeJavaScript(pageHealthScript()).then(value=>{
   if(!closed&&live(entry)&&revision===entry.pageRevision)stage(entry,'page',{...value,...nativeState(entry)});
  }).catch(()=>{}).finally(()=>{entry.sampling=false;});
 }
 function ensure(){const win=owner();const previous=existing();if(previous)return previous;const retired=views.get(selected);if(retired?.attached){try{win.contentView.removeChildView(retired.view);}catch{}}retired?.releaseAudio?.();retired?.releaseDownloads?.();
  const provider=providerFor(selected),aiSession=session.fromPartition(provider.partition);
  if(!configuredSessions.has(aiSession)){
   aiSession.webRequest.onBeforeRequest((details,callback)=>{let permitted=false;try{const u=new URL(details.url);permitted=['https:','wss:','data:','blob:','about:'].includes(u.protocol)||(qaOrigin&&u.origin===qaOrigin);}catch{}callback({cancel:!permitted});});
   configuredSessions.add(aiSession);
  }
  const view=new WebContentsView({webPreferences:{session:aiSession,backgroundThrottling:false,sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false}});
  view.setBackgroundColor('#ffffff');view.setVisible(false);
  const startURL=new URL(retired&&allowedNavigation(retired.navigationURL)?retired.navigationURL:qaURL||provider.url);if(qaURL)startURL.searchParams.set('provider',provider.id);
  const contents=view.webContents,entry={provider,view,webContentsId:contents.id,loadError:false,crashed:false,loading:true,started:false,attached:false,shown:false,url:startURL.href,pageRevision:0,loadGeneration:0,navigationURL:startURL.href,loadStartedAt:Date.now(),authenticationStartedAt:retired?.authenticationStartedAt??null};
  contents.setBackgroundThrottling(false);
  views.set(provider.id,entry);stage(entry,'created');
  entry.releaseAudio=registerAIMicrophoneOwner({session:aiSession,contents,window:win,provider:provider.id,label:provider.label,app,dialog,systemPreferences,
   isActive:()=>!closed&&visible&&selected===provider.id&&existing()===entry&&!entry.crashed&&entry.shown&&view.getVisible?.()!==false&&getWindow()===win&&win.isVisible?.()!==false&&win.isMinimized?.()!==true&&(!win.contentView.children||win.contentView.children.at(-1)===view),
   revision:()=>entry.pageRevision,onStatus:state=>{entry.audioPermission=state;}});
  entry.releaseDownloads=registerAIDownloadOwner({session:aiSession,contents,window:win,app,
   isActive:()=>!closed&&visible&&selected===provider.id&&existing()===entry,
   onStatus:download=>{entry.download=download;}});
  // Preserve the user's current conversation when a citation opens a new tab.
  // Authentication retains the old isolated-session route and no IPC bridge.
  contents.setWindowOpenHandler(({url})=>{
   stage(entry,'popup');
   try{
    const current=owner();
    if(!visible||selected!==provider.id||existing()!==entry||!entry.shown||current!==win||!safeHTTPS(url))return{action:'deny'};
    if(authenticationPopup(provider.id,url))loadPage(entry,url);
    else void Promise.resolve(shell.openExternal(url)).catch(()=>diagnostics?.record('ai_web_external',{code:'IO_FAILED'}));
   }catch{/* A late popup from a closed workspace cannot act on another window. */}
   return{action:'deny'};
  });
  const navigation=(event,url,isInPlace,isMainFrame)=>{
   const target=event.url??url;
   if(!allowedNavigation(target)){event.preventDefault();return;}
   // A normal target=_self citation or window.location change must not replace
   // ChatGPT either. Preserve its own routes, supported login redirects and
   // subframes; other providers retain their existing navigation behavior.
   if(provider.id!=='chatgpt'||(event.isMainFrame??isMainFrame)===false)return;
   if(authenticationPopup(provider.id,target)){noteAuthenticationEntry(entry,target);return;}
   if(isProviderOrigin(provider.id,target)||!safeHTTPS(target))return;
   // Enterprise/school SSO can visit arbitrary IdP domains after a known login
   // entry. Keep that bounded chain in this session, never start it from an
   // ordinary citation, and end it as soon as the provider commits its return.
   if(authenticationActive(entry))return;
   event.preventDefault();stage(entry,'navigation',{mainFrame:true,inPlace:!!(event.isSameDocument??isInPlace)});
   try{
    const current=owner();
    if(!visible||selected!==provider.id||existing()!==entry||!entry.shown||entry.crashed||current!==win)return;
    void Promise.resolve(shell.openExternal(target)).catch(()=>diagnostics?.record('ai_web_external',{code:'IO_FAILED'}));
   }catch{/* Late navigation and a failed external open leave this page intact. */}
  };
  contents.on('will-navigate',navigation);contents.on('will-redirect',navigation);
  contents.on('did-start-navigation',(event,url,isInPlace,isMainFrame)=>{url=event.url??url;isInPlace=event.isSameDocument??isInPlace;isMainFrame=event.isMainFrame??isMainFrame;if(!isMainFrame)return;let hashOnly=false;try{const before=new URL(entry.navigationURL),after=new URL(url);before.hash='';after.hash='';hashOnly=isInPlace&&before.href===after.href;}catch{}if(!hashOnly){entry.pageRevision++;if(!isInPlace)entry.loadGeneration++;entry.loadStartedAt=Date.now();entry.loadError=false;if(!isInPlace)entry.loading=true;}entry.navigationURL=url;stage(entry,'navigation',{mainFrame:true,inPlace:!!isInPlace});});
  contents.on('will-attach-webview',event=>event.preventDefault());
  contents.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){entry.loadError=true;entry.loading=false;stage(entry,'load',{errorCode:code});diagnostics?.record('ai_web_load',{code:'NETWORK_ERROR'});}});
  contents.on('did-navigate',(event,url,statusCode)=>{finishAuthentication(entry,event.url??url);statusCode=event.httpResponseCode??statusCode;if(statusCode>=400){entry.loadError=true;stage(entry,'load',{errorCode:statusCode});}});
  contents.on('did-navigate-in-page',(event,url,isMainFrame)=>{if((event.isMainFrame??isMainFrame)!==false)finishAuthentication(entry,event.url??url);});
  contents.on('did-start-loading',()=>{entry.loading=true;entry.loadStartedAt=Date.now();stage(entry,'load');});
  contents.on('did-stop-loading',()=>{entry.loading=false;stage(entry,'load');});
  contents.on('did-finish-load',()=>{entry.loading=false;entry.crashed=false;entry.unresponsive=false;stage(entry,'load');if(visible&&selected===entry.provider.id&&entry.shown)contents.invalidate?.();});
  contents.on('render-process-gone',(_event,details)=>{entry.crashed=true;entry.loadError=true;entry.loading=false;stage(entry,'crashed',{reason:['crashed','oom','killed','clean-exit','abnormal-exit','launch-failed','integrity-failure'].includes(details?.reason)?details.reason:'unknown'});});
  contents.once('destroyed',()=>{entry.loadError=true;entry.loading=false;if(!closed)stage(entry,'closed');});
  contents.on('unresponsive',()=>{entry.unresponsive=true;stage(entry,'unresponsive');});
  contents.on('responsive',()=>{entry.unresponsive=false;stage(entry,'responsive');});
  return entry;
 }
 function showSelected(){const win=owner(),entry=ensure();hideAll(entry);
  // Keep the existing page at the front of the native view stack. Reordering
  // does not detach it, reload its document, or interrupt its stream/focus.
  if(!entry.attached||win.contentView.children&&win.contentView.children.at(-1)!==entry.view){win.contentView.addChildView(entry.view);entry.attached=true;}
  entry.view.setBounds(lastBounds);
  if(!entry.shown||entry.view.getVisible?.()===false){entry.view.setVisible(true);entry.shown=true;stage(entry,'visibility',{state:'visible',shown:true});entry.view.webContents.invalidate?.();}
  // First navigation starts only after the native child has a parent, bounds,
  // and a visible surface. Subsequent layout/show calls retain its document.
  if(!entry.started){entry.started=true;loadPage(entry,entry.url);}
 }
 function selectProvider(id){providerFor(id);if(id===selected)return;hideAll();selected=id;selectionRevision++;if(visible&&lastBounds)showSelected();}
 function repairSurface(repaint=false){
  if(closed||!visible||!lastBounds)return;const entry=existing();if(!entry||entry.crashed)return;
  try{
   const win=owner();if(win.isVisible?.()===false||win.isMinimized?.()===true)return;
   const children=win.contentView.children;
   const drift=!entry.shown||!entry.attached||entry.view.getVisible?.()===false||!!children&&(!children.includes(entry.view)||children.at(-1)!==entry.view);
   if(drift)showSelected();
   if(drift||repaint)entry.view.webContents.invalidate?.();
  }catch{/* Closing/replacing an owner can race a native event or status poll. */}
 }
 function status(){repairSurface();const entry=existing(),raw=views.get(selected),provider=providerFor(selected);if(raw){stage(raw,'status',nativeState(raw));if(visible)samplePage(raw);}let url=new URL(provider.url).origin;try{if(entry)url=new URL(entry.view.webContents.getURL()||entry.url).origin;}catch{}return{provider:selected,label:provider.label,pasteMode:provider.pasteMode,visible,loading:!!entry&&(entry.loading||entry.view.webContents.isLoading()),loadError:!!raw&&(!entry||raw.loadError||raw.crashed),pageState:raw?(!entry?'closed':raw.crashed?'crashed':raw.unresponsive?'unresponsive':raw.loadError?'failed':raw.loading?'loading':'ready'):'idle',loadTimedOut:!!entry&&(entry.loading||entry.view.webContents.isLoading())&&Date.now()-entry.loadStartedAt>=20_000,url,...(entry?.download?{download:entry.download}:{}),...(entry?.audioPermission?{audioPermission:entry.audioPermission}:{})};}
 handler('aiSetVisible',async request=>{if(!request||typeof request.visible!=='boolean')fail('INVALID_REQUEST');if(!request.visible){if(visible)selectionRevision++;hideAll();visible=false;return{visible:false};}const win=owner(),area=win.getContentBounds();lastBounds=cssRectToDIP(request.bounds,{width:area.width,height:area.height},win.webContents.getZoomFactor());showSelected();visible=true;return{visible:true};});
 handler('aiStatus',async()=>status());
 handler('aiReload',async()=>{if(!visible)fail('BUSY');owner();const current=existing();if(!current){showSelected();return{reloading:true};}const wasCrashed=current.crashed;current.loadGeneration++;current.loadError=false;current.crashed=false;current.unresponsive=false;current.loading=true;current.loadStartedAt=Date.now();stage(current,'load');try{current.view.webContents.reload();}catch{current.loadError=true;current.crashed=wasCrashed;current.loading=false;stage(current,'load');fail('NETWORK_ERROR');}return{reloading:true};});
 handler('captureSelection',async request=>{const win=owner(),area=win.getContentBounds();const rect=cssRectToDIP(request?.rect,{width:area.width,height:area.height},win.webContents.getZoomFactor());const screenshot=await win.webContents.capturePage(rect);const scaled=screenshot.getSize();const limited=scaled.width*scaled.height>12_000_000?screenshot.resize({width:Math.round(scaled.width*Math.sqrt(12_000_000/(scaled.width*scaled.height)))}):screenshot;return{dataURL:limited.toDataURL(),width:limited.getSize().width,height:limited.getSize().height};});
 handler('aiPasteImage',async request=>{
  if(!request||request.provider!==selected)fail('CANCELLED');
  if(request.copyOnly!==undefined&&typeof request.copyOnly!=='boolean')fail('INVALID_REQUEST');
  const {image,bytes}=pngImage(request,nativeImage),expectedImage=imageFingerprint(image);
  if(!expectedImage)fail('INVALID_REQUEST');
  const provider=providerFor(selected),entry=existing(),win=owner(),revision=selectionRevision,pageRevision=entry?.pageRevision,operation=++pasteRevision;
  const copied=(reason,copied=true)=>({copied,pasteAttempted:false,attachmentConfirmed:false,...(reason?{reason}:{})});
  try{await withClipboardImage(()=>writePNG(clipboard,ClipboardItem,bytes));}catch{return copied('clipboardMismatch',false);}
  // Explicit copy and unverified provider adapters never touch page DOM, focus,
  // native paste, or login. Website sessions retain their normal isolation.
  if(request.copyOnly)return copied();
  if(provider.pasteMode!=='composer'||provider.id!=='chatgpt')return copied('unsupported');
  if(!entry)return copied('notVisible');
  const contents=entry.view.webContents;
  const blockReason=()=>{
   if(closed||!visible||!live(entry)||getWindow()!==win||win.isDestroyed())return 'notVisible';
   if(selected!==provider.id||existing()!==entry)return 'providerChanged';
   if(revision!==selectionRevision||operation!==pasteRevision)return 'cancelled';
   if(entry.pageRevision!==pageRevision)return 'navigation';
   try{const url=contents.getURL();return isProviderOrigin(provider.id,url)||!!(qaOrigin&&new URL(url||entry.url).origin===qaOrigin)?null:'navigation';}catch{return 'navigation';}
  };
  let blocked=blockReason();if(blocked)return copied(blocked);
  const scripts=composerScripts({origin:qaOrigin||new URL(provider.url).origin,pageURL:contents.getURL(),nonce:randomUUID()});
  const scriptReason=result=>['navigation','composerMissing','composerFocus'].includes(result?.reason)?result.reason:'composerFocus';
  let focusResult,before=[];
  try{focusResult=await contents.executeJavaScript(scripts.focus,true);}catch{return copied(blockReason()||'composerFocus');}
  blocked=blockReason();if(blocked)return copied(blocked);
  if(focusResult?.ready!==true)return copied(scriptReason(focusResult));
  try{before=await contents.executeJavaScript(scripts.attachments,true);}catch{}
  blocked=blockReason();if(blocked)return copied(blocked);
  if(!Array.isArray(before))return copied('composerFocus');
  blocked=await confirmNativeFocus(win,contents,blockReason);if(blocked)return copied(blocked);
  try{focusResult=await contents.executeJavaScript(scripts.verify,true);}catch{return copied(blockReason()||'composerFocus');}
  blocked=blockReason();if(blocked)return copied(blocked);
  if(focusResult?.ready!==true)return copied(scriptReason(focusResult));
  const dispatched=await withClipboardImage(async()=>{
   const focusedReason=()=>blockReason()||(win.isFocused?.()===false||contents.isFocused?.()===false?'nativeFocus':null);
   let reason=focusedReason();if(reason)return {pasted:false,reason};
   // Electron 44 clipboard writes/reads are async. Replace the clipboard with
   // this validated request snapshot only after the exact composer is ready,
   // then verify its PNG pixels just before native trusted paste. No awaits,
   // renderer IPC, or page scripts occur between the final guard and paste.
   try{await writePNG(clipboard,ClipboardItem,bytes);}catch{return {pasted:false,reason:focusedReason()||'clipboardMismatch'};}
   reason=focusedReason();if(reason)return {pasted:false,reason};
   const verified=await clipboardHasPNG(clipboard,nativeImage,expectedImage,()=>!focusedReason());
   reason=focusedReason();if(reason)return {pasted:false,reason};
   if(!verified)return {pasted:false,reason:'clipboardMismatch'};
   // No asynchronous work may appear between this final check and paste.
   reason=focusedReason();if(reason)return {pasted:false,reason};
   try{contents.paste();return {pasted:true};}catch{return {pasted:false,reason:'pasteFailed'};}
  });
  if(!dispatched.pasted)return copied(dispatched.reason);
  let attachmentConfirmed=false;
  for(let attempt=0;attempt<8&&!blockReason();attempt++){await new Promise(resolve=>setTimeout(resolve,250));if(blockReason())break;try{const after=await contents.executeJavaScript(scripts.attachments,true);attachmentConfirmed=!blockReason()&&Array.isArray(after)&&(after.length>before.length||after.some(value=>!before.includes(value)));if(attachmentConfirmed)break;}catch{break;}}
  return{copied:true,pasteAttempted:true,attachmentConfirmed};
 });
 handler('aiDragImage',async request=>{
  if(!request||request.provider!==selected)fail('CANCELLED');
  const {image,bytes}=pngImage(request,nativeImage),win=owner(),entry=existing(),revision=selectionRevision,operation=++dragRevision;
  const current=()=>!closed&&visible&&revision===selectionRevision&&operation===dragRevision&&request.provider===selected&&existing()===entry&&live(entry)&&getWindow()===win&&!win.isDestroyed()&&!win.webContents.isDestroyed();
  if(!current())fail('CANCELLED');
  const file=await dragCache.create(bytes,current);
  if(!current())fail('CANCELLED');
  win.webContents.startDrag({file,icon:image.resize({width:Math.min(image.getSize().width,160)})});
  return{dragStarted:true};
 });
 const wakeEvents=['show','restore','focus','enter-full-screen','leave-full-screen'];
 const repaint=()=>repairSurface(true);
 for(const event of wakeEvents)windowOwner?.on(event,repaint);
 function close(){if(closed)return;closed=true;visible=false;for(const event of wakeEvents)windowOwner?.removeListener(event,repaint);void dragCache.close().catch(error=>diagnostics?.record('ai_image_drag_cleanup',error));for(const entry of views.values()){entry.releaseAudio?.();entry.releaseDownloads?.();if(live(entry))entry.view.webContents.close();}views.clear();}
 windowOwner?.once('closed',close);
 return{close,selectProvider,status};
}
function installAIPanel({app,getWindow,handler,diagnostics,providerStore}){
 const controllers=new Map();
 const store=providerStore||new AIWebProviderStore({dataDirectory:app.getPath('userData'),onStorageError:error=>diagnostics?.record('ai_web_settings',error)});
 async function controller(){const win=getWindow();if(!win||win.isDestroyed())fail('BUSY');let entry=controllers.get(win);if(!entry){await store.load();if(win.isDestroyed())fail('BUSY');entry=controllers.get(win);if(!entry){const operations=new Map();const panel=createAIPanel({app,getWindow:()=>win,handler:(name,action)=>operations.set(name,action),diagnostics,initialProvider:store.provider});entry={operations,panel};controllers.set(win,entry);win.once('closed',()=>{panel.close();controllers.delete(win);});}}return entry;}
 for(const name of ['aiSetVisible','aiStatus','aiReload','captureSelection','aiPasteImage','aiDragImage'])handler(name,async request=>(await controller()).operations.get(name)(request));
 handler('aiWebSettings',()=>store.get());
 handler('setAIWebProvider',async request=>{const info=await store.set(request);for(const [win,entry]of controllers){if(win.isDestroyed())continue;try{entry.panel.selectProvider(info.provider);win.webContents.send('desktop:aiWebProviderChanged',info);}catch(error){diagnostics?.record('ai_web_switch',error);}}return info;});
 return{close:()=>{for(const entry of controllers.values())entry.panel.close();controllers.clear();}};
}
module.exports={installAIPanel,createAIPanel,validateRect,cssRectToDIP,safeHTTPS,localQAURL};

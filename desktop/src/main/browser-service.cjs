'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {BrowserWindow,WebContentsView,session,ipcMain,dialog,Menu,nativeImage,shell}=require('electron');
const {fail,publicError}=require('./errors.cjs');
const {displayBrand,appLocale}=require('./app-brand.cjs');
const {object,string,webURL,navigationURL,normalizeClip}=require('./browser-security.cjs');
const {validateTarget,saveClip,savePDF,readClipFile}=require('./browser-clips.cjs');
const {BrowserExtensions}=require('./browser-extensions.cjs');
const {browserStateForApp,MAX_TABS}=require('./browser-state.cjs');
const {browserLibraryForApp}=require('./browser-library.cjs');
const {BrowserDownloads}=require('./browser-downloads.cjs');
const {BrowserLoginDiagnostics,STRUCTURE_SCRIPT,blockedReason,DURATION_MS}=require('./browser-login-diagnostics.cjs');
const {BrowserPageLoadState,schoolRecoveryURL}=require('./browser-page-load.cjs');
const {mailWebsite}=require('./work-mail-websites.cjs');
const officialMailEntries=new Map(['qq','gmail','outlook-personal','outlook-work'].map(provider=>[mailWebsite({provider}),{provider,url:mailWebsite({provider}),label:({qq:'QQ邮箱官网',gmail:'Gmail官网','outlook-personal':'Outlook个人邮箱官网','outlook-work':'Outlook工作/学校邮箱官网'})[provider]}]));
const {AsyncLocalStorage}=require('node:async_hooks');
const extensionOwners=new AsyncLocalStorage(),sharedExtensions=new WeakMap(),browserOwners=new WeakMap();
const CHROME_HEIGHT=156;
const stableZoom=value=>Number.isFinite(value)?Math.min(5,Math.max(.25,Math.round(value*1e6)/1e6)):1;
const tabTitle=value=>String(value||'新标签页').replace(/\0/g,'').slice(0,200).toWellFormed()||'新标签页';
// OAuth/SAML callback credentials stay in Chromium's live navigation only. This
// affects automatic history/restoration, never the actual URL or request body.
const authParameter=/^(?:code|state|sid|access_token|id_token|refresh_token|oauth_token|oauth_verifier|code_verifier|samlrequest|samlresponse|relaystate|wresult|wctx|session_state|client_info)$/i;
function automaticPageURL(value){try{const url=new URL(webURL(value)),fragment=url.hash.slice(1),queries=[url.search,fragment.includes('?')?fragment.slice(fragment.indexOf('?')+1):fragment];for(const query of queries)for(const key of new URLSearchParams(query).keys())if(authParameter.test(key))return null;return url.href;}catch{return null;}}

const escapeHTML=value=>String(value).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
async function captureVisible(contents,rect){for(let attempt=0;attempt<2;attempt++){try{const image=rect?await contents.capturePage(rect):await contents.capturePage();if(!image.isEmpty())return image;}catch(error){if(attempt)throw error;}await new Promise(resolve=>setTimeout(resolve,120));}fail('IO_FAILED');}
const EXTRACT=`(()=>({title:String(document.title||'网页剪藏').slice(0,512),selection:String(window.getSelection()?.toString()||'').slice(0,90000),text:String(document.body?.innerText||'').slice(0,90000)}))()`;
class BrowserService{
 constructor({app,vaults,getMainWindow,diagnostics,ipc=ipcMain}){
  Object.assign(this,{app,vaults,getMainWindow,diagnostics});this.ipcMain=ipc;this.disposed=false;this.loginDiagnostics=new BrowserLoginDiagnostics();this.loginDiagnosticOpen=false;this.loginDeferred=null;this.loginInFlight=null;this.loginExpiryTimer=null;this.window=null;this.tabs=[];this.active=null;this.target=null;this.status='输入网址或关键词开始浏览';this.busy=false;this.management=false;this.stateRevision=0;this.snapshotIssueReported=false;
  this.sessionState=browserStateForApp(app);this.libraryStore=browserLibraryForApp(app);this.library=null;this.librarySearch='';this.libraryLimit=100;this.libraryUnsubscribe=this.libraryStore.subscribe(()=>this.update());this.closedTabs=[];this.sessionRecordId=null;this.restoring=false;this.closingWindow=false;
  this.shellPath=path.join(__dirname,'..','browser','browser.html');this.shellURL=pathToFileURL(this.shellPath).href;
  this.browserSession=session.fromPartition('persist:inkspace-browser-v1');
  this.browserSession.setPermissionRequestHandler((wc,permission,callback,details={})=>{for(const owner of browserOwners.get(this.browserSession)||[])owner.loginDiagnostics.permission(wc?.id,'request',permission,details.requestingUrl||details.requestingOrigin,details);callback(false);});
  this.browserSession.setPermissionCheckHandler((wc,permission,origin,details={})=>{for(const owner of browserOwners.get(this.browserSession)||[])owner.loginDiagnostics.permission(wc?.id,'check',permission,origin,details);return false;});
  this.browserSession.setDevicePermissionHandler(()=>false);
  let owners=browserOwners.get(this.browserSession);if(!owners){owners=new Set();browserOwners.set(this.browserSession,owners);const browserSession=this.browserSession;
   browserSession.webRequest.onBeforeRequest((details,callback)=>{let allowed=false;try{const url=new URL(details.url);allowed=['http:','https:','ws:','wss:','data:','blob:'].includes(url.protocol)||(url.protocol==='chrome-extension:'&&(!!browserSession.extensions.getExtension(url.hostname)||url.hostname==='mhjfbmdgcfjbbpaeojofohoefgiehjai'));}catch{}
    for(const owner of owners){owner.loginDiagnostics.network('request',details);if(allowed&&details.resourceType==='mainFrame')owner.recordNavigationMethod(details);}callback({cancel:!allowed});});
   for(const[event,phase]of [['onResponseStarted','response'],['onBeforeRedirect','redirect'],['onErrorOccurred','error']])browserSession.webRequest[event](details=>{for(const owner of owners)owner.loginDiagnostics.network(phase,details);});
  }owners.add(this);
  this.downloadsOpen=false;this.downloadSearch='';this.downloadLimit=50;this.downloads=new BrowserDownloads({app,session:this.browserSession,shell,onChange:status=>this.update(status)});
  this.uiSession=session.fromPartition('inkspace-browser-controls');this.uiSession.setPermissionRequestHandler((_wc,_p,callback)=>callback(false));this.uiSession.setPermissionCheckHandler(()=>false);
  const uiRoot=pathToFileURL(path.join(__dirname,'..','browser')+path.sep).href;
  this.uiSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(uiRoot)}));
  let extensionState=sharedExtensions.get(this.browserSession);
  if(!extensionState){const extensions=new BrowserExtensions({session:this.browserSession,directory:path.join(app.getPath('userData'),'browser-extensions'),dialog,getWindow:()=>{const caller=extensionOwners.getStore(),win=caller?.window||caller?.getMainWindow();if(!caller||caller.disposed||!win||win.isDestroyed())fail('CANCELLED');return win;}});extensionState={extensions,initialized:extensions.initialize()};sharedExtensions.set(this.browserSession,extensionState);}
  this.extensions=extensionState.extensions;this.initialized=extensionState.initialized;
  this.ipcMain.handle('browser:action',async(event,request)=>{
   try{if(!this.window||event.sender!==this.window.webContents||event.senderFrame!==this.window.webContents.mainFrame||event.senderFrame.url!==this.shellURL)fail('PERMISSION_DENIED');return{ok:true,value:await this.action(request)};}
   catch(error){this.diagnostics?.record('browser',error);this.update(error?.message||'操作未完成');return{ok:false,error:publicError(error)};}
  });
 }
 async openURL(value){const url=webURL(value);await this.open();if(this.current()&&!this.current().url)await this.navigate(this.current(),url);else{const tab=this.addTab();await this.navigate(tab,url);}return{opened:true};}
 async open(value={}){
  if(this.disposed)fail('CANCELLED');
  object(value,['vaultId','parentPath','boardPath']);if(value.vaultId)this.target=await validateTarget(this.vaults,value);else if(Object.keys(value).length)fail('INVALID_REQUEST');
  await this.initialized;
  if(this.disposed)fail('CANCELLED');
  if(!this.window||this.window.isDestroyed()){
   this.window=new BrowserWindow({width:1180,height:830,minWidth:880,minHeight:560,title:this.brandTitle(),backgroundColor:'#f6f7fa',show:false,webPreferences:{session:this.uiSession,preload:path.join(__dirname,'..','preload','browser.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false}});
   this.window.webContents.setWindowOpenHandler(()=>({action:'deny'}));this.window.webContents.on('will-navigate',e=>e.preventDefault());this.window.webContents.on('will-attach-webview',e=>e.preventDefault());
   this.window.webContents.on('before-input-event',(event,input)=>this.keyInput(event,input));
   this.window.on('resize',()=>this.layout());this.window.on('close',()=>{this.persist();this.closingWindow=true;});this.window.on('closed',()=>{this.stopLoginDiagnostics('window-closed');this.loginDiagnostics.clear();this.loginDiagnosticOpen=false;for(const tab of this.tabs)if(!tab.view.webContents.isDestroyed())tab.view.webContents.close();this.sessionState.release(this.sessionRecordId);this.tabs=[];this.active=null;this.window=null;this.management=false;this.library=null;this.downloadsOpen=false;this.closingWindow=false;});
   this.window.webContents.once('did-finish-load',()=>{this.update();this.window?.show();});await this.window.loadFile(this.shellPath);if(this.disposed)fail('CANCELLED');this.restoreTabs();
  }
  if(this.window.isMinimized())this.window.restore();this.window.show();this.window.focus();this.update();return{opened:true};
 }
 brandTitle(){return displayBrand(appLocale(this.app))+' · '+(appLocale(this.app).startsWith('zh')?'浏览器':'Browser');}
 refreshBrand(){if(this.window&&!this.window.isDestroyed()){this.window.setTitle(this.brandTitle());this.update();}}
 nativePageValue(tab,read,fallback){if(!tab)return fallback;try{const contents=tab.view.webContents;if(contents.isDestroyed())throw Error('NATIVE_PAGE_UNAVAILABLE');return read(contents);}catch{if(!this.snapshotIssueReported){this.snapshotIssueReported=true;this.diagnostics?.record('browserSnapshot',{code:'IO_FAILED'});}return fallback;}}
 state(){this.loginDiagnostics.tabCount(this.tabs.length);const current=this.current(),revision=++this.stateRevision;const pageLoad=current?.load.snapshot()||null,pageURL=this.nativePageValue(current,wc=>wc.getURL(),current?.url||'');if(current)this.loginDiagnostics.context(current.view.webContents.id,pageURL);return{revision,pageLoad:pageLoad?{...pageLoad,schoolRecoveryAvailable:!!schoolRecoveryURL(pageLoad.error?.host),officialEntry:current.officialEntry?{...current.officialEntry}:null}:null,loginDiagnostics:{open:this.loginDiagnosticOpen,scope:current?this.loginDiagnostics.describe(current.view.webContents.id,pageURL):null,report:this.loginDiagnostics.snapshot()},brandTitle:this.brandTitle(),tabs:this.tabs.map(t=>({id:t.id,title:t.title,url:t.url,loading:!t.load.error&&this.nativePageValue(t,wc=>!!wc.isLoading(),false)})),active:this.active,url:current?.url||'',canGoBack:this.nativePageValue(current,wc=>!!wc.navigationHistory.canGoBack(),false),canGoForward:this.nativePageValue(current,wc=>!!wc.navigationHistory.canGoForward(),false),target:this.target?{label:this.target.boardPath||this.target.parentPath||'资料库根目录',board:!!this.target.boardPath}:null,status:pageLoad?.error?('网页加载失败 · '+(pageLoad.error.host||'未知网站')+' · '+pageLoad.error.code):pageLoad?.phase==='loading'?('当前页面仍在加载 · '+(pageLoad.host||'未知网站')):this.nativePageValue(current,wc=>!!wc.isLoading(),false)?('当前页面仍有资源加载 · '+(pageLoad?.host||'未知网站')):this.status,busy:this.busy,management:this.management,extensions:this.extensions.list(),canReopenTab:this.closedTabs.length>0,zoom:this.nativePageValue(current,wc=>wc.getZoomFactor(),stableZoom(current?.zoom)),find:current?{open:current.find.open,text:current.find.text,matches:current.find.matches,active:current.find.active}:null,sessionWarning:this.sessionState.warning,libraryWarning:this.libraryStore.warning,bookmarked:this.libraryStore.hasBookmark(this.nativePageValue(current,wc=>wc.getURL(),current?.url||'')),downloads:this.downloadsOpen?this.downloads.query(this.downloadSearch,this.downloadLimit):null,downloadActive:this.downloads.store.live.size,library:this.library?this.libraryStore.query(this.library,this.librarySearch,this.libraryLimit):null};}

 update(status){if(status)this.status=String(status).slice(0,1000);if(this.window&&!this.window.isDestroyed()){this.layout();this.window.webContents.send('browser:state',this.state());}}
 current(){return this.tabs.find(t=>t.id===this.active);}
 layout(){if(!this.window||this.window.isDestroyed())return;const [width,height]=this.window.getContentSize(),top=CHROME_HEIGHT+(this.current()?.find.open&&!this.management&&!this.library&&!this.downloadsOpen&&!this.loginDiagnosticOpen?38:0);for(const tab of this.tabs){tab.view.setVisible(tab.id===this.active&&!this.management&&!this.library&&!this.downloadsOpen&&!this.loginDiagnosticOpen&&!tab.load.error&&(!!tab.url||tab.popupBlank));tab.view.setBounds({x:0,y:top,width,height:Math.max(1,height-top)});}}
 snapshotTab(tab){let url=null;try{if(tab.restorable&&tab.restoreURL)url=automaticPageURL(tab.restoreURL);}catch{}return {url,title:url?tabTitle(tab.title):'新标签页',zoom:stableZoom(tab.view.webContents.isDestroyed()?tab.zoom:tab.view.webContents.getZoomFactor())};}
 persist(){if(this.restoring||this.closingWindow||!this.sessionRecordId||!this.tabs.length)return;try{const previousWarning=this.sessionState.warning;this.sessionState.update({id:this.sessionRecordId,tabs:this.tabs.map(t=>this.snapshotTab(t)),activeIndex:Math.max(0,this.tabs.findIndex(t=>t.id===this.active)),closedTabs:this.closedTabs});if(previousWarning!==this.sessionState.warning)this.update();}catch(error){this.diagnostics?.record('browser-session',error);}}
 restoreTabs(){const saved=this.sessionState.acquire(this.sessionRecordId);this.sessionRecordId=saved.id;this.closedTabs=saved.closedTabs;this.restoring=true;try{for(const record of saved.tabs)this.addTab(record.url,{record,restore:true});this.active=this.tabs[saved.activeIndex]?.id||this.tabs[0]?.id;}finally{this.restoring=false;}this.persist();this.layout();}
 recordNavigationMethod(details){const tab=this.tabs.find(t=>t.view.webContents.id===details.webContentsId);if(!tab)return;tab.load.noteRequest(details.url,details.method);tab.restoreURL=details.method==='GET'?automaticPageURL(details.url):null;tab.restorable=!!tab.restoreURL;this.persist();}
 focusControl(id){if(!this.window||this.window.isDestroyed())return;this.window.webContents.focus();this.window.webContents.send('browser:focus',id);}
 selectTab(id){if(!this.tabs.some(t=>t.id===id))fail('INVALID_REQUEST');this.active=id;this.management=false;this.library=null;this.downloadsOpen=false;this.loginDiagnosticOpen=false;this.layout();this.persist();}
 closeTab(id){const index=this.tabs.findIndex(t=>t.id===id);if(index<0)fail('INVALID_REQUEST');const tab=this.tabs[index];this.closedTabs.push(this.snapshotTab(tab));this.closedTabs=this.closedTabs.slice(-MAX_TABS);this.tabs.splice(index,1);this.window.contentView.removeChildView(tab.view);tab.view.webContents.close();if(this.active===tab.id)this.active=this.tabs[Math.min(index,this.tabs.length-1)]?.id;if(!this.tabs.length)this.addTab();this.layout();this.persist();}
 reopenTab(){if(!this.closedTabs.length)return;if(this.tabs.length>=MAX_TABS)fail('TOO_LARGE');const record=this.closedTabs.pop();this.addTab(record.url,{record,restore:true});this.persist();}
 setPageZoom(direction){const tab=this.current();if(!tab)return;const wc=tab.view.webContents,steps=[.25,.33,.5,.67,.75,.8,.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5],now=wc.getZoomFactor();let next=1;if(direction==='in')next=steps.find(s=>s>now+.005)||5;else if(direction==='out')next=[...steps].reverse().find(s=>s<now-.005)||.25;else if(direction!=='reset')fail('INVALID_REQUEST');wc.setZoomFactor(next);tab.zoom=next;this.persist();}
 openFind(){const tab=this.current();if(!tab?.url){this.focusControl('address');return;}tab.find.open=true;this.management=false;this.library=null;this.downloadsOpen=false;this.loginDiagnosticOpen=false;this.layout();this.update();this.focusControl('findText');}
 findText(text,next=false,forward=true){const tab=this.current();if(!tab)return;string(text,512);tab.find.open=true;tab.find.text=text;tab.find.matches=0;tab.find.active=0;if(!text){tab.view.webContents.stopFindInPage('clearSelection');tab.find.requestId=0;}else tab.find.requestId=tab.view.webContents.findInPage(text,{findNext:!next,forward});this.layout();}
 closeFind(){const tab=this.current();if(!tab)return;tab.view.webContents.stopFindInPage('clearSelection');tab.find.open=false;tab.find.requestId=0;this.layout();if(tab.url)tab.view.webContents.focus();}
 keyInput(event,input){if(input.type!=='keyDown')return;if(input.key==='Escape'&&this.current()?.find.open){event.preventDefault();this.closeFind();this.update();return;}if(input.alt||!(input.meta||input.control))return;const key=String(input.key).toLowerCase();let action,value;if(key==='d'&&!input.shift){action='bookmark';}else if(key==='y'){action='library';value='history';}else if(key==='b'&&input.shift){action='library';value='bookmarks';}else if(key==='l'){event.preventDefault();this.focusControl('address');return;}if(key==='t'){action=input.shift?'reopenTab':'newTab';}else if(key==='w')action='closeTab';else if(key==='f')action='openFind';else if(key==='r')action='reload';else if(['+','='].includes(key)){action='zoom';value='in';}else if(['-','_'].includes(key)){action='zoom';value='out';}else if(key==='0'){action='zoom';value='reset';}if(!action)return;event.preventDefault();void this.action({action,...(value?{value}:{}),...(action==='closeTab'?{id:this.active}:{})}).catch(error=>this.update(publicError(error).message));}

 addTab(url,{record,restore=false,popupOptions=null,officialEntry=null}={}){
  if(this.disposed)fail('CANCELLED');
  if(this.tabs.length>=MAX_TABS)fail('TOO_LARGE');
  const preferences={...popupOptions?.webPreferences,session:this.browserSession,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false};
  const view=new WebContentsView(popupOptions?.webContents?{webContents:popupOptions.webContents}:{webPreferences:preferences}),wc=view.webContents;
  this.downloads.register(wc);wc.setZoomMode('isolated');const tab={id:crypto.randomUUID(),view,load:new BrowserPageLoadState(),officialEntry,url:'',title:record?.title||'新标签页',zoom:record?.zoom||1,restorable:true,restoreURL:null,popupBlank:!!popupOptions,find:{open:false,text:'',matches:0,active:0,requestId:0}};wc.setZoomFactor(tab.zoom);this.tabs.push(tab);this.window.contentView.addChildView(view);this.active=tab.id;this.management=false;this.library=null;this.downloadsOpen=false;this.loginDiagnosticOpen=false;
  const guard=(event,url)=>{try{webURL(url);}catch{this.loginDiagnostics.navigationBlocked(wc.id,url);event.preventDefault();this.update(blockedReason(url)==='tooLong'?'网址超出当前8192字符安全上限，未打开。':'仅支持 http / https 网页地址。');}};
  wc.on('will-navigate',guard);wc.on('will-redirect',guard);wc.on('will-attach-webview',e=>e.preventDefault());
  wc.setWindowOpenHandler(({url,referrer})=>{let policyReason=blockedReason(url);
   // Let Chromium own form bodies, named windows and the opener relationship.
   // In particular, never turn a popup POST into a fresh GET or persist its body.
   try{if(url!=='about:blank')webURL(url);webURL(wc.getURL());if(this.disposed||this.closingWindow){policyReason='disposed';throw Error('POPUP_UNAVAILABLE');}if(this.tabs.length>=MAX_TABS){policyReason='capacity';throw Error('POPUP_UNAVAILABLE');}}
   catch{this.loginDiagnostics.navigationBlocked(wc.id,url,policyReason,'popup');this.update('未打开新窗口：地址不受支持或标签页已达到 20 个。');return{action:'deny'};}
   return{action:'allow',outlivesOpener:true,overrideBrowserWindowOptions:{webPreferences:{session:this.browserSession,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false}},createWindow:options=>{
    const child=this.addTab(undefined,{popupOptions:options,officialEntry:tab.officialEntry}),contents=child.view.webContents;this.loginDiagnostics.trackPopup(wc.id,contents.id);if(url!=='about:blank')child.load.begin(url,true);
    // Electron supplies an existing guest for window.open/forms. OpenURLFromTab
    // links have no guest; only that GET-only path needs explicit navigation.
    if(!options.webContents&&url!=='about:blank'){void contents.loadURL(url,{httpReferrer:referrer}).catch(()=>this.update());}
    return contents;
   }};
  });
  if(popupOptions){
   wc.on('close',()=>{if(this.tabs.includes(tab)&&!this.closingWindow&&!this.disposed)this.closeTab(tab.id);});
   wc.once('destroyed',()=>{const index=this.tabs.indexOf(tab);if(index<0||this.closingWindow||this.disposed)return;this.tabs.splice(index,1);try{this.window?.contentView.removeChildView(view);}catch{}if(this.active===tab.id)this.active=this.tabs[Math.min(index,this.tabs.length-1)]?.id;if(!this.tabs.length)this.addTab();this.layout();this.persist();this.update();});
  }
  wc.on('did-start-navigation',(_event,url,isSameDocument,isMainFrame)=>{if(isMainFrame&&!isSameDocument){tab.load.started(url);if(this.loginDeferred?.contents===wc)this.cancelLoginDeferred();this.update();}});
  wc.on('did-redirect-navigation',(_event,url,_same,isMainFrame)=>{if(isMainFrame){tab.load.redirect(url);this.update();}});
  wc.on('did-navigate',(_event,url)=>{tab.load.commit(url||wc.getURL());});
  wc.on('did-stop-loading',()=>{if(!wc.isDestroyed()){tab.load.stopped(wc.getURL());this.update();}});
  wc.on('responsive',()=>{tab.load.renderer='responsive';this.update();});wc.on('unresponsive',()=>{tab.load.renderer='unresponsive';this.update();});
  const sync=()=>{if(wc.isDestroyed()||this.closingWindow)return;const loadedURL=wc.getURL();if(loadedURL&&loadedURL!=='about:blank'){try{tab.url=webURL(loadedURL);tab.popupBlank=false;if(tab.restorable){tab.restoreURL=automaticPageURL(tab.url);tab.restorable=!!tab.restoreURL;}}catch{return;}}tab.title=tabTitle(wc.getTitle());this.layout();this.update();};
  for(const event of ['did-navigate','did-navigate-in-page','page-title-updated','did-start-loading','did-stop-loading'])wc.on(event,sync);
  for(const event of ['did-navigate','did-navigate-in-page','page-title-updated'])wc.on(event,()=>this.persist());
  const visited=()=>{if(wc.isDestroyed()||this.closingWindow)return;try{const url=automaticPageURL(wc.getURL());tab.historyId=url?this.libraryStore.visit(url,wc.getTitle()):null;}catch{}};
  wc.on('did-navigate',visited);wc.on('did-navigate-in-page',(_event,_url,isMainFrame)=>{if(isMainFrame)visited();});
  wc.on('page-title-updated',()=>{if(tab.historyId&&!wc.isDestroyed()&&automaticPageURL(wc.getURL()))this.libraryStore.updateVisitTitle(tab.historyId,wc.getTitle());});
  wc.on('before-input-event',(event,input)=>this.keyInput(event,input));
  wc.on('found-in-page',(_event,result)=>{if(result.requestId!==tab.find.requestId||!tab.find.open)return;tab.find.matches=result.matches;tab.find.active=result.activeMatchOrdinal;this.update();});
  wc.on('did-finish-load',()=>{if(wc.isDestroyed())return;tab.load.finish(wc.getURL());this.update();wc.setZoomFactor(tab.zoom);if(tab.find.open&&tab.find.text)this.findTextForTab(tab);});
  wc.on('did-fail-load',(_e,code,description,_url,isMainFrame)=>{this.loginDiagnostics.frameFailure(wc.id,_url,code,isMainFrame);if(isMainFrame&&tab.load.fail(_url,code,description))this.update();});
  wc.on('console-message',(details,_level,message,line,sourceId)=>this.loginDiagnostics.console(wc.id,details?.message??message,details?.sourceId??sourceId,details?.lineNumber??line));
  wc.on('render-process-gone',()=>{tab.load.renderer='gone';tab.load.fail(tab.url,-1,'ERR_RENDERER_PROCESS_GONE');this.update();});
  wc.on('context-menu',(_event,params)=>{
   const template=[{label:'剪藏选中文字',enabled:!!params.selectionText.trim(),click:()=>void this.performCapture('selection',tab.id)},{label:'剪藏当前网址',click:()=>void this.performCapture('link',tab.id)},{label:'剪藏可见画面',click:()=>void this.performCapture('screenshot',tab.id)}];
   if(params.mediaType==='image')template.push({label:'剪藏此图片的可见区域',click:()=>void this.performCapture('image',tab.id,{x:params.x,y:params.y})});
   template.push({type:'separator'},{role:'copy'},{role:'paste'});Menu.buildFromTemplate(template).popup({window:this.window});
  });
  this.layout();this.update();if(url)void this.navigate(tab,url);if(!restore)this.persist();return tab;
 }
 findTextForTab(tab){tab.find.requestId=tab.view.webContents.findInPage(tab.find.text,{findNext:true});}
 async navigate(tab,value){const url=navigationURL(value),epoch=tab.load.begin(url,true);tab.officialEntry=officialMailEntries.get(url)||null;tab.url=url;tab.restoreURL=automaticPageURL(url);tab.restorable=!!tab.restoreURL;this.cancelLoginDeferred();this.management=false;this.library=null;this.downloadsOpen=false;this.loginDiagnosticOpen=false;this.layout();this.persist();this.update(this.current()===tab?'正在打开网页…':undefined);try{await tab.view.webContents.loadURL(url);if(tab.load.isCurrent(epoch)){tab.load.finish(tab.view.webContents.getURL());this.update(this.current()===tab?'网页已加载。':undefined);}}catch(error){if(tab.load.isCurrent(epoch)&&error?.code!=='ERR_ABORTED'){tab.load.fail(url,error?.errno||-2,error?.code);this.update();}}}
 async chooseTarget(){const result=await dialog.showOpenDialog(this.window||this.getMainWindow(),{title:'选择剪藏保存文件夹',properties:['openDirectory'],filters:[{name:'文件夹',extensions:['*']}]});if(!result.canceled){const vault=await this.vaults.grantVault(result.filePaths[0]);this.target={vaultId:vault.id,parentPath:''};this.update('剪藏将保存到：'+vault.name);}}
 async importClip(value){
  const target=await validateTarget(this.vaults,value),result=await dialog.showOpenDialog(this.window||this.getMainWindow(),{title:'导入 Chrome / Safari 剪藏文件',properties:['openFile'],filters:[{name:displayBrand(appLocale(this.app))+' '+(appLocale(this.app).startsWith('zh')?'剪藏':'Web clip'),extensions:['inkclip']}]});
  if(result.canceled)return null;const clip=await readClipFile(result.filePaths[0]);
  const answer=await dialog.showMessageBox(this.window||this.getMainWindow(),{title:'导入网页剪藏',message:clip.title,detail:`来源：${clip.url}\n保存到：${target.boardPath||target.parentPath||'所选资料库根目录'}\n\n${clip.text.slice(0,500)}`,buttons:['取消','导入'],defaultId:1,cancelId:0,noLink:true});if(answer.response!==1)return null;
  return saveClip(this.vaults,target,clip,{nativeImage});
 }
 async performCapture(kind,id=this.active,point){
  if(this.busy)return;this.busy=true;this.update('正在剪藏…');
  try{if(!this.target)await this.chooseTarget();if(!this.target)return;const tab=this.tabs.find(t=>t.id===id);if(!tab)fail('INVALID_REQUEST');const wc=tab.view.webContents,url=webURL(wc.getURL());
   const target={...this.target},extracted=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:EXTRACT}]);if(wc.getURL()!==url)fail('CONFLICT');
   const title=String(extracted.title||'网页剪藏').slice(0,512);let result;
   if(kind==='pdf'){result=await savePDF(this.vaults,target,await wc.printToPDF({printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:'<div style="font-size:8px;margin:0 20px;">'+escapeHTML(title)+'</div>',footerTemplate:'<div style="font-size:8px;margin:0 20px;">'+escapeHTML(url)+'</div>'}),title,{url,capturedAt:new Date().toISOString()});}
   else{
    let imageDataURL;
    if(kind==='screenshot'||kind==='image'){
     let rect;if(kind==='image'){
      if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))fail('INVALID_REQUEST');
      rect=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:`(()=>{const e=document.elementFromPoint(${Math.round(point.x)},${Math.round(point.y)});if(!e||e.tagName!=='IMG')return null;const r=e.getBoundingClientRect(),x=Math.max(0,Math.floor(r.x)),y=Math.max(0,Math.floor(r.y));return {x,y,width:Math.min(innerWidth,Math.floor(r.right))-x,height:Math.min(innerHeight,Math.floor(r.bottom))-y}})()`}]);
      if(!rect||!['x','y','width','height'].every(k=>Number.isSafeInteger(rect[k])&&rect[k]>=0)||rect.width<1||rect.height<1||rect.width*rect.height>16*1024*1024)fail('INVALID_REQUEST');
     }
     imageDataURL=(await captureVisible(wc,rect)).toDataURL();
    }
    const clip=normalizeClip({format:'inkspace-clip',version:1,kind,title,url,text:kind==='selection'?extracted.selection:kind==='page'?extracted.text:'',capturedAt:new Date().toISOString(),...(imageDataURL?{imageDataURL}:{})});
    if(wc.getURL()!==url)fail('CONFLICT');result=await saveClip(this.vaults,target,clip,{nativeImage});
   }
   this.update(result.warning||'已保存：'+result.path);
  }catch(error){this.diagnostics?.record('browser-capture',error);this.update(error?.code==='INVALID_REQUEST'?'没有可剪藏的内容，请先选中文字或打开网页。':error?.code==='CONFLICT'?'网页或白板发生变化，请重试剪藏。':'剪藏未完成：'+publicError(error).message);}
  finally{this.busy=false;this.update();}
 }
 cancelLoginDeferred(){const task=this.loginDeferred;if(!task)return;this.loginDeferred=null;task.contents.removeListener('did-stop-loading',task.listener);}
 stopLoginDiagnostics(reason='user'){this.cancelLoginDeferred();clearTimeout(this.loginExpiryTimer);this.loginExpiryTimer=null;if(this.loginInFlight)this.loginInFlight.abandoned=true;this.loginDiagnostics.stop(reason);}
 nativeLoginState(tab,role){const wc=tab?.view.webContents;const read=name=>{try{const value=typeof wc?.[name]==='function'?wc[name]():null;return typeof value==='boolean'?value:null;}catch{return null;}};let url=tab?.url||'';try{url=wc.getURL()||url;}catch{}return{role,url,targetURL:tab?.load.url,isLoading:read('isLoading'),isLoadingMainFrame:read('isLoadingMainFrame'),isWaitingForResponse:read('isWaitingForResponse'),isCrashed:read('isCrashed'),isDestroyed:read('isDestroyed'),renderer:tab?.load.renderer||'unknown'};}
 captureLoginNative(){const run=this.loginDiagnostics.run,current=this.current();if(!run||!this.loginDiagnostics.active(run.id))return;const target=this.tabs.find(t=>t.view.webContents.id===run.startId);if(target)this.loginDiagnostics.native(run.id,target.view.webContents.id,this.nativeLoginState(target,'target'));if(current&&current!==target)this.loginDiagnostics.native(run.id,current.view.webContents.id,this.nativeLoginState(current,'current'));if(current)this.loginDiagnostics.context(current.view.webContents.id,this.nativeLoginState(current,'current').url);}
 async captureLoginStructure(){
  const run=this.loginDiagnostics.run,tab=this.current();if(!run||!this.loginDiagnostics.active(run.id))return;this.captureLoginNative();
  if(!tab||!run.tracked.has(tab.view.webContents.id)){this.loginDiagnostics.structureUnavailable(run.id,run.startId,'target-changed');return;}
  const contents=tab.view.webContents,epoch=tab.load.epoch,native=this.nativeLoginState(tab,'current');
  if(native.isDestroyed===true||native.isCrashed===true||native.isLoadingMainFrame===null){this.loginDiagnostics.structureUnavailable(run.id,contents.id,'target-unavailable');return;}
  if(native.isLoadingMainFrame===true){
   this.loginDiagnostics.structureUnavailable(run.id,contents.id,'deferred-loading');
   if(this.loginDeferred?.runId===run.id&&this.loginDeferred.contents===contents&&this.loginDeferred.epoch===epoch)return;
   this.cancelLoginDeferred();const task={runId:run.id,contents,epoch,listener:null};task.listener=()=>{if(this.loginDeferred!==task)return;this.cancelLoginDeferred();if(this.loginDiagnostics.active(task.runId)&&this.current()===tab&&tab.load.isCurrent(task.epoch))void this.captureLoginStructure().then(()=>this.update());};this.loginDeferred=task;contents.once('did-stop-loading',task.listener);return;
  }
  this.cancelLoginDeferred();if(this.loginInFlight){this.loginDiagnostics.structureUnavailable(run.id,contents.id,'pending');return;}
  const sample={runId:run.id,contentsId:contents.id,epoch,targetURL:tab.load.url,pageURL:native.url,abandoned:false};this.loginInFlight=sample;let timer;
  // The native call has no cancellation API. Keep its slot until it actually
  // settles, even after the1500ms UI timeout, so repeated actions cannot pile up.
  const task=Promise.resolve().then(()=>contents.executeJavaScriptInIsolatedWorld(1002,[{code:STRUCTURE_SCRIPT}])).then(value=>({status:'success',value}),()=>({status:'rejected'}));
  void task.then(()=>{if(this.loginInFlight===sample)this.loginInFlight=null;});
  try{const result=await Promise.race([task,new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout'}),1500);})]);
   if(sample.abandoned||!this.loginDiagnostics.active(run.id))return;
   if(this.current()!==tab||!tab.load.isCurrent(epoch)||tab.load.url!==sample.targetURL||this.nativeLoginState(tab,'current').url!==sample.pageURL){this.loginDiagnostics.structureUnavailable(run.id,contents.id,'target-changed');return;}
   if(result.status==='success')this.loginDiagnostics.structure(run.id,contents.id,result.value);else this.loginDiagnostics.structureUnavailable(run.id,contents.id,result.status);
  }finally{clearTimeout(timer);}
 }
 async exportLoginDiagnostics(){
  const report=this.loginDiagnostics.snapshot();if(!report)fail('INVALID_REQUEST');
  const result=await dialog.showSaveDialog(this.window,{title:'保存脱敏登录诊断（本机 JSON）',defaultPath:'LW-login-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return{exported:false};
  const fs=require('node:fs/promises'),destination=result.filePath,temp=path.join(path.dirname(destination),'.lw-login-'+crypto.randomUUID()+'.tmp');let handle;
  try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.sync();await handle.close();handle=null;await fs.rename(temp,destination);return{exported:true};}
  finally{if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
 }
 async action(request){
  if(this.disposed)fail('CANCELLED');
  object(request,['action','value','id']);string(request.action,40);
  const current=this.current();
  switch(request.action){
   case'state':return this.state();
   case'loginDiagnosticsOpen':if(typeof request.value!=='boolean'||request.id!==undefined)fail('INVALID_REQUEST');this.loginDiagnosticOpen=request.value;if(request.value){this.management=false;this.library=null;this.downloadsOpen=false;await this.captureLoginStructure();}this.layout();break;
   case'loginDiagnosticsStart':{if(request.value!==undefined||request.id!==undefined||!current?.url)fail('INVALID_REQUEST');this.stopLoginDiagnostics('replaced');let ua='';try{ua=current.view.webContents.getUserAgent();}catch{}const runId=this.loginDiagnostics.start(current.view.webContents.id,{electronVersion:process.versions.electron,chromiumVersion:process.versions.chrome,electronUserAgent:/Electron\//.test(ua),enabledExtensionCount:this.extensions.list().filter(e=>e.enabled).length,tabCount:this.tabs.length,startURL:this.nativeLoginState(current,'current').url});this.loginExpiryTimer=setTimeout(()=>{if(this.loginDiagnostics.run?.id===runId){this.stopLoginDiagnostics('timeout');this.update();}},DURATION_MS);this.loginExpiryTimer.unref?.();await this.captureLoginStructure();if(this.loginDiagnostics.active(runId)){this.loginDiagnosticOpen=false;this.layout();this.update('已开始最多120秒的脱敏诊断；请在当前标签手动操作，不会自动刷新或提交。');}break;}
   case'loginDiagnosticsRefresh':if(request.value!==undefined||request.id!==undefined)fail('INVALID_REQUEST');await this.captureLoginStructure();break;
   case'loginDiagnosticsStop':if(request.value!==undefined||request.id!==undefined)fail('INVALID_REQUEST');this.captureLoginNative();this.stopLoginDiagnostics('user');this.update('脱敏诊断已停止；报告已冻结，未自动保存或上传。');break;
   case'loginDiagnosticsExport':if(request.value!==undefined||request.id!==undefined)fail('INVALID_REQUEST');return await this.exportLoginDiagnostics();
   case'controlsFailed':if(!['render','transport'].includes(request.value)||request.id!==undefined)fail('INVALID_REQUEST');this.diagnostics?.record('browserControls',{code:'IO_FAILED'});return{reported:true};
   case'navigate':if(current)await this.navigate(current,request.value);break;
   case'newTab':this.addTab();this.focusControl('address');break;
   case'reopenTab':this.reopenTab();break;
   case'openFind':this.openFind();break;
   case'find':object(request.value,['text','next','forward']);if(request.value.next!==undefined&&typeof request.value.next!=='boolean'||request.value.forward!==undefined&&typeof request.value.forward!=='boolean')fail('INVALID_REQUEST');this.findText(request.value.text,request.value.next,request.value.forward);break;
   case'closeFind':this.closeFind();break;
   case'zoom':this.setPageZoom(request.value);break;
   case'selectTab':this.selectTab(request.id);break;
   case'closeTab':this.closeTab(request.id);break;
   case'back':if(current?.view.webContents.navigationHistory.canGoBack())current.view.webContents.navigationHistory.goBack();break;
   case'forward':if(current?.view.webContents.navigationHistory.canGoForward())current.view.webContents.navigationHistory.goForward();break;
   case'reload':if(current?.url)current.view.webContents.reload();break;
   case'capture':if(!['page','selection','link','screenshot','pdf'].includes(request.value))fail('INVALID_REQUEST');await this.performCapture(request.value);break;
   case'chooseTarget':if(this.busy)fail('BUSY');await this.chooseTarget();break;
   case'targetFolder':if(this.target)delete this.target.boardPath;break;
   case'importClip':if(!this.target)await this.chooseTarget();if(this.target){const result=await this.importClip(this.target);if(result)this.update(result.warning||'已导入：'+result.path);}break;
   case'systemBrowser':if(current?.url){const entry=current.officialEntry,authOrFailure=current.load.method!=='GET'||!!current.load.error||!automaticPageURL(current.url)||(entry&&new URL(current.url).hostname!==new URL(entry.url).hostname);if(authOrFailure&&!entry){this.update('此认证或失败页面不会转交当前网址；请先从邮箱官方入口打开。');break;}const url=authOrFailure?entry.url:webURL(current.url);const answer=await dialog.showMessageBox(this.window,{title:'在系统浏览器打开',message:authOrFailure?'从'+entry.label+'开始新的登录？':'将当前网址交给默认浏览器？',detail:authOrFailure?'仅打开固定官方入口；系统浏览器使用独立会话，需要本人登录。不会转交当前认证网址、表单或Cookie。':url,buttons:['取消','打开'],defaultId:0,cancelId:0,noLink:true});if(answer.response===1)await shell.openExternal(url);}break;
   case'pageRecoverBack':if(request.value!==undefined||request.id!==undefined)fail('INVALID_REQUEST');if(current?.load.error&&current.view.webContents.navigationHistory.canGoBack())current.view.webContents.navigationHistory.goBack();break;
   case'pageRecoverSchool':if(request.value!==undefined||request.id!==undefined||!schoolRecoveryURL(current?.load.error?.host))fail('INVALID_REQUEST');await this.openURL(schoolRecoveryURL(current.load.error.host));break;
   case'pageRecoverOfficial':if(request.value!==undefined||request.id!==undefined||!current?.load.error||!current.officialEntry)fail('INVALID_REQUEST');await this.openURL(current.officialEntry.url);break;
   case'bookmark':if(current){const url=webURL(current.view.webContents.getURL());if(this.libraryStore.hasBookmark(url)){const item=this.libraryStore.data.bookmarks.find(v=>v.url===url);if(this.libraryStore.removeBookmark(item.id))this.update('已取消书签。');}else if(this.libraryStore.bookmark(url,current.title))this.update('已添加书签。');}break;
   case'library':if(!['bookmarks','history',null].includes(request.value))fail('INVALID_REQUEST');this.library=request.value;this.librarySearch='';this.libraryLimit=100;this.management=false;this.downloadsOpen=false;this.loginDiagnosticOpen=false;this.layout();this.update();if(this.library)this.focusControl('librarySearch');break;
   case'librarySearch':string(request.value,512);this.librarySearch=request.value;this.libraryLimit=100;break;
   case'libraryMore':this.libraryLimit=Math.min(50000,this.libraryLimit+100);break;
   case'libraryOpen':string(request.id,64);{const source=this.library==='bookmarks'?this.libraryStore.data.bookmarks:this.library==='history'?this.libraryStore.data.history:[];const entry=source.find(v=>v.id===request.id);if(!entry)fail('INVALID_REQUEST');if(!current)this.addTab();await this.navigate(this.current(),entry.url);}break;
   case'libraryEdit':if(this.library!=='bookmarks')fail('INVALID_REQUEST');{const edit=this.libraryStore.editBookmark(request.id,request.value);this.update(edit.saved?'书签已更新。':undefined);return{...this.state(),bookmarkEditResult:edit};}
   case'libraryDelete':string(request.id,64);if(this.library==='bookmarks')this.libraryStore.removeBookmark(request.id);else if(this.library==='history')this.libraryStore.removeVisit(request.id);else fail('INVALID_REQUEST');break;
   case'clearHistory':{const answer=await dialog.showMessageBox(this.window,{title:'清空浏览历史',message:'清空此浏览器的全部浏览历史？',detail:'书签、已打开网页和登录状态会保留。',buttons:['取消','清空历史'],defaultId:0,cancelId:0,noLink:true});if(answer.response===1&&this.libraryStore.clearHistory())this.update('浏览历史已清空。');}break;
   case'extensions':this.management=!!request.value;this.library=null;this.downloadsOpen=false;this.loginDiagnosticOpen=false;this.layout();break;
   case'downloads':if(typeof request.value!=='boolean')fail('INVALID_REQUEST');this.downloadsOpen=request.value;this.loginDiagnosticOpen=false;this.management=false;this.library=null;this.layout();break;
   case'downloadSearch':string(request.value,512);this.downloadSearch=request.value;this.downloadLimit=50;break;
   case'downloadMore':this.downloadLimit=Math.min(1000,this.downloadLimit+50);break;
   case'downloadPause':case'downloadResume':case'downloadCancel':case'downloadOpen':case'downloadReveal':if(request.value!==undefined)fail('INVALID_REQUEST');try{await this.downloads.action(request.action.slice(8).toLowerCase(),request.id);}catch{this.update('下载状态已变化或当前操作不可用，请查看下载中心。');}break;
   case'installExtension':await extensionOwners.run(this,()=>this.extensions.action('install'));this.update('扩展列表已更新；必要时刷新网页。');break;
   case'toggleExtension':case'removeExtension':string(request.id,36);await extensionOwners.run(this,()=>this.extensions.action(request.action==='toggleExtension'?'toggle':'remove',request.id));break;
   default:fail('INVALID_REQUEST');
  }
  this.update();return this.state();
 }
 dispose(){if(this.disposed)return;this.stopLoginDiagnostics('window-closed');this.loginDiagnostics.clear();this.persist();this.disposed=true;this.libraryUnsubscribe();browserOwners.get(this.browserSession)?.delete(this);this.downloads.dispose();this.ipcMain.removeHandler('browser:action');if(this.window&&!this.window.isDestroyed())this.window.destroy();}
}
module.exports={BrowserService};

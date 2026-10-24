'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {BrowserWindow,WebContentsView,session,ipcMain,dialog,Menu,nativeImage,shell}=require('electron');
const {fail,publicError}=require('./errors.cjs');
const {object,string,webURL,navigationURL,normalizeClip}=require('./browser-security.cjs');
const {validateTarget,saveClip,savePDF,readClipFile}=require('./browser-clips.cjs');
const {BrowserExtensions}=require('./browser-extensions.cjs');
const {browserStateForApp,MAX_TABS}=require('./browser-state.cjs');
const {AsyncLocalStorage}=require('node:async_hooks');
const extensionOwners=new AsyncLocalStorage(),sharedExtensions=new WeakMap(),browserOwners=new WeakMap();
const CHROME_HEIGHT=156;
const stableZoom=value=>Number.isFinite(value)?Math.min(5,Math.max(.25,Math.round(value*1e6)/1e6)):1;
const tabTitle=value=>String(value||'新标签页').replace(/\0/g,'').slice(0,200).toWellFormed()||'新标签页';
const escapeHTML=value=>String(value).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
async function captureVisible(contents,rect){for(let attempt=0;attempt<2;attempt++){try{const image=rect?await contents.capturePage(rect):await contents.capturePage();if(!image.isEmpty())return image;}catch(error){if(attempt)throw error;}await new Promise(resolve=>setTimeout(resolve,120));}fail('IO_FAILED');}
const EXTRACT=`(()=>({title:String(document.title||'网页剪藏').slice(0,512),selection:String(window.getSelection()?.toString()||'').slice(0,90000),text:String(document.body?.innerText||'').slice(0,90000)}))()`;
class BrowserService{
 constructor({app,vaults,getMainWindow,diagnostics,ipc=ipcMain}){
  Object.assign(this,{app,vaults,getMainWindow,diagnostics});this.ipcMain=ipc;this.disposed=false;this.window=null;this.tabs=[];this.active=null;this.target=null;this.status='输入网址或关键词开始浏览';this.busy=false;this.management=false;
  this.sessionState=browserStateForApp(app);this.closedTabs=[];this.sessionRecordId=null;this.restoring=false;this.closingWindow=false;
  this.shellPath=path.join(__dirname,'..','browser','browser.html');this.shellURL=pathToFileURL(this.shellPath).href;
  this.browserSession=session.fromPartition('persist:inkspace-browser-v1');
  this.browserSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  this.browserSession.setPermissionCheckHandler(()=>false);
  this.browserSession.setDevicePermissionHandler(()=>false);
  let owners=browserOwners.get(this.browserSession);if(!owners){owners=new Set();browserOwners.set(this.browserSession,owners);const browserSession=this.browserSession;
   browserSession.webRequest.onBeforeRequest((details,callback)=>{let allowed=false;try{const url=new URL(details.url);allowed=['http:','https:','ws:','wss:','data:','blob:'].includes(url.protocol)||(url.protocol==='chrome-extension:'&&(!!browserSession.extensions.getExtension(url.hostname)||url.hostname==='mhjfbmdgcfjbbpaeojofohoefgiehjai'));}catch{}
    if(allowed&&details.resourceType==='mainFrame')for(const owner of owners)owner.recordNavigationMethod(details);callback({cancel:!allowed});});
  }owners.add(this);
  this.onDownload=(_event,item,contents)=>{if(!this.tabs.some(tab=>tab.view.webContents===contents))return;item.setSaveDialogOptions({title:'保存浏览器下载文件',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_'))});item.once('done',(_e,state)=>this.update(state==='completed'?'下载完成':'下载已取消或失败'));};this.browserSession.on('will-download',this.onDownload);
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
   this.window=new BrowserWindow({width:1180,height:830,minWidth:880,minHeight:560,title:'人生赢家 · 浏览器',backgroundColor:'#f6f7fa',show:false,webPreferences:{session:this.uiSession,preload:path.join(__dirname,'..','preload','browser.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false}});
   this.window.webContents.setWindowOpenHandler(()=>({action:'deny'}));this.window.webContents.on('will-navigate',e=>e.preventDefault());this.window.webContents.on('will-attach-webview',e=>e.preventDefault());
   this.window.webContents.on('before-input-event',(event,input)=>this.keyInput(event,input));
   this.window.on('resize',()=>this.layout());this.window.on('close',()=>{this.persist();this.closingWindow=true;});this.window.on('closed',()=>{for(const tab of this.tabs)if(!tab.view.webContents.isDestroyed())tab.view.webContents.close();this.sessionState.release(this.sessionRecordId);this.tabs=[];this.active=null;this.window=null;this.management=false;this.closingWindow=false;});
   this.window.webContents.once('did-finish-load',()=>{this.update();this.window?.show();});await this.window.loadFile(this.shellPath);if(this.disposed)fail('CANCELLED');this.restoreTabs();
  }
  if(this.window.isMinimized())this.window.restore();this.window.show();this.window.focus();this.update();return{opened:true};
 }
 state(){const current=this.current();return{tabs:this.tabs.map(t=>({id:t.id,title:t.title,url:t.url,loading:t.view.webContents.isLoading()})),active:this.active,url:current?.url||'',canGoBack:current?.view.webContents.navigationHistory.canGoBack()||false,canGoForward:current?.view.webContents.navigationHistory.canGoForward()||false,target:this.target?{label:this.target.boardPath||this.target.parentPath||'资料库根目录',board:!!this.target.boardPath}:null,status:this.status,busy:this.busy,management:this.management,extensions:this.extensions.list(),canReopenTab:this.closedTabs.length>0,zoom:current&&!current.view.webContents.isDestroyed()?current.view.webContents.getZoomFactor():1,find:current?{open:current.find.open,text:current.find.text,matches:current.find.matches,active:current.find.active}:null,sessionWarning:this.sessionState.warning};}
 update(status){if(status)this.status=String(status).slice(0,1000);if(this.window&&!this.window.isDestroyed())this.window.webContents.send('browser:state',this.state());}
 current(){return this.tabs.find(t=>t.id===this.active);}
 layout(){if(!this.window||this.window.isDestroyed())return;const [width,height]=this.window.getContentSize(),top=CHROME_HEIGHT+(this.current()?.find.open&&!this.management?38:0);for(const tab of this.tabs){tab.view.setVisible(tab.id===this.active&&!this.management&&!!tab.url);tab.view.setBounds({x:0,y:top,width,height:Math.max(1,height-top)});}}
 snapshotTab(tab){let url=null;try{if(tab.restorable&&tab.restoreURL)url=webURL(tab.restoreURL);}catch{}return {url,title:url?tabTitle(tab.title):'新标签页',zoom:stableZoom(tab.view.webContents.isDestroyed()?tab.zoom:tab.view.webContents.getZoomFactor())};}
 persist(){if(this.restoring||this.closingWindow||!this.sessionRecordId||!this.tabs.length)return;try{const previousWarning=this.sessionState.warning;this.sessionState.update({id:this.sessionRecordId,tabs:this.tabs.map(t=>this.snapshotTab(t)),activeIndex:Math.max(0,this.tabs.findIndex(t=>t.id===this.active)),closedTabs:this.closedTabs});if(previousWarning!==this.sessionState.warning)this.update();}catch(error){this.diagnostics?.record('browser-session',error);}}
 restoreTabs(){const saved=this.sessionState.acquire(this.sessionRecordId);this.sessionRecordId=saved.id;this.closedTabs=saved.closedTabs;this.restoring=true;try{for(const record of saved.tabs)this.addTab(record.url,{record,restore:true});this.active=this.tabs[saved.activeIndex]?.id||this.tabs[0]?.id;}finally{this.restoring=false;}this.persist();this.layout();}
 recordNavigationMethod(details){const tab=this.tabs.find(t=>t.view.webContents.id===details.webContentsId);if(!tab)return;tab.restorable=details.method==='GET';try{tab.restoreURL=tab.restorable?webURL(details.url):null;}catch{tab.restorable=false;tab.restoreURL=null;}this.persist();}
 focusControl(id){if(!this.window||this.window.isDestroyed())return;this.window.webContents.focus();this.window.webContents.send('browser:focus',id);}
 selectTab(id){if(!this.tabs.some(t=>t.id===id))fail('INVALID_REQUEST');this.active=id;this.management=false;this.layout();this.persist();}
 closeTab(id){const index=this.tabs.findIndex(t=>t.id===id);if(index<0)fail('INVALID_REQUEST');const tab=this.tabs[index];this.closedTabs.push(this.snapshotTab(tab));this.closedTabs=this.closedTabs.slice(-MAX_TABS);this.tabs.splice(index,1);this.window.contentView.removeChildView(tab.view);tab.view.webContents.close();if(this.active===tab.id)this.active=this.tabs[Math.min(index,this.tabs.length-1)]?.id;if(!this.tabs.length)this.addTab();this.layout();this.persist();}
 reopenTab(){if(!this.closedTabs.length)return;if(this.tabs.length>=MAX_TABS)fail('TOO_LARGE');const record=this.closedTabs.pop();this.addTab(record.url,{record,restore:true});this.persist();}
 setPageZoom(direction){const tab=this.current();if(!tab)return;const wc=tab.view.webContents,steps=[.25,.33,.5,.67,.75,.8,.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5],now=wc.getZoomFactor();let next=1;if(direction==='in')next=steps.find(s=>s>now+.005)||5;else if(direction==='out')next=[...steps].reverse().find(s=>s<now-.005)||.25;else if(direction!=='reset')fail('INVALID_REQUEST');wc.setZoomFactor(next);tab.zoom=next;this.persist();}
 openFind(){const tab=this.current();if(!tab?.url){this.focusControl('address');return;}tab.find.open=true;this.management=false;this.layout();this.update();this.focusControl('findText');}
 findText(text,next=false,forward=true){const tab=this.current();if(!tab)return;string(text,512);tab.find.open=true;tab.find.text=text;tab.find.matches=0;tab.find.active=0;if(!text){tab.view.webContents.stopFindInPage('clearSelection');tab.find.requestId=0;}else tab.find.requestId=tab.view.webContents.findInPage(text,{findNext:!next,forward});this.layout();}
 closeFind(){const tab=this.current();if(!tab)return;tab.view.webContents.stopFindInPage('clearSelection');tab.find.open=false;tab.find.requestId=0;this.layout();if(tab.url)tab.view.webContents.focus();}
 keyInput(event,input){if(input.type!=='keyDown')return;if(input.key==='Escape'&&this.current()?.find.open){event.preventDefault();this.closeFind();this.update();return;}if(input.alt||!(input.meta||input.control))return;const key=String(input.key).toLowerCase();let action,value;if(key==='l'){event.preventDefault();this.focusControl('address');return;}if(key==='t'){action=input.shift?'reopenTab':'newTab';}else if(key==='w')action='closeTab';else if(key==='f')action='openFind';else if(key==='r')action='reload';else if(['+','='].includes(key)){action='zoom';value='in';}else if(['-','_'].includes(key)){action='zoom';value='out';}else if(key==='0'){action='zoom';value='reset';}if(!action)return;event.preventDefault();void this.action({action,...(value?{value}:{}),...(action==='closeTab'?{id:this.active}:{})}).catch(error=>this.update(publicError(error).message));}

 addTab(url,{record,restore=false}={}){
  if(this.disposed)fail('CANCELLED');
  if(this.tabs.length>=MAX_TABS)fail('TOO_LARGE');
  const view=new WebContentsView({webPreferences:{session:this.browserSession,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false}}),wc=view.webContents;
  wc.setZoomMode('isolated');const tab={id:crypto.randomUUID(),view,url:'',title:record?.title||'新标签页',zoom:record?.zoom||1,restorable:true,restoreURL:null,find:{open:false,text:'',matches:0,active:0,requestId:0}};wc.setZoomFactor(tab.zoom);this.tabs.push(tab);this.window.contentView.addChildView(view);this.active=tab.id;this.management=false;
  const guard=(event,url)=>{try{webURL(url);}catch{event.preventDefault();this.update('仅支持 http / https 网页地址。');}};
  wc.on('will-navigate',guard);wc.on('will-redirect',guard);wc.on('will-attach-webview',e=>e.preventDefault());
  wc.setWindowOpenHandler(({url,postBody})=>{if(postBody){this.update('此新窗口包含表单提交，请在当前网页继续操作；不会保存或重放提交内容。');return{action:'deny'};}try{this.addTab(webURL(url));}catch{this.update('未打开新窗口：地址不受支持或标签页已达到 20 个。');}return{action:'deny'};});
  const sync=()=>{if(wc.isDestroyed()||this.closingWindow)return;const loadedURL=wc.getURL();if(loadedURL&&loadedURL!=='about:blank'){try{tab.url=webURL(loadedURL);if(tab.restorable)tab.restoreURL=tab.url;}catch{return;}}tab.title=tabTitle(wc.getTitle());this.layout();this.update();};
  for(const event of ['did-navigate','did-navigate-in-page','page-title-updated','did-start-loading','did-stop-loading'])wc.on(event,sync);
  for(const event of ['did-navigate','did-navigate-in-page','page-title-updated'])wc.on(event,()=>this.persist());
  wc.on('before-input-event',(event,input)=>this.keyInput(event,input));
  wc.on('found-in-page',(_event,result)=>{if(result.requestId!==tab.find.requestId||!tab.find.open)return;tab.find.matches=result.matches;tab.find.active=result.activeMatchOrdinal;this.update();});
  wc.on('did-finish-load',()=>{if(wc.isDestroyed())return;wc.setZoomFactor(tab.zoom);if(tab.find.open&&tab.find.text)this.findTextForTab(tab);});
  wc.on('did-fail-load',(_e,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)this.update(`网页加载失败：${description}`);});
  wc.on('render-process-gone',()=>this.update('网页进程已结束，点击刷新重新打开。'));
  wc.on('context-menu',(_event,params)=>{
   const template=[{label:'剪藏选中文字',enabled:!!params.selectionText.trim(),click:()=>void this.performCapture('selection',tab.id)},{label:'剪藏当前网址',click:()=>void this.performCapture('link',tab.id)},{label:'剪藏可见画面',click:()=>void this.performCapture('screenshot',tab.id)}];
   if(params.mediaType==='image')template.push({label:'剪藏此图片的可见区域',click:()=>void this.performCapture('image',tab.id,{x:params.x,y:params.y})});
   template.push({type:'separator'},{role:'copy'},{role:'paste'});Menu.buildFromTemplate(template).popup({window:this.window});
  });
  this.layout();this.update();if(url)void this.navigate(tab,url);if(!restore)this.persist();return tab;
 }
 findTextForTab(tab){tab.find.requestId=tab.view.webContents.findInPage(tab.find.text,{findNext:true});}
 async navigate(tab,value){const url=navigationURL(value);tab.url=url;tab.restoreURL=url;tab.restorable=true;this.management=false;this.layout();this.persist();this.update('正在打开网页…');try{await tab.view.webContents.loadURL(url);this.update('网页已加载。');}catch(error){if(error?.code!=='ERR_ABORTED')this.update('网页加载失败，请检查网址或网络。');}}
 async chooseTarget(){const result=await dialog.showOpenDialog(this.window||this.getMainWindow(),{title:'选择剪藏保存文件夹',properties:['openDirectory'],filters:[{name:'文件夹',extensions:['*']}]});if(!result.canceled){const vault=await this.vaults.grantVault(result.filePaths[0]);this.target={vaultId:vault.id,parentPath:''};this.update('剪藏将保存到：'+vault.name);}}
 async importClip(value){
  const target=await validateTarget(this.vaults,value),result=await dialog.showOpenDialog(this.window||this.getMainWindow(),{title:'导入 Chrome / Safari 剪藏文件',properties:['openFile'],filters:[{name:'人生赢家剪藏',extensions:['inkclip']}]});
  if(result.canceled)return null;const clip=await readClipFile(result.filePaths[0]);
  const answer=await dialog.showMessageBox(this.window||this.getMainWindow(),{title:'导入网页剪藏',message:clip.title,detail:`来源：${clip.url}\n保存到：${target.boardPath||target.parentPath||'所选资料库根目录'}\n\n${clip.text.slice(0,500)}`,buttons:['取消','导入'],defaultId:1,cancelId:0,noLink:true});if(answer.response!==1)return null;
  return saveClip(this.vaults,target,clip,{nativeImage});
 }
 async performCapture(kind,id=this.active,point){
  if(this.busy)return;this.busy=true;this.update('正在剪藏…');
  try{if(!this.target)await this.chooseTarget();if(!this.target)return;const tab=this.tabs.find(t=>t.id===id);if(!tab)fail('INVALID_REQUEST');const wc=tab.view.webContents,url=webURL(wc.getURL());
   const target={...this.target},extracted=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:EXTRACT}]);if(wc.getURL()!==url)fail('CONFLICT');
   const title=String(extracted.title||'网页剪藏').slice(0,512);let result;
   if(kind==='pdf'){result=await savePDF(this.vaults,target,await wc.printToPDF({printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:'<div style="font-size:8px;margin:0 20px;">'+escapeHTML(title)+'</div>',footerTemplate:'<div style="font-size:8px;margin:0 20px;">'+escapeHTML(url)+'</div>'}),title);}
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
 async action(request){
  if(this.disposed)fail('CANCELLED');
  object(request,['action','value','id']);string(request.action,40);
  const current=this.current();
  switch(request.action){
   case'state':return this.state();
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
   case'systemBrowser':if(current?.url){const url=webURL(current.url);const answer=await dialog.showMessageBox(this.window,{title:'在系统浏览器打开',message:'将当前网址交给默认浏览器？',detail:url,buttons:['取消','打开'],defaultId:0,cancelId:0,noLink:true});if(answer.response===1)await shell.openExternal(url);}break;
   case'extensions':this.management=!!request.value;this.layout();break;
   case'installExtension':await extensionOwners.run(this,()=>this.extensions.action('install'));this.update('扩展列表已更新；必要时刷新网页。');break;
   case'toggleExtension':case'removeExtension':string(request.id,36);await extensionOwners.run(this,()=>this.extensions.action(request.action==='toggleExtension'?'toggle':'remove',request.id));break;
   default:fail('INVALID_REQUEST');
  }
  this.update();return this.state();
 }
 dispose(){if(this.disposed)return;this.persist();this.disposed=true;browserOwners.get(this.browserSession)?.delete(this);this.browserSession.removeListener('will-download',this.onDownload);this.ipcMain.removeHandler('browser:action');if(this.window&&!this.window.isDestroyed())this.window.destroy();}
}
module.exports={BrowserService};

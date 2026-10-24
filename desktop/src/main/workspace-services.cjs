'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {VaultWatcher}=require('./vault-watch.cjs');
const {VaultWatchLifecycle}=require('./vault-watch-lifecycle.cjs');
const {VideoService}=require('./video-service.cjs');
const {PythonService}=require('./python-service.cjs');
const {TexService}=require('./tex-service.cjs');

// File authority, write locks and backups stay shared; mutable jobs and native
// controls belong to the window that started them.
function workspaceServiceFactories({app,vaults,windows,auxiliaryIPC,dialog,BrowserWindow,powerMonitor,diagnostics,videoSubtitles,devURL,dataDirectory}){
 const runtimeRoot=path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),'runtime');
 const platform=process.platform==='darwin'&&process.arch==='arm64'?'darwin-arm64':process.platform==='win32'&&process.arch==='x64'?'win32-x64':null;
 const pythonRuntime=platform?path.join(runtimeRoot,'python',platform,...(platform==='darwin-arm64'?['bin','python3']:['python.exe'])):path.join(dataDirectory,'unsupported-runtime');
 let latexCacheReady=null;
 const temporary=context=>context.runtimeDirectory||(context.runtimeDirectory=path.join(dataDirectory,'workspace-runs',crypto.randomUUID()));
 const get=(name,context)=>windows.service(name,factories[name],context);
 const events=(value,context,channel)=>{value.on('event',event=>windows.send(context,channel,event));return value;};
 const factories={
  videos:()=>new VideoService(vaults,{allowAudio:true}),
  videoWindows:context=>new(require('./video-window.cjs').VideoWindowManager)({app,videos:get('videos',context),videoSubtitles,devURL,diagnostics,electron:{BrowserWindow,ipcMain:auxiliaryIPC.scope(contents=>context.services.get('videoWindows')?.owns(contents))}}),
  localOCR:context=>new(require('./local-ocr-service.cjs').LocalOCRService)({vaults,dataDirectory:temporary(context),runtimePath:path.join(runtimeRoot,'nativeOCR',platform==='darwin-arm64'?platform:'unsupported','InkSpaceOCR')}),
  python:context=>events(new PythonService({vaultService:vaults,runtimePath:pythonRuntime,dataDirectory:temporary(context)}),context,'desktop:pythonEvent'),
  notebooks:context=>events(new(require('./notebook-service.cjs').NotebookService)({vaultService:vaults,runtimePath:pythonRuntime,packagesPath:path.join(runtimeRoot,'notebook',platform||'unsupported'),helperPath:path.join(runtimeRoot,'notebook','kernel.py'),dataDirectory:temporary(context)}),context,'desktop:notebookEvent'),
  latex:()=>{const value=new TexService({vaultService:vaults,runtimePath:platform?path.join(runtimeRoot,'latex',platform,platform==='win32-x64'?'tectonic.exe':'tectonic'):path.join(dataDirectory,'unsupported-latex-runtime'),seedCachePath:path.join(runtimeRoot,'latex','basic-cache'),dataDirectory});const prepare=value.prepareCache.bind(value);value.prepareCache=()=>latexCacheReady||(latexCacheReady=prepare().catch(error=>{latexCacheReady=null;throw error;}));return value;},
  nativeInkBridge:()=>new(require('../native/native-ink-bridge.cjs').NativeBoardInkBridge)({runtimePath:path.join(runtimeRoot,'native-ink','darwin-arm64','InkSpaceInkHelper.app','Contents','MacOS','InkSpaceInkHelper')}),
  vaultWatcher:context=>{const value=new VaultWatcher(vaults),lifecycle=new VaultWatchLifecycle(value,{powerMonitor});value.on('change',event=>windows.send(context,'desktop:vaultChange',event));const dispose=value.dispose.bind(value);value.dispose=()=>{lifecycle.dispose();dispose();};return value;},
  mediaEditor:context=>events(new(require('./media-editor-service.cjs').MediaEditorService)({vaults,videos:get('videos',context),dialog,getWindow:()=>context.window,BrowserWindow}),context,'desktop:mediaEditorEvent'),
  browser:context=>new(require('./browser-service.cjs').BrowserService)({app,vaults,getMainWindow:()=>context.window,diagnostics,ipc:auxiliaryIPC.scope(contents=>context.services.get('browser')?.window?.webContents===contents)}),
 };
 return factories;
}
module.exports={workspaceServiceFactories};

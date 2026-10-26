'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {VaultWatcher}=require('./vault-watch.cjs');
const {VaultWatchLifecycle}=require('./vault-watch-lifecycle.cjs');
const {VideoService}=require('./video-service.cjs');
const {PythonService}=require('./python-service.cjs');
const {TexService}=require('./tex-service.cjs');

// File authority, write locks and backups stay shared; mutable jobs and native
// controls belong to the window that started them.
function workspaceServiceFactories({app,vaults,reviews,windows,auxiliaryIPC,dialog,BrowserWindow,nativeImage,powerMonitor,diagnostics,videoSubtitles,devURL,dataDirectory,systemPreferences}){
 const runtimeRoot=path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),'runtime');
 const platform=process.platform==='darwin'&&process.arch==='arm64'?'darwin-arm64':process.platform==='win32'&&process.arch==='x64'?'win32-x64':null;
 const pythonRuntime=platform?path.join(runtimeRoot,'python',platform,...(platform==='darwin-arm64'?['bin','python3']:['python.exe'])):path.join(dataDirectory,'unsupported-runtime');
 let latexCacheReady=null;
 const temporary=context=>context.runtimeDirectory||(context.runtimeDirectory=path.join(dataDirectory,'workspace-runs',crypto.randomUUID()));
 const get=(name,context)=>windows.service(name,factories[name],context);
 const events=(value,context,channel)=>{value.on('event',event=>windows.send(context,channel,event));return value;};
 const dictationPermission=new(require('./quick-note-microphone-permission.cjs').QuickNoteMicrophonePermissionBroker)({systemPreferences});
 const personalVoice=()=>require('./voice-profile-store.cjs').voiceProfileForApp(app);
 const factories={
  recognitionSamples:()=>new(require('./recognition-samples-service.cjs').RecognitionSamplesService)(require('./recognition-samples-store.cjs').recognitionSamplesForApp(app,{decodeImage:(bytes,info)=>{const image=nativeImage.createFromBuffer(bytes),size=image.getSize();return !image.isEmpty()&&((size.width===info.width&&size.height===info.height)||(size.width===info.height&&size.height===info.width));}})),
  recognitionPackage:context=>new(require('./recognition-sample-transfer.cjs').RecognitionSampleTransfer)(get('recognitionSamples',context).store),
  recognitionRecording:context=>{const value=events(new(require('./recognition-recording-service.cjs').RecognitionRecordingService)({runtimePath:path.join(runtimeRoot,'recognition-recorder',platform||'unsupported','RecognitionRecorder.app','Contents','MacOS','RecognitionRecorder'),samples:get('recognitionSamples',context),isForeground:()=>!context.closed&&!context.window.isDestroyed()&&context.window.isFocused()&&context.window.isVisible()&&!context.window.isMinimized()}),context,'desktop:recognitionRecordingEvent');const background=()=>value.background(),cancel=()=>value.cancel();for(const name of ['blur','hide','minimize'])context.window.on(name,background);for(const name of ['render-process-gone','destroyed','did-start-navigation'])context.window.webContents.on(name,cancel);powerMonitor.on('suspend',cancel);const dispose=value.dispose.bind(value);value.dispose=()=>{for(const name of ['blur','hide','minimize'])context.window.removeListener(name,background);for(const name of ['render-process-gone','destroyed','did-start-navigation'])context.window.webContents.removeListener(name,cancel);powerMonitor.removeListener('suspend',cancel);dispose();};return value;},
  clipCatalog:()=>new(require('./browser-clip-catalog.cjs').BrowserClipCatalog)({vaults,nativeImage}),
  reviewQueue:()=>new(require('./review-queue-service.cjs').ReviewQueueService)({vaults,reviews}),
  voiceProfile:context=>events(new(require('./voice-profile-store.cjs').VoiceProfileService)(personalVoice()),context,'desktop:voiceProfileChanged'),
  videos:()=>new VideoService(vaults,{allowAudio:true}),
  videoWindows:context=>new(require('./video-window.cjs').VideoWindowManager)({app,videos:get('videos',context),videoSubtitles,devURL,diagnostics,electron:{BrowserWindow,ipcMain:auxiliaryIPC.scope(contents=>context.services.get('videoWindows')?.owns(contents))}}),
  quickNoteDictation:context=>{const value=events(new(require('./quick-note-dictation-service.cjs').QuickNoteDictationService)({runtimePath:path.join(runtimeRoot,'dictation',platform||'unsupported','InkSpaceDictation.app','Contents','MacOS','InkSpaceDictation'),voiceProfileStore:personalVoice(),permissionBroker:dictationPermission,isForeground:()=>!context.closed&&!context.window.isDestroyed()&&context.window.isFocused()&&context.window.isVisible()&&!context.window.isMinimized(),onDiagnostic:stage=>diagnostics?.recordDictationStartupStage(stage)}),context,'desktop:quickNoteDictationEvent');const cancel=()=>value.cancelPermissionRequest();for(const name of ['blur','hide','minimize'])context.window.on(name,cancel);const dispose=value.dispose.bind(value);value.dispose=()=>{for(const name of ['blur','hide','minimize'])context.window.removeListener(name,cancel);dispose();};return value;},
  ocrSampleBridge:context=>new(require('./ocr-sample-bridge.cjs').OCRSampleBridge)({vaults,ocr:get('localOCR',context),samples:get('recognitionSamples',context),dataDirectory:temporary(context),runtimePath:path.join(runtimeRoot,'nativeOCR',platform==='darwin-arm64'?platform:'unsupported','InkSpaceOCR')}),
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

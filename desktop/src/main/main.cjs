'use strict';
const {app,BrowserWindow,Menu,ShareMenu,clipboard,dialog,ipcMain,protocol,session,shell,powerMonitor,safeStorage,nativeImage,Notification,powerSaveBlocker,systemPreferences}=require('electron');
const {displayBrand,appLocale,freezeApplicationPaths,applyApplicationBrand}=require('./app-brand.cjs');
const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const {DocumentService}=require('./document-service.cjs');const {printDocumentPDF}=require('./document-pdf.cjs');
const {VaultService,durableWrite,relativePath,kindOf}=require('./vault-service.cjs');const {KnowledgeService}=require('./knowledge-service.cjs');const {ReviewService}=require('./review-service.cjs');const {Diagnostics}=require('./diagnostics.cjs');const {fail,publicError}=require('./errors.cjs');const {safeDevURL}=require('./security.cjs');
// Development QA opt-in isolates test preferences and backups from the real app.
if(!app.isPackaged&&process.env.INKSPACE_QA_USER_DATA){const qaData=path.resolve(process.env.INKSPACE_QA_USER_DATA);require('node:fs').mkdirSync(qaData,{recursive:true,mode:0o700});app.setPath('userData',qaData);}
freezeApplicationPaths(app);
const primaryInstance=app.requestSingleInstanceLock();if(!primaryInstance)app.quit();
const externalDocuments=new(require('./external-document-open.cjs').ExternalDocumentOpen)({onError:error=>diagnostics?.record('externalDocumentOpen',error)});
// This must be installed synchronously: Finder's cold-start event can precede ready.
app.on('open-file',(event,file)=>{event.preventDefault();if(primaryInstance)externalDocuments.enqueue(file);});
const queueDocumentArguments=argv=>{let count=0;for(const value of argv.slice(1))if(typeof value==='string'&&path.isAbsolute(value)&&kindOf(value)!=='unsupported'){externalDocuments.enqueue(value);count++;}return count;};
if(primaryInstance&&process.platform!=='darwin')queueDocumentArguments(process.argv);
app.on('second-instance',(_event,argv)=>{if(!queueDocumentArguments(argv)&&externalDocuments.dependencies)revealMainWindow();});
protocol.registerSchemesAsPrivileged([
 {scheme:'inkspace-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}},
 {scheme:'vault-video',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}},
 {scheme:'vault-asset',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}
]);
const devURL=!app.isPackaged?safeDevURL(process.env.INKSPACE_RENDERER_URL):undefined;
const rendererOrigin=devURL?new URL(devURL).origin:'inkspace-app://ui';
const {WindowContexts,ScopedIPCRouter}=require('./window-contexts.cjs');
const windows=new WindowContexts({devURL}),auxiliaryIPC=new ScopedIPCRouter(ipcMain);
let serviceFactories={};
function workspace(){return windows.current();}
function ownerWindow(){return workspace().window;}
function service(name,context=workspace()){return windows.service(name,serviceFactories[name],context);}
function mediaEditor(){return service('mediaEditor');}
function browser(){return service('browser');}
let fileManagement=null,videoSubtitles=null,translations=null,pngOrganization=null;
let regionCards,studyDrafts,studyTransfer,studyLayouts,studyLayoutPackages,study,noteExchange,pdfLayers,pdfExtend,calendarFiles,calendarReminders,recentVaults,courseWorkspaces;
let workSpace,workSources,workStudy,workMail,pdfAnnotations,wordAnnotations,pendingWorkItem=null;
const {workItemURL,resolveWorkNotification}=require('./work-notification-links.cjs');
async function pendingWorkOpen(){if(!pendingWorkItem||!workSpace)return null;const value=await resolveWorkNotification(workSpace,pendingWorkItem);if(!value)pendingWorkItem=null;return value;}
app.on('open-url',(event,value)=>{const id=workItemURL(value);if(!id)return;event.preventDefault();pendingWorkItem=id;if(app.isReady()&&workSpace){const context=revealMainWindow();void pendingWorkOpen().then(value=>{if(value)windows.send(context,'desktop:workNotificationOpen',value);}).catch(()=>{});}});
function publishWork(snapshot){if(workMail)void workMail.reconcile();for(const context of windows.windows.values())windows.send(context,'desktop:workSpaceChanged',{revision:snapshot.revision});return snapshot;}
let vaults=null,documents=null,diagnostics=null,knowledge=null,reviews=null,unifiedIndex=null;
function stopBoardSpeechPower(context){if(context.boardSpeechBlocker!==null){powerSaveBlocker.stop(context.boardSpeechBlocker);context.boardSpeechBlocker=null;}}
function cancelWindowTranslations(context){for(const requestId of context.translationRequests.values())translations?.cancel({requestId});context.translationRequests.clear();}
function cn(){return appLocale(app).toLowerCase().startsWith('zh');}
function localized(en,zh){return cn()?zh:en;}
function args(value,fields){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))fail('INVALID_REQUEST');return value;}
function fileArgs(value,extra=[]){args(value,['vaultId','path',...extra]);if(typeof value.vaultId!=='string'||typeof value.path!=='string')fail('INVALID_REQUEST');return value;}
function handler(name,fn){ipcMain.handle('desktop:'+name,async(event,value)=>{
 const phase=name==='captureSelection'?'capture':name==='recognizeBoardText'?'recognition':null,start=Date.now();
 const trace=(result,error)=>{if(!phase)return;const code=error?publicError(error).code:null;diagnostics?.recordOCRStage({phase,durationMs:Math.min(600000,Math.max(0,Date.now()-start)),status:code?({CANCELLED:'cancelled',OCR_TIMEOUT:'timed_out',OCR_OUTPUT_LIMIT:'output_limited'}[code]||'failed'):phase==='capture'?'captured':result.pages[0].boxes.length?'recognized':'no_text',...(phase==='capture'&&!error?{width:result.width,height:result.height}:phase==='recognition'&&!error?{boxes:result.pages[0].boxes.length}:{})});};
 try{const result=await windows.invoke(event,value,fn);trace(result,null);return {ok:true,value:result};}catch(error){diagnostics?.record(name,error);trace(null,error);return {ok:false,error:publicError(error)};}
 });}
async function withDialog(fn){const context=workspace();if(context.dialogBusy)fail('BUSY');context.dialogBusy=true;try{return await fn();}finally{context.dialogBusy=false;}}
async function saveExport(data,options,protectedSource){return withDialog(async()=>{const result=await dialog.showSaveDialog(ownerWindow(),options);if(result.canceled||!result.filePath)return {saved:false};workspace();const parent=await fs.realpath(path.dirname(result.filePath)),target=path.join(parent,path.basename(result.filePath));if(protectedSource){const selected=await fs.realpath(target).catch(error=>{if(error.code==='ENOENT')return target;throw error;});if(selected===protectedSource)fail('PATH_DENIED');}const temp=path.join(parent,'.inkspace-export-'+crypto.randomUUID()+'.tmp');try{await durableWrite(temp,data);await fs.rename(temp,target);return {saved:true};}finally{await fs.unlink(temp).catch(()=>{});}});}
function contentSecurityPolicy(){const dev=devURL?` ${new URL(devURL).origin} ${new URL(devURL).origin.replace(/^http/,'ws')}`:'';return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vault-asset:; font-src 'self' data:; connect-src 'self' vault-asset: vault-video:${dev}; media-src 'self' vault-video: blob:; worker-src 'self' blob:; frame-src 'self' vault-asset: http: https:; object-src 'none'; base-uri 'none'; form-action 'none'`;}
async function registerProtocols(){const rendererRoot=await fs.realpath(path.join(app.getAppPath(),'dist','renderer'));const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm'};
 protocol.handle('inkspace-app',async request=>{try{const u=new URL(request.url);if(u.hostname!=='ui'||request.method!=='GET')fail('PATH_DENIED');const rel=relativePath(decodeURIComponent(u.pathname==='/'?'index.html':u.pathname.slice(1)));const file=await fs.realpath(path.join(rendererRoot,rel));if(!file.startsWith(rendererRoot+path.sep))fail('PATH_DENIED');const stat=await fs.stat(file);if(!stat.isFile()||stat.size>32*1024*1024)fail('TOO_LARGE');return new Response(await fs.readFile(file),{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':contentSecurityPolicy()}});}catch{return new Response('Not available',{status:404});}});
 protocol.handle('vault-video',async request=>{try{const origin=request.headers.get('Origin');if(origin&&origin!==rendererOrigin)fail('PERMISSION_DENIED');const options={method:request.method,range:request.headers.get('Range'),signal:request.signal},result=await videoResponse(request.url,options);return new Response(result.body,{status:result.status,headers:{...result.headers,'Access-Control-Allow-Origin':rendererOrigin,'Cross-Origin-Resource-Policy':'cross-origin'}});}catch(error){return new Response('Not available',{status:error?.code==='CONFLICT'?409:error?.code==='BUSY'?429:403,headers:{'Cache-Control':'no-store'}});}});
 protocol.handle('vault-asset',async request=>{try{if(!['GET','HEAD'].includes(request.method))fail('PERMISSION_DENIED');const origin=request.headers.get('Origin');if(origin&&origin!==rendererOrigin)fail('PERMISSION_DENIED');const result=await vaults.asset(request.url,request.headers.get('Range'));return new Response(request.method==='HEAD'?null:result.body,{status:result.status,headers:{...result.headers,'Access-Control-Allow-Origin':rendererOrigin,'Cross-Origin-Resource-Policy':'cross-origin'}});}catch{return new Response('Not available',{status:403,headers:{'Cache-Control':'no-store'}});}});
}
function installIPC(){
 handler('wordAnnotationsScan',value=>wordAnnotations.scan(workspace().id,args(value,['vaultId','folderPath','requestId'])));
 handler('wordAnnotationsCancel',value=>wordAnnotations.cancel(workspace().id,args(value,['requestId','token'])));
 handler('wordAnnotationsResolve',value=>wordAnnotations.resolve(workspace().id,args(value,['scanToken','resultId'])));
 handler('workWordAnnotationPrepare',value=>workStudy.prepareWordAnnotation(workspace().id,value));
 handler('pdfAnnotationsScan',value=>pdfAnnotations.scan(workspace().id,args(value,['vaultId','folderPath','requestId'])));
 handler('pdfAnnotationsCancel',value=>pdfAnnotations.cancel(workspace().id,args(value,['requestId','token'])));
 handler('pdfAnnotationsResolve',value=>pdfAnnotations.resolve(workspace().id,args(value,['scanToken','resultId'])));
 handler('workPDFAnnotationPrepare',value=>workStudy.preparePDFAnnotation(workspace().id,value));
 handler('pngOrganizationPreview',value=>pngOrganization.preview(workspace().id,fileArgs(value,['requestId'])));
 handler('pngOrganizationCancel',value=>pngOrganization.cancel(workspace().id,args(value,['requestId','token'])));
 handler('pngOrganizationCommit',value=>pngOrganization.commit(workspace().id,args(value,['token'])));
 handler('pngOrganizationHistory',value=>pngOrganization.history(args(value,['vaultId'])));
 handler('pngOrganizationUndo',value=>pngOrganization.undo(args(value,['vaultId','id'])));
 handler('workNotificationOpenPending',value=>{args(value??{},[]);return pendingWorkOpen();});
 handler('workNotificationOpenClaim',value=>{args(value,['itemId']);if(value.itemId===pendingWorkItem)pendingWorkItem=null;return{claimed:true};});
 handler('workMailOpenWebsite',value=>browser().openURL(require('./work-mail-websites.cjs').mailWebsite(value)));
 handler('workStudyPrepare',value=>workStudy.prepare(workspace().id,value));
 handler('workStudyCommit',value=>workStudy.commit(workspace().id,value));
 handler('workStudyCancel',value=>workStudy.cancel(workspace().id,value));
 handler('workStudyOpen',value=>workStudy.open(workspace().id,value));
 handler('workMailAccounts',value=>{args(value??{},[]);return workMail.accounts(workspace().id);});
 handler('workMailConnect',value=>workMail.connect(workspace().id,value));
 handler('workMailDisconnect',value=>workMail.disconnect(workspace().id,value));
 handler('workMailInbox',value=>workMail.inbox(workspace().id,value));
 handler('workMailMessage',value=>workMail.message(workspace().id,value));
 handler('workMailCancel',value=>workMail.cancel(workspace().id,value));
 handler('workMailCommit',value=>workMail.commit(workspace().id,value));
 handler('workMailOpen',value=>workMail.open(workspace().id,value));
 handler('workNotificationStatus',value=>{args(value??{},[]);return workMail.notificationStatus(workspace().id);});
 handler('workNotificationRequest',value=>{args(value??{},[]);if(!ownerWindow().isFocused())fail('PERMISSION_DENIED');return workMail.notificationRequest(workspace().id);});
 handler('workSpaceSnapshot',value=>{args(value??{},[]);return workSpace.snapshot();});
 handler('workSpaceMutate',async value=>publishWork(await workSpace.mutate(args(value,['revision','operation']))));
 handler('workSourceRegister',async value=>{args(value,['vaultId']);const result=await workSources.register(value.vaultId);publishWork(result.snapshot);return result;});
 handler('workSourceRefresh',async value=>{args(value,['sourceId']);return publishWork(await workSources.refresh(value.sourceId));});
 handler('workSourceOpen',value=>workSources.open(args(value,['sourceId','path','documentID','taskId'])));
 handler('recognitionRecordingInfo',value=>{args(value??{},[]);return service('recognitionRecording').info();});
 handler('recognitionRecordingStart',value=>service('recognitionRecording').start(value));
 handler('recognitionRecordingStop',value=>service('recognitionRecording').stop(value));
 handler('recognitionRecordingCancel',value=>service('recognitionRecording').cancel(value));
 handler('recognitionPackagePlan',value=>service('recognitionPackage').planExport(value));
 handler('recognitionPackageExport',value=>withDialog(()=>service('recognitionPackage').export(value,async plan=>{const chosen=await dialog.showSaveDialog(ownerWindow(),{title:localized(`Export ${plan.count} samples (${(plan.packageBytes/1048576).toFixed(2)} MiB)`,`导出 ${plan.count} 项样本（${(plan.packageBytes/1048576).toFixed(2)} MiB）`),defaultPath:'recognition-samples.json',filters:[{name:'Personal recognition sample package',extensions:['json']}]});workspace();return chosen.canceled?null:chosen.filePath||null;})));
 handler('recognitionPackageSelect',value=>withDialog(async()=>{args(value??{},[]);return service('recognitionPackage').select(async()=>{const chosen=await dialog.showOpenDialog(ownerWindow(),{title:localized('Choose an offline recognition sample package','选择离线个人识别样本包'),properties:['openFile'],filters:[{name:'Recognition sample package JSON',extensions:['json']}]});workspace();return chosen.canceled||chosen.filePaths.length!==1?null:chosen.filePaths[0];});}));
 handler('recognitionPackageMedia',value=>service('recognitionPackage').previewMedia(value));
 handler('recognitionPackageCommit',value=>service('recognitionPackage').commit(value));
 handler('recognitionPackageCancel',value=>service('recognitionPackage').cancel(value));
 handler('recognitionSamplesList',value=>{args(value??{},[]);return service('recognitionSamples').snapshot();});
 handler('recognitionSamplesSelect',value=>withDialog(async()=>{args(value,['kind']);if(!['handwriting','speech'].includes(value.kind))fail('LEARNING_INVALID');const chosen=await dialog.showOpenDialog(ownerWindow(),{title:value.kind==='speech'?localized('Choose an original PCM WAV sample','选择原始 PCM WAV 语音样本'):localized('Choose original handwriting PNG / JPEG','选择原始手写 PNG / JPEG'),properties:['openFile'],filters:[{name:value.kind==='speech'?'PCM WAV':'PNG / JPEG',extensions:value.kind==='speech'?['wav']:['png','jpg','jpeg']}]});workspace();if(chosen.canceled||chosen.filePaths.length!==1)return null;return service('recognitionSamples').selectPath(value.kind,chosen.filePaths[0]);}));
 handler('recognitionSamplesFromOCR',value=>service('ocrSampleBridge').prepare(fileArgs(value,['resultId','page','requestId'])));
 handler('recognitionSamplesCancelOCR',value=>service('ocrSampleBridge').cancel(args(value,['requestId'])));
 handler('recognitionSamplesCancelDraft',value=>{args(value??{},[]);return service('recognitionSamples').cancel();});
 handler('recognitionSamplesCommit',value=>service('recognitionSamples').commit(value));
 handler('recognitionSamplesUpdate',value=>service('recognitionSamples').update(value));
 handler('recognitionSamplesMedia',value=>service('recognitionSamples').readMedia(value));
 handler('recognitionSamplesClean',value=>service('recognitionSamples').clean(value));
 handler('createPDFVisualExcerpt',value=>require('./pdf-visual-excerpt.cjs').createPDFVisualExcerpt(vaults,fileArgs(value,['boardID','expectedSHA256','itemID','title','sourceReference','dataURL','x','y']),{nativeImage}));
 handler('readStudyImage',value=>require('./study-image.cjs').readStudyImage(vaults,fileArgs(value,['boardID','itemID','sourcePath']),{nativeImage}));
 handler('prepareBoardRegionCard',value=>regionCards.prepare(workspace().id,fileArgs(value,['boardID','expectedSHA256','requestId','canvasID','rect','screenRect'])));
 handler('commitBoardRegionCard',value=>regionCards.commit(workspace().id,args(value,['token','title','card'])));
 handler('cancelBoardRegionCard',value=>regionCards.cancel(workspace().id,args(value,['requestId','token'])));
 handler('prepareStudyDraft',value=>studyDrafts.prepare(workspace().id,fileArgs(value,['nodeIDs','kind'])));
 handler('commitStudyDraft',value=>{const request=args(value,['token','rows','selectedIDs']),context=workspace(),plan=studyDrafts.session(context.id,request.token);if(!context.grants.has(plan.req.vaultId))fail('PERMISSION_DENIED');return studyDrafts.commit(context.id,request);});
 handler('cancelStudyDraft',value=>studyDrafts.cancel(workspace().id,args(value,['token'])));
 handler('studyLayoutPackageSelect',value=>withDialog(()=>studyLayoutPackages.select(fileArgs(value),{dialog,window:ownerWindow()})));
 handler('studyLayoutPackageCommit',value=>studyLayoutPackages.commit(fileArgs(value,['token'])));
 handler('studyLayoutPackageCancel',value=>studyLayoutPackages.cancel(fileArgs(value,['token'])));
 handler('studyLayoutPackageExport',async value=>{const result=await studyLayoutPackages.exportData(fileArgs(value));if(!result.count)return{saved:false,count:0};const saved=await saveExport(result.data,{title:localized('Card layout package','卡片排版包'),defaultPath:result.name,filters:[{name:'JSON',extensions:['json']}]});return{...saved,count:result.count};});
 handler('readStudyLayout',value=>studyLayouts.read(fileArgs(value,['itemID'])));
 handler('saveStudyLayout',value=>studyLayouts.save(fileArgs(value,['itemID','expectedRevision','layout','replaceStale'])));
 handler('readStudy',value=>study.read(fileArgs(value)));
 handler('appendStudy',value=>study.append(fileArgs(value,['event'])));
 handler('selectStudyImport',value=>withDialog(()=>studyTransfer.select(fileArgs(value),{dialog,window:ownerWindow()})));
 handler('previewStudyImport',value=>studyTransfer.preview(fileArgs(value,['token','delimiter','header'])));
 handler('commitStudyImport',value=>studyTransfer.commit(fileArgs(value,['token','delimiter','header','indices','expectedSHA256'])));
 handler('exportStudyCards',async value=>{const result=await studyTransfer.exportData(fileArgs(value,['delimiter','formulaProtection']));if(result.count===0)return{saved:false,count:0,omitted:result.omitted,escapedCells:result.escapedCells};const saved=await saveExport(result.data,{title:localized('Export question & answer cards','导出问答卡'),defaultPath:result.name,filters:[{name:'CSV / TSV',extensions:[value.delimiter]}]});return{...saved,count:result.count,omitted:result.omitted,escapedCells:result.escapedCells};});
 handler('readPDFExtend',value=>pdfExtend.read(fileArgs(value)));
 handler('appendPDFExtend',value=>pdfExtend.append(fileArgs(value,['expectedSourceSHA256','record'])));
 handler('readPDFExtendImage',value=>pdfExtend.image(fileArgs(value,['resource','sha256'])));
 handler('importPDFExtendImage',value=>withDialog(async()=>{const request=fileArgs(value,['expectedSourceSHA256']),chosen=await dialog.showOpenDialog(ownerWindow(),{properties:['openFile'],filters:[{name:'Image',extensions:['png','jpg','jpeg']}]});if(chosen.canceled||!chosen.filePaths[0])return null;const source=await fs.open(chosen.filePaths[0],require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);let data;try{const before=await source.stat();if(!before.isFile()||before.size>10*1024*1024)fail('TOO_LARGE');data=await source.readFile();const after=await source.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('CONFLICT');}finally{await source.close();}const info=require('./image-import.cjs').imageInfo(data);if(info.width*info.height>16000000)fail('TOO_LARGE');const image=nativeImage.createFromBuffer(data);if(image.isEmpty())fail('INVALID_REQUEST');const resized=image.resize(info.width>=info.height?{width:Math.min(2048,info.width),quality:'best'}:{height:Math.min(2048,info.height),quality:'best'}).toPNG();return pdfExtend.storeImage(request,resized);}));

 handler('importNoteExchange',value=>withDialog(()=>noteExchange.import(args(value,['vaultId','parentPath','source']),{dialog,window:ownerWindow()})));
 handler('exportNoteExchange',value=>withDialog(()=>noteExchange.export(args(value,['vaultId','paths','target','mode']),{dialog,window:ownerWindow()})));
 handler('importNoteOutline',value=>noteExchange.outline(fileArgs(value,['expectedSHA256'])));

 handler('readCalendarFile',value=>calendarFiles.read(value));
 handler('importCalendarICS',value=>{args(value??{},[]);return withDialog(()=>calendarFiles.importICS({dialog,window:ownerWindow()}));});
 handler('exportCalendarICS',value=>withDialog(()=>calendarFiles.exportICS(value,{dialog,window:ownerWindow()})));
 handler('scheduleCalendarReminders',value=>calendarReminders.replace(value,workspace().window.webContents.id));
 handler('calendarReminderStatus',value=>{args(value??{},[]);return calendarReminders.info();});
 handler('consumeCalendarReminder',value=>{args(value??{},[]);const context=workspace(),pending=context.pendingCalendarReminder;context.pendingCalendarReminder=null;return pending;});
 handler('mediaEditorInfo',()=>mediaEditor().info());
 handler('mediaEditorImport',value=>withDialog(()=>mediaEditor().import(value)));
 handler('mediaEditorOpen',value=>withDialog(()=>mediaEditor().open(value)));
 handler('mediaEditorSave',value=>withDialog(()=>mediaEditor().save(value)));
 handler('mediaEditorPreview',value=>mediaEditor().preview(value));
 handler('mediaEditorCompositionPreview',value=>mediaEditor().compositionPreview(value));
 handler('mediaEditorImportCaptions',value=>withDialog(()=>mediaEditor().importCaptions(value)));
 handler('mediaEditorRelease',value=>mediaEditor().release(value));
 handler('mediaEditorExport',value=>withDialog(()=>mediaEditor().export(value)));
 handler('mediaEditorCancel',value=>mediaEditor().cancel(value));
 handler('clipCatalogList',value=>service('clipCatalog').list(args(value,['vaultId','folderPath','query','requestId'])));
 handler('clipCatalogCancel',value=>service('clipCatalog').cancel(args(value,['requestId'])));
 handler('clipCatalogInspect',value=>service('clipCatalog').inspect(args(value,['vaultId','ref'])));
 handler('clipCatalogPlace',value=>service('clipCatalog').place(args(value,['vaultId','ref','targetPath','expectedSHA256','contentSHA256','x','y'])));
 handler('openBrowser',value=>browser().open(value??{}));
 handler('importBrowserClip',value=>withDialog(()=>browser().importClip(value)));
 handler('readBoardClipboard',value=>{args(value??{},[]);return require('./board-clipboard.cjs').readBoardClipboard({clipboard,nativeImage});});
 handler('pasteBoardContent',value=>require('./board-paste.cjs').pasteBoardContent(vaults,fileArgs(value,['expectedSHA256','content','x','y']),{nativeImage}));
 handler('exportMathWorksheet',request=>{const result=require('./math-export.cjs').decodeMathExport(request);return saveExport(result.data,{title:localized('Export math worksheet','导出数学工作表'),defaultPath:result.name,filters:[{name:result.extension.toUpperCase(),extensions:[result.extension]}]});});
 handler('readPDFSourceInfo',value=>pdfLayers.readPDFSourceInfo(fileArgs(value)));
 handler('readPDFLayers',value=>pdfLayers.readPDFLayers(fileArgs(value)));
 handler('appendPDFLayerRecord',value=>pdfLayers.appendPDFLayerRecord(fileArgs(value,['expectedSourceSHA256','record'])));
 handler('exportPDFTranslation',value=>withDialog(()=>require('./pdf-translation-export.cjs').exportPDFTranslation(vaults,pdfLayers,args(value,['vaultId','path','sourceSHA256','target','provider','model','range','pages','omittedPages','status']),{dialog,window:ownerWindow(),printPDF:printDocumentPDF})));
 handler('translationInfo',()=>translations.info());
 handler('unlockTranslation',()=>translations.unlock());
 handler('setTranslationKey',value=>translations.setKey(args(value,['key','provider'])));
 handler('setTranslationModel',value=>translations.setModel(args(value,['model','provider'])));
 handler('setTranslationProvider',value=>translations.setProvider(args(value,['provider'])));
 handler('translateSelection',async value=>{const request=args(value,['requestId','target','imageDataURL','text','provider','purpose','expectedModel']),context=workspace();if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.requestId||''))fail('INVALID_REQUEST');if(context.translationRequests.has(request.requestId))fail('BUSY');const internal=crypto.randomUUID();context.translationRequests.set(request.requestId,internal);try{return await translations.translate({...request,requestId:internal});}finally{if(context.translationRequests.get(request.requestId)===internal)context.translationRequests.delete(request.requestId);}});
 handler('cancelTranslation',value=>{args(value,['requestId']);if(typeof value.requestId!=='string')fail('INVALID_REQUEST');const internal=workspace().translationRequests.get(value.requestId);return internal?translations.cancel({requestId:internal}):{cancelled:false};});
 handler('openVideoWindow',value=>service('videoWindows').openVideoWindow(fileArgs(value,['playback'])));handler('videoWindowInfo',()=>service('videoWindows').videoWindowInfo());handler('setVideoWindowPinned',value=>service('videoWindows').setVideoWindowPinned(args(value,['pinned'])));
 handler('openOriginal',value=>withDialog(()=>require('./open-original.cjs').openOriginal(vaults,fileArgs(value,['application']),{dialog,shell,window:ownerWindow()})));
 handler('getLastInkLocation',value=>require('./board-navigation.cjs').getLastInkLocation(vaults,fileArgs(value,['expectedSHA256'])));
 handler('boardHistoryState',value=>vaults.boardHistoryState(fileArgs(value)));handler('undoBoard',value=>vaults.undoBoard(fileArgs(value,['expectedSHA256'])));handler('redoBoard',value=>vaults.redoBoard(fileArgs(value,['expectedSHA256'])));
 handler('boardVersionsList',value=>require('./board-versions.cjs').boardVersions(vaults).list(fileArgs(value,['expectedSHA256'])));
 handler('boardVersionsCompare',value=>require('./board-versions.cjs').boardVersions(vaults).compare(fileArgs(value,['expectedSHA256','fromSHA256','toSHA256'])));
 handler('boardVersionsRestoreCopy',value=>require('./board-versions.cjs').boardVersions(vaults).restoreCopy(fileArgs(value,['expectedSHA256','versionSHA256','name'])));
 handler('getFolderOrder',value=>fileManagement.getFolderOrder(fileArgs(value)));handler('setFolderOrder',value=>fileManagement.setFolderOrder(fileArgs(value,['paths'])));
 handler('getFilePreparationProgress',async value=>{const request=args(value,['vaultId']);if(typeof request.vaultId!=='string')fail('INVALID_REQUEST');await vaults.root(request.vaultId);return fileManagement.getPreparationProgress(request.vaultId);});
 handler('cancelFilePreparation',async value=>{const request=args(value,['vaultId']);if(typeof request.vaultId!=='string')fail('INVALID_REQUEST');await vaults.root(request.vaultId);return fileManagement.cancelPreparation(request.vaultId);});
 handler('moveFiles',async value=>{const result=await fileManagement.moveFiles(args(value,['vaultId','paths','targetPath']));service('videos').dispose();return result;});
 handler('renameFiles',async value=>{const result=await fileManagement.renameFiles(args(value,['vaultId','path','name']));service('videos').dispose();return result;});
 handler('revealInFinder',value=>require('./file-context-actions.cjs').revealInFinder(vaults,fileArgs(value),{shell}));
 handler('copyFileReference',value=>require('./file-context-actions.cjs').copyFileReference(vaults,fileArgs(value,['kind']),{clipboard}));
 handler('trashFiles',async value=>{const result=await fileManagement.trashFiles(args(value,['vaultId','paths']));service('videos').dispose();return result;});
 handler('listTrash',value=>fileManagement.listTrash(args(value,['vaultId'])));
 handler('restoreTrash',value=>fileManagement.restoreTrash(args(value,['vaultId','id'])));
 handler('shareFiles',value=>withDialog(async()=>{args(value,['vaultId','paths']);const filePaths=await fileManagement.resolveSharePaths(value);if(process.platform!=='darwin')fail('UNSUPPORTED');new ShareMenu({filePaths}).popup({window:ownerWindow()});return {opened:true};}));
 handler('getVideoSubtitles',value=>videoSubtitles.getVideoSubtitles(fileArgs(value)));handler('saveVideoSubtitles',value=>videoSubtitles.saveVideoSubtitles(fileArgs(value,['subtitle','expectedSHA256'])));
 handler('getVideoUrl',value=>service('videos').getVideoUrl(fileArgs(value)));handler('releaseVideoUrl',value=>{args(value,['url']);if(typeof value.url!=='string')fail('INVALID_REQUEST');return service('videos').releaseVideoUrl(value);});
 handler('readVoiceProfile',value=>{args(value??{},[]);return service('voiceProfile').read();});
 handler('updateVoiceProfile',value=>service('voiceProfile').update(value));
 handler('exportVoiceProfile',async value=>{args(value??{},[]);return saveExport(service('voiceProfile').export(),{title:localized('Export personal vocabulary','导出个人语音档案'),defaultPath:'个人语音档案.json',filters:[{name:'Personal vocabulary JSON',extensions:['json']}]});});
 handler('importVoiceProfile',value=>withDialog(async()=>{args(value,['expectedSHA256']);const picked=await dialog.showOpenDialog(ownerWindow(),{title:localized('Import personal vocabulary','导入个人语音档案'),properties:['openFile'],filters:[{name:'Personal vocabulary JSON',extensions:['json']}]});if(picked.canceled||!picked.filePaths[0])return null;const handle=await fs.open(picked.filePaths[0],require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);let bytes;try{const stat=await handle.stat();if(!stat.isFile()||stat.size>16*1024*1024)fail('VOICE_PROFILE_LIMIT');bytes=await handle.readFile();}finally{await handle.close();}let profile;try{profile=require('./voice-profile-model.cjs').parseVoiceProfile(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{fail('VOICE_PROFILE_INVALID');}const answer=await dialog.showMessageBox(ownerWindow(),{title:localized('Merge personal vocabulary','合并个人词句'),message:localized(`Import ${profile.entries.length} personal phrases?`,`导入 ${profile.entries.length} 条个人词句？`),detail:localized('Keep this Mac’s switch and existing edits. Repeated imports do not count as new corrections.','保留本机开关和已有修改。重复导入不会当成新的纠正次数。'),buttons:[localized('Cancel','取消'),localized('Import','导入')],defaultId:0,cancelId:0,noLink:true});return answer.response===1?service('voiceProfile').update({expectedSHA256:value.expectedSHA256,action:'import',profile}):null;}));
 handler('quickNoteDictationInfo',()=>service('quickNoteDictation').info());
 handler('startQuickNoteDictation',value=>service('quickNoteDictation').start(value));
 handler('stopQuickNoteDictation',value=>service('quickNoteDictation').stop(value));
 handler('cancelQuickNoteDictation',value=>service('quickNoteDictation').cancel(value));
 handler('setBoardSpeechActive',value=>{args(value,['active']);if(typeof value.active!=='boolean')fail('INVALID_REQUEST');const context=workspace();if(value.active&&context.boardSpeechBlocker===null)context.boardSpeechBlocker=powerSaveBlocker.start('prevent-app-suspension');else if(!value.active)stopBoardSpeechPower(context);return{active:context.boardSpeechBlocker!==null};});
 handler('recognizeBoardText',value=>service('localOCR').recognizeBoardText(args(value,['requestId','imageDataURL','customWords']),{nativeImage}));
 handler('copyBoardText',value=>{args(value,['text']);if(typeof value.text!=='string'||value.text.length>200000||value.text.includes('\0'))fail('INVALID_REQUEST');clipboard.writeText(value.text);return{copied:true};});
 handler('localOCRInfo',()=>service('localOCR').info());handler('recognizeLocalOCR',value=>service('localOCR').recognize(fileArgs(value,['requestId','startPage','endPage'])));handler('cancelLocalOCR',value=>service('localOCR').cancel(args(value,['requestId'])));handler('copyLocalOCR',value=>service('localOCR').copy(fileArgs(value,['resultId']),clipboard));handler('saveLocalOCR',value=>service('localOCR').save(fileArgs(value,['resultId'])));
 handler('latexInfo',()=>service('latex').info());handler('compileLatex',value=>service('latex').compile(fileArgs(value,['expectedSHA256'])));
 handler('createDocument',value=>documents.createDocument(args(value,['vaultId','parentPath','name','document'])));handler('readEditableDocument',value=>documents.readEditableDocument(fileArgs(value)));handler('saveDocument',value=>documents.saveDocument(fileArgs(value,['expectedSHA256','document'])));
 handler('watchVault',async value=>{const result=await service('vaultWatcher').watch(args(value,['vaultId']));windows.activate(value.vaultId);return result;});handler('unwatchVault',value=>{args(value,['watchId']);if(typeof value.watchId!=='string')fail('INVALID_REQUEST');return service('vaultWatcher').stop(value.watchId);});handler('addBoardFileCards',value=>vaults.addBoardFileCards(fileArgs(value,['expectedSHA256','sourcePaths','x','y'])));handler('addBoardFileCard',value=>vaults.addBoardFileCard(fileArgs(value,['expectedSHA256','sourcePath','x','y'])));
 handler('listReviewQueue',value=>service('reviewQueue').list(value));handler('cancelReviewQueue',value=>service('reviewQueue').cancel(value));
 handler('listReviews',value=>reviews.listReviews(fileArgs(value)));handler('deleteReview',value=>reviews.deleteReview(args(value,['vaultId','id'])));handler('createReview',value=>reviews.createReview(args(value,['vaultId','review'])));
 handler('setInterfaceLanguage',value=>{args(value,['language']);if(!['zh','en'].includes(value.language))fail('INVALID_REQUEST');const brand=applyApplicationBrand(app,value.language);installDocumentMenu();for(const context of windows.windows.values()){context.services.get('browser')?.refreshBrand?.();context.services.get('videoWindows')?.refreshBrand?.();}return{name:brand.name,language:brand.language};});
 handler('info',async()=>({version:app.getVersion(),platform:process.platform,python:{available:await service('python').available(),version:'3.14.7',sandboxed:false}}));
 handler('chooseVault',async()=>windows.grant(await chooseFolder()));
 handler('openFolderWindow',async value=>{args(value??{},[]);const chosen=await chooseFolder();if(!chosen)return{opened:false};workspace();createWindow(chosen);return{opened:true};});
 handler('initialWindowVault',value=>{args(value??{},[]);return workspace().activeVault;});
 handler('externalOpenRequests',value=>{args(value??{},[]);return externalDocuments.list(workspace());});
 handler('acknowledgeExternalOpen',value=>{args(value,['id']);return externalDocuments.acknowledge(workspace(),value.id);});
 handler('moveExternalOpenToNewWindow',value=>{args(value,['id']);return externalDocuments.moveToNewWindow(workspace(),value.id);});
 handler('listCourseWorkspaces',()=>courseWorkspaces.list());
 handler('saveCourseWorkspace',value=>courseWorkspaces.save(args(value,['vaultId','name','layout','revision'])));
 handler('renameCourseWorkspace',value=>courseWorkspaces.rename(args(value,['id','name','revision'])));
 handler('deleteCourseWorkspace',value=>courseWorkspaces.remove(args(value,['id','revision'])));
 handler('prepareCourseWorkspace',async value=>{const prepared=await courseWorkspaces.prepare(args(value,['id']));return{...prepared,vault:windows.grant(prepared.vault)};});
 handler('recentRelinkPreview',value=>withDialog(async()=>{args(value,['id']);const context=workspace();const selected=await dialog.showOpenDialog(ownerWindow(),{title:localized('Relink the original course folder','重新关联原资料夹'),properties:['openDirectory']});workspace();if(selected.canceled||!selected.filePaths[0])return null;return recentVaults.previewRelink(value,selected.filePaths[0],context.id);}));
 handler('recentRelinkConfirm',async value=>windows.grant(await recentVaults.confirmRelink(args(value,['previewId','confirmed']),workspace().id)));
 handler('listRecentVaults',()=>recentVaults.list());handler('reopenRecentVault',async value=>windows.grant(await recentVaults.reopen(value)));handler('forgetRecentVault',value=>recentVaults.forget(value));
 handler('listDirectory',value=>vaults.listDirectory(fileArgs(value)));handler('readFile',value=>vaults.readFile(fileArgs(value)));handler('getAssetUrl',value=>vaults.getAssetUrl(fileArgs(value,['hideBoardID','hideBoardIDs'])));
 handler('mergeBoards',value=>require('./board-merge.cjs').mergeBoards(vaults,fileArgs(value,['expectedSHA256','sourcePath','expectedSourceSHA256','direction','position','mode','newPath'])));
 handler('inspectBoardMerge',value=>require('./board-merge.cjs').inspectBoardMerge(vaults,fileArgs(value,['expectedSHA256','sourcePath','expectedSourceSHA256'])));
 handler('undoBoardMerge',value=>require('./board-merge.cjs').undoBoardMerge(vaults,fileArgs(value,['expectedSHA256','journalID'])));
 handler('mutateBoard',value=>vaults.mutateBoard(fileArgs(value,['expectedSHA256','operation'])));
 handler('prepareBoardRelink',value=>require('./board-relink.cjs').prepare(vaults,fileArgs(value,['expectedSHA256','id','field','candidatePath','requestId'])));
 handler('resolveBoardSource',async value=>{const request=args(value,['vaultId','boardPath','expectedBoardSHA256','sourcePath']),context=workspace(),controller=new AbortController(),closed=()=>controller.abort();context.window.webContents.once('destroyed',closed);try{return await require('./board-source-resolver.cjs').resolveBoardSource(vaults,request,{signal:controller.signal});}finally{context.window.webContents.removeListener('destroyed',closed);}});
 handler('getBoardRelinkProgress',async value=>{const request=args(value,['vaultId','requestId']);await vaults.root(request.vaultId);return require('./board-relink-stream.cjs').progress(vaults,request);});
 handler('cancelBoardRelink',async value=>{const request=args(value,['vaultId','requestId']);await vaults.root(request.vaultId);return require('./board-relink-stream.cjs').cancel(vaults,request);});
 handler('knowledgeGraph',value=>knowledge.knowledgeGraph(args(value,['vaultId'])));handler('createBoard',value=>vaults.createBoard(args(value,['vaultId','parentPath','name'])));handler('saveBoardElements',value=>vaults.saveBoardElements(fileArgs(value,['expectedSHA256','items','edges'])));
 handler('unifiedSearchStatus',value=>unifiedIndex.status(args(value,['vaultId']).vaultId));
handler('unifiedSearchStart',(value,context)=>unifiedIndex.start(args(value,['vaultId','continuePending']),context.id));
handler('unifiedSearchCancel',(value,context)=>{args(value,['vaultId']);return unifiedIndex.cancel(context.id);});
handler('unifiedSearchQuery',value=>unifiedIndex.search(args(value,['vaultId','query','kind','offset'])));
handler('unifiedSearchResolve',value=>unifiedIndex.resolve(args(value,['vaultId','resultId'])));
handler('searchNotes',value=>knowledge.searchNotes(args(value,['vaultId','query'])));handler('noteLinks',value=>knowledge.noteLinks(fileArgs(value)));
 handler('saveText',value=>vaults.saveText(fileArgs(value,['expectedSHA256','text'])));
 handler('createFolder',value=>vaults.createFolder(args(value,['vaultId','parentPath','name'])));
 handler('createTextFile',value=>vaults.createTextFile(args(value,['vaultId','parentPath','name','content'])));
 handler('notebookDataInfo',value=>require('./notebook-data.cjs').notebookDataInfo(vaults,fileArgs(value)));
 handler('notebookInfo',()=>service('notebooks').info());handler('runNotebookCells',value=>service('notebooks').run(fileArgs(value,['expectedSHA256','runId','cellIndices'])));handler('interruptNotebook',value=>service('notebooks').interrupt(fileArgs(value)));handler('restartNotebook',value=>service('notebooks').restart(fileArgs(value)));handler('closeNotebook',value=>service('notebooks').close(fileArgs(value)));
 handler('runPython',value=>service('python').run(fileArgs(value,['expectedSHA256','runId'])));handler('cancelPython',value=>service('python').cancel(args(value,['runId'])));
 handler('importImage',value=>withDialog(async()=>{args(value,['vaultId','parentPath']);await vaults.resolve(value.vaultId,value.parentPath,{directory:true});const result=await dialog.showOpenDialog(ownerWindow(),{title:localized('Import an image into this folder','将图片导入此文件夹'),properties:['openFile'],filters:[{name:'PNG / JPEG',extensions:['png','jpg','jpeg']}]});if(result.canceled||!result.filePaths.length)return null;return require('./image-import.cjs').importSelectedImage(vaults,value,result.filePaths[0]);}));
 handler('openExternal',value=>require('./browser-link-routing.cjs').routeWebLink(value,{openBrowser:url=>browser().openURL(url),openSystem:url=>withDialog(async()=>{const result=await dialog.showMessageBox(ownerWindow(),{type:'question',title:localized('Open link','打开链接'),message:localized('Open this link in your default browser?','在默认浏览器打开此链接？'),detail:url,buttons:[localized('Cancel','取消'),localized('Open','打开')],defaultId:0,cancelId:0,noLink:true});if(result.response!==1)return {opened:false};await shell.openExternal(url);return {opened:true};})}));
 handler('getDiagnostics',()=>diagnostics.get());handler('exportDiagnostics',()=>saveExport(Buffer.from(JSON.stringify(diagnostics.get(),null,2)),{title:localized('Export diagnostic report','导出诊断报告'),defaultPath:displayBrand(appLocale(app))+'-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]}));
 handler('exportSourceFile',value=>withDialog(()=>require('./source-file-export.cjs').exportSourceFile(vaults,fileArgs(value,['expectedSHA256']),{dialog,window:ownerWindow()})));
 handler('exportCurrentViewPDF',async value=>{args(value??{},['name','source']);if(value?.name!==undefined&&(typeof value.name!=='string'||value.name.length>200||/[\\/\x00-\x1f]/.test(value.name)))fail('INVALID_REQUEST');if(workspace().dialogBusy||workspace().printingPDF)fail('BUSY');const context=workspace();context.printingPDF=true;try{let protectedSource;if(value?.source){const source=fileArgs(value.source,['expectedSHA256']);const fresh=await vaults.snapshot(source,256*1024*1024);if(fresh.sha256!==source.expectedSHA256)fail('CONFLICT');protectedSource=await fs.realpath((await vaults.resolve(source.vaultId,source.path)).full);}const data=await ownerWindow().webContents.printToPDF({printBackground:true,preferCSSPageSize:true,generateTaggedPDF:true});if(data.length>128*1024*1024)fail('TOO_LARGE');return await saveExport(data,{title:localized('Save PDF','保存 PDF'),defaultPath:value?.name||displayBrand(appLocale(app))+'-current-view.pdf',filters:[{name:'PDF',extensions:['pdf']}]},protectedSource);}finally{context.printingPDF=false;}});
}
async function chooseFolder(){return withDialog(async()=>{
 let root;if(!app.isPackaged&&process.env.INKSPACE_QA_VAULT)root=process.env.INKSPACE_QA_VAULT;else{
  const result=await dialog.showOpenDialog(ownerWindow(),{title:localized('Choose your local vault folder','选择本机仓库文件夹'),properties:['openDirectory']});
  if(result.canceled||!result.filePaths.length)return null;root=result.filePaths[0];
 }
 workspace();return recentVaults.choose(root);
});}
async function chooseDocument(){return withDialog(async()=>{
 const file=await require('./external-document-open.cjs').selectDocument({dialog,window:ownerWindow(),localized});
 workspace();if(file&&!externalDocuments.enqueue(file))fail('TOO_LARGE');
});}
function installDocumentMenu(){
 const action=(operation)=>()=>{
  const context=revealMainWindow(windows.focused()||createWindow());
  void Promise.resolve().then(()=>windows.run(context,operation)).catch(error=>{
   diagnostics?.record('documentMenu',error);dialog.showErrorBox(localized('Open document','打开文档'),publicError(error).message);
  });
 };
 require('./document-menu.cjs').installDocumentMenu({Menu,localized,onOpenFile:action(chooseDocument),applicationName:displayBrand(appLocale(app)),onOpenFolder:action(async()=>{const chosen=await chooseFolder();workspace();if(chosen)createWindow(chosen);})});
}
function cancelWindowJobs(context){
 regionCards?.closeOwner(context.id);studyDrafts?.closeOwner(context.id);pdfAnnotations?.closeOwner(context.id);wordAnnotations?.closeOwner(context.id);pngOrganization?.closeOwner(context.id);
 unifiedIndex?.cancel(context.id);workMail?.cancelOwner(context.id);workStudy?.cancelOwner(context.id);
 stopBoardSpeechPower(context);cancelWindowTranslations(context);
 context.services.get('ocrSampleBridge')?.cancelAll();context.services.get('localOCR')?.cancelAll();context.services.get('python')?.dispose();context.services.get('nativeInkBridge')?.cancel();context.services.get('latex')?.cancel();
 const notebooks=context.services.get('notebooks');if(notebooks){void notebooks.dispose();context.services.delete('notebooks');}
}
function createWindow(initialVault=null){
 const win=new BrowserWindow({width:1420,height:960,minWidth:900,minHeight:620,title:initialVault?displayBrand(appLocale(app))+' · '+initialVault.name:displayBrand(appLocale(app)),backgroundColor:'#ffffff',show:false,frame:true,resizable:true,minimizable:true,maximizable:true,fullscreenable:true,webPreferences:{backgroundThrottling:false,preload:path.join(__dirname,'..','preload','preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false}});
 const context=windows.add(win,initialVault);
 require('./editable-context-menu.cjs').installEditableContextMenu(win,{Menu,localized});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.on('will-attach-webview',event=>event.preventDefault());
 win.webContents.on('will-prevent-unload',event=>{const choice=dialog.showMessageBoxSync(win,{type:'warning',title:localized('Unsaved changes','有尚未保存的修改'),message:localized('Close and discard your unsaved changes?','关闭并放弃尚未保存的修改？'),buttons:[localized('Keep Editing','继续编辑'),localized('Discard and Close','放弃并关闭')],defaultId:0,cancelId:0,noLink:true});if(choice===1)event.preventDefault();});
 win.webContents.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace){externalDocuments.reset(context);cancelWindowJobs(context);}});
 win.webContents.on('render-process-gone',()=>{externalDocuments.reset(context);cancelWindowJobs(context);});
 win.on('focus',()=>{windows.lastActive=context;});win.once('ready-to-show',()=>{if(!win.isDestroyed())win.show();});
 win.on('closed',()=>{cancelWindowJobs(context);calendarReminders?.release(context.id);externalDocuments.remove(context);windows.remove(context);});
 void win.loadURL(devURL||'inkspace-app://ui/index.html').catch(error=>diagnostics?.record('windowLoad',error));return context;
}
function revealMainWindow(context=windows.focused()){
 if(!windows.alive(context))return createWindow();
 const win=context.window;if(win.isMinimized())win.restore();win.show();win.focus();return context;
}
async function videoResponse(url,options){
 const parsed=new URL(url),token=parsed.pathname.slice(1);
 for(const context of windows.windows.values()){
  if(parsed.hostname==='composition'){const editor=context.services.get('mediaEditor');if(editor?.leases.has(token))return editor.compositionResponse(url,options);}
  else{const videos=context.services.get('videos');if(videos?.tokens.has(token))return videos.response(url,options);}
 }
 fail('PATH_DENIED');
}
let aiPanels=null;
app.whenReady().then(async()=>{
 if(!primaryInstance)return;
 applyApplicationBrand(app);
 const dataDirectory=app.getPath('userData');
 diagnostics=new Diagnostics(dataDirectory);windows.diagnostics=diagnostics;await diagnostics.load();
 translations=new(require('./translation-service.cjs').TranslationService)({dataDirectory,safeStorage,validateImage:(data,size)=>{const image=nativeImage.createFromBuffer(data),actual=image.getSize();return !image.isEmpty()&&actual.width===size.width&&actual.height===size.height;}});
 const nativeInkBridge=process.platform==='darwin'&&process.arch==='arm64'?{info:()=>service('nativeInkBridge').info(),apply:request=>service('nativeInkBridge').apply(request)}:null;
 vaults=new VaultService({dataDirectory,nativeInkBridge});
 noteExchange=new(require('./note-exchange.cjs').NoteExchange)(vaults,{applicationName:()=>displayBrand(appLocale(app)),diagnosticsDirectory:path.join(dataDirectory,'note-import-recovery'),onError:(operation,error)=>diagnostics?.record(operation,error),imageDecoder:(data,info)=>{const image=nativeImage.createFromBuffer(data),size=image.getSize();return !image.isEmpty()&&size.width===info.width&&size.height===info.height;}});
 courseWorkspaces=new(require('./course-workspace-store.cjs').CourseWorkspaceStore)({dataDirectory,vaults,resolveFolder:folder=>recentVaults.resumeFolder(folder)});
 recentVaults=new(require('./recent-vaults.cjs').RecentVaults)({dataDirectory,vaults,onStorageError:error=>diagnostics?.record('recentVaults',error)});
 workSpace=new(require('./work-space-store.cjs').WorkSpaceStore)({dataDirectory});
 workMail=new(require('./work-mail-service.cjs').WorkMailService)({app,dataDirectory,store:workSpace,publish:publishWork});void workMail.reconcile();
 workSources=new(require('./work-source-catalog.cjs').WorkSourceCatalogue)({store:workSpace,vaults,resolveFolder:folder=>recentVaults.resumeFolder(folder),grant:vault=>windows.grant(vault)});
 wordAnnotations=new(require('./word-annotations-service.cjs').WordAnnotationQueueService)({vaults});
 pdfAnnotations=new(require('./pdf-annotations-service.cjs').PDFAnnotationQueueService)({vaults});
 workStudy=new(require('./work-study-capture.cjs').WorkStudyCaptureService)({store:workSpace,sources:workSources,vaults,pdfAnnotations,wordAnnotations,publish:publishWork,onOpen:async target=>{const context=createWindow(target.vault);windows.grant(target.vault,context);externalDocuments.deliver(context,target);return{opened:true};}});
 pdfLayers=new(require('./pdf-layer-service.cjs').PDFLayerService)(vaults);pdfExtend=new(require('./pdf-extend-service.cjs').PDFExtendService)(vaults);study=new(require('./study-service.cjs').StudyService)(vaults,{nativeImage});studyTransfer=new(require('./study-transfer-service.cjs').StudyTransferService)(vaults,study);
 studyLayoutPackages=new(require('./study-layout-package.cjs').StudyLayoutPackageService)(vaults,study);
 studyLayouts=new(require('./study-layout-service.cjs').StudyLayoutService)(vaults,{studyService:study});
 regionCards=new(require('./board-region-study.cjs').BoardRegionStudyService)(vaults,study,{nativeImage,capture:async(owner,rect)=>{const context=windows.windows.get(owner);if(!windows.alive(context)||context!==workspace())fail('CANCELLED');const wc=context.window.webContents,zoom=wc.getZoomFactor(),size=context.window.getContentBounds();if(rect.y<48||rect.x<0||rect.y<0||rect.width<8||rect.height<8||rect.x+rect.width>size.width/zoom||rect.y+rect.height>size.height/zoom)fail('REGION_STUDY_INVALID');const image=await wc.capturePage({x:Math.round(rect.x*zoom),y:Math.round(rect.y*zoom),width:Math.round(rect.width*zoom),height:Math.round(rect.height*zoom)});if(!windows.alive(context)||image.isEmpty())fail('CANCELLED');return{data:image.toPNG()};}});
 studyDrafts=new(require('./study-draft-service.cjs').StudyDraftService)(vaults,study);
  pngOrganization=require('./png-organization-service.cjs').pngOrganizationForVaults(vaults,{nativeImage});
  fileManagement=new(require('./vault-file-management.cjs').VaultFileManagement)(vaults);videoSubtitles=new(require('./video-subtitles.cjs').VideoSubtitleService)(vaults);documents=new DocumentService(vaults,{printPDF:printDocumentPDF});knowledge=new KnowledgeService(vaults);reviews=new ReviewService(vaults);
 unifiedIndex=new(require('./unified-index.cjs').UnifiedIndex)({vaults,dataDirectory,runtimePath:path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),'runtime','nativeOCR',process.platform==='darwin'?'darwin-arm64':'win32-x64',process.platform==='darwin'?'InkSpaceOCR':'InkSpaceOCR.exe')});
  serviceFactories=require('./workspace-services.cjs').workspaceServiceFactories({app,vaults,reviews,windows,auxiliaryIPC,dialog,BrowserWindow,nativeImage,powerMonitor,diagnostics,videoSubtitles,devURL,dataDirectory,systemPreferences});
 const calendarService=require('./calendar-service.cjs');calendarFiles=new calendarService.CalendarFiles(vaults);
 calendarReminders=new calendarService.CalendarReminderScheduler({vaults,dataDirectory,isSupported:()=>Notification.isSupported(),disabled:process.env.INKSPACE_DISABLE_NOTIFICATIONS==='1'||Boolean(process.env.INKSPACE_QA_USER_DATA||process.env.INKSPACE_QA_VAULT),onStatus:status=>{for(const context of windows.windows.values())windows.send(context,'desktop:calendarReminderStatus',status);},notify:message=>{
  const notice=new Notification({title:message.title,body:message.body,silent:false});notice.on('failed',()=>calendarReminders.notificationFailed());
  notice.on('click',()=>{void vaults.root(message.vaultId).then(root=>{
   const vault={id:message.vaultId,name:path.basename(root)},context=revealMainWindow(windows.forVault(message.vaultId)||createWindow(vault));
   context.pendingCalendarReminder={vaultId:message.vaultId,vault,eventId:message.eventId,occurrenceStart:message.occurrenceStart};
   const send=()=>{if(context.pendingCalendarReminder)windows.send(context,'desktop:calendarReminder',context.pendingCalendarReminder);};
   if(context.window.webContents.isLoading())context.window.webContents.once('did-finish-load',send);else send();
  }).catch(error=>diagnostics?.record('calendarReminderClick',error));});notice.show();
 }});
 powerMonitor.on('resume',()=>void calendarReminders.tick());powerMonitor.on('unlock-screen',()=>void calendarReminders.tick());
 const allowedFullscreen=contents=>!!contents&&(windows.windows.has(contents.id)||[...windows.windows.values()].some(context=>context.services.get('videoWindows')?.owns(contents)));
 session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>callback(permission==='fullscreen'&&allowedFullscreen(contents)));session.defaultSession.setPermissionCheckHandler((contents,permission)=>permission==='fullscreen'&&allowedFullscreen(contents));
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{try{const mainContents=windows.windows.get(details.webContentsId)?.window.webContents,embedded=require('./board-web-network.cjs').embeddedWebRequest(details,mainContents);if(embedded!==null){callback({cancel:!embedded});return;}const u=new URL(details.url),permitted=['inkspace-app:','vault-asset:','vault-video:','data:','blob:','devtools:'].includes(u.protocol)||(devURL&&(u.origin===new URL(devURL).origin||u.origin===new URL(devURL).origin.replace(/^http/,'ws')));callback({cancel:!permitted});}catch{callback({cancel:true});}});
 session.defaultSession.webRequest.onHeadersReceived((details,callback)=>{const headers={...details.responseHeaders};if(details.resourceType==='mainFrame')headers['Content-Security-Policy']=[contentSecurityPolicy()];callback({responseHeaders:headers});});
 await registerProtocols();installIPC();aiPanels=require('./ai-panel.cjs').installAIPanel({app,getWindow:ownerWindow,handler,diagnostics});
 if(!externalDocuments.pending.length)createWindow();await externalDocuments.configure({vaults,windows,recentVaults,createWindow,reveal:revealMainWindow});if(!windows.focused())createWindow();app.on('activate',()=>revealMainWindow());
 installDocumentMenu();
}).catch(error=>{diagnostics?.record('startup',error);dialog.showErrorBox(displayBrand(appLocale(app)),publicError(error).message);app.quit();});
app.on('will-quit',()=>{for(const context of [...windows.windows.values()]){cancelWindowJobs(context);windows.remove(context);}aiPanels?.close();workMail?.dispose();calendarReminders?.dispose();translations?.dispose();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});

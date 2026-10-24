'use strict';
const fs=require('node:fs/promises'); const path=require('node:path'); const crypto=require('node:crypto');
const {publicError}=require('./errors.cjs');
const OCR_PHASES=new Set(['capture','recognition']),OCR_STATES=new Set(['captured','recognized','no_text','failed','cancelled','timed_out','output_limited']);
const AI_WEB_PROVIDERS=new Set(['chatgpt','deepseek','claude','gemini']);
const AI_WEB_PHASES=new Set(['created','navigation','load','visibility','popup','closed','crashed','unresponsive','responsive','status','page']);
const AI_WEB_STATES=new Set(['idle','loading','ready','failed','closed','crashed','hidden','visible']);
const AI_WEB_REASONS=new Set(['crashed','oom','killed','clean-exit','abnormal-exit','launch-failed','integrity-failure','unknown']);
const AI_WEB_KEYS=new Set(['provider','phase','state','webContentsId','mainFrame','inPlace','shown','x','y','width','height','errorCode','reason','popups','navigations','loads','pageRevision','loadGeneration','attached','topmost','windowVisible','windowMinimized','windowFocused','contentFocused','backgroundThrottling','readyState','visibilityState','assistantNodes','visibleAssistantNodes','bodyChildren','userNodes','generating']);
// A closed schema deliberately excludes page URLs, titles, messages and DOM
// strings. Reading data descriptors also avoids invoking an accidental getter.
function aiWebStage(value){
 try{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!AI_WEB_KEYS.has(key)||!Object.hasOwn(descriptors[key],'value')))return null;
  const input=Object.fromEntries(Object.entries(descriptors).map(([key,descriptor])=>[key,descriptor.value]));
  if(!AI_WEB_PROVIDERS.has(input.provider)||!AI_WEB_PHASES.has(input.phase)||!AI_WEB_STATES.has(input.state))return null;
  const result={provider:input.provider,phase:input.phase,state:input.state};
  for(const key of ['webContentsId','x','y','width','height','errorCode','popups','navigations','loads','pageRevision','loadGeneration','assistantNodes','visibleAssistantNodes','bodyChildren','userNodes'])if(Object.hasOwn(input,key)){
   const minimum=key==='webContentsId'?1:key==='errorCode'?-2147483648:['x','y'].includes(key)?-50000:0;
   const maximum=key==='webContentsId'?Number.MAX_SAFE_INTEGER:key==='errorCode'?2147483647:['x','y','width','height'].includes(key)?50000:1000000;
   if(!Number.isSafeInteger(input[key])||input[key]<minimum||input[key]>maximum)return null;result[key]=input[key];
  }
  for(const key of ['mainFrame','inPlace','shown','attached','topmost','windowVisible','windowMinimized','windowFocused','contentFocused','backgroundThrottling','generating'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='boolean')return null;result[key]=input[key];}
  for(const [key,allowed]of [['reason',AI_WEB_REASONS],['readyState',new Set(['loading','interactive','complete'])],['visibilityState',new Set(['visible','hidden'])]])if(Object.hasOwn(input,key)){if(!allowed.has(input[key]))return null;result[key]=input[key];}
  if(result.visibleAssistantNodes!=null&&result.assistantNodes!=null&&result.visibleAssistantNodes>result.assistantNodes)return null;
  return result;
 }catch{return null;}
}
function loadedAIWebStage(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const {at,...data}=value,clean=aiWebStage(data);
 if(!clean||typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)return null;
 return {at,...clean};
}
function ocrStage(value){
 if(!value||!OCR_PHASES.has(value.phase)||!OCR_STATES.has(value.status)||!Number.isFinite(value.durationMs)||value.durationMs<0||value.durationMs>600000)return null;
 const result={phase:value.phase,status:value.status,durationMs:Math.round(value.durationMs)};
 for(const key of ['width','height','boxes'])if(value[key]!=null){const max=key==='boxes'?30000:20000;if(!Number.isSafeInteger(value[key])||value[key]<0||value[key]>max)return null;result[key]=value[key];}
 return result;
}
class Diagnostics {
 constructor(directory){this.file=path.join(directory,'desktop-diagnostics.json');this.events=[];this.ocrStages=[];this.aiWebStages=[];this.aiWebStatusSignatures=new Map();this.storageIssue=false;this.queue=Promise.resolve();}
 async load(){try{const stat=await fs.stat(this.file);if(stat.size>128*1024)throw Error();const data=JSON.parse(await fs.readFile(this.file,'utf8'));this.events=Array.isArray(data.events)?data.events.filter(e=>typeof e.operation==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(e.operation)&&typeof e.code==='string'&&/^[A-Z_]{1,40}$/.test(e.code)&&Number.isSafeInteger(e.count)&&e.count>0&&Number.isFinite(Date.parse(e.firstAt))&&Number.isFinite(Date.parse(e.lastAt))).slice(-200).map(({operation,code,count,firstAt,lastAt})=>({operation,code,count,firstAt,lastAt})):[];this.ocrStages=Array.isArray(data.ocrStages)?data.ocrStages.slice(-40).flatMap(value=>{const clean=ocrStage(value);return clean&&typeof value.at==='string'&&Number.isFinite(Date.parse(value.at))?[{at:value.at,...clean}]:[]}):[];this.aiWebStages=Array.isArray(data.aiWebStages)?data.aiWebStages.slice(-40).flatMap(value=>{const clean=loadedAIWebStage(value);return clean?[clean]:[]}):[];this.aiWebStatusSignatures.clear();for(const {at,...stage}of this.aiWebStages)if(['status','page'].includes(stage.phase))this.aiWebStatusSignatures.set(stage.provider+':'+stage.phase,JSON.stringify(stage));}catch(e){if(e.code!=='ENOENT')this.storageIssue=true;}}
 record(operation,error){const {code}=publicError(error);if(code==='CANCELLED')return;const now=new Date().toISOString();const existing=this.events.find(e=>e.operation===operation&&e.code===code);if(existing){existing.count++;existing.lastAt=now;}else{this.events.push({operation,code,count:1,firstAt:now,lastAt:now});this.events=this.events.slice(-200);}this.persist();}
 recordOCRStage(value){const clean=ocrStage(value);if(!clean)return;this.ocrStages.push({at:new Date().toISOString(),...clean});this.ocrStages=this.ocrStages.slice(-40);this.persist();}
 recordAIWebStage(value){
  const clean=aiWebStage(value);if(!clean)return false;
  const signature=JSON.stringify(clean),last=this.aiWebStages.at(-1);
  if(last){const {at,...previous}=last;if(JSON.stringify(previous)===signature)return false;}
  // Native status and page structure are sampled by the panel poller. Identical samples must not turn a
  // healthy idle website into a disk write every two seconds, even when other
  // lifecycle events or another provider's status occur between those samples.
  if(['status','page'].includes(clean.phase)){const key=clean.provider+':'+clean.phase;if(this.aiWebStatusSignatures.get(key)===signature)return false;this.aiWebStatusSignatures.set(key,signature);}
  this.aiWebStages.push({at:new Date().toISOString(),...clean});this.aiWebStages=this.aiWebStages.slice(-40);this.persist();return true;
 }
 persist(){this.queue=this.queue.then(async()=>{await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify({schemaVersion:1,events:this.events,ocrStages:this.ocrStages,aiWebStages:this.aiWebStages}),{mode:0o600,flag:'wx'});await fs.rename(tmp,this.file);this.storageIssue=false;}finally{await fs.unlink(tmp).catch(()=>{});}}).catch(()=>{this.storageIssue=true;});}
 get(){return {schemaVersion:1,events:this.events.map(e=>({...e})),ocrStages:this.ocrStages.map(e=>({...e})),aiWebStages:this.aiWebStages.map(e=>({...e})),storageIssue:this.storageIssue};}
 async settled(){await this.queue;}
}
module.exports={Diagnostics,ocrStage,aiWebStage};

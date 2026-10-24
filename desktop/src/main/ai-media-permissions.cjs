'use strict';
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {isProviderOrigin}=require('./ai-web-providers.cjs');

const MICROPHONE_USAGE_DESCRIPTION='仅在你在 AI 网页中开启语音或听写时使用麦克风；音频由所选 AI 服务处理。';
const sessions=new WeakMap(),systemPrompts=new WeakMap();

function hasMacMicrophoneUsage(executable){
 try{
  if(typeof executable!=='string'||!path.isAbsolute(executable))return false;
  const plist=path.resolve(path.dirname(executable),'..','Info.plist');
  const value=execFileSync('/usr/bin/plutil',['-extract','NSMicrophoneUsageDescription','raw','-o','-',plist],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:2000,maxBuffer:16384});
  return value.trim().length>0;
 }catch{return false;}
}

function trustedRequest(owner,contents,permission,details,origin){
 try{
  if(!owner||owner.disposed||owner.contents!==contents||permission!=='media'||!details||details.isMainFrame!==true||!owner.isActive()||contents.isDestroyed()||owner.window.isDestroyed())return false;
  if(!isProviderOrigin(owner.provider,contents.getURL())||!isProviderOrigin(owner.provider,details.requestingUrl))return false;
  if(origin!==undefined&&!isProviderOrigin(owner.provider,origin))return false;
  if(details.securityOrigin!==undefined&&!isProviderOrigin(owner.provider,details.securityOrigin))return false;
  if(details.embeddingOrigin!==undefined&&!isProviderOrigin(owner.provider,details.embeddingOrigin))return false;
  return true;
 }catch{return false;}
}

function accessStatus(owner){
 try{
  if(owner.platform!=='darwin')return 'unknown';
  if(owner.configurationValid===undefined)owner.configurationValid=owner.configurationReady()===true;
  return owner.configurationValid?owner.systemPreferences.getMediaAccessStatus('microphone'):'unknown';
 }catch{return 'unknown';}
}

function requestSystemAccess(preferences){
 let request=systemPrompts.get(preferences);if(request)return request;
 request=Promise.resolve().then(()=>preferences.askForMediaAccess('microphone'));
 systemPrompts.set(preferences,request);
 request.finally(()=>{if(systemPrompts.get(preferences)===request)systemPrompts.delete(preferences);}).catch(()=>{});
 return request;
}

function sessionState(session){
 let state=sessions.get(session);if(state)return state;
 state={owners:new Map()};sessions.set(session,state);
 session.setPermissionCheckHandler((contents,permission,origin,details)=>{
  const owner=state.owners.get(contents);
  return trustedRequest(owner,contents,permission,details,origin)&&details.mediaType==='audio'&&owner.consented&&accessStatus(owner)==='granted';
 });
 session.setPermissionRequestHandler((contents,permission,callback,details)=>{
  const owner=state.owners.get(contents);
  const audioOnly=Array.isArray(details?.mediaTypes)&&details.mediaTypes.length===1&&details.mediaTypes[0]==='audio';
  if(!audioOnly||!trustedRequest(owner,contents,permission,details)||owner.pending){callback(false);return;}
  let revision;try{revision=owner.revision();}catch{callback(false);return;}let finished=false;
  const respond=granted=>{if(finished)return;finished=true;if(owner.pending===operation)owner.pending=null;try{callback(granted===true);}catch{}};
  const operation={deny:()=>respond(false)};owner.pending=operation;
  const current=()=>{try{return state.owners.get(contents)===owner&&owner.pending===operation&&owner.revision()===revision&&trustedRequest(owner,contents,permission,details);}catch{return false;}};
  const status=value=>{if(!owner.disposed)try{owner.onStatus(value);}catch{}};
  void(async()=>{
   let systemStatus=accessStatus(owner);
   if(systemStatus==='denied'||systemStatus==='restricted'){status(systemStatus==='denied'?'system-denied':'system-restricted');respond(false);return;}
   if(!['granted','not-determined'].includes(systemStatus)){status('unavailable');respond(false);return;}
   if(!owner.consented){
    status('prompting');const zh=owner.app.getLocale?.().startsWith('zh');
    const result=await owner.dialog.showMessageBox(owner.window,{type:'question',title:zh?'AI 网页麦克风':'AI webpage microphone',message:zh?`允许 ${owner.label} 使用麦克风？`:`Allow ${owner.label} to use the microphone?`,detail:zh?'网页将继续你发起的语音或听写，并由该 AI 服务处理音频。你可以在网页内停止。':'The webpage can continue your requested voice or dictation, with audio processed by this AI service. You can stop it on the webpage.',buttons:zh?['暂不允许','允许麦克风']:['Not now','Allow microphone'],defaultId:0,cancelId:0,noLink:true});
    if(!current()){status('cancelled');respond(false);return;}
    if(result.response!==1){status('cancelled');respond(false);return;}
   }
   if(!current()){status('cancelled');respond(false);return;}
   systemStatus=accessStatus(owner);
   if(systemStatus==='not-determined'){
    status('prompting');const allowed=await requestSystemAccess(owner.systemPreferences);
    if(!current()){status('cancelled');respond(false);return;}
    if(allowed!==true){status('system-denied');respond(false);return;}
    systemStatus=accessStatus(owner);
   }
   if(!current()){status('cancelled');respond(false);return;}
   if(systemStatus!=='granted'){status(systemStatus==='restricted'?'system-restricted':systemStatus==='denied'?'system-denied':'unavailable');respond(false);return;}
   owner.consented=true;status('granted');respond(true);
  })().catch(()=>{if(current())status('unavailable');respond(false);}).finally(()=>{if(owner.pending===operation)owner.pending=null;});
 });
 return state;
}

function registerAIMicrophoneOwner({session,contents,window,provider,label,app,dialog,systemPreferences,isActive,revision,onStatus=()=>{},platform=process.platform,configurationReady=()=>hasMacMicrophoneUsage(app.getPath('exe'))}){
 if(!contents||contents.session!==session||contents.isDestroyed()||!window||window.isDestroyed())throw Error('Invalid AI microphone owner');
 const state=sessionState(session);if(state.owners.has(contents))throw Error('Duplicate AI microphone owner');
 const owner={contents,window,provider,label,app,dialog,systemPreferences,isActive,revision,onStatus,platform,configurationReady,consented:false,disposed:false,pending:null};
 const dispose=()=>{if(owner.disposed)return;owner.disposed=true;owner.pending?.deny();if(state.owners.get(contents)===owner)state.owners.delete(contents);contents.removeListener('destroyed',dispose);window.removeListener('closed',dispose);};
 state.owners.set(contents,owner);contents.once('destroyed',dispose);window.once('closed',dispose);
 return dispose;
}

module.exports={MICROPHONE_USAGE_DESCRIPTION,hasMacMicrophoneUsage,registerAIMicrophoneOwner};

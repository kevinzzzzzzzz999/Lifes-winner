'use strict';
// Main-process TCC broker. It requests permission, never captures audio and
// never grants web origins access. A first grant always requires another click.
class QuickNoteMicrophonePermissionBroker {
 constructor({systemPreferences,platform=process.platform}={}){this.preferences=systemPreferences;this.platform=platform;this.inFlight=null;}
 async authorize({isForeground=()=>false,onStage=()=>{}}={}){
  if(this.platform!=='darwin'||!this.preferences)return{state:'unavailable'};
  if(!isForeground()){onStage('broker-foreground-required');return{state:'foreground-required'};}
  let status;try{status=this.preferences.getMediaAccessStatus('microphone');}catch{return{state:'unavailable'};}
  if(!['not-determined','granted','denied','restricted','unknown'].includes(status))return{state:'unavailable'};
  onStage('broker-status-'+status);
  if(status==='granted')return{state:'ready'};
  if(status==='denied'||status==='restricted')return{state:status};
  if(status!=='not-determined')return{state:'unavailable'};
  if(this.inFlight)return{state:'busy'};
  // Recheck immediately before the OS call. Losing focus after this call cannot
  // cancel the system dialog, but no eventual response can start a helper.
  if(!isForeground()){onStage('broker-foreground-required');return{state:'foreground-required'};}
  onStage('broker-request-begin');
  let request;try{request=Promise.resolve(this.preferences.askForMediaAccess('microphone'));}catch{return{state:'unavailable'};}
  this.inFlight=request;
  try{const allowed=await request;onStage(allowed===true?'broker-request-granted':'broker-request-denied');return{state:allowed===true?'permission-granted':'denied'};}
  catch{return{state:'unavailable'};}
  finally{if(this.inFlight===request)this.inFlight=null;}
 }
}
module.exports={QuickNoteMicrophonePermissionBroker};

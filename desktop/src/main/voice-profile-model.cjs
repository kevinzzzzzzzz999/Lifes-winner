'use strict';
const crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const LIMITS=Object.freeze({entries:500,phrase:64,example:4000,bytes:16*1024*1024,context:100});
const phraseKey=value=>value.trim().normalize('NFC').toLowerCase();
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('VOICE_PROFILE_INVALID');}
function text(value,max,{empty=false}={}){if(typeof value!=='string'||value.length>max||value.includes('\0')||!value.isWellFormed()||(!empty&&!value.trim()))fail('VOICE_PROFILE_INVALID');return value;}
function stamp(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().replace('.000Z','Z')!==value.replace('.000Z','Z'))fail('VOICE_PROFILE_INVALID');return value;}
function entry(value){object(value,['id','phrase','source','createdAt','updatedAt','confirmations','originalText','correctedText']);if(!UUID.test(value.id||'')||!['manual','confirmed-correction'].includes(value.source)||!Number.isSafeInteger(value.confirmations)||value.confirmations<1||value.confirmations>100000)fail('VOICE_PROFILE_INVALID');const phrase=text(value.phrase,LIMITS.phrase);if(phrase!==phrase.trim())fail('VOICE_PROFILE_INVALID');return{id:value.id,phrase,source:value.source,createdAt:stamp(value.createdAt),updatedAt:stamp(value.updatedAt),confirmations:value.confirmations,...(value.originalText===undefined?{}:{originalText:text(value.originalText,LIMITS.example,{empty:true})}),...(value.correctedText===undefined?{}:{correctedText:text(value.correctedText,LIMITS.example,{empty:true})})};}
function parseVoiceProfile(value){object(value,['schemaVersion','kind','id','enabled','updatedAt','entries']);if(value.schemaVersion!==1||value.kind!=='quick-note-voice-profile'||!UUID.test(value.id||'')||typeof value.enabled!=='boolean'||!Array.isArray(value.entries)||value.entries.length>LIMITS.entries)fail('VOICE_PROFILE_INVALID');const entries=value.entries.map(entry);if(new Set(entries.map(v=>v.id.toLowerCase())).size!==entries.length||new Set(entries.map(v=>phraseKey(v.phrase))).size!==entries.length)fail('VOICE_PROFILE_INVALID');return{schemaVersion:1,kind:value.kind,id:value.id,enabled:value.enabled,updatedAt:stamp(value.updatedAt),entries};}
function newVoiceProfile(now=new Date()){return{schemaVersion:1,kind:'quick-note-voice-profile',id:crypto.randomUUID(),enabled:true,updatedAt:now.toISOString(),entries:[]};}
function preferredPhrase(value){const phrase=text(value,LIMITS.phrase).trim();if(!phrase)fail('VOICE_PROFILE_INVALID');return phrase;}
function addVoicePhrase(profile,{phrase,originalText,correctedText,source='manual'},now=new Date()){
 const next=structuredClone(parseVoiceProfile(profile)),preferred=preferredPhrase(phrase),at=now.toISOString();
 if(source==='confirmed-correction'){if(!next.enabled)fail('VOICE_PROFILE_DISABLED');text(originalText,LIMITS.example);text(correctedText,LIMITS.example);if(originalText===correctedText)fail('VOICE_PROFILE_NO_CORRECTION');}
 else if(source!=='manual')fail('VOICE_PROFILE_INVALID');
 const prior=next.entries.find(v=>phraseKey(v.phrase)===phraseKey(preferred));if(!prior&&next.entries.length>=LIMITS.entries)fail('VOICE_PROFILE_LIMIT');
 const value={id:prior?.id||crypto.randomUUID(),phrase:preferred,source,createdAt:prior?.createdAt||at,updatedAt:at,confirmations:Math.min(100000,(prior?.confirmations||0)+1),...(source==='confirmed-correction'?{originalText,correctedText}:prior?.source==='confirmed-correction'?{source:prior.source,...(prior.originalText===undefined?{}:{originalText:prior.originalText}),...(prior.correctedText===undefined?{}:{correctedText:prior.correctedText})}:{})};
 next.entries=prior?next.entries.map(v=>v.id===prior.id?value:v):[value,...next.entries];next.updatedAt=at;return parseVoiceProfile(next);
}
function profileContext(profile){const parsed=parseVoiceProfile(profile);return parsed.enabled?[...parsed.entries].sort((a,b)=>b.confirmations-a.confirmations||Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,LIMITS.context).map(v=>v.phrase):[];}
function mergeVoiceProfiles(profile,incoming,now=new Date()){
 const next=structuredClone(parseVoiceProfile(profile)),other=parseVoiceProfile(incoming),at=now.toISOString();
 for(const item of other.entries){
  const byID=next.entries.find(v=>v.id.toLowerCase()===item.id.toLowerCase());
  if(byID){if(phraseKey(byID.phrase)!==phraseKey(item.phrase))fail('VOICE_PROFILE_CONFLICT');const count=Math.max(byID.confirmations,item.confirmations);if(Date.parse(item.updatedAt)>Date.parse(byID.updatedAt)){const id=byID.id;Object.assign(byID,item,{id});}byID.confirmations=count;continue;}
  const byPhrase=next.entries.find(v=>phraseKey(v.phrase)===phraseKey(item.phrase));if(byPhrase){byPhrase.confirmations=Math.max(byPhrase.confirmations,item.confirmations);continue;}
  if(next.entries.length>=LIMITS.entries)fail('VOICE_PROFILE_LIMIT');next.entries.push({...item});
 }
 next.updatedAt=at;return parseVoiceProfile(next);
}
module.exports={phraseKey,LIMITS,parseVoiceProfile,newVoiceProfile,addVoicePhrase,mergeVoiceProfiles,profileContext,preferredPhrase};

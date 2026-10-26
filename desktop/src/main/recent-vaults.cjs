'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const {absolute,validBirth,validIdentity,identity,samePhysical,sameLocation,inspect,relocatedEntry}=require('./recent-vault-identity.cjs');

const RECENT_VAULTS_FILE='recent-vaults.json';
const MAX_RECENT_VAULTS=8,MAX_BYTES=128*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const recordKeys=['id','name','selectedPath','canonicalPath','dev','ino','lastOpenedAt'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function validRecord(value){
 return plain(value)&&Object.keys(value).every(k=>recordKeys.includes(k)||['birthtimeMs','historyRoot','previousIdentities'].includes(k))&&recordKeys.every(key=>Object.hasOwn(value,key))&&
  typeof value.id==='string'&&UUID.test(value.id)&&typeof value.name==='string'&&value.name.length>0&&value.name.length<=1024&&!value.name.includes('\0')&&
  absolute(value.selectedPath)&&absolute(value.canonicalPath)&&value.name===(path.basename(value.canonicalPath)||value.canonicalPath)&&
  Number.isSafeInteger(value.dev)&&value.dev>=0&&Number.isSafeInteger(value.ino)&&value.ino>=0&&
  (value.birthtimeMs===undefined||validBirth(value.birthtimeMs))&&(value.historyRoot===undefined||absolute(value.historyRoot))&&(value.previousIdentities===undefined||Array.isArray(value.previousIdentities)&&value.previousIdentities.length<=32&&value.previousIdentities.every(validIdentity))&&
  typeof value.lastOpenedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.lastOpenedAt)&&Number.isFinite(Date.parse(value.lastOpenedAt))&&new Date(value.lastOpenedAt).toISOString()===value.lastOpenedAt;
}
function parseRecords(data){
 const value=JSON.parse(data);
 if(!plain(value)||Object.keys(value).length!==2||![1,2].includes(value.schemaVersion)||!Array.isArray(value.entries)||value.entries.length>MAX_RECENT_VAULTS||!value.entries.every(validRecord)||new Set(value.entries.map(entry=>entry.id)).size!==value.entries.length||(value.schemaVersion===1&&new Set(value.entries.map(entry=>entry.canonicalPath)).size!==value.entries.length))fail('IO_FAILED');
 return value.entries;
}
function requestID(value){
 if(!plain(value)||Object.keys(value).length!==1||typeof value.id!=='string'||!UUID.test(value.id))fail('INVALID_REQUEST');
 return value.id;
}
async function readRecords(file){
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES)fail('IO_FAILED');
  const buffer=Buffer.alloc(MAX_BYTES+1);let length=0;
  while(length<buffer.length){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
  if(length>MAX_BYTES)fail('IO_FAILED');
  return parseRecords(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));
 }finally{await handle.close();}
}
async function writeRecords(dataDirectory,entries){
 const data=Buffer.from(JSON.stringify({schemaVersion:2,entries}));if(data.length>MAX_BYTES)fail('IO_FAILED');
 await fs.mkdir(dataDirectory,{recursive:true,mode:0o700});
 const directory=await fs.lstat(dataDirectory);if(directory.isSymbolicLink()||!directory.isDirectory())fail('IO_FAILED');
 const file=path.join(dataDirectory,RECENT_VAULTS_FILE),temporary=path.join(dataDirectory,'.recent-vaults-'+crypto.randomUUID()+'.tmp');
 try{
  // Never follow a substituted profile file, including during recovery from corrupt JSON.
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('IO_FAILED');}catch(error){if(error.code!=='ENOENT')throw error;}
  const handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
  await fs.rename(temporary,file);
 }finally{await fs.unlink(temporary).catch(()=>{});}
}

// History is a main-process-only list of previously chosen folders, not a set of
// live grants. Listing it reads one bounded profile file and never visits a vault.
class RecentVaults {
 constructor({dataDirectory,vaults,load,persist,onStorageError=()=>{}}){
  this.vaults=vaults;this.entries=[];this.storageIssue=false;this.queue=Promise.resolve();this.loaded=null;this.readOnly=false;this.previews=new Map();
  this.loadRecords=load||(()=>readRecords(path.join(dataDirectory,RECENT_VAULTS_FILE)));
  this.persistRecords=persist||(entries=>writeRecords(dataDirectory,entries));this.onStorageError=onStorageError;
 }
 storageFailed(error){this.storageIssue=true;try{this.onStorageError(error);}catch{}}
 async load(){
  if(!this.loaded)this.loaded=(async()=>{try{this.entries=await this.loadRecords();}catch(error){this.entries=[];if(error.code!=='ENOENT'){this.readOnly=true;this.storageFailed(error);}}})();
  await this.loaded;
 }
 serial(operation){const result=this.queue.catch(()=>{}).then(async()=>{await this.load();return operation();});this.queue=result.catch(()=>{});return result;}
 async persist(entries){if(this.readOnly)fail('IO_FAILED');await this.persistRecords(entries);this.storageIssue=false;}
 list(){return this.serial(()=>({entries:this.entries.map(({id,name,lastOpenedAt})=>({id,name,lastOpenedAt})),storageIssue:this.storageIssue}));}
 choose(selectedPath){return this.serial(async()=>{
  const granted=await this.vaults.grantVault(selectedPath);
  // A folder opens even if private history storage fails. Existing history and
  // capabilities are changed only after the new record is durably published.
  try{
   const candidate=await inspect(selectedPath);await this.vaults.root(granted.id);
   const exact=this.entries.find(e=>sameLocation(identity(e),candidate));
   const physical=this.entries.filter(e=>samePhysical(identity(e),candidate));
   const previous=exact||(physical.length===1?physical[0]:null);
   const entry=previous?relocatedEntry(previous,selectedPath,candidate):{id:crypto.randomUUID(),name:granted.name,selectedPath:path.resolve(selectedPath),canonicalPath:candidate.root,dev:candidate.dev,ino:candidate.ino,...(candidate.birthtimeMs!==undefined?{birthtimeMs:candidate.birthtimeMs}:{}),historyRoot:candidate.root,previousIdentities:[],lastOpenedAt:new Date().toISOString()};
   if(!validRecord(entry))fail('IO_FAILED');
   const entries=[entry,...this.entries.filter(old=>old.id!==entry.id)].slice(0,MAX_RECENT_VAULTS);
   await this.persist(entries);this.entries=entries;
   return this.vaults.resumeVault(granted,previous?identity(previous):candidate,entry.historyRoot,entry.id);
  }catch(error){this.storageFailed(error);return granted;}
 });}
 // Selecting a replacement never creates a grant. The UI first reviews the
 // exact old/new roots; a different-volume or legacy folder needs confirmation.
 previewRelink(request,selectedPath,owner){const id=requestID(request);return this.serial(async()=>{
  const entry=this.entries.find(e=>e.id===id);if(!entry)fail('RECENT_VAULT_UNAVAILABLE');
  const candidate=await inspect(selectedPath);await this.checkCandidate(entry,candidate);
  const now=Date.now();for(const [token,p] of this.previews)if(p.expires<=now)this.previews.delete(token);
  if(this.previews.size>=8)this.previews.delete(this.previews.keys().next().value);
  const previewId=crypto.randomUUID(),value={previewId,id,name:entry.name,previousPath:entry.canonicalPath,candidatePath:candidate.root,identityMatch:samePhysical(identity(entry),candidate)?'same-directory':'confirmation-required'};
  this.previews.set(previewId,{owner,expires:now+5*60*1000,entry:JSON.stringify(entry),selectedPath,candidate,value});return value;
 });}
 async checkCandidate(entry,candidate){
  if(this.entries.some(e=>e.id!==entry.id&&samePhysical(identity(e),candidate)))fail('RECENT_VAULT_RELINK_CONFLICT');
  let original;try{original=await inspect(entry.canonicalPath);}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  if(original&&samePhysical(original,identity(entry))&&!sameLocation(original,candidate))fail('RECENT_VAULT_SOURCE_AVAILABLE');
 }
 confirmRelink(request,owner){if(!plain(request)||Object.keys(request).length!==2||!UUID.test(request.previewId||'')||request.confirmed!==true)fail('INVALID_REQUEST');return this.serial(async()=>{
  const p=this.previews.get(request.previewId);if(!p||p.owner!==owner||p.expires<=Date.now())fail('RECENT_VAULT_RELINK_EXPIRED');
  const entry=this.entries.find(e=>e.id===p.value.id);if(!entry||JSON.stringify(entry)!==p.entry)fail('CONFLICT');
  const candidate=await inspect(p.selectedPath);if(!sameLocation(candidate,p.candidate))fail('CONFLICT');await this.checkCandidate(entry,candidate);
  const granted=await this.vaults.grantVault(candidate.root,candidate);await this.vaults.root(granted.id);
  const updated=relocatedEntry(entry,p.selectedPath,candidate),entries=[updated,...this.entries.filter(e=>e.id!==entry.id)];
  try{await this.persist(entries);}catch(error){this.storageFailed(error);fail('IO_FAILED');}
  this.entries=entries;this.previews.delete(request.previewId);
  return this.vaults.resumeVault(granted,identity(entry),updated.historyRoot,entry.id);
 });}
 // D03 stores an identity, never a basename. Confirmed aliases let an older
 // workspace find the newly authorized root without rewriting that workspace.
 resumeFolder(folder){return this.serial(async()=>{
  const matches=this.entries.filter(e=>(!folder.recentId||e.id===folder.recentId)&&(sameLocation(identity(e),folder)||(e.previousIdentities||[]).some(p=>sameLocation(p,folder))));
  if(matches.length>1)fail('RECENT_VAULT_RELINK_CONFLICT');
  if(!matches.length)return this.vaults.grantVault(folder.root,folder);
  const e=matches[0],granted=await this.vaults.grantVault(e.selectedPath,identity(e));await this.vaults.root(granted.id);return this.vaults.resumeVault(granted,folder,e.historyRoot||e.canonicalPath,e.id);
 });}
 reopen(request){const id=requestID(request);return this.serial(async()=>{
  const entry=this.entries.find(value=>value.id===id);if(!entry)fail('RECENT_VAULT_UNAVAILABLE');
  let granted;
  try{
   // grantVault repeats the identity comparison immediately before issuing its
   // session capability; changed original paths never fall back to another path.
   granted=await this.vaults.grantVault(entry.selectedPath,identity(entry));
   await this.vaults.root(granted.id);
  }catch(error){if(error.code==='TOO_LARGE')throw error;fail('RECENT_VAULT_UNAVAILABLE');}
  const updated={...entry,lastOpenedAt:new Date().toISOString()};this.entries=[updated,...this.entries.filter(value=>value.id!==id)];
  try{await this.persist(this.entries);}catch(error){this.storageFailed(error);}
  return this.vaults.resumeVault(granted,identity(entry),entry.historyRoot||entry.canonicalPath,id);
 });}
 forget(request){const id=requestID(request);return this.serial(async()=>{
  const entries=this.entries.filter(value=>value.id!==id);if(entries.length===this.entries.length)return {forgotten:false};
  try{await this.persist(entries);}catch(error){this.storageFailed(error);fail('IO_FAILED');}
  this.entries=entries;return {forgotten:true};
 });}
}
module.exports={RecentVaults,RECENT_VAULTS_FILE,MAX_RECENT_VAULTS};

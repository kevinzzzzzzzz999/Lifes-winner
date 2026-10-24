'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {fail}=require('./errors.cjs');

const RECENT_VAULTS_FILE='recent-vaults.json';
const MAX_RECENT_VAULTS=8,MAX_BYTES=128*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const recordKeys=['id','name','selectedPath','canonicalPath','dev','ino','lastOpenedAt'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const absolute=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0')&&path.isAbsolute(value)&&path.resolve(value)===value;
function validRecord(value){
 return plain(value)&&Object.keys(value).length===recordKeys.length&&recordKeys.every(key=>Object.hasOwn(value,key))&&
  typeof value.id==='string'&&UUID.test(value.id)&&typeof value.name==='string'&&value.name.length>0&&value.name.length<=1024&&!value.name.includes('\0')&&
  absolute(value.selectedPath)&&absolute(value.canonicalPath)&&value.name===(path.basename(value.canonicalPath)||value.canonicalPath)&&
  Number.isSafeInteger(value.dev)&&value.dev>=0&&Number.isSafeInteger(value.ino)&&value.ino>=0&&
  typeof value.lastOpenedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.lastOpenedAt)&&Number.isFinite(Date.parse(value.lastOpenedAt))&&new Date(value.lastOpenedAt).toISOString()===value.lastOpenedAt;
}
function parseRecords(data){
 const value=JSON.parse(data);
 if(!plain(value)||Object.keys(value).length!==2||value.schemaVersion!==1||!Array.isArray(value.entries)||value.entries.length>MAX_RECENT_VAULTS||!value.entries.every(validRecord)||new Set(value.entries.map(entry=>entry.id)).size!==value.entries.length||new Set(value.entries.map(entry=>entry.canonicalPath)).size!==value.entries.length)fail('IO_FAILED');
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
 const data=Buffer.from(JSON.stringify({schemaVersion:1,entries}));if(data.length>MAX_BYTES)fail('IO_FAILED');
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
  this.vaults=vaults;this.entries=[];this.storageIssue=false;this.queue=Promise.resolve();this.loaded=null;
  this.loadRecords=load||(()=>readRecords(path.join(dataDirectory,RECENT_VAULTS_FILE)));
  this.persistRecords=persist||(entries=>writeRecords(dataDirectory,entries));this.onStorageError=onStorageError;
 }
 storageFailed(error){this.storageIssue=true;try{this.onStorageError(error);}catch{}}
 async load(){
  if(!this.loaded)this.loaded=(async()=>{try{this.entries=await this.loadRecords();}catch(error){this.entries=[];if(error.code!=='ENOENT')this.storageFailed(error);}})();
  await this.loaded;
 }
 serial(operation){const result=this.queue.catch(()=>{}).then(async()=>{await this.load();return operation();});this.queue=result.catch(()=>{});return result;}
 async persist(entries){await this.persistRecords(entries);this.storageIssue=false;}
 list(){return this.serial(()=>({entries:this.entries.map(({id,name,lastOpenedAt})=>({id,name,lastOpenedAt})),storageIssue:this.storageIssue}));}
 choose(selectedPath){return this.serial(async()=>{
  const granted=await this.vaults.grantVault(selectedPath);
  // A successful folder grant must still succeed if local history cannot be saved.
  try{
   const identity=this.vaults.vaults.get(granted.id),canonicalPath=await fs.realpath(selectedPath);
   if(!identity||canonicalPath!==identity.root)fail('RECENT_VAULT_UNAVAILABLE');
   await this.vaults.root(granted.id);
   const previous=this.entries.find(entry=>entry.canonicalPath===canonicalPath&&entry.dev===identity.dev&&entry.ino===identity.ino);
   const entry={id:previous?.id||crypto.randomUUID(),name:granted.name,selectedPath:path.resolve(selectedPath),canonicalPath,dev:identity.dev,ino:identity.ino,lastOpenedAt:new Date().toISOString()};
   if(!validRecord(entry))fail('IO_FAILED');
   this.entries=[entry,...this.entries.filter(old=>old.canonicalPath!==canonicalPath&&old.selectedPath!==entry.selectedPath)].slice(0,MAX_RECENT_VAULTS);
   try{await this.persist(this.entries);}catch(error){this.storageFailed(error);}
   return {...granted,recentId:entry.id};
  }catch(error){this.storageFailed(error);return granted;}
 });}
 reopen(request){const id=requestID(request);return this.serial(async()=>{
  const entry=this.entries.find(value=>value.id===id);if(!entry)fail('RECENT_VAULT_UNAVAILABLE');
  let granted;
  try{
   // grantVault repeats the identity comparison immediately before issuing its
   // session capability; changed original paths never fall back to another path.
   granted=await this.vaults.grantVault(entry.selectedPath,{root:entry.canonicalPath,dev:entry.dev,ino:entry.ino});
   await this.vaults.root(granted.id);
  }catch(error){if(error.code==='TOO_LARGE')throw error;fail('RECENT_VAULT_UNAVAILABLE');}
  const updated={...entry,lastOpenedAt:new Date().toISOString()};this.entries=[updated,...this.entries.filter(value=>value.id!==id)];
  try{await this.persist(this.entries);}catch(error){this.storageFailed(error);}
  return {...granted,recentId:id};
 });}
 forget(request){const id=requestID(request);return this.serial(async()=>{
  const entries=this.entries.filter(value=>value.id!==id);if(entries.length===this.entries.length)return {forgotten:false};
  try{await this.persist(entries);}catch(error){this.storageFailed(error);fail('IO_FAILED');}
  this.entries=entries;return {forgotten:true};
 });}
}
module.exports={RecentVaults,RECENT_VAULTS_FILE,MAX_RECENT_VAULTS};

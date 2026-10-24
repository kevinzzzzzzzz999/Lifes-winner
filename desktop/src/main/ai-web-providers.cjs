'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const PROVIDERS=Object.freeze([
 Object.freeze({id:'chatgpt',label:'ChatGPT',url:'https://chatgpt.com/',partition:'persist:inkspace-chatgpt',pasteMode:'composer'}),
 Object.freeze({id:'deepseek',label:'DeepSeek',url:'https://chat.deepseek.com/',partition:'persist:inkspace-ai-deepseek',pasteMode:'manual'}),
 Object.freeze({id:'claude',label:'Claude',url:'https://claude.ai/',partition:'persist:inkspace-ai-claude',pasteMode:'manual'}),
 Object.freeze({id:'gemini',label:'Gemini',url:'https://gemini.google.com/',partition:'persist:inkspace-ai-gemini',pasteMode:'manual'}),
]);
const SETTINGS_FILE='ai-web-settings.json';
function providerFor(id){const provider=PROVIDERS.find(value=>value.id===id);if(!provider)fail('INVALID_REQUEST');return provider;}
function providerRequest(request){if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==1||typeof request.provider!=='string')fail('INVALID_REQUEST');return providerFor(request.provider).id;}
function isProviderOrigin(provider,url){try{const u=new URL(url);return !u.username&&!u.password&&u.origin===new URL(providerFor(provider).url).origin;}catch{return false;}}
function publicProvider(provider){const {id,label,url,pasteMode}=provider;return{id,label,url,pasteMode};}
function parseSettings(data){const value=JSON.parse(data);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='provider,schemaVersion'||value.schemaVersion!==1)fail('IO_FAILED');return providerFor(value.provider).id;}
async function readSettings(file){const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>1024)fail('IO_FAILED');const buffer=Buffer.alloc(1025);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>1024)fail('IO_FAILED');return parseSettings(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));}finally{await handle.close();}}
async function writeSettings(directory,provider){
 await fs.mkdir(directory,{recursive:true,mode:0o700});const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())fail('IO_FAILED');
 const file=path.join(directory,SETTINGS_FILE),temp=path.join(directory,'.ai-web-'+crypto.randomUUID()+'.tmp');
 try{try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('IO_FAILED');}catch(error){if(error.code!=='ENOENT')throw error;}
  const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify({schemaVersion:1,provider}));await handle.sync();}finally{await handle.close();}await fs.rename(temp,file);
 }finally{await fs.unlink(temp).catch(()=>{});}
}
// Contains one preference only. Website sessions and API credentials stay elsewhere.
class AIWebProviderStore{
 constructor({dataDirectory,load,persist,onStorageError=()=>{}}){this.provider='chatgpt';this.storageIssue=false;this.loaded=null;this.queue=Promise.resolve();this.loadPreference=load||(()=>readSettings(path.join(dataDirectory,SETTINGS_FILE)));this.persistPreference=persist||(id=>writeSettings(dataDirectory,id));this.onStorageError=onStorageError;}
 async load(){if(!this.loaded)this.loaded=(async()=>{try{this.provider=providerFor(await this.loadPreference()).id;}catch(error){if(error.code!=='ENOENT'){this.storageIssue=true;this.onStorageError(error);}}})();await this.loaded;}
 info(){return{provider:this.provider,providers:PROVIDERS.map(publicProvider),storageIssue:this.storageIssue};}
 async get(){await this.load();return this.info();}
 set(request){const provider=providerRequest(request);const result=this.queue.catch(()=>{}).then(async()=>{await this.load();try{await this.persistPreference(provider);}catch(error){this.storageIssue=true;this.onStorageError(error);fail('IO_FAILED');}this.provider=provider;this.storageIssue=false;return this.info();});this.queue=result.catch(()=>{});return result;}
}
module.exports={PROVIDERS,SETTINGS_FILE,providerFor,providerRequest,isProviderOrigin,publicProvider,parseSettings,AIWebProviderStore};

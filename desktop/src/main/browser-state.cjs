'use strict';
// URL-only browser restoration. Cookies remain in Electron's browser partition;
// this file never contains document bodies, form values, credentials or POST data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {webURL}=require('./browser-security.cjs');
const FORMAT='inkspace-browser-state',VERSION=1,MAX_TABS=20,MAX_WINDOWS=20,MAX_BYTES=8*1024*1024;
const emptyWindow=()=>({id:crypto.randomUUID(),tabs:[{url:null,title:'新标签页',zoom:1}],activeIndex:0,closedTabs:[]});
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('INVALID_BROWSER_STATE');}
function tabState(value){
 keys(value,['url','title','zoom']);if(value.url!==null)webURL(value.url);
 if(typeof value.title!=='string'||value.title.length>200||value.title.includes('\0')||!value.title.isWellFormed()||!Number.isFinite(value.zoom)||value.zoom<.25||value.zoom>5)throw Error('INVALID_BROWSER_STATE');
 return {url:value.url===null?null:webURL(value.url),title:value.url===null?'新标签页':value.title,zoom:value.zoom};
}
function windowState(value){
 keys(value,['id','tabs','activeIndex','closedTabs']);if(typeof value.id!=='string'||!/^[-a-zA-Z0-9]{1,64}$/.test(value.id)||!Array.isArray(value.tabs)||value.tabs.length<1||value.tabs.length>MAX_TABS||!Array.isArray(value.closedTabs)||value.closedTabs.length>MAX_TABS||!Number.isSafeInteger(value.activeIndex)||value.activeIndex<0||value.activeIndex>=value.tabs.length)throw Error('INVALID_BROWSER_STATE');
 return {id:value.id,tabs:value.tabs.map(tabState),activeIndex:value.activeIndex,closedTabs:value.closedTabs.map(tabState)};
}
function parseState(value){
 keys(value,['format','version','windows','lastActiveWindowId']);if(value.format!==FORMAT||value.version!==VERSION||!Array.isArray(value.windows)||value.windows.length>MAX_WINDOWS)throw Error('UNSUPPORTED_BROWSER_STATE');
 const windows=value.windows.map(windowState);if(new Set(windows.map(w=>w.id)).size!==windows.length||!(value.lastActiveWindowId===null||windows.some(w=>w.id===value.lastActiveWindowId)))throw Error('INVALID_BROWSER_STATE');
 return {format:FORMAT,version:VERSION,windows,lastActiveWindowId:value.lastActiveWindowId};
}
function freshState(){return {format:FORMAT,version:VERSION,windows:[],lastActiveWindowId:null};}
class BrowserStateStore{
 constructor(directory,{fsAPI=fs}={}){this.fs=fsAPI;this.file=path.join(directory,'browser-state-v1.json');this.data=freshState();this.claims=new Set();this.blocked=false;this.warning='';this.recoveryNotice='';this.lastFileBytes=null;this.load();}
 read(file){const stat=this.fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error('INVALID_BROWSER_STATE');return parseState(JSON.parse(this.fs.readFileSync(file,'utf8')));}
 load(){
  try{this.data=this.read(this.file);this.lastFileBytes=this.fs.readFileSync(this.file);return;}catch(error){
   if(error.code!=='ENOENT'){this.blocked=true;this.warning='浏览器会话记录无法读取或版本较新，原文件已保留；本次浏览不会覆盖它。';}
   try{this.data=this.read(this.file+'.bak');if(!this.blocked)this.warning=this.recoveryNotice='已从上一次完整记录恢复浏览器标签页。';}
   catch(backupError){if(backupError.code!=='ENOENT'){this.blocked=true;this.warning='浏览器会话备份无法读取，原文件已保留；本次浏览不会覆盖它。';}}
  }
 }
 acquire(preferred){
  let record=this.data.windows.find(w=>w.id===preferred&&!this.claims.has(w.id));
  if(!record)record=this.data.windows.find(w=>w.id===this.data.lastActiveWindowId&&!this.claims.has(w.id))||this.data.windows.find(w=>!this.claims.has(w.id));
  if(!record){if(this.data.windows.length>=MAX_WINDOWS)throw Error('BROWSER_WINDOW_LIMIT');record=emptyWindow();this.data.windows.push(record);}
  this.claims.add(record.id);this.data.lastActiveWindowId=record.id;return structuredClone(record);
 }
 release(id){this.claims.delete(id);}
 atomic(file,bytes){
  const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
  try{fd=this.fs.openSync(temp,'wx',0o600);this.fs.writeFileSync(fd,bytes);this.fs.fsyncSync(fd);this.fs.closeSync(fd);fd=undefined;this.fs.renameSync(temp,file);const directory=this.fs.openSync(path.dirname(file),'r');try{this.fs.fsyncSync(directory);}finally{this.fs.closeSync(directory);}}
  finally{if(fd!==undefined)this.fs.closeSync(fd);try{this.fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
 }
 update(record){
  const next=windowState(record),index=this.data.windows.findIndex(w=>w.id===next.id);if(index<0||!this.claims.has(next.id))throw Error('UNKNOWN_BROWSER_WINDOW');
  this.data.windows[index]=next;this.data.lastActiveWindowId=next.id;
  if(this.blocked)return false;
  try{
   this.fs.mkdirSync(path.dirname(this.file),{recursive:true});
   const bytes=JSON.stringify(parseState(this.data));if(Buffer.byteLength(bytes)>MAX_BYTES)throw Error('BROWSER_STATE_TOO_LARGE');
   // Recheck existing data immediately before replacement. A newer/corrupt file
   // is preserved even if it changed after this process initially loaded it.
   try{this.read(this.file);const previous=this.fs.readFileSync(this.file);if(!this.lastFileBytes||!previous.equals(this.lastFileBytes))throw Error('BROWSER_STATE_CHANGED');try{this.read(this.file+'.bak');}catch(error){if(error.code!=='ENOENT')throw error;}this.atomic(this.file+'.bak',previous);}
   catch(error){if(error.code!=='ENOENT')throw error;if(this.lastFileBytes)throw Error('BROWSER_STATE_CHANGED');}
   this.atomic(this.file,bytes);this.lastFileBytes=Buffer.from(bytes);this.warning=this.recoveryNotice;return true;
  }catch(error){if(['INVALID_BROWSER_STATE','UNSUPPORTED_BROWSER_STATE','BROWSER_STATE_CHANGED'].includes(error.message)||['INVALID_REQUEST','PERMISSION_DENIED'].includes(error.code)||error instanceof SyntaxError)this.blocked=true;this.warning=this.blocked?'浏览器会话文件已变化或无法读取，原文件已保留；本次浏览不会覆盖它。':'浏览器标签页暂未保存，请检查剩余空间或文件权限。';return false;}
 }
}
const stores=new WeakMap();
function browserStateForApp(app){let store=stores.get(app);if(!store){store=new BrowserStateStore(app.getPath('userData'));stores.set(app,store);}return store;}
module.exports={BrowserStateStore,browserStateForApp,parseState,windowState,tabState,MAX_TABS,MAX_WINDOWS,MAX_BYTES};

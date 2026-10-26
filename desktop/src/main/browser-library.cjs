'use strict';
// Bookmarks and committed HTTP(S) visits only. Never reads page text, forms or cookies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {webURL,object,string}=require('./browser-security.cjs');
const FORMAT='inkspace-browser-library',VERSION=1,MAX_BOOKMARKS=10000,MAX_HISTORY=50000,MAX_BYTES=32*1024*1024;
const cleanTitle=value=>String(value||'未命名网页').replace(/\0/g,'').slice(0,200).toWellFormed()||'未命名网页';
const fresh=()=>({format:FORMAT,version:VERSION,bookmarks:[],history:[]});
function entry(value,history=false){
 const fields=history?['id','url','title','visitedAt']:['id','url','title','createdAt'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k))||typeof value.id!=='string'||!/^[-a-zA-Z0-9]{1,64}$/.test(value.id)||typeof value.title!=='string'||value.title.length>200||value.title!==cleanTitle(value.title))throw Error('INVALID_BROWSER_LIBRARY');
 const dateKey=history?'visitedAt':'createdAt';if(typeof value[dateKey]!=='string'||!Number.isFinite(Date.parse(value[dateKey]))||new Date(value[dateKey]).toISOString()!==value[dateKey])throw Error('INVALID_BROWSER_LIBRARY');
 return {id:value.id,url:webURL(value.url),title:value.title,[dateKey]:value[dateKey]};
}
function parseLibrary(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['format','version','bookmarks','history'].includes(k))||value.format!==FORMAT||value.version!==VERSION||!Array.isArray(value.bookmarks)||value.bookmarks.length>MAX_BOOKMARKS||!Array.isArray(value.history)||value.history.length>MAX_HISTORY)throw Error('INVALID_BROWSER_LIBRARY');
 const bookmarks=value.bookmarks.map(v=>entry(v)),history=value.history.map(v=>entry(v,true));
 if(new Set(bookmarks.map(v=>v.id)).size!==bookmarks.length||new Set(bookmarks.map(v=>v.url)).size!==bookmarks.length||new Set(history.map(v=>v.id)).size!==history.length)throw Error('INVALID_BROWSER_LIBRARY');
 return {format:FORMAT,version:VERSION,bookmarks,history};
}
class BrowserLibraryStore{
 constructor(directory,{fsAPI=fs,now=()=>new Date()}={}){this.fs=fsAPI;this.now=now;this.file=path.join(directory,'browser-library-v1.json');this.data=fresh();this.lastBytes=null;this.warning='';this.blocked=false;this.listeners=new Set();this.load();}
 read(file){const info=this.fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES)throw Error('INVALID_BROWSER_LIBRARY');const bytes=this.fs.readFileSync(file);return {data:parseLibrary(JSON.parse(bytes.toString('utf8'))),bytes};}
 load(){try{const result=this.read(this.file);this.data=result.data;this.lastBytes=result.bytes;}catch(error){if(error.code!=='ENOENT'){this.blocked=true;this.warning='书签或历史记录无法读取，原文件已保留；暂时不会覆盖它。';}try{this.data=this.read(this.file+'.bak').data;if(!this.blocked)this.warning='已从上一次完整记录恢复书签和历史。';}catch(backupError){if(backupError.code!=='ENOENT'){this.blocked=true;this.warning='书签或历史备份无法读取，原文件已保留。';}}}}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 notify(){for(const listener of this.listeners)listener();}
 atomic(file,bytes){const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=this.fs.openSync(temp,'wx',0o600);this.fs.writeFileSync(fd,bytes);this.fs.fsyncSync(fd);this.fs.closeSync(fd);fd=undefined;this.fs.renameSync(temp,file);const directory=this.fs.openSync(path.dirname(file),'r');try{this.fs.fsyncSync(directory);}finally{this.fs.closeSync(directory);}}finally{if(fd!==undefined)this.fs.closeSync(fd);try{this.fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}}
 commit(next){
  if(this.blocked)return false;
  try{const validated=parseLibrary(next),bytes=Buffer.from(JSON.stringify(validated));if(bytes.length>MAX_BYTES)throw Error('BROWSER_LIBRARY_TOO_LARGE');this.fs.mkdirSync(path.dirname(this.file),{recursive:true});
   let previous;try{previous=this.read(this.file).bytes;if(!this.lastBytes||!previous.equals(this.lastBytes))throw Error('BROWSER_LIBRARY_CHANGED');}catch(error){if(error.code!=='ENOENT')throw error;if(this.lastBytes)throw Error('BROWSER_LIBRARY_CHANGED');}
   try{this.read(this.file+'.bak');}catch(error){if(error.code!=='ENOENT')throw error;}
   if(previous)this.atomic(this.file+'.bak',previous);this.atomic(this.file,bytes);this.lastBytes=bytes;this.data=validated;this.warning='';this.notify();return true;
  }catch(error){if(['INVALID_BROWSER_LIBRARY','BROWSER_LIBRARY_CHANGED'].includes(error.message)||error instanceof SyntaxError||error.code==='INVALID_REQUEST'||error.code==='PERMISSION_DENIED')this.blocked=true;this.warning=this.blocked?'书签或历史文件已变化，原文件已保留；本次操作未保存。':'书签或历史暂未保存，请检查空间和文件权限。';this.notify();return false;}
 }
 hasBookmark(url){try{return this.data.bookmarks.some(v=>v.url===webURL(url));}catch{return false;}}
 bookmark(url,title){url=webURL(url);const existing=this.data.bookmarks.find(v=>v.url===url);if(existing)return existing.id;if(this.data.bookmarks.length>=MAX_BOOKMARKS)throw Error('BOOKMARK_LIMIT');const item={id:crypto.randomUUID(),url,title:cleanTitle(title),createdAt:this.now().toISOString()},next={...this.data,bookmarks:[item,...this.data.bookmarks]};return this.commit(next)?item.id:null;}
 editBookmark(id,request){
  string(id,64);object(request,['title','url','expected']);object(request.expected,['title','url','createdAt']);string(request.expected.title,200);string(request.expected.url,8192);string(request.expected.createdAt,64);
  const current=this.data.bookmarks.find(item=>item.id===id);if(!current)return{saved:false,reason:'missing'};
  if(current.title!==request.expected.title||current.url!==request.expected.url||current.createdAt!==request.expected.createdAt)return{saved:false,reason:'changed'};
  if(typeof request.title!=='string'||!request.title.trim()||request.title.length>200||request.title.includes('\0')||!request.title.isWellFormed())return{saved:false,reason:'invalid-title'};
  let url;try{url=webURL(request.url);}catch{return{saved:false,reason:'invalid-url'};}
  if(this.data.bookmarks.some(item=>item.id!==id&&item.url===url))return{saved:false,reason:'duplicate'};
  if(this.blocked)return{saved:false,reason:'storage'};
  if(current.title===request.title&&current.url===url)return{saved:true,unchanged:true};
  const next={...this.data,bookmarks:this.data.bookmarks.map(item=>item.id===id?{...item,title:request.title,url}:item)};
  return this.commit(next)?{saved:true}:{saved:false,reason:'storage'};
 }
 removeBookmark(id){return this.commit({...this.data,bookmarks:this.data.bookmarks.filter(v=>v.id!==id)});}
 visit(url,title){url=webURL(url);const item={id:crypto.randomUUID(),url,title:cleanTitle(title),visitedAt:this.now().toISOString()};return this.commit({...this.data,history:[item,...this.data.history].slice(0,MAX_HISTORY)})?item.id:null;}
 updateVisitTitle(id,title){const current=this.data.history.find(v=>v.id===id),clean=cleanTitle(title);if(!current||current.title===clean)return true;return this.commit({...this.data,history:this.data.history.map(v=>v.id===id?{...v,title:clean}:v)});}
 removeVisit(id){return this.commit({...this.data,history:this.data.history.filter(v=>v.id!==id)});}
 clearHistory(){// Intentionally clears only history; backup must not resurrect a deleted visit.
  const saved=this.commit({...this.data,history:[]});if(saved){try{this.atomic(this.file+'.bak',this.lastBytes);}catch{this.warning='历史已清空，但旧备份暂未清除，请检查空间和文件权限。';this.notify();}}return saved;
 }
 query(kind,search='',limit=100){const needle=String(search).trim().toLocaleLowerCase(),source=kind==='bookmarks'?this.data.bookmarks:this.data.history,filtered=needle?source.filter(v=>(v.title+'\n'+v.url).toLocaleLowerCase().includes(needle)):source;return {kind,search,total:source.length,matched:filtered.length,entries:filtered.slice(0,Math.min(MAX_HISTORY,Math.max(100,limit))).map(v=>({...v})),limit};}
}
const stores=new WeakMap();function browserLibraryForApp(app){let store=stores.get(app);if(!store){store=new BrowserLibraryStore(app.getPath('userData'));stores.set(app,store);}return store;}
module.exports={BrowserLibraryStore,browserLibraryForApp,parseLibrary,MAX_BOOKMARKS,MAX_HISTORY,MAX_BYTES};

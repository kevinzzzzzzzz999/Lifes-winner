'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {fail,publicError}=require('./errors.cjs');
const {relativePath,kindOf}=require('./vault-service.cjs');

const MAX_PENDING=256;
const DOCUMENT_EXTENSIONS=['ipynb','json','md','markdown','tex','py','js','ts','txt','html','htm','csv','tsv','pdf','png','jpg','jpeg','doc','docx','pptx','xls','xlsx','xlsm','mp4','mov','m4v'];
async function selectDocument({dialog,window,localized=(en)=>en}){
 const result=await dialog.showOpenDialog(window,{title:localized('Open file','打开文件'),properties:['openFile'],filters:[{name:localized('Supported documents','支持的文档'),extensions:DOCUMENT_EXTENSIONS}]});
 if(result.canceled)return null;
 // The native picker explicitly permits one document. Unexpected multiple
 // results are an error, rather than silently opening only the first source.
 if(!Array.isArray(result.filePaths)||result.filePaths.length!==1)fail('INVALID_REQUEST');
 return selectedPath(result.filePaths[0]);
}
function selectedPath(value){
 if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f\x7f-\x9f]/.test(value)||!path.isAbsolute(value)||path.resolve(value)!==value)fail('PATH_DENIED');
 return value;
}
function fileWithin(root,file){
 const rel=path.relative(root,file);
 if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))return null;
 try{const safe=relativePath(rel.split(path.sep).join('/'));if(safe.split('/').some(part=>part.toLowerCase()==='.inkspace-reviews'))return null;return safe;}catch{return null;}
}
async function inspectDocument(value){
 const selected=selectedPath(value),stat=await fs.lstat(selected);
 if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)fail('PATH_DENIED');
 if(kindOf(selected)==='unsupported')fail('UNSUPPORTED');
 const directory=await fs.realpath(path.dirname(selected)),file=path.join(directory,path.basename(selected));
 // Grant the actual parent of the explicitly selected file, never a guessed
 // broad ancestor. Existing vaults retain their stricter path validation.
 if(await fs.realpath(selected)!==file)fail('PATH_DENIED');
 relativePath(path.basename(file));
 if(file.split(path.sep).some(part=>part.toLowerCase()==='.inkspace-reviews'))fail('PATH_DENIED');
 return {file,directory};
}

// Finder can deliver open-file before ready. Keep the entire request until the
// renderer subscribes and explicitly acknowledges it; did-finish-load alone
// does not mean React's listeners have been installed.
class ExternalDocumentOpen {
 constructor({onError=()=>{}}={}){this.pending=[];this.dependencies=null;this.draining=null;this.mailboxes=new Map();this.onError=onError;}
 enqueue(file){
  if(this.pending.length>=MAX_PENDING){this.onError(new Error('External document queue is full.'));return false;}
  this.pending.push(file);this.drain();return true;
 }
 configure(dependencies){this.dependencies=dependencies;return this.drain();}
 async idle(){while(this.draining)await this.draining;}
 drain(){
  if(!this.dependencies||this.draining)return this.draining;
  this.draining=(async()=>{while(this.pending.length){const file=this.pending.shift();try{await this.route(file);}catch(error){this.report(error);}}})().finally(()=>{this.draining=null;if(this.pending.length)this.drain();});
  return this.draining;
 }
 mailbox(context){let value=this.mailboxes.get(context.id);if(!value){value={ready:false,requests:[]};this.mailboxes.set(context.id,value);}return value;}
 notify(context){const mailbox=this.mailbox(context);if(mailbox.ready&&mailbox.requests.length)this.dependencies.windows.send(context,'desktop:externalOpenRequests',{});}
 deliver(context,request){const mailbox=this.mailbox(context);if(mailbox.requests.length>=MAX_PENDING)fail('TOO_LARGE');mailbox.requests.push({id:crypto.randomUUID(),...request});this.notify(context);}
 list(context){const mailbox=this.mailbox(context);mailbox.ready=true;return [...mailbox.requests];}
 acknowledge(context,id){if(typeof id!=='string'||! /^[a-f0-9-]{36}$/i.test(id))fail('INVALID_REQUEST');const mailbox=this.mailbox(context),index=mailbox.requests.findIndex(request=>request.id===id);if(index<0)return {acknowledged:false};mailbox.requests.splice(index,1);return {acknowledged:true};}
 async moveToNewWindow(context,id){
  if(typeof id!=='string')fail('INVALID_REQUEST');const request=this.mailbox(context).requests.find(value=>value.id===id);if(!request?.vault)fail('INVALID_REQUEST');
  const {vaults,windows,createWindow,reveal}=this.dependencies;await vaults.resolve(request.vault.id,request.path);
  const target=createWindow(request.vault);windows.grant(request.vault,target);this.deliver(reveal(target),{vault:request.vault,path:request.path});return {opened:true};
 }
 reset(context){const mailbox=this.mailboxes.get(context.id);if(mailbox)mailbox.ready=false;}
 remove(context){this.mailboxes.delete(context.id);}
 report(error){
  try{this.onError(error);}catch{}
  const {windows,createWindow,reveal}=this.dependencies;
  const context=reveal(windows.focused()||createWindow());
  // The public error contains neither the absolute source path nor contents.
  try{this.deliver(context,{error:publicError(error)});}catch{}
 }
 async route(selected){
  const {vaults,windows,recentVaults,createWindow,reveal}=this.dependencies;
  const {file,directory}=await inspectDocument(selected);
  const activeIds=new Set([...windows.windows.values()].filter(context=>windows.alive(context)).map(context=>context.activeVault?.id));
  const candidates=[...vaults.vaults.entries()].filter(([,value])=>fileWithin(value.root,file)).sort((a,b)=>Number(activeIds.has(b[0]))-Number(activeIds.has(a[0]))||b[1].root.length-a[1].root.length);
  let vault=null,rel=null;
  for(const [id,value] of candidates){try{const candidate=fileWithin(value.root,file);await vaults.resolve(id,candidate);vault={id,name:path.basename(value.root)||value.root};rel=candidate;break;}catch{}}
  // A cold launch can retain the original chosen vault, so whiteboard links
  // remain relative to the same root instead of a nested document directory.
  if(!vault&&recentVaults){
   await recentVaults.load();
   const entries=recentVaults.entries.filter(entry=>fileWithin(entry.canonicalPath,file)).sort((a,b)=>b.canonicalPath.length-a.canonicalPath.length);
   for(const entry of entries){try{const candidate=await vaults.grantVault(entry.selectedPath,{root:entry.canonicalPath,dev:entry.dev,ino:entry.ino}),candidatePath=fileWithin(entry.canonicalPath,file);await vaults.resolve(candidate.id,candidatePath);vault={...candidate,recentId:entry.id};rel=candidatePath;break;}catch{}}
  }
  if(!vault){vault=await vaults.grantVault(directory);rel=path.basename(file);await vaults.resolve(vault.id,rel);}
  const focused=windows.focused();let context=focused?.activeVault?.id===vault.id?focused:windows.forVault(vault.id);
  if(!context){
   // Only reuse the pristine startup window before it has any renderer grants.
   // A warm window with drafts or an in-flight folder choice is never replaced.
   context=[...windows.windows.values()].find(value=>windows.alive(value)&&!value.activeVault&&!value.grants.size&&!this.mailbox(value).ready);
   if(context){windows.grant(vault,context);context.activeVault=vault;}else context=createWindow(vault);
  }
  // Revalidate after selection and before publishing a renderer capability.
  await vaults.resolve(vault.id,rel);
  windows.grant(vault,context);
  this.deliver(reveal(context),{vault,path:rel});
 }
}
module.exports={ExternalDocumentOpen,inspectDocument,fileWithin,selectDocument,DOCUMENT_EXTENSIONS,MAX_PENDING};

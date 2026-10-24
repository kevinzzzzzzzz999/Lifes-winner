'use strict';
// Clipboard file grants are created only from native pasteboard representations.
// IPC carries opaque short-lived grants, never arbitrary paths supplied by a page.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fileURLToPath}=require('node:url');
const {constants}=require('node:fs');
const {fail}=require('./errors.cjs');
const {relativePath}=require('./vault-path.cjs');
const grants=new Map(),MAX_FILES=100,MAX_URI_BYTES=512*1024,MAX_TOTAL=512*1024*1024;
function grantFileURLs(value){
 if(typeof value!=='string'||Buffer.byteLength(value)>MAX_URI_BYTES||value.includes('\0'))fail('TOO_LARGE');
 const paths=[];
 for(const line of value.split(/\r?\n/)){const text=line.trim();if(!text||text.startsWith('#'))continue;let url;try{url=new URL(text);}catch{fail('INVALID_REQUEST');}if(url.protocol!=='file:')continue;if(url.username||url.password||url.search||url.hash||url.hostname&&url.hostname!=='localhost')fail('PATH_DENIED');let full;try{full=fileURLToPath(url);}catch{fail('PATH_DENIED');}if(!path.isAbsolute(full)||full.includes('\0'))fail('PATH_DENIED');if(!paths.includes(full))paths.push(full);if(paths.length>MAX_FILES)fail('TOO_LARGE');}
 const now=Date.now();for(const [key,value]of grants)if(value.expires<now)grants.delete(key);
 while(grants.size+paths.length>1024)grants.delete(grants.keys().next().value);
 return paths.map(full=>{const token=crypto.randomUUID(),name=path.basename(full);grants.set(token,{full,name,expires:now+10*60*1000});return{token,name};});
}
function resolveGrant(file){if(!file||typeof file.token!=='string'||typeof file.name!=='string')fail('INVALID_REQUEST');const grant=grants.get(file.token);if(!grant||grant.name!==file.name||grant.expires<Date.now())fail('NOT_FOUND');return grant;}
function limitFor(name,kind){if(kind==='text')return require('./vault-service.cjs').textLimit(name);if(['docx','pptx','spreadsheet'].includes(kind))return 16*1024*1024;if(kind==='video')return 512*1024*1024;return 128*1024*1024;}
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
async function prepareClipboardFiles(vaults,request,files,parent){
 const {kindOf}=require('./vault-service.cjs'),root=await vaults.root(request.vaultId),prepared=[];let total=0;
 for(const file of files){
  const grant=resolveGrant(file),kind=kindOf(grant.name);if(!['text','media','docx','pptx','spreadsheet','video'].includes(kind))fail('UNSUPPORTED');
  let full,stat;try{full=await fs.realpath(grant.full);stat=await fs.stat(full);}catch(error){if(['EACCES','EPERM'].includes(error.code))fail('PERMISSION_DENIED');throw error;}
  const maximum=limitFor(grant.name,kind);if(!stat.isFile())fail('UNSUPPORTED');
  if(full.startsWith(root+path.sep)){
   const sourcePath=path.relative(root,full).split(path.sep).join('/');relativePath(sourcePath);if(sourcePath.split('/').some(p=>p.startsWith('.')))fail('PATH_DENIED');await vaults.resolve(request.vaultId,sourcePath);prepared.push({sourcePath,title:grant.name,kind,full,stat,maximum});continue;
  }
  if(stat.size>maximum)fail('TOO_LARGE');total+=stat.size;if(total>MAX_TOTAL)fail('TOO_LARGE');
  const ext=path.extname(grant.name),stem=path.basename(grant.name,ext).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^[. ]+|[. ]+$/g,'')||'Clipboard';
  const name=Array.from(stem).slice(0,90).join('')+'-'+crypto.randomUUID().slice(0,8)+ext;
  prepared.push({sourcePath:parent?parent+'/'+name:name,title:grant.name,kind,full,stat,maximum,name,external:true});
 }
 return prepared;
}
async function publishClipboardFile(vaults,request,parent,file){
 if(!file.external)return;
 const directory=await vaults.resolve(request.vaultId,parent,{directory:true}),target=path.join(directory.full,file.name),temp=path.join(directory.full,'.inkspace-paste-'+crypto.randomUUID()+'.tmp');
 let source,destination;
 try{
  source=await fs.open(file.full,constants.O_RDONLY|(constants.O_NOFOLLOW||0));if(!same(file.stat,await source.stat()))fail('CONFLICT');
  destination=await fs.open(temp,'wx',0o600);let bytes=0;const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  while(bytes<file.stat.size){const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,file.stat.size-bytes),bytes);if(!bytesRead)fail('CONFLICT');const chunk=buffer.subarray(0,bytesRead);hash.update(chunk);await destination.writeFile(chunk);bytes+=bytesRead;}
  if(!same(file.stat,await source.stat()))fail('CONFLICT');await destination.sync();await destination.close();destination=null;
  await vaults.resolve(request.vaultId,parent,{directory:true});await fs.link(temp,target);file.published=true;file.publishedStat=await fs.lstat(target);await fs.unlink(temp);file.sha256=hash.digest('hex');file.publishedStat=await fs.lstat(target);
  // Retain document bytes as a normal source card; preview/conversion happens
  // on opening through the existing reader. Importing never runs source code.
  if(file.kind==='text'){const snapshot=await vaults.snapshot({vaultId:request.vaultId,path:file.sourcePath},file.maximum);require('./vault-service.cjs').utf8(snapshot.data);}
 }catch(error){if(['EACCES','EPERM'].includes(error.code))fail('PERMISSION_DENIED');throw error;}
 finally{await source?.close().catch(()=>{});await destination?.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
}
async function verifyClipboardFile(vaults,request,file){
 const value=await vaults.resolve(request.vaultId,file.sourcePath);if(!same(file.external?file.publishedStat:file.stat,value.stat))fail('CONFLICT');
}
async function rollbackClipboardFile(vaults,request,file){
 if(!file.published)return;try{const value=await vaults.resolve(request.vaultId,file.sourcePath);if(same(file.publishedStat,value.stat))await fs.unlink(value.full);}catch{}
}
module.exports={grantFileURLs,prepareClipboardFiles,publishClipboardFile,verifyClipboardFile,rollbackClipboardFile,MAX_FILES,MAX_URI_BYTES};

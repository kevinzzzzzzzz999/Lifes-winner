'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {snapshotFile,copyVerified}=require('./exchange-stream.cjs');
const {fail}=require('./errors.cjs');
async function exportSourceFile(vaults,request,{dialog,window}){
 if(!/^[a-f0-9]{64}$/.test(request.expectedSHA256||'')||request.path.split('/').some(p=>p.startsWith('.')))fail('INVALID_REQUEST');
 const source=await vaults.resolve(request.vaultId,request.path);const snapshot=await snapshotFile(source.full);
 let temp;
 try{
  if(snapshot.sha256!==request.expectedSHA256)fail('CONFLICT');
  const name=path.basename(request.path),ext=path.extname(name).slice(1),r=await dialog.showSaveDialog(window,{title:'另存原文件副本 / Save original copy',defaultPath:name,...(ext?{filters:[{name:ext.toUpperCase(),extensions:[ext]}]}:{})});
  if(r.canceled||!r.filePath)return{saved:false};
  // The explicit copy flow never writes back over the source, even through an alias.
  const parent=await fs.realpath(path.dirname(r.filePath)),target=path.join(parent,path.basename(r.filePath));
  const resolved=await fs.realpath(target).catch(e=>{if(e.code==='ENOENT')return target;throw e;});
  if(resolved===snapshot.canonical)fail('PATH_DENIED');
  temp=path.join(parent,'.inkspace-export-'+crypto.randomUUID()+'.tmp');
  await copyVerified(snapshot.file,temp,{sha256:snapshot.sha256});await snapshot.revalidate({fullHash:true});
  await fs.rename(temp,target);temp=null;return{saved:true,name:path.basename(target),bytes:snapshot.bytes};
 }finally{if(temp)await fs.unlink(temp).catch(()=>{});await snapshot.dispose();}
}
module.exports={exportSourceFile};

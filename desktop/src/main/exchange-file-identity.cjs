'use strict';
// File providers may update dates/xattrs without changing bytes. Dates are a
// reason to re-hash, never proof that owned content was replaced.
const fs=require('node:fs/promises'),crypto=require('node:crypto'),{constants}=require('node:fs');
const {AppError}=require('./errors.cjs');
const MAX_BYTES=1536*1024*1024,CHUNK=1024*1024;
function reject(code,reason){const error=new AppError(code);error.transactionReason=reason;throw error;}
function abort(signal){if(signal?.aborted)reject('CANCELLED','cancelled');}
function sameIdentity(a,b){return a.dev===b.dev&&a.ino===b.ino;}
function sameMetadata(a,b){return a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
async function verifyDirectory(full,identity,{code='FILE_OPERATION_RECOVERY'}={}){
 let stat;try{stat=await fs.lstat(full);}catch(error){if(error.code==='ENOENT')reject(code,'directory-missing');throw error;}
 if(!stat.isDirectory()||stat.isSymbolicLink()||!sameIdentity(stat,identity))reject(code,'directory-identity-changed');return stat;
}
async function verifyOwnedFile(full,{identity,sha256,forceHash=false,allowLinks=true,signal,maxBytes=MAX_BYTES,directory,code='FILE_OPERATION_RECOVERY'}={}){
 if(!identity||typeof sha256!=='string'||! /^[a-f0-9]{64}$/i.test(sha256))reject('INVALID_REQUEST','invalid-verification-request');
 const parent=async()=>{if(directory)await verifyDirectory(directory.path,directory.identity,{code});};
 const validate=stat=>{if(!stat.isFile()||stat.isSymbolicLink()||!sameIdentity(stat,identity))reject(code,'file-identity-changed');if(!allowLinks&&stat.nlink!==1)reject(code,'file-link-count-changed');if(stat.size!==identity.size)reject(code,'file-size-changed');if(stat.size>maxBytes)reject('TOO_LARGE','verification-budget');};
 abort(signal);await parent();let current;try{current=await fs.lstat(full);}catch(error){if(error.code==='ENOENT')reject(code,'file-missing');throw error;}validate(current);
 const changed=!sameMetadata(current,identity);
 if(!forceHash&&!changed){await parent();return{stat:current,hashed:false,metadataChanged:false};}
 // A known digest is not enough if an already-read region changes while a
 // later region is being hashed. Require one complete stable pass; provider
 // metadata churn may retry twice, but never authorizes an unstable byte view.
 const canonical=await fs.realpath(full),handle=await fs.open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  let metadataChanged=changed;
  for(let attempt=0;attempt<3;attempt++){
   abort(signal);await parent();const before=await handle.stat();validate(before);
   const buffer=Buffer.alloc(Math.min(CHUNK,Math.max(1,before.size))),digest=crypto.createHash('sha256');let offset=0;
   while(offset<before.size){abort(signal);const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!bytesRead)reject(code,'file-read-incomplete');digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
   abort(signal);const after=await handle.stat(),latest=await fs.lstat(full);validate(after);validate(latest);await parent();if(await fs.realpath(full)!==canonical)reject(code,'file-path-changed');
   if(digest.digest('hex')!==sha256.toLowerCase())reject(code,'file-content-changed');
   const stable=sameMetadata(before,after)&&sameMetadata(after,latest);
   metadataChanged ||= !stable;
   if(stable)return{stat:latest,hashed:true,metadataChanged};
  }
  reject(code,'file-metadata-unstable');
 }finally{await handle.close();}
}
module.exports={verifyDirectory,verifyOwnedFile,sameIdentity,sameMetadata};

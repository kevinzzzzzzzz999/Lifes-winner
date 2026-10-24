'use strict';
// Immutable disk snapshots keep archive-sized bytes out of the Electron heap.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {constants}=require('node:fs'),{fail}=require('./errors.cjs');
const FILE_BYTES=1536*1024*1024,BATCH_BYTES=3*1024*1024*1024,CHUNK=1024*1024;
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size;
const same=(a,b)=>sameIdentity(a,b)&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function abort(signal){if(signal?.aborted)fail('CANCELLED');}
async function walkFile(full,{maxBytes=FILE_BYTES,signal,onChunk,expected,expectedSHA256,allowLinks=false}={}){
 abort(signal);const canonical=await fs.realpath(full),outer=await fs.lstat(full);
 const regular=s=>s.isFile()&&!s.isSymbolicLink()&&(allowLinks||s.nlink===1);
 if(!regular(outer))fail('PATH_DENIED');if(outer.size>maxBytes)fail('TOO_LARGE');
 if(expected&&(!sameIdentity(outer,expected)||!expectedSHA256&&!same(outer,expected)))fail('CONFLICT');
 const h=await fs.open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const before=await h.stat();if(!regular(before)||!sameIdentity(before,outer))fail('CONFLICT');
  const chunk=Buffer.alloc(Math.min(CHUNK,Math.max(1,before.size)));
  // Verification passes never invoke onChunk: a snapshot/copy must write each
  // byte once, even when iCloud changes permissions or timestamps mid-read.
  const digest=async(consume)=>{const hash=crypto.createHash('sha256');let count=0;
   while(count<before.size){abort(signal);const {bytesRead}=await h.read(chunk,0,Math.min(chunk.length,before.size-count),count);if(!bytesRead)fail('CONFLICT');const bytes=chunk.subarray(0,bytesRead);hash.update(bytes);if(consume)await consume(bytes,count);count+=bytesRead;}
   abort(signal);return hash.digest('hex');
  };
  const checkedStat=async()=>{abort(signal);const stat=await h.stat(),current=await fs.lstat(full);
   if(!regular(stat)||!regular(current)||!sameIdentity(before,stat)||!sameIdentity(stat,current)||await fs.realpath(full)!==canonical)fail('CONFLICT');
   return{stat,current};
  };
  const sha256=await digest(onChunk);let state=await checkedStat();
  if(!same(before,outer)||!same(before,state.stat)||!same(state.stat,state.current)){
   // ctime also changes for chmod/xattr/hard-link metadata. It is a reason to
   // verify content, not proof of a conflicting edit. Two independent bounded
   // reads must agree; a same-length edit with restored mtime still fails.
   let stable=false;
   for(let attempt=0;attempt<3;attempt++){
    const verifyBefore=await checkedStat();
    if(await digest()!==sha256)fail('CONFLICT');state=await checkedStat();
    if(same(verifyBefore.stat,state.stat)&&same(verifyBefore.current,state.current)&&same(state.stat,state.current)){stable=true;break;}
   }
   // Never accept bytes changed behind an already-read chunk. Metadata churn
   // is retried within this bound; a continuously changing source must retry.
   if(!stable)fail('CONFLICT');
  }
  if(expectedSHA256&&sha256!==expectedSHA256)fail('CONFLICT');
  return{bytes:before.size,stat:state.current,sha256,canonical};
 }finally{await h.close();}
}
async function snapshotFile(full,options={}){
 const stat=await fs.lstat(full);if(stat.size>(options.maxBytes??FILE_BYTES))fail('TOO_LARGE');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-exchange-')),file=path.join(directory,'source');let h;
 try{
  h=await fs.open(file,'wx',0o600);const result=await walkFile(full,{...options,onChunk:async data=>{await h.writeFile(data);}});await h.sync();await h.close();h=null;
  let baseline=result.stat;
  const snapshot={...result,file,source:full,dispose:async()=>{await fs.unlink(file).catch(()=>{});await fs.rmdir(directory).catch(()=>{});},revalidate:async({fullHash=false}={})=>{
   abort(options.signal);const current=await fs.lstat(full);
   if(!current.isFile()||current.isSymbolicLink()||!options.allowLinks&&current.nlink!==1||!sameIdentity(current,baseline)||await fs.realpath(full)!==result.canonical)fail('CONFLICT');
   if(fullHash||!same(current,baseline)){
    const fresh=await walkFile(full,{maxBytes:options.maxBytes,signal:options.signal,allowLinks:options.allowLinks,expected:baseline,expectedSHA256:result.sha256});
    // A verified metadata-only change becomes the new baseline. Otherwise a
    // single cloud chmod would rehash a 1.5 GiB source for every staged asset.
    baseline=fresh.stat;snapshot.stat=fresh.stat;
   }
  }};
  return snapshot;
 }catch(e){if(h)await h.close().catch(()=>{});await fs.unlink(file).catch(()=>{});await fs.rmdir(directory).catch(()=>{});throw e;}
}
async function copyVerified(source,destination,{sha256,maxBytes=FILE_BYTES,signal,allowLinks=false}={}){
 const h=await fs.open(destination,'wx',0o600);let complete=false;
 try{const result=await walkFile(source,{maxBytes,signal,allowLinks,expectedSHA256:sha256,onChunk:data=>h.writeFile(data)});
  await h.sync();complete=true;return{...result,destinationStat:await h.stat()};
 }finally{await h.close();if(!complete)await fs.unlink(destination).catch(()=>{});}
}
module.exports={FILE_BYTES,BATCH_BYTES,CHUNK,walkFile,snapshotFile,copyVerified,same};

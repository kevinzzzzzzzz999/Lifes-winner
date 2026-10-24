'use strict';
const {spawn}=require('node:child_process');
const {fail,AppError}=require('./errors.cjs');

// Only the Mac system's legacy Word reader is used. Original paths never reach
// the converter: its input is the already-authorized, immutable vault snapshot.
const MAX_DOC_BYTES=16*1024*1024,MAX_CONVERTED_BYTES=16*1024*1024;
const DOC_SIGNATURE=Buffer.from('d0cf11e0a1b11ae1','hex');
const LEGACY_DOC_NOTICE='Legacy Word .doc is shown as a read-only preview. Layout, tables and images may differ; open the original application for the complete document.';
let active=0;

async function convertLegacyDOC(data,{platform=process.platform,spawnProcess=spawn,timeoutMs=10000}={}){
 if(platform!=='darwin')fail('LEGACY_DOC_UNAVAILABLE');
 if(!Buffer.isBuffer(data)||data.length<512||!data.subarray(0,8).equals(DOC_SIGNATURE))fail('LEGACY_DOC_UNREADABLE');
 if(data.length>MAX_DOC_BYTES)fail('TOO_LARGE');
 if(active>=2)fail('BUSY');
 active++;
 try{return await new Promise((resolve,reject)=>{
  let child,settled=false,bytes=0,chunks=[],timer;
  const finish=(code,result)=>{
   if(settled)return;settled=true;clearTimeout(timer);
   if(code){try{child?.kill('SIGKILL');}catch{}chunks=[];reject(new AppError(code));}
   else resolve(result);
  };
  try{child=spawnProcess('/usr/bin/textutil',['-stdin','-stdout','-format','doc','-convert','docx','-noload','-nostore','-strip','-timeout','1'],{shell:false,stdio:['pipe','pipe','ignore'],windowsHide:true});}
  catch{return finish('LEGACY_DOC_UNAVAILABLE');}
  timer=setTimeout(()=>finish('LEGACY_DOC_TIMEOUT'),Math.min(10000,Math.max(20,timeoutMs)));timer.unref?.();
  child.on('error',()=>finish('LEGACY_DOC_UNAVAILABLE'));
  child.stdin.on('error',()=>finish('LEGACY_DOC_UNREADABLE'));
  child.stdout.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>MAX_CONVERTED_BYTES)return finish('TOO_LARGE');chunks.push(chunk);});
  child.on('close',code=>{if(settled)return;if(code!==0||!bytes)return finish('LEGACY_DOC_UNREADABLE');finish(null,Buffer.concat(chunks,bytes));});
  try{child.stdin.end(data);}catch{finish('LEGACY_DOC_UNREADABLE');}
 });}finally{active--;}
}

async function previewLegacyDOC(data,options){
 const converted=await convertLegacyDOC(data,options);
 // Reuse DOCX's ZIP/decompression limits, external-file prohibition and bounded
 // picture handling rather than trusting the native converter's output as HTML.
 const preview=await require('./docx-preview.cjs').previewDocx(converted);
 return {...preview,warnings:[LEGACY_DOC_NOTICE,...preview.warnings]};
}
module.exports={convertLegacyDOC,previewLegacyDOC,MAX_DOC_BYTES,MAX_CONVERTED_BYTES,LEGACY_DOC_NOTICE};

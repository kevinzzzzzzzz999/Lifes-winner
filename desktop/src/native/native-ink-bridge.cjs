'use strict';
const fs=require('node:fs/promises'),{spawn}=require('node:child_process');
const CODES=new Set(['INK_TRANSFORM_FAILED','INK_RUNTIME_UNAVAILABLE','INK_CROSSES_BOUNDARY','COLLAPSE_HAS_CONTENT','NO_INK_SELECTED','INVALID_REQUEST','INVALID_BOARD','TOO_LARGE','BUSY','CANCELLED']);
const failure=code=>Object.assign(new Error(CODES.has(code)?code:'INK_TRANSFORM_FAILED'),{code:CODES.has(code)?code:'INK_TRANSFORM_FAILED'});
class NativeBoardInkBridge {
 constructor({runtimePath,timeoutMs=30000}={}){this.runtimePath=runtimePath;this.timeoutMs=timeoutMs;this.active=null;this.closed=false;}
 async info(){try{const stat=await fs.stat(this.runtimePath);return{available:!this.closed&&process.platform==='darwin'&&stat.isFile()};}catch{return{available:false};}}
 async apply({board,operation}){
  if(this.closed||!(await this.info()).available)throw failure('INK_RUNTIME_UNAVAILABLE');if(this.active)throw failure('BUSY');
  let input;try{input=Buffer.from(JSON.stringify({board,operation:{...operation,kind:operation?.kind??operation?.type}}));}catch{throw failure('INVALID_REQUEST');}
  if(input.length>64*1024*1024)throw failure('TOO_LARGE');
  return new Promise((resolve,reject)=>{
   let child,timer,finished=false,bytes=0,stderrBytes=0;const chunks=[];
   const complete=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);if(this.active===child)this.active=null;if(error)reject(error);else resolve(value);};
   try{child=spawn(this.runtimePath,[],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{reject(failure('INK_RUNTIME_UNAVAILABLE'));return;}
   this.active=child;
   timer=setTimeout(()=>{child.kill('SIGKILL');complete(failure('INK_TRANSFORM_FAILED'));},this.timeoutMs);
   child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>96*1024*1024){child.kill('SIGKILL');complete(failure('TOO_LARGE'));}else chunks.push(chunk);});
   // Native diagnostic text is never returned to the renderer or interpreted.
   child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>256*1024){child.kill('SIGKILL');complete(failure('INK_TRANSFORM_FAILED'));}});
   child.on('error',()=>complete(failure('INK_RUNTIME_UNAVAILABLE')));
   child.on('close',(exitCode,signal)=>{if(finished)return;if(child.inkCancelled)return complete(failure('CANCELLED'));try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(result.ok!==true)throw failure(result.error?.code);if(exitCode!==0||signal)throw failure('INK_TRANSFORM_FAILED');const value=result.value;if(!value||!Array.isArray(value.itemUpdates)||!Array.isArray(value.newItems)||!Array.isArray(value.removedIDs)||!Array.isArray(value.selectedIDs))throw failure('INK_TRANSFORM_FAILED');complete(null,value);}catch(error){complete(failure(error.code));}});
   child.stdin.on('error',()=>{});child.stdin.end(input);
  });
 }
 cancel(){if(this.active){this.active.inkCancelled=true;this.active.kill('SIGKILL');}}
 dispose(){this.closed=true;this.cancel();}
}
module.exports={NativeBoardInkBridge};

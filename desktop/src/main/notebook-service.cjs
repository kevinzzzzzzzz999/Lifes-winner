'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const os=require('node:os');
const {fail}=require('./errors.cjs');
const {pythonEnvironment}=require('./python-service.cjs');
const MAX_NOTEBOOK=128*1024*1024;
const MAX_SOURCE=32*1024*1024,MAX_CELL_SOURCE=8*1024*1024;
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
function fileKey(value){if(!value||typeof value.vaultId!=='string'||typeof value.path!=='string'||!value.path.toLowerCase().endsWith('.ipynb'))fail('INVALID_REQUEST');return JSON.stringify([value.vaultId,value.path]);}
function readCells(data,indices){
 let book;try{book=JSON.parse(data.toString('utf8').replace(/^\uFEFF/,''));}catch{fail('INVALID_REQUEST');}
 if(book?.nbformat!==4||!Array.isArray(book.cells)||book.cells.length>1000)fail('INVALID_REQUEST');
 const language=book.metadata?.kernelspec?.language||book.metadata?.language_info?.name||'python';
 if(typeof language!=='string'||!/^python(?:3)?$/i.test(language))fail('UNSUPPORTED');
 if(!Array.isArray(indices)||!indices.length||indices.length>1000||new Set(indices).size!==indices.length)fail('INVALID_REQUEST');
 let bytes=0;
 return indices.map(index=>{
  if(!Number.isInteger(index)||index<0||index>=book.cells.length)fail('INVALID_REQUEST');
  const cell=book.cells[index];if(cell?.cell_type!=='code')fail('INVALID_REQUEST');
  const source=Array.isArray(cell.source)&&cell.source.every(v=>typeof v==='string')?cell.source.join(''):cell.source;
  if(typeof source!=='string')fail('TOO_LARGE');
  const size=Buffer.byteLength(source);if(size>MAX_CELL_SOURCE||(bytes+=size)>MAX_SOURCE)fail('TOO_LARGE');
  return {index,source};
 });
}
class NotebookService extends EventEmitter {
 constructor({vaultService,runtimePath,packagesPath,helperPath,dataDirectory,timeoutMs=120000,startTimeoutMs=20000,maximumOutputBytes=4*1024*1024,maximumMemoryBytes=1536*1024*1024,maxKernelCount=3}){
  super();Object.assign(this,{vaultService,runtimePath,packagesPath,helperPath,dataDirectory,timeoutMs,startTimeoutMs,maximumOutputBytes,maximumMemoryBytes,maxKernelCount});this.kernels=new Map();this.pending=new Map();this.restarting=new Map();this.disposed=false;
 }
 async info(){
  let available=false;let packages={};
  try{const info=JSON.parse(await fs.readFile(path.join(path.dirname(this.packagesPath),'PROVENANCE.json'),'utf8'));packages=Object.fromEntries(info.packages.filter(p=>['ipython','numpy','pandas','matplotlib','openpyxl','xlrd'].includes(p.name.toLowerCase())).map(p=>[p.name,p.version]));
   available=(await fs.stat(this.runtimePath)).isFile()&&(await fs.stat(path.join(this.packagesPath,'IPython','__init__.py'))).isFile()&&(await fs.stat(this.helperPath)).isFile();
  }catch{}
  if(process.platform!=='darwin'||process.arch!=='arm64'||Number(os.release().split('.')[0])<23)available=false;
  return {available,pythonVersion:'3.14.7',engine:'IPython',packages,maxKernelCount:this.maxKernelCount,timeoutSeconds:this.timeoutMs/1000,sandboxed:false};
 }
 emitFor(kernel,values){if(kernel.run)this.emit('event',{vaultId:kernel.vaultId,path:kernel.path,kernelId:kernel.id,runId:kernel.run.id,...values});}
 // An open notebook owns its Python variables until explicitly closed/restarted.
 // Bound the number of kernels instead of silently expiring an idle session.
 finish(kernel,reason,kernelAlive=true){const run=kernel.run;if(!run)return;clearTimeout(run.timer);clearTimeout(run.interruptTimer);kernel.run=null;this.emit('event',{vaultId:kernel.vaultId,path:kernel.path,kernelId:kernel.id,runId:run.id,kind:'run-end',reason,status:reason==='completed'?'ok':'error',kernelAlive});}
 async run(request){
  const key=fileKey(request);if(this.disposed||this.restarting.has(key)||this.pending.has(key)||this.kernels.get(key)?.run)fail('BUSY');
  if(!uuid(request.runId)||! /^[a-f0-9]{64}$/.test(request.expectedSHA256||''))fail('INVALID_REQUEST');
  const pending={cancelled:false};this.pending.set(key,pending);
  try{
   const snapshot=await this.vaultService.snapshot(request,MAX_NOTEBOOK);if(snapshot.sha256!==request.expectedSHA256)fail('CONFLICT');
   const cells=readCells(snapshot.data,request.cellIndices);if(pending.cancelled||this.disposed)fail('CANCELLED');let kernel=this.kernels.get(key);
   if(kernel&&kernel.original!==snapshot.full){await this.stop(kernel,'restarted');kernel=null;}
   if(!kernel){if(this.kernels.size>=this.maxKernelCount)fail('NOTEBOOK_KERNEL_LIMIT');if(!(await this.info()).available)fail('RUNTIME_UNAVAILABLE');if(pending.cancelled||this.disposed||this.pending.get(key)!==pending)fail('CANCELLED');kernel=await this.start(key,request,snapshot.full,pending);}
   if(pending.cancelled||this.disposed||kernel.dead){await this.stop(kernel,'cancelled');fail('CANCELLED');}
   kernel.lastRunId=request.runId;kernel.run={id:request.runId,output:0,count:0,cell:null,indices:new Set(request.cellIndices),interrupted:false};
   kernel.run.timer=setTimeout(()=>void this.stop(kernel,'timeout'),this.timeoutMs);kernel.run.timer.unref?.();
   kernel.child.stdin.write(JSON.stringify({runId:request.runId,cells})+'\n',error=>{if(error)void this.stop(kernel,'failed');});
   return {runId:request.runId,kernelId:kernel.id};
  }catch(error){if(pending.cancelled||this.disposed)fail('CANCELLED');throw error;}finally{if(this.pending.get(key)===pending)this.pending.delete(key);}
 }
 async start(key,request,original,pending){
  const id=randomUUID(),directory=path.join(this.dataDirectory,'notebook-kernels',id);await fs.mkdir(directory,{recursive:true,mode:0o700});
  // A restart may have completed while mkdir/info/snapshot was awaiting I/O.
  // Never let that cancelled startup replace a newer kernel with the same key.
  if(pending&&(pending.cancelled||this.disposed||this.pending.get(key)!==pending)){await fs.rm(directory,{recursive:true,force:true});fail('CANCELLED');}
  if(this.kernels.size>=this.maxKernelCount){await fs.rm(directory,{recursive:true,force:true});fail('NOTEBOOK_KERNEL_LIMIT');}
  const kernel={key,id,vaultId:request.vaultId,path:request.path,original,directory,run:null,dead:false,child:null};this.kernels.set(key,kernel);
  const environment={...pythonEnvironment(),MPLBACKEND:'module://matplotlib_inline.backend_inline',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'};
  const child=spawn(this.runtimePath,['-I','-S','-B','-u',this.helperPath,this.packagesPath,original,directory,String(this.maximumMemoryBytes)],{cwd:path.dirname(original),env:environment,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe','pipe']});kernel.child=child;
  const decoder=new StringDecoder('utf8');let buffered='';let ready=false;let settled=false;
  const startup=new Promise((resolve,reject)=>{kernel.resolveReady=()=>{if(settled)return;settled=true;ready=true;clearTimeout(kernel.startTimer);resolve(kernel);};kernel.rejectReady=()=>{if(settled)return;settled=true;clearTimeout(kernel.startTimer);reject(Object.assign(new Error('Notebook kernel unavailable'),{code:'PYTHON_FAILED'}));};});
  kernel.startTimer=setTimeout(()=>{kernel.rejectReady();void this.stop(kernel,'failed');},this.startTimeoutMs);kernel.startTimer.unref?.();
  child.on('error',()=>{kernel.rejectReady();void this.stop(kernel,'failed');});
  child.stdin.on('error',()=>{if(!kernel.dead)void this.stop(kernel,'failed');});
  child.stdio[3].on('data',chunk=>{
   if(kernel.dead)return;buffered+=decoder.write(chunk);if(Buffer.byteLength(buffered)>this.maximumOutputBytes+1024*64){void this.stop(kernel,'output_limit');return;}
   let newline;while((newline=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);let event;try{event=JSON.parse(line);}catch{void this.stop(kernel,'failed');return;}
    if(event.kind==='ready'&&!ready){kernel.resolveReady();continue;}this.receive(kernel,event);
   }
  });
  for(const name of ['stdout','stderr']){const streamDecoder=new StringDecoder('utf8');child[name].on('data',data=>{if(kernel.dead||!kernel.run)return;const text=streamDecoder.write(data);if(text)this.receive(kernel,{kind:'output',runId:kernel.run.id,cellIndex:kernel.run.cell,output:{output_type:'stream',name,text}});});}
  kernel.closed=new Promise(resolve=>child.once('close',()=>{const unexpectedlyIdle=!kernel.dead&&!kernel.run;kernel.rejectReady();this.finish(kernel,'failed',false);if(unexpectedlyIdle&&kernel.lastRunId)this.emit('event',{vaultId:kernel.vaultId,path:kernel.path,kernelId:kernel.id,runId:kernel.lastRunId,kind:'run-end',reason:'failed',status:'error',kernelAlive:false});kernel.dead=true;clearTimeout(kernel.killTimer);if(this.kernels.get(key)===kernel)this.kernels.delete(key);this.killGroup(kernel,'SIGKILL');void fs.rm(directory,{recursive:true,force:true}).catch(()=>{});resolve();}));
  try{await startup;return kernel;}catch(error){await this.stop(kernel,'failed');throw error;}
 }
 receive(kernel,event){
  const run=kernel.run;if(!run||event.runId!==run.id||kernel.dead)return;
  if(event.kind==='limit'){void this.stop(kernel,['memory_limit','output_limit'].includes(event.reason)?event.reason:'failed');return;}
  if(event.kind==='run-end'){this.finish(kernel,run.interrupted?'cancelled':event.reason==='completed'?'completed':'error');return;}
  if(!run.indices.has(event.cellIndex))return;
  if(event.kind==='cell-start'){run.cell=event.cellIndex;this.emitFor(kernel,{kind:'cell-start',cellIndex:event.cellIndex,executionCount:event.executionCount});return;}
  if(event.cellIndex!==run.cell)return;
  if(event.kind==='output'){
   const output=event.output;if(!output||!['stream','display_data','execute_result','error'].includes(output.output_type))return;
   run.output+=Buffer.byteLength(JSON.stringify(output));run.count++;
   if(run.output>this.maximumOutputBytes||run.count>4000){void this.stop(kernel,'output_limit');return;}
   this.emitFor(kernel,{kind:'output',cellIndex:event.cellIndex,output});
  }else if(event.kind==='clear-output')this.emitFor(kernel,{kind:'clear-output',cellIndex:event.cellIndex,wait:event.wait===true});
  else if(event.kind==='cell-end')this.emitFor(kernel,{kind:'cell-end',cellIndex:event.cellIndex,executionCount:event.executionCount,status:event.status==='ok'?'ok':'error'});
 }
 killGroup(kernel,signal){const pid=kernel.child?.pid;if(!pid)return;try{if(process.platform==='win32')kernel.child.kill(signal);else process.kill(-pid,signal);}catch{try{kernel.child.kill(signal);}catch{}}}
 async stop(kernel,reason){
  if(!kernel)return;if(kernel.dead)return kernel.closed;
  kernel.dead=true;kernel.rejectReady?.();clearTimeout(kernel.startTimer);
  this.finish(kernel,reason,false);if(this.kernels.get(kernel.key)===kernel)this.kernels.delete(kernel.key);
  this.killGroup(kernel,'SIGTERM');kernel.killTimer=setTimeout(()=>this.killGroup(kernel,'SIGKILL'),500);kernel.killTimer.unref?.();
  if(kernel.closed)await kernel.closed;
 }
 interrupt(request){const key=fileKey(request),kernel=this.kernels.get(key);const pending=this.pending.get(key);if(!kernel?.run){if(pending){pending.cancelled=true;if(kernel)void this.stop(kernel,'cancelled');return {interrupted:true};}return {interrupted:false};}const run=kernel.run;run.interrupted=true;this.killGroup(kernel,'SIGINT');run.interruptTimer=setTimeout(()=>void this.stop(kernel,'cancelled'),1500);run.interruptTimer.unref?.();return {interrupted:true};}
 restart(request){const key=fileKey(request),existing=this.restarting.get(key);if(existing)return existing;
  const operation=Promise.resolve().then(async()=>{const token=this.pending.get(key);if(token){token.cancelled=true;this.pending.delete(key);}const kernel=this.kernels.get(key);if(kernel)await this.stop(kernel,'restarted');return {restarted:!!kernel||!!token};}).finally(()=>{if(this.restarting.get(key)===operation)this.restarting.delete(key);});this.restarting.set(key,operation);return operation;
 }
 async close(request){const key=fileKey(request);const restart=this.restarting.get(key);if(restart)await restart;const token=this.pending.get(key);if(token){token.cancelled=true;this.pending.delete(key);}const kernel=this.kernels.get(key);if(kernel)await this.stop(kernel,'closed');return {closed:!!kernel};}
 dispose(){this.disposed=true;for(const token of this.pending.values())token.cancelled=true;this.pending.clear();return Promise.all([...this.kernels.values()].map(kernel=>this.stop(kernel,'closed')));}
}
module.exports={NotebookService,readCells,MAX_NOTEBOOK};

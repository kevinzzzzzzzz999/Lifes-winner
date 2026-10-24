'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');const {StringDecoder}=require('node:string_decoder');const {EventEmitter}=require('node:events');const {fail}=require('./errors.cjs');const {MAX_TEXT,durableWrite}=require('./vault-service.cjs');
const BOOTSTRAP=`import sys, os
snapshot, original = sys.argv[1:3]
with open(snapshot, 'rb') as source: code = source.read()
sys.argv = [original]
sys.path.insert(0, os.path.dirname(original))
namespace = {'__name__': '__main__', '__file__': original, '__package__': None, '__cached__': None}
exec(compile(code, original, 'exec'), namespace, namespace)
`;
function pythonEnvironment(){const result={};for(const name of ['SystemRoot','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LANG','LC_ALL','PATH'])if(process.env[name])result[name]=process.env[name];return result;}
class PythonService extends EventEmitter {
 constructor({vaultService,runtimePath,dataDirectory,timeoutMs=60000,maximumOutputBytes=2*1024*1024}){super();this.vaultService=vaultService;this.runtimePath=runtimePath;this.dataDirectory=dataDirectory;this.timeoutMs=timeoutMs;this.maximumOutputBytes=maximumOutputBytes;this.active=null;}
 async available(){try{const st=await fs.stat(this.runtimePath);return st.isFile();}catch{return false;}}
 async run(request){if(this.active)fail('BUSY');if(typeof request?.runId!=='string'||! /^[a-f0-9-]{36}$/i.test(request.runId)||typeof request.path!=='string'||!request.path.toLowerCase().endsWith('.py')||! /^[a-f0-9]{64}$/.test(request.expectedSHA256||''))fail('INVALID_REQUEST');const run={id:request.runId,child:null,reason:'completed',finished:false,output:0,timer:null,killTimer:null,cancelRequested:false};this.active=run;let directory;
  try{if(!await this.available())fail('RUNTIME_UNAVAILABLE');const snap=await this.vaultService.snapshot(request,MAX_TEXT);if(snap.sha256!==request.expectedSHA256)fail('CONFLICT');directory=path.join(this.dataDirectory,'python-runs',request.runId);await fs.mkdir(directory,{recursive:true,mode:0o700});const snapshotPath=path.join(directory,'source.py');await durableWrite(snapshotPath,snap.data);if(run.cancelRequested)fail('CANCELLED');
   const child=spawn(this.runtimePath,['-I','-S','-B','-u','-c',BOOTSTRAP,snapshotPath,snap.full],{cwd:path.dirname(snap.full),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:pythonEnvironment()});run.child=child;
   const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
   const forward=(kind,chunk)=>{if(run.finished)return;const available=Math.max(0,this.maximumOutputBytes-run.output);const part=chunk.subarray(0,available);run.output+=part.length;const text=decoders[kind].write(part);if(text)this.emit('event',{runId:run.id,kind,text});if(chunk.length>available)this.stop(run,'output_limit');};child.stdout.on('data',chunk=>forward('stdout',chunk));child.stderr.on('data',chunk=>forward('stderr',chunk));
   child.once('close',(exitCode,signal)=>{if(run.finished)return;run.finished=true;clearTimeout(run.timer);clearTimeout(run.killTimer);for(const kind of ['stdout','stderr']){const text=decoders[kind].end();if(text)this.emit('event',{runId:run.id,kind,text});}if(this.active===run)this.active=null;this.emit('event',{runId:run.id,kind:'exit',exitCode,signal,reason:run.reason});void fs.rm(directory,{recursive:true,force:true}).catch(()=>{});});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>{run.reason='failed';reject(new Error('spawn'));});});run.timer=setTimeout(()=>this.stop(run,'timeout'),this.timeoutMs);run.timer.unref?.();if(run.cancelRequested)this.stop(run,'cancelled');return {runId:run.id};
  }catch(e){if(!run.child){if(this.active===run)this.active=null;if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}if(e.code)throw e;fail('PYTHON_FAILED');}
 }
 stop(run,reason){if(run.finished)return;if(run.reason==='completed')run.reason=reason;run.cancelRequested=true;if(!run.child)return;const pid=run.child.pid;if(!pid)return;
  if(process.platform==='win32'){const systemRoot=process.env.SystemRoot||process.env.WINDIR;if(systemRoot){const killer=spawn(path.join(systemRoot,'System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>run.child.kill());}else run.child.kill();}
  else{try{process.kill(-pid,'SIGTERM');}catch{run.child.kill('SIGTERM');}if(!run.killTimer){run.killTimer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{run.child.kill('SIGKILL');}},1000);run.killTimer.unref?.();}}
 }
 cancel({runId}){if(typeof runId!=='string')fail('INVALID_REQUEST');if(!this.active||this.active.id!==runId)return {cancelled:false};this.stop(this.active,'cancelled');return {cancelled:true};}
 dispose(){if(this.active)this.stop(this.active,'cancelled');}
}
module.exports={PythonService,pythonEnvironment,BOOTSTRAP};

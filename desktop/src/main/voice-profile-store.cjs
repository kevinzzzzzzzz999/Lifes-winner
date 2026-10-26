'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {fail}=require('./errors.cjs');
const {phraseKey,LIMITS,parseVoiceProfile,newVoiceProfile,addVoicePhrase,mergeVoiceProfiles,profileContext,preferredPhrase}=require('./voice-profile-model.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
class VoiceProfileStore extends EventEmitter{
 constructor(directory,{fsAPI=fs,now=()=>new Date()}={}){super();this.fs=fsAPI;this.now=now;this.file=path.join(directory,'voice-learning','profile-v1.json');this.fresh=newVoiceProfile(now());this.load();}
 readFile(file){const stat=this.fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMITS.bytes)fail('VOICE_PROFILE_INVALID');const bytes=this.fs.readFileSync(file);return{bytes,profile:parseVoiceProfile(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))};}
 load(){this.warning='';this.readOnly=false;this.bytes=null;this.profile=this.fresh;try{const result=this.readFile(this.file);this.profile=result.profile;this.bytes=result.bytes;}catch(error){if(error.code!=='ENOENT'){this.readOnly=true;this.warning='个人语音档案无法读取或版本较新，原文件已保留；暂不使用这些词句。';}try{this.profile=this.readFile(this.file+'.bak').profile;if(!this.readOnly)this.warning='已从最近完整备份恢复个人词句，下一次确认修改时保存。';}catch(backup){if(backup.code!=='ENOENT'){this.readOnly=true;this.warning='个人语音档案或备份无法读取，原文件已保留；暂不使用这些词句。';}}}return this.snapshot();}
 snapshot(){return{profile:structuredClone(this.profile),sha256:this.bytes?hash(this.bytes):null,readOnly:this.readOnly,warning:this.warning};}
 read(){return this.load();}
 contextWords(){const snapshot=this.load();return snapshot.readOnly?[]:profileContext(snapshot.profile);}
 atomic(file,bytes){const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=this.fs.openSync(temp,'wx',0o600);this.fs.writeFileSync(fd,bytes);this.fs.fsyncSync(fd);this.fs.closeSync(fd);fd=undefined;this.fs.renameSync(temp,file);const directory=this.fs.openSync(path.dirname(file),'r');try{this.fs.fsyncSync(directory);}finally{this.fs.closeSync(directory);}}finally{if(fd!==undefined)this.fs.closeSync(fd);try{this.fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}}
 update(request){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['expectedSHA256','action','enabled','phrase','id','originalText','correctedText','profile'].includes(k))||!(request.expectedSHA256===null||typeof request.expectedSHA256==='string'&&/^[a-f0-9]{64}$/.test(request.expectedSHA256)))fail('INVALID_REQUEST');
  const previous=this.load();if(previous.readOnly)fail('VOICE_PROFILE_PROTECTED');if(request.expectedSHA256!==previous.sha256)fail('VOICE_PROFILE_CONFLICT');let next=structuredClone(previous.profile),at=this.now().toISOString();
  switch(request.action){
   case'setEnabled':if(typeof request.enabled!=='boolean')fail('INVALID_REQUEST');next.enabled=request.enabled;break;
   case'add':next=addVoicePhrase(next,{phrase:request.phrase},this.now());break;
   case'remember':next=addVoicePhrase(next,{phrase:request.phrase,originalText:request.originalText,correctedText:request.correctedText,source:'confirmed-correction'},this.now());break;
   case'edit':{const found=next.entries.find(v=>v.id.toLowerCase()===String(request.id).toLowerCase());if(!found)fail('NOT_FOUND');const phrase=preferredPhrase(request.phrase);if(next.entries.some(v=>v.id!==found.id&&phraseKey(v.phrase)===phraseKey(phrase)))fail('EXISTS');found.phrase=phrase;found.updatedAt=at;break;}
   case'delete':next.entries=next.entries.filter(v=>v.id.toLowerCase()!==String(request.id).toLowerCase());break;
   case'clear':next.entries=[];break;
   case'import':next=mergeVoiceProfiles(next,request.profile,this.now());break;
   default:fail('INVALID_REQUEST');
  }
  next.updatedAt=at;next=parseVoiceProfile(next);const bytes=Buffer.from(JSON.stringify(next,null,2)+'\n');if(bytes.length>LIMITS.bytes)fail('VOICE_PROFILE_LIMIT');
  try{
   this.fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
   // Never replace an externally altered or unrecognized main/backup file.
   try{const current=this.readFile(this.file);if(!this.bytes||!current.bytes.equals(this.bytes))fail('VOICE_PROFILE_CONFLICT');}catch(error){if(error.code!=='ENOENT')throw error;if(this.bytes)fail('VOICE_PROFILE_CONFLICT');}
   try{this.readFile(this.file+'.bak');}catch(error){if(error.code!=='ENOENT')throw error;}
   if(this.bytes)this.atomic(this.file+'.bak',this.bytes);this.atomic(this.file,bytes);this.bytes=bytes;this.profile=next;this.warning='';
   if(['delete','clear'].includes(request.action)){try{this.atomic(this.file+'.bak',bytes);}catch{this.warning='词句已删除；旧备份清理暂未完成，请检查文件权限或剩余空间。';}}
   this.emit('changed');return this.snapshot();
  }catch(error){if(error.code==='VOICE_PROFILE_CONFLICT')throw error;fail('IO_FAILED');}
 }
 export(){const current=this.read();if(current.readOnly)fail('VOICE_PROFILE_PROTECTED');return Buffer.from(JSON.stringify(parseVoiceProfile(current.profile),null,2)+'\n');}
}
class VoiceProfileService extends EventEmitter{
 constructor(store){super();this.store=store;this.changed=()=>this.emit('event',{changed:true});store.on('changed',this.changed);}
 read(){return this.store.read();}update(value){return this.store.update(value);}export(){return this.store.export();}
 dispose(){this.store.removeListener('changed',this.changed);this.removeAllListeners();}
}
const stores=new WeakMap();function voiceProfileForApp(app){let store=stores.get(app);if(!store){store=new VoiceProfileStore(app.getPath('userData'));stores.set(app,store);}return store;}
module.exports={VoiceProfileStore,VoiceProfileService,voiceProfileForApp};

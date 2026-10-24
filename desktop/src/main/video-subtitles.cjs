'use strict';
// Portable association: exact video basename, adjacent sidecar, never source edits.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./errors.cjs'),{relativePath}=require('./vault-path.cjs'),{isVideoPath}=require('./video-service.cjs');
const {validateSubtitleFormat}=require('./subtitle-format-validation.cjs');
const SUFFIX='.inkspace-subtitles.json',MAX_TEXT_BYTES=2*1024*1024,MAX_SCALARS=200000,MAX_JSON_BYTES=4*1024*1024;
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function fields(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('INVALID_REQUEST');}
function publicVideoPath(value){relativePath(value);if(value.split('/').some(p=>p.startsWith('.'))||!isVideoPath(value))fail('PATH_DENIED');return value;}
function subtitlePath(video){relativePath(video);const parent=path.posix.dirname(video);return(parent==='.'?'':parent+'/')+'.'+path.posix.basename(video)+SUFFIX;}
function sidecarVideoPath(value){if(typeof value!=='string')return null;const name=path.posix.basename(value);if(!name.startsWith('.')||!name.endsWith(SUFFIX))return null;const video=name.slice(1,-SUFFIX.length);if(!video||video.startsWith('.')||!isVideoPath(video))return null;const parent=path.posix.dirname(value);return(parent==='.'?'':parent+'/')+video;}
function validateSubtitle(value){if(value===null)return null;fields(value,['name','text','enabled']);if(typeof value.name!=='string'||!value.name.isWellFormed()||Array.from(value.name).length>255||/[\\/\p{Cc}\p{Cf}]/u.test(value.name)||!/^.+\.(srt|vtt|txt)$/i.test(value.name)||typeof value.enabled!=='boolean'||typeof value.text!=='string'||!value.text.isWellFormed()||value.text.includes('\0'))fail('INVALID_REQUEST');if(Buffer.byteLength(value.text,'utf8')>MAX_TEXT_BYTES||Array.from(value.text).length>MAX_SCALARS)fail('TOO_LARGE');validateSubtitleFormat(value.name,value.text);return{name:value.name,text:value.text,enabled:value.enabled};}
function decodeSidecar(data){if(data.length>MAX_JSON_BYTES)fail('TOO_LARGE');let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));fields(value,['schemaVersion','subtitle']);if(value.schemaVersion!==1||!Object.hasOwn(value,'subtitle'))fail('INVALID_REQUEST');return{schemaVersion:1,subtitle:validateSubtitle(value.subtitle)};}catch(error){if(error.code==='TOO_LARGE')throw error;fail('INVALID_SUBTITLE');}}
async function durableWrite(file,data,mode){const handle=await fs.open(file,'wx',mode||0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}}
async function syncDirectory(directory){let handle;try{handle=await fs.open(directory,constants.O_RDONLY);await handle.sync();}catch(error){if(process.platform!=='win32'||!['EPERM','EINVAL','EISDIR','ENOTSUP'].includes(error.code))throw error;}finally{await handle?.close();}}
class VideoSubtitleService{
 constructor(vaults){this.vaults=vaults;}
 request(value,save=false){fields(value,save?['vaultId','path','subtitle','expectedSHA256']:['vaultId','path']);if(typeof value.vaultId!=='string')fail('INVALID_REQUEST');publicVideoPath(value.path);if(save&&value.expectedSHA256!==null&&(typeof value.expectedSHA256!=='string'||!/^[a-f0-9]{64}$/i.test(value.expectedSHA256)))fail('INVALID_REQUEST');return{vaultId:value.vaultId,path:value.path};}
 async load(request){const video=await this.vaults.resolve(request.vaultId,request.path);const rel=subtitlePath(request.path);let snap=null,subtitle=null;try{snap=await this.vaults.snapshot({vaultId:request.vaultId,path:rel},MAX_JSON_BYTES);subtitle=decodeSidecar(snap.data).subtitle;}catch(error){if(error.code!=='ENOENT')throw error;}const current=await this.vaults.resolve(request.vaultId,request.path);if(!same(video.stat,current.stat))fail('CONFLICT');return{video,rel,snap,subtitle};}
 async getVideoSubtitles(value){const request=this.request(value),loaded=await this.load(request);return{subtitle:loaded.subtitle,sha256:loaded.snap?.sha256||null};}
 async saveVideoSubtitles(value){const request=this.request(value,true),subtitle=validateSubtitle(value.subtitle),expected=value.expectedSHA256?.toLowerCase()||null,data=Buffer.from(JSON.stringify({schemaVersion:1,subtitle})+'\n');if(data.length>MAX_JSON_BYTES)fail('TOO_LARGE');const rel=subtitlePath(request.path);
  // Same order as move/trash: prevents a save appearing between their scan and transfer.
  return this.vaults.locked(request.vaultId+':file-management',()=>this.vaults.locked(request.vaultId+':'+rel,async()=>{
   const before=await this.load(request);if((before.snap?.sha256||null)!==expected)fail('CONFLICT');if(before.snap&&JSON.stringify(before.subtitle)===JSON.stringify(subtitle))return{subtitle,sha256:before.snap.sha256};
   const backupId=await this.vaults.backup(rel,before.snap?.data||null,data),parent=path.dirname(before.video.full),temp=path.join(parent,'.inkspace-save-'+crypto.randomUUID()+'.tmp'),dest=path.join(parent,path.posix.basename(rel));
   try{await durableWrite(temp,data,before.snap?.stat.mode&0o777);const current=await this.load(request);if(!same(before.video.stat,current.video.stat)||(current.snap?.sha256||null)!==expected||before.snap&&(!current.snap||!same(before.snap.stat,current.snap.stat)))fail('CONFLICT');
    if(before.snap)await fs.rename(temp,dest);else{await fs.link(temp,dest);await fs.unlink(temp);}await syncDirectory(parent);return{subtitle,sha256:digest(data),backupId};
   }finally{await fs.unlink(temp).catch(()=>{});}
  }));
 }
}
module.exports={VideoSubtitleService,subtitlePath,sidecarVideoPath,validateSubtitle,decodeSidecar,MAX_TEXT_BYTES,MAX_SCALARS,MAX_JSON_BYTES};

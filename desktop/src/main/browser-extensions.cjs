'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {extensionSummary}=require('./browser-security.cjs');
const {fail}=require('./errors.cjs');
// Only app-owned snapshots are loaded; changing the original unpacked folder
// cannot silently change the permissions or code accepted by the user.
class BrowserExtensions{
 constructor({session,directory,dialog,getWindow}){Object.assign(this,{session,directory,dialog,getWindow});this.records=[];this.busy=false;}
 async initialize(){
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});
  try{const file=path.join(this.directory,'installed.json'),stat=await fs.stat(file);if(stat.size>1024*1024)throw Error();const records=JSON.parse(await fs.readFile(file,'utf8'));if(!Array.isArray(records)||records.length>32)throw Error();this.records=records.filter(r=>r&&/^[a-f0-9-]{36}$/.test(r.key)&&typeof r.name==='string'&&Array.isArray(r.permissions));}catch{this.records=[];}
  for(const record of this.records)if(record.enabled){try{await this.load(record);}catch{record.enabled=false;record.error='扩展未能加载，请重新安装或查看兼容性。';}}
 }
 list(){return this.records.map(({key,name,version,enabled,permissions,warnings,error})=>({key,name,version,enabled,permissions,warnings,error}));}
 async persist(){const temp=path.join(this.directory,'list-'+crypto.randomUUID()+'.tmp');await fs.writeFile(temp,JSON.stringify(this.records.map(({id,...r})=>r)),{mode:0o600,flag:'wx'});await fs.rename(temp,path.join(this.directory,'installed.json'));}
 async load(record){const extension=await this.session.extensions.loadExtension(path.join(this.directory,record.key),{allowFileAccess:false});record.id=extension.id;record.enabled=true;delete record.error;}
 async action(action,key){
  if(this.busy)fail('BUSY');this.busy=true;try{
   if(action==='install')return await this.install();
   const record=this.records.find(r=>r.key===key);if(!record)fail('INVALID_REQUEST');
   if(action==='remove'){if(record.id)this.session.extensions.removeExtension(record.id);this.records=this.records.filter(r=>r!==record);await this.persist();await fs.rm(path.join(this.directory,record.key),{recursive:true,force:true});}
   else if(action==='toggle'){if(record.enabled){if(record.id)this.session.extensions.removeExtension(record.id);record.enabled=false;delete record.id;}else await this.load(record);await this.persist();}
   else fail('INVALID_REQUEST');
   return this.list();
  }finally{this.busy=false;}
 }
 async install(){
  if(this.records.length>=32)fail('TOO_LARGE');
  const selected=await this.dialog.showOpenDialog(this.getWindow(),{title:'选择含 manifest.json 的解压扩展文件夹',properties:['openDirectory'],filters:[{name:'文件夹',extensions:['*']}]});if(selected.canceled)return this.list();
  const source=await fs.realpath(selected.filePaths[0]),key=crypto.randomUUID(),destination=path.join(this.directory,key);await fs.mkdir(destination,{mode:0o700});
  let committed=false,total=0,count=0;
  try{
   const copy=async(folder,relative='',depth=0)=>{if(depth>20)fail('TOO_LARGE');for(const name of await fs.readdir(folder)){if(++count>3000)fail('TOO_LARGE');const sourcePath=path.join(folder,name),rel=path.join(relative,name),stat=await fs.lstat(sourcePath);if(stat.isSymbolicLink())fail('PATH_DENIED');if(stat.isDirectory()){await fs.mkdir(path.join(destination,rel),{mode:0o700});await copy(sourcePath,rel,depth+1);}else if(stat.isFile()&&stat.nlink===1){total+=stat.size;if(stat.size>32*1024*1024||total>128*1024*1024)fail('TOO_LARGE');const handle=await fs.open(sourcePath,require('node:fs').constants.O_RDONLY|(require('node:fs').constants.O_NOFOLLOW||0));try{const check=await handle.stat();if(check.ino!==stat.ino||check.dev!==stat.dev||check.size!==stat.size)fail('CONFLICT');const data=Buffer.alloc(stat.size+1);const {bytesRead}=await handle.read(data,0,data.length,0);const after=await handle.stat();if(bytesRead!==stat.size||after.mtimeMs!==stat.mtimeMs||after.size!==stat.size)fail('CONFLICT');await fs.writeFile(path.join(destination,rel),data.subarray(0,bytesRead),{mode:0o600,flag:'wx'});}finally{await handle.close();}}else fail('PATH_DENIED');}};
   await copy(source);const manifestFile=path.join(destination,'manifest.json'),stat=await fs.stat(manifestFile);if(stat.size>256*1024)fail('TOO_LARGE');const summary=extensionSummary(JSON.parse(await fs.readFile(manifestFile,'utf8')));
   const answer=await this.dialog.showMessageBox(this.getWindow(),{type:'warning',title:'安装浏览器扩展',message:`安装“${summary.name}” ${summary.version}？`,detail:`扩展可按以下权限读取或修改浏览器网页。请只安装你信任的来源。\n\n${summary.permissions.join('\n')||'未声明额外权限'}\n\n${summary.warnings.join('\n')}`,buttons:['取消','安装并启用'],defaultId:0,cancelId:0,noLink:true});
   if(answer.response!==1)return this.list();
   const record={key,...summary,enabled:false};await this.load(record);this.records.push(record);try{await this.persist();committed=true;}catch(error){this.session.extensions.removeExtension(record.id);this.records.pop();throw error;}return this.list();
  }finally{if(!committed)await fs.rm(destination,{recursive:true,force:true});}
 }
}
module.exports={BrowserExtensions};

'use strict';
const fs=require('node:fs/promises'),path=require('node:path');const {execFile}=require('node:child_process');const {fail}=require('./errors.cjs');
async function openOriginal(vaults,request,{dialog,shell,window}){
 const allowed=new Set(['.xlsx','.xls','.xlsm','.csv','.doc','.docx','.ppt','.pptx','.pdf','.txt','.md','.markdown','.tex','.png','.jpg','.jpeg','.mp4','.mov','.m4v']);
 if(!['default','choose'].includes(request.application)||!allowed.has(path.extname(request.path).toLowerCase()))fail('UNSUPPORTED');
 const initial=await vaults.resolve(request.vaultId,request.path);if(!initial.stat.isFile())fail('UNSUPPORTED');
 let selectedApp;
 if(request.application==='choose'){
  if(process.platform!=='darwin')fail('UNSUPPORTED');const choice=await dialog.showOpenDialog(window,{title:'选择编辑应用 / Choose an application',defaultPath:'/Applications',properties:['openFile'],filters:[{name:'Applications',extensions:['app']}]});if(choice.canceled||!choice.filePaths.length)return {opened:false};selectedApp=await fs.realpath(choice.filePaths[0]);if(path.extname(selectedApp).toLowerCase()!=='.app'||!(await fs.stat(selectedApp)).isDirectory())fail('INVALID_REQUEST');
 }
 const current=await vaults.resolve(request.vaultId,request.path);if(current.full!==initial.full||current.stat.dev!==initial.stat.dev||current.stat.ino!==initial.stat.ino)fail('CONFLICT');
 if(selectedApp)await new Promise((resolve,reject)=>execFile('/usr/bin/open',['-a',selectedApp,current.full],{timeout:15000,maxBuffer:4096},e=>e?reject(e):resolve()));
 else if(await shell.openPath(current.full))fail('IO_FAILED');return{opened:true};
}
module.exports={openOriginal};

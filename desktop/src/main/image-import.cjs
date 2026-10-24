'use strict';
const fs=require('node:fs/promises');const {constants}=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {fail}=require('./errors.cjs');
function imageInfo(data){
 if(data.length>=24&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.toString('ascii',12,16)==='IHDR')return dimensions('png',data.readUInt32BE(16),data.readUInt32BE(20));
 if(data.length>=4&&data[0]===255&&data[1]===216){let at=2;while(at+4<=data.length){if(data[at]!==255)fail('UNSUPPORTED');while(data[at]===255)at++;const marker=data[at++];if(marker===0xd9||marker===0xda)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;if(at+2>data.length)break;const length=data.readUInt16BE(at);if(length<2||at+length>data.length)fail('UNSUPPORTED');if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(length<8)fail('UNSUPPORTED');return dimensions('jpg',data.readUInt16BE(at+5),data.readUInt16BE(at+3));}at+=length;}}
 fail('UNSUPPORTED');
}
function dimensions(extension,width,height){if(!width||!height||width>20000||height>20000||width*height>64*1024*1024)fail('TOO_LARGE');return {extension,width,height};}
async function importSelectedImage(vaults,request,selectedPath){
 // selectedPath is supplied only by the trusted native file chooser, never IPC.
 await vaults.resolve(request.vaultId,request.parentPath,{directory:true});const real=await fs.realpath(selectedPath);const stat=await fs.stat(real);if(!stat.isFile()||stat.size>128*1024*1024)fail('TOO_LARGE');const handle=await fs.open(real,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let data;try{const before=await handle.stat();if(before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size)fail('CONFLICT');const chunks=[];let size=0;while(size<=stat.size){const chunk=Buffer.allocUnsafe(Math.min(65536,stat.size+1-size));const {bytesRead}=await handle.read(chunk,0,chunk.length,size);if(!bytesRead)break;chunks.push(chunk.subarray(0,bytesRead));size+=bytesRead;}const after=await handle.stat();if(size!==stat.size||after.size!==stat.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('CONFLICT');data=Buffer.concat(chunks,size);}finally{await handle.close();}
 const info=imageInfo(data);const stem=path.basename(selectedPath,path.extname(selectedPath)).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^[. ]+|[. ]+$/g,'')||'Image';const name=Array.from(stem).slice(0,100).join('')+'-'+crypto.randomUUID().slice(0,8)+'.'+info.extension;const created=await vaults.createData(request.vaultId,request.parentPath,name,data,{backup:false});return {path:created.path,assetUrl:created.assetUrl};
}
module.exports={imageInfo,importSelectedImage};

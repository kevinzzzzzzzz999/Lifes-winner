'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const {object,normalizeClip,clipText,fileStem,MAX_CLIP_BYTES}=require('./browser-security.cjs');
const {normalizeImage}=require('./board-clipboard.cjs');
async function validateTarget(vaults,value={}){
 object(value,['vaultId','parentPath','boardPath']);
 if(typeof value.vaultId!=='string'||typeof value.parentPath!=='string')fail('INVALID_REQUEST');
 await vaults.resolve(value.vaultId,value.parentPath,{directory:true});
 if(value.boardPath!==undefined){if(typeof value.boardPath!=='string'||!value.boardPath.endsWith('.inkspace.json'))fail('INVALID_REQUEST');const board=await vaults.readFile({vaultId:value.vaultId,path:value.boardPath});if(board.kind!=='board')fail('INVALID_REQUEST');}
 return {...value};
}
function boardPosition(board,width=480,height=260){
 const x=Math.max(0,Math.min(board.canvasWidth-width,Math.round(board.viewport?.x??0)));
 let y=Math.max(0,Math.min(board.canvasHeight-height,Math.round(board.viewport?.y??0)));
 for(let n=0;n<1000;n++){
  const overlaps=board.items.filter(v=>v.x<x+width&&v.x+v.width>x&&v.y<y+height&&v.y+v.height>y);
  if(!overlaps.length)return{x,y};y=Math.max(...overlaps.map(v=>v.y+v.height))+24;if(y+height>board.canvasHeight)break;
 }
 fail('BOARD_SPACE_INSUFFICIENT');
}
async function saveClip(vaults,target,input,{nativeImage}={}){
 await validateTarget(vaults,target);const clip=normalizeClip(input),content=clipText(clip);
 if(target.boardPath){
  const request={vaultId:target.vaultId,path:target.boardPath};const current=await vaults.readFile(request);
  const position=boardPosition(current.board,640,clip.imageDataURL?940:260);
  const result=await require('./board-paste.cjs').pasteBoardContent(vaults,{...request,expectedSHA256:current.sha256,...position,content:{text:{title:clip.title,text:content,width:480,height:260},...(clip.imageDataURL?{images:[{dataURL:clip.imageDataURL,title:clip.title}]}:{})}},{nativeImage});
  return {path:result.path,kind:'board'};
 }
 const image=clip.imageDataURL?normalizeImage(clip.imageDataURL,nativeImage):null;
 const name=fileStem(clip.title)+'-'+crypto.randomUUID().slice(0,8);
 // Notes use plain text so webpage HTML/Markdown cannot create executable content.
 const note=await vaults.createTextFile({vaultId:target.vaultId,parentPath:target.parentPath,name:name+'.txt',content});
 if(image){try{const asset=await vaults.createData(target.vaultId,target.parentPath,name+'.png',image.data,{backup:false});return{path:note.path,imagePath:asset.path,kind:'text'};}catch{return {path:note.path,kind:'text',warning:'文字和来源已保存，图片保存失败；请重试图片剪藏。'};}}
 return {path:note.path,kind:'text'};
}
async function savePDF(vaults,target,data,title){
 await validateTarget(vaults,target);if(!Buffer.isBuffer(data)||data.length>128*1024*1024||data.subarray(0,5).toString()!=='%PDF-')fail('INVALID_REQUEST');
 const file=await vaults.createData(target.vaultId,target.parentPath,fileStem(title)+'-'+crypto.randomUUID().slice(0,8)+'.pdf',data,{backup:false});
 if(target.boardPath){try{const request={vaultId:target.vaultId,path:target.boardPath},current=await vaults.readFile(request);await vaults.addBoardFileCard({...request,expectedSHA256:current.sha256,sourcePath:file.path,...boardPosition(current.board,360,180)});}catch{return {path:file.path,kind:'media',warning:'PDF 已保存到资料夹；白板发生变化，未添加卡片。'};}}
 return {path:file.path,kind:'media'};
}
async function readClipFile(file){
 const handle=await fs.open(file,require('node:fs').constants.O_RDONLY|(require('node:fs').constants.O_NOFOLLOW||0));
 try{const before=await handle.stat();if(!before.isFile()||before.size>MAX_CLIP_BYTES)fail('TOO_LARGE');const data=Buffer.alloc(before.size+1);const {bytesRead}=await handle.read(data,0,data.length,0);const after=await handle.stat();if(bytesRead!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('CONFLICT');let clip;try{clip=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,bytesRead)));}catch{fail('INVALID_REQUEST');}return normalizeClip(clip);}finally{await handle.close();}
}
module.exports={validateTarget,boardPosition,saveClip,savePDF,readClipFile};

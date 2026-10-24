'use strict';
// Add content to the current on-disk board, never replace it with a renderer's
// stale item array. Assets are published before one conflict-checked board commit.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {constants}=require('node:fs');
const {fail}=require('./errors.cjs');
const {relativePath}=require('./vault-path.cjs');
const {validateBoard}=require('./board-validation.cjs');
const {LIMITS,normalizeImage}=require('./board-clipboard.cjs');
const {boardGeneratedAssetDirectory,ensureBoardGeneratedAssets}=require('./board-generated-assets.cjs');
const MAX_BOARD=64*1024*1024;
const {prepareClipboardFiles,publishClipboardFile,verifyClipboardFile,rollbackClipboardFile,MAX_FILES}=require('./clipboard-files.cjs');
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('INVALID_REQUEST');};
const text=(value,maximum)=>{if(typeof value!=='string'||value.length>maximum||value.includes('\0')||!value.isWellFormed())fail('INVALID_REQUEST');return value;};
function parseBoard(data){let board;try{board=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data),(_key,value)=>{if(typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value))fail('INVALID_BOARD');return value;});}catch{fail('INVALID_BOARD');}validateBoard(board);return board;}
function validateContent(content){
 object(content,['text','images','files']);let note;
 if(content.text!==undefined){const v=content.text;object(v,['text','title','richTextHTML','width','height','textFormat','url']);if(v.textFormat!==undefined&&!['richText','markdown','latex','python','web'].includes(v.textFormat))fail('INVALID_REQUEST');text(v.text,100000);if(!v.text.trim())fail('INVALID_REQUEST');if(v.title!==undefined)text(v.title,10000);if(v.richTextHTML!==undefined)text(v.richTextHTML,300000);
  let url;if(v.url!==undefined||v.textFormat==='web'){url=require('./board-web-url.cjs').webCardURL(v.url??v.text);if(v.textFormat!=='web')fail('INVALID_REQUEST');}
  const width=v.width??480,height=v.height??240;if(!Number.isFinite(width)||!Number.isFinite(height)||width<80||width>4000||height<40||height>8000)fail('INVALID_REQUEST');
  note={text:v.textFormat==='web'?url:v.text,...(url?{url}:{}),title:v.title??v.text.trim().split(/\r?\n/)[0].slice(0,100),width,height,textFormat:v.textFormat||'richText',...((!v.textFormat||v.textFormat==='richText')&&v.richTextHTML?{richTextHTML:v.richTextHTML}:{})};
 }
 const images=content.images??[];if(!Array.isArray(images)||images.length>LIMITS.imageCount)fail('TOO_LARGE');
 for(const image of images){object(image,['dataURL','title']);if(typeof image.dataURL!=='string')fail('INVALID_REQUEST');if(image.title!==undefined)text(image.title,10000);}
 const files=content.files??[];if(!Array.isArray(files)||files.length>MAX_FILES)fail('TOO_LARGE');for(const file of files){object(file,['token','name']);text(file.token,100);text(file.name,1000);}
 if(!note&&!images.length&&!files.length)fail('INVALID_REQUEST');return{note,images,files};
}
async function writable(vaults,request,snap){
 if(!(snap.stat.mode&0o222))fail('PERMISSION_DENIED');
 const parent=path.posix.dirname(request.path)==='.'?'':path.posix.dirname(request.path),directory=await vaults.resolve(request.vaultId,parent,{directory:true});
 if(!(directory.stat.mode&0o222))fail('PERMISSION_DENIED');
 try{await fs.access(snap.full,constants.W_OK);await fs.access(directory.full,constants.W_OK);}catch{fail('PERMISSION_DENIED');}
 return parent;
}
async function pasteBoardContent(vaults,request,{nativeImage}={}){
 object(request,['vaultId','path','expectedSHA256','content','x','y']);relativePath(request.path);
 if(request.path.split('/').some(p=>p.startsWith('.')))fail('PATH_DENIED');
 if(!request.path.toLowerCase().endsWith('.inkspace.json')||typeof request.expectedSHA256!=='string'||! /^[a-f0-9]{64}$/.test(request.expectedSHA256)||typeof request.vaultId!=='string'||!Number.isFinite(request.x)||!Number.isFinite(request.y)||request.x<0||request.y<0)fail('INVALID_REQUEST');
 const content=validateContent(request.content);
 return vaults.lockedBoard(request,async()=>{
  const snap=await vaults.snapshot(request,MAX_BOARD);if(snap.sha256!==request.expectedSHA256)fail('CONFLICT');
  const board=parseBoard(snap.data),parent=await writable(vaults,request,snap);
  if(!Number.isSafeInteger(board.revision+1))fail('INVALID_BOARD');
  let totalBytes=0,totalPixels=0;
  const imageParent=boardGeneratedAssetDirectory(request.path);
  const images=content.images.map(v=>{const image=normalizeImage(v.dataURL,nativeImage);totalBytes+=image.data.length;totalPixels+=image.width*image.height;if(totalBytes>LIMITS.totalImageBytes||totalPixels>LIMITS.totalImagePixels)fail('TOO_LARGE');const name='Clipboard-'+crypto.randomUUID()+'.png';return{...image,title:v.title??'Pasted image',name,sourcePath:imageParent+'/'+name};});
  const files=await prepareClipboardFiles(vaults,request,content.files,parent);
  const added=[];let y=request.y;
  if(content.note){added.push({id:crypto.randomUUID(),kind:content.note.textFormat==='latex'?'formula':'text',x:request.x,y,...content.note});y+=content.note.height+24;}
  for(const image of images){const scale=Math.min(1,640/Math.max(image.width,image.height)),width=Math.max(1,image.width*scale),height=Math.max(1,image.height*scale);added.push({id:crypto.randomUUID(),kind:'document',title:image.title,sourcePath:image.sourcePath,x:request.x,y,width,height});y+=height+24;}
  const columns=Math.min(4,files.length);for(let index=0;index<files.length;index++){const file=files[index];added.push({id:crypto.randomUUID(),kind:'document',title:file.title,sourcePath:file.sourcePath,x:request.x+(index%columns)*384,y:y+Math.floor(index/columns)*204,width:360,height:180});}
  if(added.some(v=>v.x+v.width>board.canvasWidth||v.y+v.height>board.canvasHeight))fail('BOARD_SPACE_INSUFFICIENT');
  const next={...board,items:[...board.items,...added],revision:board.revision+1,writerID:await vaults.writerID(),updatedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};validateBoard(next);
  const data=Buffer.from(JSON.stringify(next));if(data.length>MAX_BOARD)fail('TOO_LARGE');
  const published=[];let committed=false,assetDirectory;
  try{
   if(images.length)assetDirectory=await ensureBoardGeneratedAssets(vaults,request.vaultId,request.path);
   for(const image of images){
    // Register the unique destination before createData: it may publish before a
    // provider readback fails. Cleanup below requires the exact expected digest.
    const entry={path:image.sourcePath,sha256:require('./vault-service.cjs').digest(image.data)};published.push(entry);
    await assetDirectory.revalidate();
    await vaults.createData(request.vaultId,imageParent,image.name,image.data,{backup:false});
   }
   for(const file of files)await publishClipboardFile(vaults,request,parent,file);
   const result=await vaults.commitSnapshot(request,snap,data,MAX_BOARD,async()=>{
    await writable(vaults,request,snap);
    if(assetDirectory)await assetDirectory.revalidate();
    for(const file of files)await verifyClipboardFile(vaults,request,file);
    for(const image of published){const current=await vaults.snapshot({vaultId:request.vaultId,path:image.path},LIMITS.imageBytes);if(current.sha256!==image.sha256)fail('CONFLICT');}
   });committed=true;
   // Assets intentionally survive Undo so Redo and retained board history work.
   let history;try{history=await vaults.boardHistory.recordTransition(request,snap.data,data);}catch{history={canUndo:false,canRedo:false,warning:'The whiteboard was saved, but its local undo history could not be updated.'};}
   return{path:request.path,name:path.posix.basename(request.path),kind:'board',board:next,...result,selectedIDs:added.map(v=>v.id),history};
  }catch(error){
   if(!committed)for(const file of files)await rollbackClipboardFile(vaults,request,file);
   if(!committed)for(const asset of published){try{const current=await vaults.snapshot({vaultId:request.vaultId,path:asset.path},LIMITS.imageBytes);if(current.sha256===asset.sha256){const checkedPath=await vaults.resolve(request.vaultId,asset.path);if(checkedPath.stat.ino===current.stat.ino&&checkedPath.stat.dev===current.stat.dev)await fs.unlink(current.full);}}catch{}}
   throw error;
  }
 });
}
module.exports={pasteBoardContent,validateContent};

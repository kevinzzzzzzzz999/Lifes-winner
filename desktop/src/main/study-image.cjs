'use strict';
const {fail}=require('./errors.cjs'),{imageInfo}=require('./image-import.cjs'),{relativePath}=require('./vault-path.cjs'),{validateBoard}=require('./board-validation.cjs');
const MAX_BYTES=8*1024*1024,MAX_PIXELS=16*1024*1024;
function imageNodePath(node){return node?.kind==='document'&&typeof node.sourcePath==='string'&&/\.(png|jpe?g)$/i.test(node.sourcePath)?node.sourcePath:null;}
async function loadNodeImage(vaults,request,node,nativeImage){
 const path=imageNodePath(node);if(!path)fail('UNSUPPORTED');relativePath(path);
 const snap=await vaults.snapshotForRead({vaultId:request.vaultId,path},MAX_BYTES),info=imageInfo(snap.data);
 if(!['png','jpg'].includes(info.extension)||info.width<1||info.height<1||info.width>8192||info.height>8192||info.width*info.height>MAX_PIXELS)fail('TOO_LARGE');
 if(nativeImage){const image=nativeImage.createFromBuffer(snap.data),size=image.getSize();if(image.isEmpty()||size.width!==info.width||size.height!==info.height)fail('UNSUPPORTED');}
 return{dataURL:'data:image/'+(info.extension==='png'?'png':'jpeg')+';base64,'+snap.data.toString('base64'),sha256:snap.sha256,width:info.width,height:info.height,sourcePath:path};
}
async function readStudyImage(vaults,request,{nativeImage}={}){
 if(!request||Object.keys(request).some(k=>!['vaultId','path','boardID','itemID','sourcePath'].includes(k))||typeof request.vaultId!=='string')fail('INVALID_REQUEST');relativePath(request.path);if(!request.path.endsWith('.inkspace.json')||typeof request.boardID!=='string'||(typeof request.itemID!=='string'&&typeof request.sourcePath!=='string'))fail('INVALID_REQUEST');
 const snap=await vaults.snapshotForRead(request,64*1024*1024);let board;try{board=JSON.parse(snap.data);}catch{fail('INVALID_BOARD');}validateBoard(board);if(board.id.toLowerCase()!==request.boardID.toLowerCase())fail('CONFLICT');const node=typeof request.sourcePath==='string'?{kind:'document',sourcePath:request.sourcePath}:board.items.find(n=>n.id.toLowerCase()===request.itemID.toLowerCase());if(!node)fail('STUDY_NODE_MISSING');return loadNodeImage(vaults,request,node,nativeImage);
}
module.exports={imageNodePath,loadNodeImage,readStudyImage,MAX_BYTES,MAX_PIXELS};

'use strict';
// A bounded visual snapshot is a normal image node. The original PDF and study
// event format stay unchanged; fixed request IDs make a lost response retryable.
const path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./errors.cjs'),{relativePath}=require('./vault-path.cjs'),{validateBoard}=require('./board-validation.cjs'),{validateSourceReference}=require('./board-elements.cjs'),{normalizeImage}=require('./board-clipboard.cjs'),{walkFile}=require('./exchange-stream.cjs');
const {boardGeneratedAssetDirectory,ensureBoardGeneratedAssets}=require('./board-generated-assets.cjs');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/;
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function reference(v){validateSourceReference(v);if(v.extendBlockID!==undefined||v.quote!=='')fail('INVALID_REQUEST');return JSON.parse(JSON.stringify(v));}
function sameReference(a,b){return a&&a.schemaVersion===b.schemaVersion&&a.path===b.path&&a.sourceSHA256===b.sourceSHA256&&a.page===b.page&&a.quote===b.quote&&['x','y','width','height'].every(k=>a.rect?.[k]===b.rect[k]);}
async function createPDFVisualExcerpt(vaults,request,{nativeImage}={}){
 const keys=['vaultId','path','boardID','expectedSHA256','itemID','title','sourceReference','dataURL','x','y'];if(!request||Object.keys(request).some(k=>!keys.includes(k))||typeof request.vaultId!=='string'||!UUID.test(request.boardID)||!UUID.test(request.itemID)||!SHA.test(request.expectedSHA256))fail('INVALID_REQUEST');
 relativePath(request.path);if(!request.path.endsWith('.inkspace.json')||request.path.split('/').some(p=>p.startsWith('.'))||typeof request.title!=='string'||!request.title.trim()||request.title.length>1000||request.title.includes('\0')||!request.title.isWellFormed()||![request.x,request.y].every(v=>Number.isFinite(v)&&v>=0))fail('INVALID_REQUEST');
 const ref=reference(request.sourceReference),image=normalizeImage(request.dataURL,nativeImage);if(image.width*image.height>8_000_000)fail('TOO_LARGE');const id=request.itemID.toLowerCase(),assetName='Excerpt-'+id+'.png',parent=path.posix.dirname(request.path)==='.'?'':path.posix.dirname(request.path),assetParent=boardGeneratedAssetDirectory(request.path),newSourcePath=assetParent+'/'+assetName,legacySourcePath=parent?parent+'/'+assetName:assetName,assetSHA=digest(image.data);
 return vaults.lockedBoard(request,async()=>{
  let sourcePath=newSourcePath,assetDirectory;
  const snap=await vaults.snapshot(request,64*1024*1024);let board;try{board=JSON.parse(snap.data);}catch{fail('INVALID_BOARD');}validateBoard(board);if(board.id.toLowerCase()!==request.boardID.toLowerCase())fail('CONFLICT');
  const source=await vaults.resolve(request.vaultId,ref.path),pdf=await walkFile(source.full,{maxBytes:256*1024*1024,expectedSHA256:ref.sourceSHA256,onChunk:(bytes,offset)=>{if(offset===0&&bytes.subarray(0,5).toString()!=='%PDF-')fail('UNSUPPORTED');}});
  const verifySource=async()=>{const resolved=await vaults.resolve(request.vaultId,ref.path);if(resolved.stat.dev!==pdf.stat.dev||resolved.stat.ino!==pdf.stat.ino)fail('CONFLICT');await walkFile(resolved.full,{maxBytes:256*1024*1024,expected:pdf.stat,expectedSHA256:ref.sourceSHA256});};
  const verifyAsset=async()=>{const asset=await vaults.snapshot({vaultId:request.vaultId,path:sourcePath},8*1024*1024);if(asset.sha256!==assetSHA)fail('CONFLICT');};
  const old=board.items.find(n=>n.id.toLowerCase()===id);
  if(old){if(old.kind!=='document'||![newSourcePath,legacySourcePath].includes(old.sourcePath)||old.title!==request.title||old.originalSourcePath!==ref.path||old.page!==ref.page||!sameReference(old.sourceReference,ref))fail('CONFLICT');sourcePath=old.sourcePath;await verifyAsset();await verifySource();return{...await vaults.readFile(request),selectedIDs:[old.id],reused:true};}
  if(snap.sha256!==request.expectedSHA256)fail('CONFLICT');
  // A fixed-ID retry may originate from an older build that published the
  // matching image beside its board. Reuse it without moving or duplicating it.
  try{await verifyAsset();}catch(error){if(error.code!=='ENOENT')throw error;sourcePath=legacySourcePath;try{await verifyAsset();}catch(legacy){if(legacy.code!=='ENOENT')throw legacy;sourcePath=newSourcePath;}}
  const scale=Math.min(1,640/image.width,640/image.height),width=image.width*scale,height=image.height*scale;
  if(request.x+width>board.canvasWidth||request.y+height>board.canvasHeight)fail('BOARD_SPACE_INSUFFICIENT');
  const node={id,kind:'document',title:request.title,sourcePath,originalSourcePath:ref.path,page:ref.page,sourceReference:ref,x:request.x,y:request.y,width,height};
  if(!Number.isSafeInteger(board.revision+1))fail('INVALID_BOARD');const next={...board,items:[...board.items,node],revision:board.revision+1,writerID:await vaults.writerID(),updatedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};validateBoard(next);const data=Buffer.from(JSON.stringify(next));if(data.length>64*1024*1024)fail('TOO_LARGE');
  // A matching orphan can be the result of a previous response/board-save failure.
  // Never delete it on an uncertain commit: the same fixed-ID retry reuses it.
  if(sourcePath===newSourcePath)assetDirectory=await ensureBoardGeneratedAssets(vaults,request.vaultId,request.path);
  try{await verifyAsset();}catch(error){if(error.code!=='ENOENT')throw error;try{if(assetDirectory)await assetDirectory.revalidate();await vaults.createData(request.vaultId,assetParent,assetName,image.data,{backup:false});}catch(e){if(e.code!=='EXISTS'&&e.code!=='EEXIST')throw e;}await verifyAsset();}
  const result=await vaults.commitSnapshot(request,snap,data,64*1024*1024,async()=>{if(assetDirectory)await assetDirectory.revalidate();await verifySource();await verifyAsset();});
  let history;try{history=await vaults.boardHistory.recordTransition(request,snap.data,data);}catch{history={canUndo:false,canRedo:false,warning:'Saved visual excerpt; local undo history is unavailable.'};}
  return{path:request.path,name:path.posix.basename(request.path),kind:'board',board:next,...result,selectedIDs:[id],history,reused:false};
 });
}
module.exports={createPDFVisualExcerpt,sameReference};

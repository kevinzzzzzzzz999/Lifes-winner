'use strict';
const {fail}=require('./errors.cjs');
const {validateBoard}=require('./board-validation.cjs');
const cache=new WeakMap();
function previewInkLocation(board){
 const strokes=board.webInk?.strokes||[],world=board.canvasWidth;
 for(let i=strokes.length-1;i>=0;i--){const s=strokes[i];if(s.opacity<=0||!s.points.length)continue;let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;for(const p of s.points){x=Math.min(x,p[0]-p[2]/2);y=Math.min(y,p[1]-p[2]/2);right=Math.max(right,p[0]+p[2]/2);bottom=Math.max(bottom,p[1]+p[2]/2);}x=Math.max(0,x);y=Math.max(0,y);right=Math.min(world,right);bottom=Math.min(world,bottom);if(right<=x||bottom<=y)continue;const width=Math.max(1,right-x),height=Math.max(1,bottom-y);return{x:Math.min(world-width,x),y:Math.min(world-height,y),width,height};}
 return null;
}
async function getLastInkLocation(vaults,request){
 const {relativePath}=require('./vault-path.cjs');relativePath(request.path);
 if(!request.path.toLowerCase().endsWith('.inkspace.json')||request.path.split('/').some(p=>p.toLowerCase()==='.inkspace-reviews'))fail('PATH_DENIED');
 if(!/^[a-f0-9]{64}$/.test(request.expectedSHA256||''))fail('INVALID_REQUEST');
 const snap=await vaults.snapshotForRead(request,64*1024*1024);if(snap.sha256!==request.expectedSHA256)fail('CONFLICT');
 let board;try{board=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(snap.data));}catch{fail('INVALID_BOARD');}validateBoard(board);
 let result;if(board.lastInkLocation)result={location:board.lastInkLocation,source:'saved'};
 else if(board.drawing!=null||board.items.some(item=>item.kind==='inkGroup'&&item.inkData!=null)){
  if(!vaults.nativeInkBridge)result={location:null,source:'unavailable'};
  else{let memo=cache.get(vaults);if(!memo){memo=new Map();cache.set(vaults,memo);}const key=JSON.stringify([request.vaultId,request.path,snap.sha256]);result=memo.get(key);
   if(!result){const value=await vaults.nativeInkBridge.apply({board,operation:{type:'lastInkLocation'}});const location=value.lastInkLocation??null;validateBoard({...board,lastInkLocation:location});result={location,source:location?'native':'none'};if(memo.size>=32)memo.delete(memo.keys().next().value);memo.set(key,result);}
  }
 }else{const location=previewInkLocation(board);result={location,source:location?'preview':'none'};}
 // Do not navigate from a superseded cloud version after a native helper await.
 const current=await vaults.snapshotForRead(request,64*1024*1024);if(current.sha256!==snap.sha256)fail('CONFLICT');
 return{...result,boardID:board.id,sha256:snap.sha256};
}
module.exports={getLastInkLocation,previewInkLocation};

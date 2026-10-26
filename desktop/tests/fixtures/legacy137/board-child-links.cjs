'use strict';
// Child portals contain only references and parent-space presentation. The child
// document is always loaded and saved through its own path and content digest.
const {isDeepStrictEqual}=require('node:util');
const {fail}=require('./errors.cjs');
const {relativePath}=require('./vault-path.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BOARD=64*1024*1024,MAX_GRAPH_BOARDS=128,MAX_GRAPH_BYTES=128*1024*1024,MAX_GRAPH_DEPTH=32;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const key=value=>value.toLowerCase();
function validatePresentation(value,world){
 if(!object(value)||typeof value.expanded!=='boolean'||!['x','y','width','height'].every(k=>Number.isFinite(value[k]))||value.x<0||value.y<0||value.width<=0||value.height<=0||value.x+value.width>world||value.y+value.height>world)fail('INVALID_BOARD');
 // A clipped giant portal can have a canonical full-region center outside the
 // child canvas even while its visible child center is inside the canvas.
 if(value.viewport!=null){const p=value.viewport;if(!object(p)||![p.x,p.y,p.zoom].every(Number.isFinite)||Math.abs(p.x)>1e12||Math.abs(p.y)>1e12||p.zoom<=0)fail('INVALID_BOARD');}
 return value;
}
function validateLink(link,world){
 if(!object(link)||typeof link.id!=='string'||!UUID.test(link.id)||typeof link.title!=='string'||link.title.length>1000||link.title.includes('\0'))fail('INVALID_BOARD');
 try{relativePath(link.path);}catch{fail('INVALID_BOARD');}
 if(!link.path.toLowerCase().endsWith('.inkspace.json')||link.path.split('/').some(part=>part.startsWith('.')))fail('INVALID_BOARD');
 if(link.presentation!=null)validatePresentation(link.presentation,world);
 return link;
}
function preserved(old,value,fields){
 if(!object(value))fail('INVALID_REQUEST');
 for(const field of Object.keys(value))if(!fields.includes(field)&&(!old||!isDeepStrictEqual(value[field],old[field])))fail('INVALID_REQUEST');
 const result={...old};for(const field of fields)if(Object.hasOwn(value,field))result[field]=value[field];return result;
}
function mergePresentation(old,value,world){
 const next=preserved(old,value,['expanded','x','y','width','height','viewport']);
 if(value.viewport!=null)next.viewport=preserved(old?.viewport,value.viewport,['x','y','zoom']);
 validatePresentation(next,world);return next;
}
function mergeLink(old,value,world){
 const next=preserved(old,value,['id','path','title','presentation']);
 if(value.presentation!=null)next.presentation=mergePresentation(old?.presentation,value.presentation,world);
 validateLink(next,world);return next;
}
function translatePresentations(before,after){
 const prior=new Map(before.items.map(item=>[key(item.id),item]));
 return {...after,items:after.items.map(item=>{
  const old=prior.get(key(item.id));if(!old||!item.childBoards?.length)return item;
  const dx=item.x-old.x,dy=item.y-old.y;if(!dx&&!dy)return item;
  return {...item,childBoards:item.childBoards.map(link=>link.presentation?{...link,presentation:{...link.presentation,x:link.presentation.x+dx,y:link.presentation.y+dy}}:link)};
 })};
}
function placeChildCard(board,x,y){
 const width=360,height=120,gap=48;
 if(![x,y].every(Number.isFinite))fail('INVALID_REQUEST');
 if(x<0||y<0||x+width>board.canvasWidth||y+height>board.canvasHeight)fail('BOARD_SPACE_INSUFFICIENT');
 const occupied=board.items.flatMap(item=>[item,...(item.childBoards||[]).flatMap(link=>link.presentation?.expanded?[link.presentation]:[])]);
 // Scan the requested column in canvas order. Passing a blocker only moves the
 // new card downward, so earlier rectangles never need another collision pass.
 const blockers=occupied.filter(rect=>x<rect.x+rect.width+gap&&x+width+gap>rect.x).sort((a,b)=>a.y-b.y);
 for(const rect of blockers){
  if(y+height+gap<=rect.y)break;
  if(y<rect.y+rect.height+gap)y=rect.y+rect.height+gap;
  if(y+height>board.canvasHeight)fail('BOARD_SPACE_INSUFFICIENT');
 }
 return{x,y,width,height};
}
function parseBoard(data){
 let board;try{board=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data),(_key,value)=>{if(typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value))fail('INVALID_BOARD');return value;});}catch{fail('INVALID_BOARD');}
 require('./board-validation.cjs').validateBoard(board);return board;
}
const links=board=>board.items.flatMap(item=>(item.childBoards||[]).map(link=>({itemID:item.id,link})));
const edgeKey=({itemID,link})=>key(itemID)+'\0'+key(link.id)+'\0'+link.path;
async function checkChangedChildLinks(vaults,request,before,after){
 const oldEdges=new Set(links(before).map(edgeKey)),added=links(after).filter(edge=>!oldEdges.has(edgeKey(edge)));
 if(!added.length)return [];
 const checks=new Map(),cache=new Map(),complete=new Set();let totalBytes=0;
 async function visit(link,ancestors,depth){
  if(depth>MAX_GRAPH_DEPTH)fail('CHILD_BOARD_LIMIT');
  validateLink(link,8000000);
  const childID=key(link.id);
  if(childID===key(after.id)||link.path===request.path||ancestors.has(childID))fail('CHILD_BOARD_CYCLE');
  let child=cache.get(link.path);
  if(!child){
   if(cache.size>=MAX_GRAPH_BOARDS)fail('CHILD_BOARD_LIMIT');
   const snap=await vaults.snapshot({vaultId:request.vaultId,path:link.path},MAX_BOARD);
   totalBytes+=snap.data.length;if(totalBytes>MAX_GRAPH_BYTES)fail('CHILD_BOARD_LIMIT');
   child=parseBoard(snap.data);cache.set(link.path,child);checks.set(link.path,{path:link.path,sha256:snap.sha256});
  }
  if(key(child.id)!==childID)fail('CONFLICT');
  if(complete.has(link.path))return;
  const nextAncestors=new Set(ancestors);nextAncestors.add(childID);
  for(const edge of links(child))await visit(edge.link,nextAncestors,depth+1);
  complete.add(link.path);
 }
 for(const edge of added)await visit(edge.link,new Set([key(after.id)]),1);
 return [...checks.values()];
}
module.exports={validatePresentation,validateLink,mergePresentation,mergeLink,translatePresentations,placeChildCard,checkChangedChildLinks};

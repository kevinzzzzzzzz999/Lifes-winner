'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const {isDeepStrictEqual}=require('node:util');
const {fail}=require('./errors.cjs');
const {applyElements}=require('./board-elements.cjs');
const {validateBoard,validateWebInk}=require('./board-validation.cjs');
const MAX_OPERATED=2000,MAX_PDF_BYTES=128*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const geom=['x','y','width','height'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const key=id=>id.toLowerCase();
function fields(v,names){if(!object(v)||Object.keys(v).some(k=>!names.includes(k)))fail('INVALID_REQUEST');}
function id(v){if(typeof v!=='string'||!UUID.test(v))fail('INVALID_REQUEST');return key(v);}
function ids(values){if(!Array.isArray(values)||!values.length||values.length>MAX_OPERATED)fail('INVALID_REQUEST');const keys=values.map(id);if(new Set(keys).size!==keys.length)fail('INVALID_REQUEST');return new Set(keys);}
function selected(board,values){ids(values);const byID=new Map(board.items.map(i=>[key(i.id),i]));const items=values.map(value=>byID.get(key(value)));if(items.some(i=>!i))fail('INVALID_REQUEST');return items;}
function hasInk(board){return board.drawing!=null||board.items.some(i=>i.kind==='inkGroup'&&i.inkData!=null)||(board.webInk?.strokes?.length||0)>0;}
function revised(board,writerID){if(!Number.isSafeInteger(board.revision+1))fail('INVALID_BOARD');return {...board,revision:board.revision+1,writerID,updatedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};}
function geometryChanged(before,after){const prior=new Map(before.items.map(i=>[key(i.id),i]));return after.items.filter(i=>{const old=prior.get(key(i.id));return old&&geom.some(k=>i[k]!==old[k]);}).map(i=>({id:i.id,x:i.x,y:i.y,width:i.width,height:i.height}));}
function normalizePatch(board,patches){if(!Array.isArray(patches)||!patches.length||patches.length>MAX_OPERATED)fail('INVALID_REQUEST');const found=selected(board,patches.map(p=>p?.id)),byID=new Map(found.map(i=>[key(i.id),i]));for(const patch of patches){fields(patch,['id',...geom,'title','style','text','url','textFormat']);const current=byID.get(key(patch.id));if(['text','url','textFormat'].some(k=>Object.hasOwn(patch,k))&&(current.kind!=='text'||current.textFormat!=='web'||patch.textFormat!=null&&patch.textFormat!=='web'))fail('PERMISSION_DENIED');id(patch.id);if(Object.keys(patch).length<2)fail('INVALID_REQUEST');for(const k of geom)if(Object.hasOwn(patch,k)&&!Number.isFinite(patch[k]))fail('INVALID_REQUEST');if(Object.hasOwn(patch,'title')&&typeof patch.title!=='string')fail('INVALID_REQUEST');byID.set(key(patch.id),{...byID.get(key(patch.id)),...patch,id:byID.get(key(patch.id)).id});}return board.items.map(i=>byID.get(key(i.id))||i);}
function rect(v,world){fields(v,geom);if(!geom.every(k=>Number.isFinite(v[k]))||v.width<=0||v.height<=0||v.x<0||v.y<0||v.x+v.width>world||v.y+v.height>world)fail('INVALID_REQUEST');return v;}
function contains(a,b){return a.x<=b.x&&a.y<=b.y&&a.x+a.width>=b.x+b.width&&a.y+a.height>=b.y+b.height;}
function mergeNative(board,next,result,operation){
 if(!object(result)||Object.keys(result).some(k=>!['drawing','webInk','itemUpdates','newItems','removedIDs','selectedIDs','warning','lastInkLocation'].includes(k)))fail('INK_TRANSFORM_FAILED');
 const existing=new Map(next.items.map(i=>[key(i.id),i]));
 const allowedUpdates=new Set((operation.items||[]).map(i=>key(i.id)));
 if(operation.ids)for(const value of operation.ids)allowedUpdates.add(key(value));
 const updates=result.itemUpdates||[],newItems=result.newItems||[],removed=result.removedIDs||[];
 if(!Array.isArray(updates)||!Array.isArray(newItems)||!Array.isArray(removed)||updates.length>MAX_OPERATED||newItems.length>MAX_OPERATED||removed.length>MAX_OPERATED)fail('INK_TRANSFORM_FAILED');
 const seenUpdates=new Set();
 for(const update of updates){if(!object(update)||!UUID.test(update.id||'')||seenUpdates.has(key(update.id))||Object.keys(update).some(k=>!['id',...geom,'inkData'].includes(k)))fail('INK_TRANSFORM_FAILED');seenUpdates.add(key(update.id));const old=existing.get(key(update.id));if(!old||!allowedUpdates.has(key(update.id)))fail('INK_TRANSFORM_FAILED');for(const k of geom)if(Object.hasOwn(update,k)&&update[k]!==old[k])fail('INK_TRANSFORM_FAILED');if(Object.hasOwn(update,'inkData')&&old.kind!=='inkGroup')fail('INK_TRANSFORM_FAILED');existing.set(key(old.id),{...old,...update,id:old.id});}
 const removedIDs=new Set(removed.map(value=>id(value)));if(removedIDs.size!==removed.length)fail('INK_TRANSFORM_FAILED');
 for(const value of removedIDs){const old=existing.get(value);if(!old||old.kind!=='inkGroup'||!(operation.type==='unpackInk'&&allowedUpdates.has(value)||operation.type==='frameInk'&&contains(operation.rect,old)))fail('INK_TRANSFORM_FAILED');existing.delete(value);}
 for(const item of newItems){if(operation.type!=='frameInk'||!object(item)||item.kind!=='inkGroup'||!UUID.test(item.id||'')||existing.has(key(item.id))||typeof item.inkData!=='string'||Object.keys(item).some(k=>!['id','kind',...geom,'title','text','inkData','style'].includes(k)))fail('INK_TRANSFORM_FAILED');existing.set(key(item.id),item);}
 const output={...next,items:[...next.items.filter(i=>!removedIDs.has(key(i.id))).map(i=>existing.get(key(i.id))),...newItems]};
 if(Object.hasOwn(result,'drawing')){if(typeof result.drawing!=='string'&&result.drawing!==null)fail('INK_TRANSFORM_FAILED');output.drawing=result.drawing;}
 if(Object.hasOwn(result,'webInk')){validateWebInk(result.webInk);output.webInk={...(board.webInk||{}),...result.webInk};}
 if(Object.hasOwn(result,'lastInkLocation')){if(result.lastInkLocation==null)delete output.lastInkLocation;else output.lastInkLocation=result.lastInkLocation;}else delete output.lastInkLocation;
 if(result.selectedIDs!=null&&(!Array.isArray(result.selectedIDs)||result.selectedIDs.length>MAX_OPERATED||result.selectedIDs.some(value=>typeof value!=='string'||!output.items.some(i=>key(i.id)===key(value)))))fail('INK_TRANSFORM_FAILED');
 // The derived preview is no longer the last PDF-exported version. Preserve the
 // declarations but mark their digest pending, so readers do not hide new ink.
 delete output.previewPNG;
 if(output.pdfAnnotationSources)output.pdfAnnotationSources=output.pdfAnnotationSources.map(source=>({...source,sha256:'0'.repeat(64)}));
 validateBoard(output);return {board:output,selectedIDs:result.selectedIDs||[]};
}
async function native(vaults,board,next,operation){
 if(!vaults.nativeInkBridge)fail('INK_RUNTIME_UNAVAILABLE');
 let result;try{result=await vaults.nativeInkBridge.apply({board,operation});}catch(error){if(['INK_CROSSES_BOUNDARY','COLLAPSE_HAS_CONTENT','INK_RUNTIME_UNAVAILABLE','INK_TRANSFORM_FAILED','NO_INK_SELECTED','BUSY','CANCELLED','TOO_LARGE'].includes(error?.code))fail(error.code);fail('INK_TRANSFORM_FAILED');}
 return mergeNative(board,next,result,operation);
}
async function transformElements(vaults,board,next){next=require('./board-child-links.cjs').translatePresentations(board,next);validateBoard(next);const kinds=new Map(board.items.map(item=>[key(item.id),item.kind]));const changed=geometryChanged(board,next).filter(item=>['pdfPage','inkGroup'].includes(kinds.get(key(item.id))));if(!changed.length||!hasInk(board))return next;return (await native(vaults,board,next,{type:'patchItems',items:changed})).board;}
function pageLayout(sizes,{x,y,direction,scale,columns=4},world){
 if(!sizes.length||sizes.length>2000||!['vertical','horizontal','grid'].includes(direction)||!Number.isFinite(scale)||scale<0.25||scale>2||!Number.isInteger(columns)||columns<1||columns>24||![x,y].every(Number.isFinite))fail('INVALID_REQUEST');
 const width=720*scale,gap=48,layout=[];let cx=x,cy=y,rowHeight=0;
 for(let index=0;index<sizes.length;index++){const size=sizes[index];if(!size||!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.height<=0)fail('INVALID_BOARD');const height=width*size.height/size.width;if(!Number.isFinite(height)||x<0||y<0||cx+width>world||cy+height>world)fail('BOARD_SPACE_INSUFFICIENT');layout.push({x:cx,y:cy,width,height});if(direction==='vertical')cy+=height+gap;else if(direction==='horizontal')cx+=width+gap;else{rowHeight=Math.max(rowHeight,height);if((index+1)%columns===0){cx=x;cy+=rowHeight+gap;rowHeight=0;}else cx+=width+gap;}}
 return layout;
}
async function pdfSizes(data){
 let pdf;try{pdf=await require('pdf-lib').PDFDocument.load(data,{updateMetadata:false,throwOnInvalidObject:true});}catch{fail('UNSUPPORTED');}
 if(pdf.isEncrypted)fail('UNSUPPORTED');if(pdf.getPageCount()<1||pdf.getPageCount()>2000)fail('TOO_LARGE');
 return pdf.getPages().map(page=>{const box=page.getCropBox(),rotation=((page.getRotation().angle%360)+360)%360;if(![0,90,180,270].includes(rotation))fail('UNSUPPORTED');return rotation===90||rotation===270?{width:box.height,height:box.width}:{width:box.width,height:box.height};});
}
async function operation(vaults,request,board,writerID,publications=[]){
 const op=request.operation;if(!object(op)||typeof op.type!=='string')fail('INVALID_REQUEST');let next=revised(board,writerID),selection=[],sourceChecks=[],warnings=[],revalidate;
 switch(op.type){
 case 'relinkSource':return require('./board-relink.cjs').apply(vaults,request,board,next);
 case 'remove':{
  fields(op,['type','ids']);const initial=selected(board,op.ids),removed=new Set(initial.map(i=>key(i.id))),cards=new Set(initial.filter(i=>i.kind==='document').map(i=>key(i.id)));
  for(const item of board.items)if(item.sourceCardID&&cards.has(key(item.sourceCardID))){if(item.kind!=='pdfPage')fail('INVALID_BOARD');removed.add(key(item.id));}
  if(removed.size>20000)fail('TOO_LARGE');const targets=board.items.filter(i=>removed.has(key(i.id))),pages=targets.filter(i=>i.kind==='pdfPage');
  if(pages.length&&hasInk(board)){if(!vaults.nativeInkBridge)fail('INK_RUNTIME_UNAVAILABLE');try{await vaults.nativeInkBridge.apply({board,operation:{type:'collapseCheck',ids:pages.map(i=>i.id)}});}catch(error){if(['INK_RUNTIME_UNAVAILABLE','BUSY','CANCELLED','TOO_LARGE'].includes(error?.code))fail(error.code);throw Object.assign(Error('Frame or move the handwriting away before removing this page.'),{code:'REMOVE_PAGE_HAS_INK'});}}
  next.edges=board.edges.filter(e=>!removed.has(key(e.from))&&!removed.has(key(e.to)));
  const groups=targets.filter(i=>i.kind==='inkGroup');if(groups.length){if(groups.length>MAX_OPERATED)fail('TOO_LARGE');next=(await native(vaults,board,next,{type:'unpackInk',ids:groups.map(i=>i.id)})).board;}
  next.items=next.items.filter(i=>!removed.has(key(i.id)));selection=[];break;
 }
 case 'setChildBoards':{
  fields(op,['type','id','links']);const item=selected(board,[op.id])[0];if(!Array.isArray(op.links)||op.links.length>100)fail('INVALID_REQUEST');const childIDs=new Set(),links=[];
  for(const link of op.links){const childID=id(link?.id);if(childIDs.has(childID))fail('INVALID_REQUEST');childIDs.add(childID);const old=(item.childBoards||[]).find(child=>key(child.id)===childID);links.push(require('./board-child-links.cjs').mergeLink(old,link,board.canvasWidth));}
  next.items=board.items.map(old=>key(old.id)===key(item.id)?{...old,childBoards:links}:old);selection=[item.id];break;
 }
 case 'addChildBoardCard':{
  fields(op,['type','link','x','y']);if(![op.x,op.y].every(Number.isFinite))fail('INVALID_REQUEST');
  const children=require('./board-child-links.cjs'),link=children.mergeLink(null,op.link,board.canvasWidth),card={id:crypto.randomUUID(),kind:'document',title:link.title,...children.placeChildCard(board,op.x,op.y),childBoards:[link]};
  next.items=[...board.items,card];selection=[card.id];break;
 }
 case 'setChildBoardPresentations':{
  fields(op,['type','updates']);if(!Array.isArray(op.updates)||!op.updates.length||op.updates.length>MAX_OPERATED)fail('INVALID_REQUEST');
  const items=new Map(board.items.map(item=>[key(item.id),item])),seen=new Set();
  for(const update of op.updates){fields(update,['id','childID','presentation']);const itemID=id(update.id),childID=id(update.childID),pair=itemID+':'+childID,item=items.get(itemID);if(seen.has(pair)||!item||!(item.childBoards||[]).some(link=>key(link.id)===childID))fail('INVALID_REQUEST');seen.add(pair);
   items.set(itemID,{...item,childBoards:item.childBoards.map(link=>key(link.id)===childID?{...link,presentation:require('./board-child-links.cjs').mergePresentation(link.presentation,update.presentation,board.canvasWidth)}:link)});
  }
  next.items=board.items.map(item=>items.get(key(item.id)));selection=[...new Set(op.updates.map(update=>items.get(key(update.id)).id))];break;
 }
 case 'move':{fields(op,['type','ids','dx','dy']);const items=selected(board,op.ids);if(!Number.isFinite(op.dx)||!Number.isFinite(op.dy))fail('INVALID_REQUEST');next.items=normalizePatch(board,items.map(i=>({id:i.id,x:i.x+op.dx,y:i.y+op.dy})));validateBoard(next);next=await transformElements(vaults,board,next);selection=items.map(i=>i.id);break;}
 case 'patchItems':{fields(op,['type','items']);const items=normalizePatch(board,op.items);next=applyElements(board,items,board.edges,writerID,{manageProtected:true});next=await transformElements(vaults,board,next);selection=op.items.map(i=>i.id);break;}
 case 'frameInk':{fields(op,['type','rect','title']);rect(op.rect,board.canvasWidth);if(op.title!=null&&(typeof op.title!=='string'||op.title.length>1000||op.title.includes('\0')))fail('INVALID_REQUEST');const value=await native(vaults,board,next,op);next=value.board;selection=value.selectedIDs;break;}
 case 'unpackInk':{fields(op,['type','ids']);const items=selected(board,op.ids);if(items.some(i=>i.kind!=='inkGroup'))fail('INVALID_REQUEST');if(board.edges.some(e=>op.ids.some(value=>key(e.from)===key(value)||key(e.to)===key(value))))fail('COLLAPSE_HAS_CONTENT');const value=await native(vaults,board,next,{...op,ids:items.map(i=>i.id)});next=value.board;selection=value.selectedIDs;break;}
 case 'connect':{fields(op,['type','ids']);const items=selected(board,op.ids);if(items.length<2)fail('INVALID_REQUEST');const start=items[0],links=new Set(board.edges.map(e=>key(e.from)+':'+key(e.to)));next.edges=[...board.edges];for(const item of items.slice(1)){const pair=key(start.id)+':'+key(item.id);if(!links.has(pair)){next.edges.push({id:crypto.randomUUID(),from:start.id,to:item.id});links.add(pair);}}selection=items.map(i=>i.id);break;}
 case 'expandDocument':{
  fields(op,['type','id','direction','scale','x','y','columns']);const card=selected(board,[op.id])[0];if(card.kind!=='document'||typeof card.sourcePath!=='string')fail('PDF_REQUIRED');
  require('./vault-service.cjs').relativePath(card.sourcePath);if(card.sourcePath.split('/').some(s=>s.toLowerCase()==='.inkspace-reviews'))fail('PATH_DENIED');
  const excel=['.xls','.xlsx','.xlsm'].includes(path.posix.extname(card.sourcePath).toLowerCase());if(!excel&&!card.sourcePath.toLowerCase().endsWith('.pdf'))fail('PDF_REQUIRED');
  if(excel&&op.direction==='onenote')fail('PDF_REQUIRED');
  const located=await require('./board-source-resolver.cjs').resolveSourceInBoard(vaults,{vaultId:request.vaultId,boardPath:request.path,expectedBoardSHA256:request.expectedSHA256,sourcePath:card.sourcePath},board),sourceRequest={vaultId:request.vaultId,path:located.path};
  const original=await (op.direction==='onenote'?require('./onenote-publication.cjs').oneNoteSnapshot(vaults,sourceRequest,MAX_PDF_BYTES):vaults.snapshot(sourceRequest,excel?16*1024*1024:MAX_PDF_BYTES));let sourcePath=card.sourcePath,originalPath=card.originalSourcePath,originalSHA=card.originalSourceSHA256;
  if(op.direction==='onenote'){
   const columns=op.columns??2,scale=op.scale??1;
   if(!Number.isInteger(columns)||columns<1||columns>8||!Number.isFinite(scale)||scale<0.25||scale>2||[op.x,op.y].some(value=>value!=null&&(!Number.isFinite(value)||value<0)))fail('INVALID_REQUEST');
   const publisher=require('./onenote-publication.cjs'),location=publisher.oneNotePublicationLocation(sourceRequest,original.sha256,{columns});
   const attached=board.items.filter(item=>item.sourceCardID&&key(item.sourceCardID)===key(card.id));
   const current=attached.filter(item=>item.kind==='pdfPage'&&item.sourcePath===location.path);
   if(current.length>1||current.some(item=>item.page!==1||item.originalSourceSHA256!==original.sha256))fail('CONFLICT');
   if(current.length){
    // Native PDF writeback legitimately changes this referenced derivative.
    // Select it as-is, never regenerate it over newer annotations or geometry.
    const derived=await publisher.oneNoteSnapshot(vaults,{vaultId:request.vaultId,path:location.path},MAX_PDF_BYTES);
    if((await pdfSizes(derived.data)).length!==1)fail('UNSUPPORTED');
    await publisher.verifyOneNoteSources(vaults,request.vaultId,[{path:located.path,sha256:original.sha256},{path:location.path,sha256:derived.sha256}]);
    if((await vaults.snapshot(request,64*1024*1024)).sha256!==request.expectedSHA256)fail('CONFLICT');
    selection=current.map(item=>item.id);warnings=['已选中已有连续阅读版；批注、位置和尺寸均保持不变。'];
   }else{
    const published=await publisher.publishOneNotePDF(vaults,sourceRequest,original,{columns},publications);
    const derived=await publisher.oneNoteSnapshot(vaults,{vaultId:request.vaultId,path:published.path},MAX_PDF_BYTES);
    if(derived.sha256!==published.sha256)fail('CONFLICT');
    const sizes=await pdfSizes(derived.data);if(sizes.length!==1)fail('UNSUPPORTED');
    const x=op.x??card.x,y=op.y??Math.max(card.y+card.height,...attached.map(item=>item.y+item.height))+48;
    const width=720*scale*columns,height=width*sizes[0].height/sizes[0].width;
    if(![x,y,width,height].every(Number.isFinite)||x<0||y<0||width<=0||height<=0||x+width>board.canvasWidth||y+height>board.canvasHeight)fail('BOARD_SPACE_INSUFFICIENT');
    const page={id:crypto.randomUUID(),kind:'pdfPage',title:path.posix.basename(card.sourcePath)+' · 连续原稿',sourcePath:published.path,sourceCardID:card.id,page:1,x,y,width,height,originalSourcePath:located.path,originalSourceSHA256:original.sha256};
    next.items=[...board.items,page];selection=[page.id];warnings=['已生成独立连续阅读版；原 PDF 与已有页面仍然保留，请核对打印接缝。'];
    const checks=[{path:located.path,sha256:original.sha256},{path:published.path,sha256:published.sha256},{path:published.reportPath,sha256:published.reportSHA256,maximum:publisher.MAX_REPORT}];
    revalidate=()=>publisher.verifyOneNoteSources(vaults,request.vaultId,checks);
   }
   break;
  }
  if(excel){const prepared=await vaults.excel.prepare(sourceRequest,original);sourcePath=await vaults.excel.publish(sourceRequest,prepared,publications);originalPath=card.sourcePath;originalSHA=original.sha256;warnings=prepared.warnings;}
  const source=sourcePath===card.sourcePath?original:await vaults.snapshot({vaultId:request.vaultId,path:sourcePath},MAX_PDF_BYTES),sizes=await pdfSizes(source.data);
  const attached=board.items.filter(i=>i.sourceCardID&&key(i.sourceCardID)===key(card.id));if(attached.some(i=>i.kind!=='pdfPage'))fail('CONFLICT');
  const existing=excel?attached.filter(i=>i.sourcePath===sourcePath):attached;if(existing.some(i=>i.sourcePath!==sourcePath)||existing.length&&existing.length!==sizes.length)fail('CONFLICT');
  const byPage=new Map(existing.map(i=>[i.page,i]));if(byPage.size!==existing.length||existing.some(i=>i.page<1||i.page>sizes.length))fail('INVALID_BOARD');
  // A changed workbook gets a separate reading revision. Older handwritten pages
  // stay intact; never align old ink with new/reflowed cell contents by guessing.
  const defaultY=excel&&!existing.length&&attached.length?Math.max(card.y+card.height,...attached.map(i=>i.y+i.height))+48:card.y+card.height+48;
  const places=pageLayout(sizes,{x:op.x??card.x,y:op.y??defaultY,direction:op.direction,scale:op.scale,columns:op.columns??4},board.canvasWidth);
  const pages=places.map((place,index)=>{const old=byPage.get(index+1);return old?{...old,...place}:{id:crypto.randomUUID(),kind:'pdfPage',title:path.posix.basename(card.sourcePath),sourcePath,sourceCardID:card.id,page:index+1,...place,...(originalPath!=null?{originalSourcePath:originalPath,originalSourceSHA256:originalSHA}: {})};});
  const updates=new Map(pages.map(i=>[key(i.id),i]));next.items=existing.length?board.items.map(i=>updates.get(key(i.id))||i):[...board.items,...pages];validateBoard(next);next=await transformElements(vaults,board,next);selection=pages.map(i=>i.id);sourceChecks=[{path:located.path,sha256:original.sha256}];if(excel)sourceChecks.push({path:sourcePath,sha256:source.sha256});break;
 }
 case 'collapseDocument':{
  fields(op,['type','id']);const card=selected(board,[op.id])[0];if(card.kind!=='document')fail('INVALID_REQUEST');const pages=board.items.filter(i=>i.sourceCardID&&key(i.sourceCardID)===key(card.id));if(pages.some(i=>i.kind!=='pdfPage'))fail('INVALID_BOARD');const removed=new Set(pages.map(i=>key(i.id)));if(board.edges.some(e=>removed.has(key(e.from))||removed.has(key(e.to))))fail('COLLAPSE_HAS_CONTENT');
  if(pages.length&&hasInk(board)){if(!vaults.nativeInkBridge)fail('INK_RUNTIME_UNAVAILABLE');try{await vaults.nativeInkBridge.apply({board,operation:{type:'collapseCheck',ids:pages.map(i=>i.id)}});}catch(error){if(error?.code==='INK_RUNTIME_UNAVAILABLE')fail(error.code);fail('COLLAPSE_HAS_CONTENT');}}
  next.items=board.items.filter(i=>!removed.has(key(i.id)));selection=[card.id];break;
 }
 default: fail('INVALID_REQUEST');
 }
 validateBoard(next);const contentBefore={...board,revision:0,writerID:'',updatedAt:''},contentAfter={...next,revision:0,writerID:'',updatedAt:''};
 return {board:next,selectedIDs:selection,sourceChecks,warnings,...(revalidate?{revalidate}:{}),unchanged:isDeepStrictEqual(contentBefore,contentAfter)};
}
module.exports={operation,transformElements,pageLayout,pdfSizes,geometryChanged,mergeNative};

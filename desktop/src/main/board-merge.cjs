'use strict';
// Same-vault whole-board merge. Native ink remains editable; attachments remain
// references to their original root-relative files. Publish the board last.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {fail}=require('./errors.cjs'),{relativePath}=require('./vault-path.cjs');
const {validateBoard,validateWebInk}=require('./board-validation.cjs');
const {durableWrite,digest}=require('./vault-service.cjs');
const MAX_BOARD=64*1024*1024,MAX_SIDECARS=10000,MAX_SIDECAR_BYTES=64*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/;
const key=value=>value.toLowerCase(),object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const time=()=>new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
const KNOWN=new Set(['schemaVersion','id','title','createdAt','updatedAt','revision','writerID','canvasWidth','canvasHeight','drawing','boardNotesImport','webInk','lastInkLocation','pdfAnnotationSources','pdfOwnedSourcePaths','pdfMergedOwnerIDs','pdfWritebackSuspended','previewPNG','items','edges','pins','printFrames','viewport']);
function publicBoard(value){relativePath(value);if(!value.toLowerCase().endsWith('.inkspace.json')||value.split('/').some(p=>p.startsWith('.')))fail('INVALID_REQUEST');return value;}
function request(value){
 if(!object(value)||Object.keys(value).some(k=>!['vaultId','path','expectedSHA256','sourcePath','expectedSourceSHA256','mode','newPath','direction','position'].includes(k))||typeof value.vaultId!=='string'||!value.vaultId||!SHA.test(value.expectedSHA256||'')||!SHA.test(value.expectedSourceSHA256||''))fail('INVALID_REQUEST');
 publicBoard(value.path);publicBoard(value.sourcePath);
 if(value.path===value.sourcePath)fail('INVALID_REQUEST');
 const mode=value.mode??'intoTarget',direction=value.direction??'below';
 if(!['intoTarget','newCopy'].includes(mode)||!['below','right'].includes(direction))fail('INVALID_REQUEST');
 if(value.position!==undefined&&(!object(value.position)||Object.keys(value.position).sort().join(',')!=='x,y'||!['x','y'].every(k=>Number.isFinite(value.position[k]))))fail('INVALID_REQUEST');
 if(mode==='newCopy'){publicBoard(value.newPath);if([value.path,value.sourcePath].includes(value.newPath))fail('INVALID_REQUEST');}
 else if(value.newPath!==undefined)fail('INVALID_REQUEST');
 return{...value,mode,direction};
}
function parse(data){let board;try{board=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data),(_k,v)=>{if(typeof v==='number'&&Number.isInteger(v)&&!Number.isSafeInteger(v))fail('INVALID_BOARD');return v;});}catch{fail('INVALID_BOARD');}return validateBoard(board);}
function union(a,b){if(!b)return a;if(!a)return{...b};const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return{x,y,width:Math.max(a.x+a.width,b.x+b.width)-x,height:Math.max(a.y+a.height,b.y+b.height)-y};}
function finiteRect(r){return object(r)&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0;}
function hasNative(board){return board.drawing!=null||board.items.some(i=>i.kind==='inkGroup'&&i.inkData!=null);}
function webBounds(board){let bounds=null;for(const stroke of board.webInk?.strokes||[])for(const [x,y,w]of stroke.points)bounds=union(bounds,{x:x-w/2,y:y-w/2,width:w,height:w});return bounds;}
function knownBounds(board){let bounds=webBounds(board);for(const item of board.items){bounds=union(bounds,item);for(const child of item.childBoards||[])if(child.presentation)bounds=union(bounds,child.presentation);}for(const frame of board.printFrames||[])bounds=union(bounds,frame);for(const pin of board.pins)bounds=union(bounds,{x:pin.x,y:pin.y,width:1,height:1});return bounds;}
async function nativeBounds(vaults,board){
 if(!hasNative(board))return{contentBounds:null,nativeStrokeCount:0};
 if(!vaults.nativeInkBridge?.apply)fail('INK_RUNTIME_UNAVAILABLE');
 const result=await vaults.nativeInkBridge.apply({board,operation:{kind:'mergeBounds'}});
 if(!Number.isSafeInteger(result.nativeStrokeCount)||result.nativeStrokeCount<0||result.nativeStrokeCount>50000||result.contentBounds!=null&&!finiteRect(result.contentBounds))fail('INK_TRANSFORM_FAILED');
 return result;
}
function translation(source,target,direction,position){
 const origin=position??(target?direction==='below'?{x:Math.max(512,target.x),y:target.y+target.height+96}:{x:target.x+target.width+96,y:Math.max(512,target.y)}:{x:512,y:512});
 const dx=origin.x-source.x,dy=origin.y-source.y;
 if(origin.x<0||origin.y<0||origin.x+source.width>8000000||origin.y+source.height>8000000)fail('BOARD_SPACE_INSUFFICIENT');
 return{dx,dy};
}
function translateWeb(ink,dx,dy){if(!ink)return null;return{...structuredClone(ink),strokes:ink.strokes.map(stroke=>({...structuredClone(stroke),points:stroke.points.map(p=>[p[0]+dx,p[1]+dy,p[2]]),...(stroke.clipPath?{clipPath:stroke.clipPath.map(c=>c.map((v,i)=>i===0?v:v+(i%2?dx:dy)))}:{})}))};}
function rebaseURI(uri,sourcePath,targetPath){
 if(!uri||uri.startsWith('#')||uri.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(uri))return uri;
 const split=uri.search(/[?#]/),pathname=split<0?uri:uri.slice(0,split),suffix=split<0?'':uri.slice(split);
 let decoded;try{decoded=decodeURIComponent(pathname);}catch{fail('BOARD_MERGE_UNSUPPORTED');}
 if(/[\\\x00-\x1f]/.test(decoded))fail('BOARD_MERGE_UNSUPPORTED');
 const absolute=path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath),decoded));
 if(absolute==='..'||absolute.startsWith('../')||absolute.startsWith('/'))fail('PATH_DENIED');
 const rel=path.posix.relative(path.posix.dirname(targetPath),absolute)||path.posix.basename(absolute);
 return rel.split('/').map(p=>p==='..'?'..':encodeURIComponent(p)).join('/')+suffix;
}
function rebaseItem(item,sourcePath,targetPath){
 if(sourcePath===targetPath||path.posix.dirname(sourcePath)===path.posix.dirname(targetPath))return item;
 // Root-based source fields and inkspace:// links are deliberately untouched.
 const html=value=>value.replace(/\b(href|src)(\s*=\s*)(["'])([^"']*)\3/gi,(all,name,eq,quote,uri)=>name+eq+quote+rebaseURI(uri,sourcePath,targetPath)+quote);
 if(typeof item.richTextHTML==='string')item.richTextHTML=html(item.richTextHTML);
 if(item.textFormat==='markdown'&&typeof item.text==='string'){
  // Fenced/inline code is data, never a link-editing surface.
  item.text=item.text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((part,index)=>index%2?part:html(part.replace(/(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)]+)([^\n)]*\))/g,(all,start,url,end)=>start+(url.startsWith('<')?'<'+rebaseURI(url.slice(1,-1),sourcePath,targetPath)+'>':rebaseURI(url,sourcePath,targetPath))+end).replace(/^(\s*\[[^\]\n]+\]:\s*)(\S+)/gm,(all,start,url)=>start+rebaseURI(url,sourcePath,targetPath)))).join('');
 }
 return item;
}
function idFactory(board){const used=new Set([board.id,...board.items.map(i=>i.id),...board.edges.map(e=>e.id),...board.pins.map(p=>p.id),...(board.printFrames||[]).map(f=>f.id)].map(key));return()=>{let value;do{value=crypto.randomUUID();}while(used.has(key(value)));used.add(key(value));return value;};}
function annotationSources(target,source){const seen=new Map();for(const value of [...target.pdfAnnotationSources||[],...source.pdfAnnotationSources||[]]){const old=seen.get(value.sourcePath);if(old&&old.sha256.toLowerCase()!==value.sha256.toLowerCase())fail('CONFLICT');seen.set(value.sourcePath,old?{...old,pages:[...new Set([...old.pages,...value.pages])].sort((a,b)=>a-b)}:structuredClone(value));}if(seen.size>2000)fail('TOO_LARGE');return[...seen.values()];}
function newIDMap(source,fresh){const map=new Map(source.items.map(i=>[key(i.id),fresh()]));for(const item of source.items)if(item.sourceCardID&&!map.has(key(item.sourceCardID)))map.set(key(item.sourceCardID),fresh());return map;}
async function canonicalPaths(vaults,r,board,boardPath,expectedSHA256){
 const paths=new Set();for(const item of board.items){for(const rel of [item.sourcePath,item.originalSourcePath,item.sourceReference?.path])if(rel!=null)paths.add(rel);for(const link of item.childBoards||[])paths.add(link.path);}for(const declaration of board.pdfAnnotationSources||[])paths.add(declaration.sourcePath);for(const rel of board.pdfOwnedSourcePaths||[])paths.add(rel);
 if(paths.size>10000)fail('TOO_LARGE');const map=new Map(),entries=[...paths];let index=0;
 const resolve=require('./board-source-resolver.cjs').resolveSourceInBoard;
 await Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{for(;;){const rel=entries[index++];if(rel===undefined)return;const found=await resolve(vaults,{vaultId:r.vaultId,boardPath,expectedBoardSHA256:expectedSHA256,sourcePath:rel},board);map.set(rel,found.path);}}));
 if(![...map].some(([from,to])=>from!==to))return{board,map};
 const copy={...board,items:structuredClone(board.items),pdfAnnotationSources:structuredClone(board.pdfAnnotationSources),pdfOwnedSourcePaths:structuredClone(board.pdfOwnedSourcePaths)},field=(value,name)=>{if(value[name]!=null)value[name]=map.get(value[name])||value[name];};
 for(const item of copy.items){field(item,'sourcePath');field(item,'originalSourcePath');if(item.sourceReference)field(item.sourceReference,'path');for(const link of item.childBoards||[])field(link,'path');}for(const declaration of copy.pdfAnnotationSources||[])field(declaration,'sourcePath');if(copy.pdfOwnedSourcePaths)copy.pdfOwnedSourcePaths=copy.pdfOwnedSourcePaths.map(rel=>map.get(rel)||rel);
 validateBoard(copy);return{board:copy,map};
}
async function buildMerged(vaults,r,target,source,extra={}){
 for(const name of Object.keys(source))if(!KNOWN.has(name)&&!isDeepStrictEqual(source[name],target[name]))fail('BOARD_MERGE_UNSUPPORTED');
 if(key(target.id)===key(source.id))fail('CONFLICT');
 const targetNative=await nativeBounds(vaults,target),sourceNative=await nativeBounds(vaults,source);
 const a=union(union(knownBounds(target),targetNative.contentBounds),extra.target),b=union(union(knownBounds(source),sourceNative.contentBounds),extra.source)||{x:0,y:0,width:1,height:1};
 const offset=translation(b,a,r.direction,r.position),{dx,dy}=offset,fresh=idFactory(target),map=newIDMap(source,fresh),out={...target,items:structuredClone(target.items),edges:structuredClone(target.edges),pins:structuredClone(target.pins),printFrames:structuredClone(target.printFrames),viewport:{...target.viewport}};
 out.canvasWidth=out.canvasHeight=8000000;
 const outputPath=r.mode==='newCopy'?r.newPath:r.path;
 if(r.mode==='newCopy'){out.id=fresh();out.title=path.posix.basename(outputPath).slice(0,-'.inkspace.json'.length);out.createdAt=time();out.revision=0;out.items=out.items.map(i=>rebaseItem(i,r.path,outputPath));}
 if(!Number.isSafeInteger(out.revision+1))fail('INVALID_BOARD');
 const imported=source.items.map(old=>{const item=rebaseItem(structuredClone(old),r.sourcePath,outputPath);item.id=map.get(key(old.id));item.x+=dx;item.y+=dy;if(item.sourceCardID)item.sourceCardID=map.get(key(item.sourceCardID));for(const link of item.childBoards||[])if(link.presentation){link.presentation.x+=dx;link.presentation.y+=dy;}return item;});
 out.items.push(...imported);
 out.edges.push(...source.edges.map(edge=>({...structuredClone(edge),id:fresh(),from:map.get(key(edge.from)),to:map.get(key(edge.to))})));
 out.pins.push(...source.pins.map(pin=>({...structuredClone(pin),id:fresh(),x:pin.x+dx,y:pin.y+dy})));
 if(source.printFrames?.length)out.printFrames=[...out.printFrames||[],...source.printFrames.map(frame=>({...structuredClone(frame),id:fresh(),x:frame.x+dx,y:frame.y+dy}))];
 const movedWeb=translateWeb(source.webInk,dx,dy),web={version:1,strokes:[...target.webInk?.strokes||[],...movedWeb?.strokes||[]]};validateWebInk(web);out.webInk=web;
 const webOnlyA=targetNative.nativeStrokeCount===0&&(target.webInk?.strokes.length||0)>0,webOnlyB=sourceNative.nativeStrokeCount===0&&(source.webInk?.strokes.length||0)>0;
 if((targetNative.nativeStrokeCount>0&&webOnlyB)||(sourceNative.nativeStrokeCount>0&&webOnlyA))fail('BOARD_MERGE_UNSUPPORTED');
 if(targetNative.nativeStrokeCount+sourceNative.nativeStrokeCount>0){
  if(!vaults.nativeInkBridge?.apply)fail('INK_RUNTIME_UNAVAILABLE');
  const needsPreview=(targetNative.nativeStrokeCount>0&&!target.webInk?.strokes.length)||(sourceNative.nativeStrokeCount>0&&!source.webInk?.strokes.length);
  const result=await vaults.nativeInkBridge.apply({board:{...target,canvasWidth:8000000,canvasHeight:8000000},operation:{kind:'mergeDrawing',sourceBoard:source,dx,dy,portablePreview:needsPreview}});
  if(typeof result.drawing!=='string'||result.nativeStrokeCount!==targetNative.nativeStrokeCount+sourceNative.nativeStrokeCount)fail('INK_TRANSFORM_FAILED');
  out.drawing=result.drawing;
  // Normal boards already carry a precise portable mirror. Reuse it, including
  // extra future stroke metadata; only generate a mirror when one was absent.
  if(needsPreview){validateWebInk(result.webInk);out.webInk=result.webInk;}
  out.lastInkLocation=result.lastInkLocation??null;
 }else{out.drawing=null;if(source.lastInkLocation)out.lastInkLocation={...source.lastInkLocation,x:source.lastInkLocation.x+dx,y:source.lastInkLocation.y+dy};}
 const declarations=annotationSources(target,source);if(declarations.length)out.pdfAnnotationSources=declarations;
 if(source.pdfOwnedSourcePaths!=null&&!Array.isArray(source.pdfOwnedSourcePaths)||target.pdfOwnedSourcePaths!=null&&!Array.isArray(target.pdfOwnedSourcePaths))fail('INVALID_BOARD');
 const owned=[...new Set([...target.pdfOwnedSourcePaths||[],...source.pdfOwnedSourcePaths||[]])];for(const rel of owned)relativePath(rel);
 const owners=[];for(const board of [target,source]){if(board.pdfMergedOwnerIDs!=null&&!Array.isArray(board.pdfMergedOwnerIDs))fail('INVALID_BOARD');for(const owner of [board.id,...board.pdfMergedOwnerIDs||[]]){if(typeof owner!=='string'||!UUID.test(owner))fail('INVALID_BOARD');if(!owners.includes(key(owner)))owners.push(key(owner));}}if(owners.length>128)fail('TOO_LARGE');out.pdfMergedOwnerIDs=owners;
 if(owned.length||target.pdfWritebackSuspended||source.pdfWritebackSuspended||declarations.length){out.pdfOwnedSourcePaths=owned;out.pdfWritebackSuspended=true;}
 if(source.boardNotesImport&&!out.boardNotesImport)out.boardNotesImport=structuredClone(source.boardNotesImport);
 out.previewPNG=null;out.revision++;out.writerID=await vaults.writerID();out.updatedAt=time();validateBoard(out);
 const focusRect={x:b.x+dx,y:b.y+dy,width:b.width,height:b.height};
 return{board:out,map,fresh,translation:offset,sourceBounds:b,targetBounds:a,outputBounds:union(a,focusRect),focusRect,counts:{items:source.items.length,edges:source.edges.length,pins:source.pins.length,printFrames:source.printFrames?.length||0,nativeStrokes:sourceNative.nativeStrokeCount,webStrokes:source.webInk?.strokes.length||0,tapes:0,reviews:0,studyEvents:0}};
}
async function optionalSnapshot(vaults,vaultId,rel,maximum){try{return await vaults.snapshot({vaultId,path:rel},maximum);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function directoryState(vaults,vaultId,rel){try{const dir=await vaults.resolve(vaultId,rel,{directory:true}),names=(await fs.readdir(dir.full)).sort();if(names.length>MAX_SIDECARS)fail('TOO_LARGE');return{path:rel,full:dir.full,dev:dir.stat.dev,ino:dir.stat.ino,names};}catch(error){if(error.code==='ENOENT')return{path:rel,absent:true};throw error;}}
function tapePath(id){return'.inkspace/writing-aids/'+key(id)+'.json';}
function validateTape(value,boardID){
 if(!object(value)||value.version!==1||key(value.boardID||'')!==key(boardID)||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.tapes)||value.tapes.length>500)fail('BOARD_MERGE_SIDECARS');
 const ids=new Set();let points=0;
 for(const tape of value.tapes){if(!object(tape)||!UUID.test(tape.id||'')||ids.has(key(tape.id))||tape.anchorItemID!=null||!Array.isArray(tape.points)||!tape.points.length||tape.points.length>4096||!Number.isFinite(tape.width)||tape.width<=0||tape.width>4096||!object(tape.color)||!['red','green','blue','alpha'].every(k=>Number.isFinite(tape.color[k])&&tape.color[k]>=0&&tape.color[k]<=1)||typeof tape.isRevealed!=='boolean')fail('BOARD_MERGE_SIDECARS');ids.add(key(tape.id));points+=tape.points.length;for(const p of tape.points)if(!object(p)||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<tape.width/2||p.y<tape.width/2||p.x+tape.width/2>8000000||p.y+tape.width/2>8000000)fail('BOARD_MERGE_SIDECARS');}
 if(points>200000)fail('TOO_LARGE');return value;
}
function json(data,code='BOARD_MERGE_SIDECARS'){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{fail(code);}}
async function layoutExtras(vaults,r,target,source){
 const extra={},reads=[],directories=[],counts={tapes:0,reviews:0},read=async(rel,max)=>{const snap=await optionalSnapshot(vaults,r.vaultId,rel,max);reads.push({path:rel,snapshot:snap,maximum:max});return snap;};
 for(const [board,label]of [[source,'source'],[target,'target']]){const snap=await read(tapePath(board.id),4*1024*1024);if(snap){const value=validateTape(json(snap.data),board.id);if(label==='source')counts.tapes=value.tapes.length;for(const tape of value.tapes)for(const point of tape.points)extra[label]=union(extra[label],{x:point.x-tape.width/2,y:point.y-tape.width/2,width:tape.width,height:tape.width});}}
 const state=await directoryState(vaults,r.vaultId,'.inkspace-reviews');directories.push(state);
 if(!state.absent){const{validateReview,validateDeleted}=require('./review-service.cjs'),hidden=new Set();let bytes=0;
  for(const name of state.names){const match=/^([a-f0-9-]{36})\.deleted\.json$/i.exec(name);if(match){const snap=await read(state.path+'/'+name,128*1024);validateDeleted(json(snap.data),match[1]);hidden.add(key(match[1]));bytes+=snap.data.length;}}
  for(const name of state.names){if(/\.deleted\.json$/i.test(name))continue;if(!/^[a-f0-9-]{36}\.json$/i.test(name))fail('BOARD_MERGE_SIDECARS');if(hidden.has(key(name.slice(0,-5))))continue;const snap=await read(state.path+'/'+name,128*1024),review=validateReview(json(snap.data),name.slice(0,-5));bytes+=snap.data.length;
   if(key(review.boardID)===key(source.id)&&review.boardPath===r.sourcePath){extra.source=union(extra.source,review.rect);counts.reviews++;}else if(key(review.boardID)===key(target.id)&&review.boardPath===r.path)extra.target=union(extra.target,review.rect);
  }if(bytes>32*1024*1024)fail('TOO_LARGE');
 }
 return{extra,reads,directories,counts};
}
async function inspectBoardMerge(vaults,value){
 if(!object(value)||Object.keys(value).some(k=>!['vaultId','path','expectedSHA256','sourcePath','expectedSourceSHA256'].includes(k)))fail('INVALID_REQUEST');
 const r=request(value);return vaults.lockedBoard(r,async()=>{
  const src=await vaults.snapshot({vaultId:r.vaultId,path:r.sourcePath},MAX_BOARD),dst=await vaults.snapshot(r,MAX_BOARD);if(src.sha256!==r.expectedSourceSHA256||dst.sha256!==r.expectedSHA256)fail('CONFLICT');const source=parse(src.data),target=parse(dst.data);if(key(source.id)===key(target.id))fail('CONFLICT');
  for(const name of Object.keys(source))if(!KNOWN.has(name)&&!isDeepStrictEqual(source[name],target[name]))fail('BOARD_MERGE_UNSUPPORTED');
  const layout=await layoutExtras(vaults,r,target,source),a=await nativeBounds(vaults,target),b=await nativeBounds(vaults,source),events=await directoryState(vaults,r.vaultId,'.inkspace-study/'+key(source.id)+'/events');if(!events.absent&&events.names.some(n=>!/^[a-f0-9-]{36}\.json$/i.test(n)))fail('BOARD_MERGE_SIDECARS');
  await recheck(vaults,r,src,dst,layout);
  return{sourceBounds:union(union(knownBounds(source),b.contentBounds),layout.extra.source)||{x:0,y:0,width:1,height:1},targetBounds:union(union(knownBounds(target),a.contentBounds),layout.extra.target),sourceCounts:{items:source.items.length,edges:source.edges.length,pins:source.pins.length,printFrames:source.printFrames?.length||0,nativeStrokes:b.nativeStrokeCount,webStrokes:source.webInk?.strokes.length||0,...layout.counts,studyEvents:events.names?.length||0},expectedSHA256:dst.sha256,expectedSourceSHA256:src.sha256};
 });
}
async function collectSidecars(vaults,r,target,source,plan){
 const reads=[],directories=[],writes=[],read=async(rel,max)=>{const snapshot=await optionalSnapshot(vaults,r.vaultId,rel,max);reads.push({path:rel,snapshot,maximum:max});return snapshot;},dir=async rel=>{const s=await directoryState(vaults,r.vaultId,rel);directories.push(s);return s;};
 const sourceTape=await read(tapePath(source.id),4*1024*1024),targetTape=await read(tapePath(target.id),4*1024*1024);
 const decodeTape=(snap,id)=>snap?validateTape(json(snap.data),id):{version:1,boardID:id,revision:0,tapes:[]};
 const from=decodeTape(sourceTape,source.id),to=decodeTape(targetTape,target.id);
 if(from.tapes.length||r.mode==='newCopy'&&targetTape){const merged={...structuredClone(to),boardID:plan.board.id,revision:r.mode==='newCopy'?1:to.revision+1,tapes:[...structuredClone(to.tapes),...from.tapes.map(t=>({...structuredClone(t),id:plan.fresh(),points:t.points.map(p=>({...p,x:p.x+plan.translation.dx,y:p.y+plan.translation.dy}))}))]};validateTape(merged,plan.board.id);const data=Buffer.from(JSON.stringify(merged)+'\n');if(data.length>4*1024*1024)fail('TOO_LARGE');writes.push({path:tapePath(plan.board.id),data,before:r.mode==='newCopy'?null:targetTape});plan.counts.tapes=from.tapes.length;}
 const {validateEvent}=require('./study-model.cjs');let studyCount=0,studyBytes=0;
 for(const [board,imported]of [[source,true],[target,false]]){
  const state=await dir('.inkspace-study/'+key(board.id)+'/events');if(state.absent)continue;
  const events=[];for(const name of state.names){if(!/^[a-f0-9-]{36}\.json$/i.test(name))fail('BOARD_MERGE_SIDECARS');const rel=state.path+'/'+name,snap=await read(rel,64*1024),event=validateEvent(json(snap.data));if(event.id!==name.slice(0,-5).toLowerCase()||event.boardID!==key(board.id))fail('BOARD_MERGE_SIDECARS');events.push(event);studyBytes+=snap.data.length;}
  studyCount+=events.length;if(studyCount>10000||studyBytes>32*1024*1024)fail('TOO_LARGE');
  if(!imported&&r.mode!=='newCopy')continue;
  // Stable timestamp ties must retain their original event ordering.
  const originalIDs=events.map(e=>e.id).sort(),newIDs=events.map(()=>plan.fresh()).sort(),eventIDs=new Map(originalIDs.map((id,index)=>[id,newIDs[index]]));
  for(const event of events){const next=validateEvent({...event,id:eventIDs.get(event.id),boardID:key(plan.board.id),itemID:imported?(plan.map.get(event.itemID)||(()=>{const id=plan.fresh();plan.map.set(event.itemID,id);return id;})()):event.itemID});const data=Buffer.from(JSON.stringify(next)+'\n');writes.push({path:'.inkspace-study/'+key(plan.board.id)+'/events/'+next.id+'.json',data,before:null});}
  if(imported)plan.counts.studyEvents=events.length;
 }
 const reviews=await dir('.inkspace-reviews'),{validateReview,validateDeleted}=require('./review-service.cjs');
 if(!reviews.absent){const hidden=new Set();for(const name of reviews.names){const match=/^([a-f0-9-]{36})\.deleted\.json$/i.exec(name);if(match){const snap=await read(reviews.path+'/'+name,128*1024);validateDeleted(json(snap.data),match[1]);hidden.add(key(match[1]));}}
  for(const name of reviews.names){if(/\.deleted\.json$/i.test(name))continue;if(!/^[a-f0-9-]{36}\.json$/i.test(name))fail('BOARD_MERGE_SIDECARS');if(hidden.has(key(name.slice(0,-5))))continue;const snap=await read(reviews.path+'/'+name,128*1024),review=validateReview(json(snap.data),name.slice(0,-5)),imported=key(review.boardID)===key(source.id)&&review.boardPath===r.sourcePath,copyTarget=r.mode==='newCopy'&&key(review.boardID)===key(target.id)&&review.boardPath===r.path;if(!imported&&!copyTarget)continue;
   const next=structuredClone(review);next.id=plan.fresh();next.boardID=plan.board.id;next.boardPath=r.mode==='newCopy'?r.newPath:r.path;
   if(imported){next.rect.x+=plan.translation.dx;next.rect.y+=plan.translation.dy;if(next.anchor){const mapped=plan.map.get(key(next.anchor.itemID));if(!mapped)fail('BOARD_MERGE_SIDECARS');next.anchor.itemID=mapped;for(const field of ['sourcePath','originalSourcePath'])if(next.anchor[field]!=null)next.anchor[field]=plan.pathMap.get(next.anchor[field])||next.anchor[field];}plan.counts.reviews++;}
   validateReview(next);writes.push({path:reviews.path+'/'+next.id+'.json',data:Buffer.from(JSON.stringify(next)+'\n'),before:null});
  }
  const additions=writes.filter(w=>w.path.startsWith('.inkspace-reviews/'));let bytes=additions.reduce((n,w)=>n+w.data.length,0);
  if(reviews.names.length+additions.length>10000)fail('TOO_LARGE');
  for(const name of reviews.names){const resolved=await vaults.resolve(r.vaultId,reviews.path+'/'+name);bytes+=resolved.stat.size;}
  if(bytes>32*1024*1024)fail('TOO_LARGE');
 }
 if(writes.length>MAX_SIDECARS||reads.length>MAX_SIDECARS||writes.reduce((n,w)=>n+w.data.length,0)>MAX_SIDECAR_BYTES||reads.reduce((n,r)=>n+(r.snapshot?.data.length||0),0)>MAX_SIDECAR_BYTES)fail('TOO_LARGE');
 return{reads,directories,writes};
}
async function ensureDirectory(vaults,vaultId,rel){const parts=rel==='.'?[]:rel.split('/');for(let i=1;i<=parts.length;i++){const current=parts.slice(0,i).join('/');try{await vaults.resolve(vaultId,current,{directory:true});}catch(error){if(error.code!=='ENOENT')throw error;const parent=(await vaults.resolve(vaultId,parts.slice(0,i-1).join('/'),{directory:true})).full;try{await fs.mkdir(path.join(parent,parts[i-1]),{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await vaults.resolve(vaultId,current,{directory:true});}}return vaults.resolve(vaultId,rel==='.'?'':rel,{directory:true});}
async function assertRead(vaults,vaultId,entry){const now=await optionalSnapshot(vaults,vaultId,entry.path,entry.maximum);if((now?.sha256??null)!==(entry.snapshot?.sha256??null))fail('CONFLICT');}
async function recheck(vaults,r,a,b,sidecars){const source=await vaults.snapshot({vaultId:r.vaultId,path:r.sourcePath},MAX_BOARD),target=await vaults.snapshot({vaultId:r.vaultId,path:r.path},MAX_BOARD);if(source.sha256!==a.sha256||target.sha256!==b.sha256)fail('CONFLICT');for(const item of sidecars.reads)await assertRead(vaults,r.vaultId,item);for(const old of sidecars.directories){const now=await directoryState(vaults,r.vaultId,old.path);if(old.absent!==now.absent||!old.absent&&(old.dev!==now.dev||old.ino!==now.ino||!isDeepStrictEqual(old.names,now.names)))fail('CONFLICT');}}
async function recheckPublished(vaults,r,a,b,sidecars){
 const source=await vaults.snapshot({vaultId:r.vaultId,path:r.sourcePath},MAX_BOARD),target=await vaults.snapshot({vaultId:r.vaultId,path:r.path},MAX_BOARD);if(source.sha256!==a.sha256||target.sha256!==b.sha256)fail('CONFLICT');
 const written=new Set(sidecars.writes.map(w=>w.path));for(const item of sidecars.reads)if(!written.has(item.path))await assertRead(vaults,r.vaultId,item);
 for(const entry of sidecars.writes){const now=await optionalSnapshot(vaults,r.vaultId,entry.path,MAX_SIDECAR_BYTES);if(!now||now.sha256!==digest(entry.data))fail('CONFLICT');}
 for(const old of sidecars.directories){const now=await directoryState(vaults,r.vaultId,old.path),names=now.names?.filter(n=>!written.has(old.path+'/'+n));if(old.absent){if(!now.absent&&names.length)fail('CONFLICT');continue;}if(now.absent||old.dev!==now.dev||old.ino!==now.ino||!isDeepStrictEqual(old.names,names))fail('CONFLICT');}
}
async function journal(vaults,id,value){const root=path.join(vaults.dataDirectory,'board-merge-transactions');await fs.mkdir(root,{recursive:true,mode:0o700});const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())fail('PATH_DENIED');const dest=path.join(root,id+'.json'),temp=path.join(root,'.'+id+'-'+crypto.randomUUID()+'.tmp');try{await durableWrite(temp,Buffer.from(JSON.stringify(value,null,2)+'\n'));await fs.rename(temp,dest);}finally{await fs.unlink(temp).catch(()=>{});}}
async function rejectPending(vaults,r){
 const root=path.join(vaults.dataDirectory,'board-merge-transactions');let stat;try{stat=await fs.lstat(root);}catch(e){if(e.code==='ENOENT')return;throw e;}if(!stat.isDirectory()||stat.isSymbolicLink())fail('PATH_DENIED');const names=await fs.readdir(root);if(names.length>10000)fail('TOO_LARGE');const vaultRoot=await vaults.root(r.vaultId);
 for(const name of names){if(!/^[a-f0-9-]{36}\.json$/i.test(name))continue;const full=path.join(root,name),info=await fs.lstat(full);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>8*1024*1024)fail('FILE_OPERATION_RECOVERY');const record=json(await fs.readFile(full),'FILE_OPERATION_RECOVERY');if(record.vaultRoot===vaultRoot&&['prepared','sidecars-published','needs-recovery','undo-prepared','undo-sidecars-published','undo-needs-recovery'].includes(record.state)&&[record.path,record.sourcePath,record.outputPath].some(p=>[r.path,r.sourcePath,r.newPath].includes(p)))fail('FILE_OPERATION_RECOVERY');}
}
async function publishSidecar(vaults,vaultId,entry){const before=await optionalSnapshot(vaults,vaultId,entry.path,MAX_SIDECAR_BYTES);if((before?.sha256??null)!==(entry.before?.sha256??null))fail('CONFLICT');const dir=await ensureDirectory(vaults,vaultId,path.posix.dirname(entry.path)),temp=path.join(dir.full,'.merge-'+crypto.randomUUID()),dest=path.join(dir.full,path.posix.basename(entry.path));try{await durableWrite(temp,entry.data,before?.stat.mode&0o777||0o600);const latest=await optionalSnapshot(vaults,vaultId,entry.path,MAX_SIDECAR_BYTES);if((latest?.sha256??null)!==(before?.sha256??null))fail('CONFLICT');const current=await vaults.resolve(vaultId,path.posix.dirname(entry.path),{directory:true});if(current.stat.dev!==dir.stat.dev||current.stat.ino!==dir.stat.ino)fail('CONFLICT');if(before)await fs.rename(temp,dest);else{await fs.link(temp,dest);await fs.unlink(temp);}}finally{await fs.unlink(temp).catch(()=>{});}}
async function rollback(vaults,vaultId,published){let clean=true;for(const entry of [...published].reverse()){try{const now=await optionalSnapshot(vaults,vaultId,entry.path,MAX_SIDECAR_BYTES);if(!now||now.sha256!==digest(entry.data))throw Error('Changed sidecar');if(entry.before)await publishSidecar(vaults,vaultId,{path:entry.path,data:entry.before.data,before:now});else await fs.unlink(now.full);}catch{clean=false;}}return clean;}
function undoGuard(sidecars,target){
 const tape=tapePath(target.id),study='.inkspace-study/'+key(target.id)+'/events',files=new Map(),directories=[];
 for(const entry of sidecars.reads)if(entry.path===tape||entry.path.startsWith(study+'/')||entry.path.startsWith('.inkspace-reviews/'))files.set(entry.path,{path:entry.path,sha256:entry.snapshot?.sha256??null});
 for(const entry of sidecars.writes)files.set(entry.path,{path:entry.path,sha256:digest(entry.data)});
 for(const rel of [study,'.inkspace-reviews']){const before=sidecars.directories.find(d=>d.path===rel);if(!before)fail('BOARD_MERGE_SIDECARS');const names=new Set(before.names||[]);for(const entry of sidecars.writes)if(path.posix.dirname(entry.path)===rel)names.add(path.posix.basename(entry.path));directories.push({path:rel,names:[...names].sort()});}
 return{files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)),directories};
}
async function prepareCopyGuard(vaults,r,sidecars,board){
 const rel=tapePath(board.id),snap=await optionalSnapshot(vaults,r.vaultId,rel,4*1024*1024),state=await directoryState(vaults,r.vaultId,'.inkspace-study/'+key(board.id)+'/events');
 if(snap||!state.absent)fail('EXISTS');sidecars.reads.push({path:rel,snapshot:null,maximum:4*1024*1024});sidecars.directories.push(state);
 for(const entry of sidecars.reads)if(entry.path.startsWith('.inkspace-reviews/')&&entry.snapshot){const value=json(entry.snapshot.data);if(typeof value.boardID==='string'&&key(value.boardID)===key(board.id))fail('EXISTS');}
}
function companionPath(rel){relativePath(rel);if(!/^\.inkspace\/writing-aids\/[a-f0-9-]{36}\.json$/i.test(rel)&&!/^\.inkspace-study\/[a-f0-9-]{36}\/events\/[a-f0-9-]{36}\.json$/i.test(rel)&&!/^\.inkspace-reviews\/[a-f0-9-]{36}(?:\.deleted)?\.json$/i.test(rel))fail('FILE_OPERATION_RECOVERY');return rel;}
function validateGuard(guard){
 if(!object(guard)||!Array.isArray(guard.files)||guard.files.length>20000||!Array.isArray(guard.directories)||guard.directories.length!==2)fail('FILE_OPERATION_RECOVERY');const seen=new Set();
 for(const entry of guard.files){if(!object(entry)||seen.has(entry.path)||entry.sha256!==null&&!SHA.test(entry.sha256||''))fail('FILE_OPERATION_RECOVERY');companionPath(entry.path);seen.add(entry.path);}
 for(const entry of guard.directories){if(!object(entry)||!/^\.inkspace-study\/[a-f0-9-]{36}\/events$/i.test(entry.path||'')&&entry.path!=='.inkspace-reviews'||!Array.isArray(entry.names)||entry.names.length>MAX_SIDECARS||new Set(entry.names).size!==entry.names.length)fail('FILE_OPERATION_RECOVERY');for(const name of entry.names)companionPath(entry.path+'/'+name);}
 return guard;
}
function revertedGuard(record){const guard=structuredClone(record.undoGuard),writes=new Map(record.sidecars.map(s=>[s.path,s]));for(const file of guard.files)if(writes.has(file.path))file.sha256=writes.get(file.path).beforeSHA256;for(const dir of guard.directories)dir.names=dir.names.filter(name=>writes.get(dir.path+'/'+name)?.beforeSHA256!==null);return guard;}
async function checkGuard(vaults,vaultId,guard){
 validateGuard(guard);for(const entry of guard.files){const now=await optionalSnapshot(vaults,vaultId,entry.path,MAX_SIDECAR_BYTES);if((now?.sha256??null)!==entry.sha256)fail('BOARD_MERGE_UNDO_CONFLICT');}
 for(const entry of guard.directories){const now=await directoryState(vaults,vaultId,entry.path);if(!isDeepStrictEqual(now.names||[],entry.names))fail('BOARD_MERGE_UNDO_CONFLICT');}
}
async function readLocal(file,maximum){
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size>maximum)fail('FILE_OPERATION_RECOVERY');const data=await handle.readFile(),after=await handle.stat(),current=await fs.lstat(file);if(data.length>maximum||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||after.dev!==current.dev||after.ino!==current.ino||current.isSymbolicLink())fail('FILE_OPERATION_RECOVERY');return data;}finally{await handle.close();}
}
async function privateDirectory(root){const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())fail('PATH_DENIED');}
async function backupContents(vaults,id,rel,beforeSHA256,afterSHA256){
 if(!UUID.test(id||'')||beforeSHA256!==null&&!SHA.test(beforeSHA256||'')||!SHA.test(afterSHA256||''))fail('FILE_OPERATION_RECOVERY');
 const read=async(file,maximum)=>{try{return await readLocal(file,maximum);}catch(error){if(error.code==='ENOENT')fail('BOARD_MERGE_UNDO_UNAVAILABLE');throw error;}};
 const base=vaults.backupDirectory;for(const dir of [base,path.join(base,'records'),path.join(base,'objects')])await privateDirectory(dir);const record=json(await read(path.join(base,'records',id+'.json'),16*1024),'FILE_OPERATION_RECOVERY');if(record.schemaVersion!==1||record.id!==id||record.relativePath!==rel||record.beforeSHA256!==beforeSHA256||record.afterSHA256!==afterSHA256)fail('FILE_OPERATION_RECOVERY');
 const load=async sha=>{if(sha===null)return null;const data=await read(path.join(base,'objects',sha+'.bin'),MAX_SIDECAR_BYTES);if(digest(data)!==sha)fail('FILE_OPERATION_RECOVERY');return data;};return{before:await load(beforeSHA256),after:await load(afterSHA256)};
}
async function deleteCompanion(vaults,vaultId,entry){const now=await optionalSnapshot(vaults,vaultId,entry.path,MAX_SIDECAR_BYTES);if(!now||now.sha256!==entry.before.sha256)fail('BOARD_MERGE_UNDO_CONFLICT');const current=await vaults.snapshot({vaultId,path:entry.path},MAX_SIDECAR_BYTES);if(current.sha256!==now.sha256||current.stat.dev!==now.stat.dev||current.stat.ino!==now.stat.ino)fail('BOARD_MERGE_UNDO_CONFLICT');await fs.unlink(current.full);}
async function rollbackUndo(vaults,vaultId,published){let clean=true;for(const entry of [...published].reverse()){try{const now=await optionalSnapshot(vaults,vaultId,entry.path,MAX_SIDECAR_BYTES);if(entry.data===null){if(now)throw Error('A later companion must be preserved');await publishSidecar(vaults,vaultId,{path:entry.path,data:entry.before.data,before:null});}else{if(!now||now.sha256!==digest(entry.data))throw Error('A later companion must be preserved');await publishSidecar(vaults,vaultId,{path:entry.path,data:entry.before.data,before:now});}}catch{clean=false;}}return clean;}
function invalidateAssets(vaults,vaultId){for(const [id,asset]of vaults.assets)if(asset.vaultId===vaultId)vaults.assets.delete(id);vaults.pdfPreviewCache.clear();vaults.pdfPreviewBytes=0;}
async function undoNewCopy(vaults,r,record,root){
 const recoveryRecordPath=path.join(root,r.journalID+'.json'),snap=await optionalSnapshot(vaults,r.vaultId,r.path,MAX_BOARD),target=await vaults.snapshot({vaultId:r.vaultId,path:record.path},MAX_BOARD),originalTarget=parse(target.data);
 const opened=()=>({path:record.path,name:path.posix.basename(record.path),kind:'board',board:originalTarget,sha256:target.sha256,bytes:target.data.length});
 if(r.expectedSHA256!==record.outputSHA256)fail('BOARD_MERGE_UNDO_CONFLICT');
 if(record.state==='undone'||record.state==='undo-sidecars-published'&&!snap&&record.undo?.removedOutputSHA256===record.outputSHA256){if(snap||record.undo?.removedOutputSHA256!==record.outputSHA256)fail('BOARD_MERGE_UNDO_CONFLICT');await checkGuard(vaults,r.vaultId,revertedGuard(record));if(record.state!=='undone'){record.state='undone';record.undo.completedAt=time();await journal(vaults,r.journalID,record);}return{...opened(),history:await vaults.boardHistory.state({vaultId:r.vaultId,path:record.path}),journalID:r.journalID,undone:true,alreadyUndone:true,removedMergedPath:r.path,recoveryRecordPath,unchanged:true};}
 if(record.state!=='complete'||!snap||snap.sha256!==record.outputSHA256)fail('BOARD_MERGE_UNDO_CONFLICT');await checkGuard(vaults,r.vaultId,record.undoGuard);await backupContents(vaults,record.boardBackupId,r.path,null,record.outputSHA256);
 const writes=[];let bytes=0;for(const entry of record.sidecars){if(entry.beforeSHA256!==null)fail('FILE_OPERATION_RECOVERY');await backupContents(vaults,entry.backupId,entry.path,null,entry.afterSHA256);const before=await vaults.snapshot({vaultId:r.vaultId,path:entry.path},MAX_SIDECAR_BYTES);if(before.sha256!==entry.afterSHA256)fail('BOARD_MERGE_UNDO_CONFLICT');bytes+=before.data.length;if(bytes>MAX_SIDECAR_BYTES)fail('TOO_LARGE');writes.push({path:entry.path,data:null,before});}
 const published=[];record.undo={startedAt:time(),removedOutputSHA256:record.outputSHA256};record.state='undo-prepared';await journal(vaults,r.journalID,record);
 try{await checkGuard(vaults,r.vaultId,record.undoGuard);const before=await vaults.snapshot(r,MAX_BOARD);if(before.sha256!==record.outputSHA256)fail('BOARD_MERGE_UNDO_CONFLICT');for(const entry of writes){await deleteCompanion(vaults,r.vaultId,entry);published.push(entry);}await checkGuard(vaults,r.vaultId,revertedGuard(record));record.state='undo-sidecars-published';await journal(vaults,r.journalID,record);await deleteCompanion(vaults,r.vaultId,{path:r.path,before:snap});}
 catch(error){const current=await optionalSnapshot(vaults,r.vaultId,r.path,MAX_BOARD).catch(()=>undefined);if(!(record.state==='undo-sidecars-published'&&current===null)){const clean=await rollbackUndo(vaults,r.vaultId,published);record.state=clean?'complete':'undo-needs-recovery';record.undo.error=error.code||'IO_FAILED';let logged=true;try{await journal(vaults,r.journalID,record);}catch{logged=false;}if(!clean||!logged)fail('FILE_OPERATION_RECOVERY');throw error;}}
 record.state='undone';record.undo.completedAt=time();const warnings=[];try{await journal(vaults,r.journalID,record);}catch{warnings.push('The merged copy was removed, but its completion receipt could not be updated.');}invalidateAssets(vaults,r.vaultId);
 return{...opened(),history:await vaults.boardHistory.state({vaultId:r.vaultId,path:record.path}),journalID:r.journalID,undone:true,alreadyUndone:false,removedMergedPath:r.path,recoveryRecordPath,warnings};
}
async function undoBoardMerge(vaults,value){
 if(!object(value)||Object.keys(value).sort().join(',')!=='expectedSHA256,journalID,path,vaultId'||typeof value.vaultId!=='string'||!value.vaultId||!SHA.test(value.expectedSHA256||'')||!UUID.test(value.journalID||''))fail('INVALID_REQUEST');publicBoard(value.path);const r=value;
 return vaults.lockedBoard(r,async()=>{
  const root=path.join(vaults.dataDirectory,'board-merge-transactions');await privateDirectory(root);const record=json(await readLocal(path.join(root,r.journalID+'.json'),8*1024*1024),'FILE_OPERATION_RECOVERY');
  if(record.schemaVersion!==2||!record.undoGuard)fail('BOARD_MERGE_UNDO_UNAVAILABLE');if(record.id!==r.journalID||record.vaultRoot!==await vaults.root(r.vaultId)||record.outputPath!==r.path||!['intoTarget','newCopy'].includes(record.mode))fail('INVALID_REQUEST');publicBoard(record.path);if(record.mode==='intoTarget'&&record.path!==r.path||record.mode==='newCopy'&&record.path===r.path)fail('INVALID_REQUEST');
  if(!['complete','undone','undo-sidecars-published'].includes(record.state))fail('FILE_OPERATION_RECOVERY');if(!SHA.test(record.expectedSHA256||'')||!SHA.test(record.outputSHA256||'')||!Array.isArray(record.sidecars)||record.sidecars.length>MAX_SIDECARS)fail('FILE_OPERATION_RECOVERY');validateGuard(record.undoGuard);
  const seen=new Set();for(const entry of record.sidecars){companionPath(entry.path);if(seen.has(entry.path)||entry.beforeSHA256!==null&&!SHA.test(entry.beforeSHA256||'')||!SHA.test(entry.afterSHA256||'')||!UUID.test(entry.backupId||'')||record.undoGuard.files.find(f=>f.path===entry.path)?.sha256!==entry.afterSHA256)fail('FILE_OPERATION_RECOVERY');seen.add(entry.path);}
  if(record.mode==='newCopy')return undoNewCopy(vaults,r,record,root);
  const snap=await vaults.snapshot(r,MAX_BOARD),recoveryRecordPath=path.join(root,r.journalID+'.json');
  if(record.state==='undone'||record.state==='undo-sidecars-published'&&snap.sha256===record.undo?.restoredSHA256){if(!SHA.test(record.undo?.restoredSHA256||'')||snap.sha256!==record.undo.restoredSHA256||![record.outputSHA256,snap.sha256].includes(r.expectedSHA256))fail('BOARD_MERGE_UNDO_CONFLICT');await checkGuard(vaults,r.vaultId,revertedGuard(record));if(record.state!=='undone'){record.state='undone';record.undo.completedAt=time();await journal(vaults,r.journalID,record);}return{path:r.path,name:path.posix.basename(r.path),kind:'board',board:parse(snap.data),sha256:snap.sha256,bytes:snap.data.length,history:{canUndo:false,canRedo:false},journalID:r.journalID,undone:true,alreadyUndone:true,recoveryRecordPath,unchanged:true};}
  if(record.state!=='complete'||snap.sha256!==r.expectedSHA256||snap.sha256!==record.outputSHA256)fail('BOARD_MERGE_UNDO_CONFLICT');await checkGuard(vaults,r.vaultId,record.undoGuard);
  const boardBytes=await backupContents(vaults,record.boardBackupId,r.path,record.expectedSHA256,record.outputSHA256);if(!boardBytes.before)fail('FILE_OPERATION_RECOVERY');const original=parse(boardBytes.before),current=parse(snap.data);if(key(original.id)!==key(current.id)||!Number.isSafeInteger(current.revision+1))fail('INVALID_BOARD');const board={...original,revision:current.revision+1,writerID:await vaults.writerID(),updatedAt:time()};validateBoard(board);const data=Buffer.from(JSON.stringify(board)+'\n');if(data.length>MAX_BOARD)fail('TOO_LARGE');
  const writes=[];let bytes=0;for(const entry of record.sidecars){const saved=await backupContents(vaults,entry.backupId,entry.path,entry.beforeSHA256,entry.afterSHA256),before=await vaults.snapshot({vaultId:r.vaultId,path:entry.path},MAX_SIDECAR_BYTES);if(before.sha256!==entry.afterSHA256)fail('BOARD_MERGE_UNDO_CONFLICT');bytes+=saved.before?.length||0;bytes+=before.data.length;if(bytes>2*MAX_SIDECAR_BYTES)fail('TOO_LARGE');writes.push({path:entry.path,data:saved.before,before});}
  const undoBackupId=await vaults.backup(r.path,snap.data,data),published=[];record.undo={startedAt:time(),restoredSHA256:digest(data),boardBackupId:undoBackupId};record.state='undo-prepared';await journal(vaults,r.journalID,record);
  let result;try{result=await vaults.commitSnapshot(r,snap,data,MAX_BOARD,async()=>{await checkGuard(vaults,r.vaultId,record.undoGuard);for(const entry of writes){if(entry.data===null)await deleteCompanion(vaults,r.vaultId,entry);else await publishSidecar(vaults,r.vaultId,entry);published.push(entry);}await checkGuard(vaults,r.vaultId,revertedGuard(record));record.state='undo-sidecars-published';await journal(vaults,r.journalID,record);});}
  catch(error){const committed=record.state==='undo-sidecars-published'?await optionalSnapshot(vaults,r.vaultId,r.path,MAX_BOARD).catch(()=>null):null;if(committed?.sha256===digest(data))result={sha256:committed.sha256,bytes:data.length,backupId:undoBackupId};else{const clean=await rollbackUndo(vaults,r.vaultId,published);record.state=clean?'complete':'undo-needs-recovery';record.undo.error=error.code||'IO_FAILED';let logged=true;try{await journal(vaults,r.journalID,record);}catch{logged=false;}if(!clean||!logged)fail('FILE_OPERATION_RECOVERY');throw error;}}
  record.state='undone';record.undo.completedAt=time();const warnings=[];try{await journal(vaults,r.journalID,record);}catch{warnings.push('The merge was undone, but its completion receipt could not be updated.');}invalidateAssets(vaults,r.vaultId);
  return{path:r.path,name:path.posix.basename(r.path),kind:'board',board,...result,history:{canUndo:false,canRedo:false},journalID:r.journalID,undone:true,alreadyUndone:false,recoveryRecordPath,warnings};
 });
}
async function mergeBoards(vaults,value){const r=request(value);return vaults.lockedBoard({vaultId:r.vaultId,path:r.path},async()=>{
 await rejectPending(vaults,r);
 const sourceSnap=await vaults.snapshot({vaultId:r.vaultId,path:r.sourcePath},MAX_BOARD),targetSnap=await vaults.snapshot(r,MAX_BOARD);if(sourceSnap.sha256!==r.expectedSourceSHA256||targetSnap.sha256!==r.expectedSHA256)fail('CONFLICT');
 const originalSource=parse(sourceSnap.data),originalTarget=parse(targetSnap.data),sourceResolved=await canonicalPaths(vaults,r,originalSource,r.sourcePath,r.expectedSourceSHA256),targetResolved=r.mode==='newCopy'?await canonicalPaths(vaults,r,originalTarget,r.path,r.expectedSHA256):{board:originalTarget},source=sourceResolved.board,target=targetResolved.board,layout=await layoutExtras(vaults,r,target,source);
 const plan=await buildMerged(vaults,r,target,source,layout.extra);plan.pathMap=sourceResolved.map;const sidecars=await collectSidecars(vaults,r,target,source,plan),outputPath=r.mode==='newCopy'?r.newPath:r.path;sidecars.reads.push(...layout.reads);sidecars.directories.push(...layout.directories);
 if(r.mode==='newCopy')await prepareCopyGuard(vaults,r,sidecars,plan.board);
 const childChecks=await require('./board-child-links.cjs').checkChangedChildLinks(vaults,{vaultId:r.vaultId,path:outputPath},r.mode==='newCopy'?{...target,items:[]}:target,plan.board);
 // Pretty-printing half a million point tuples can exceed the board budget
 // without adding content. Keep full-precision JSON compact, never trim ink.
 const data=Buffer.from(JSON.stringify(plan.board)+'\n');if(data.length>MAX_BOARD)fail('TOO_LARGE');
 const id=crypto.randomUUID(),published=[],record={schemaVersion:2,id,state:'prepared',createdAt:time(),vaultRoot:await vaults.root(r.vaultId),mode:r.mode,path:r.path,sourcePath:r.sourcePath,outputPath,expectedSHA256:r.expectedSHA256,expectedSourceSHA256:r.expectedSourceSHA256,outputSHA256:digest(data),sidecars:[],undoGuard:undoGuard(sidecars,r.mode==='newCopy'?plan.board:target)};
 record.boardBackupId=await vaults.backup(outputPath,r.mode==='intoTarget'?targetSnap.data:null,data);
 for(const entry of sidecars.writes){const backupId=await vaults.backup(entry.path,entry.before?.data??null,entry.data);record.sidecars.push({path:entry.path,beforeSHA256:entry.before?.sha256??null,afterSHA256:digest(entry.data),backupId,published:false});}
 await journal(vaults,id,record);
 const publish=async()=>{await recheck(vaults,r,sourceSnap,targetSnap,sidecars);for(const child of childChecks){const now=await vaults.snapshot({vaultId:r.vaultId,path:child.path},MAX_BOARD);if(now.sha256!==child.sha256)fail('CONFLICT');}for(const [index,entry]of sidecars.writes.entries()){await publishSidecar(vaults,r.vaultId,entry);published.push(entry);record.sidecars[index].published=true;}await recheckPublished(vaults,r,sourceSnap,targetSnap,sidecars);record.state='sidecars-published';await journal(vaults,id,record);};
 let saved;
 try{
  if(r.mode==='newCopy'){await vaults.resolve(r.vaultId,path.posix.dirname(outputPath)==='.'?'':path.posix.dirname(outputPath),{directory:true});if(await optionalSnapshot(vaults,r.vaultId,outputPath,MAX_BOARD))fail('EXISTS');await publish();const src=await vaults.snapshot({vaultId:r.vaultId,path:r.sourcePath},MAX_BOARD),dst=await vaults.snapshot(r,MAX_BOARD);if(src.sha256!==sourceSnap.sha256||dst.sha256!==targetSnap.sha256)fail('CONFLICT');saved=await vaults.createData(r.vaultId,path.posix.dirname(outputPath)==='.'?'':path.posix.dirname(outputPath),path.posix.basename(outputPath),data);}
  else saved=await vaults.commitSnapshot(r,targetSnap,data,MAX_BOARD,publish);
 }catch(error){
  // createData may publish successfully but then fail while reopening an iCloud
  // file. Never roll back companions of an already committed whole board.
  const committed=record.state==='sidecars-published'?await optionalSnapshot(vaults,r.vaultId,outputPath,MAX_BOARD).catch(()=>null):null;
  if(committed?.sha256===digest(data)){saved={sha256:committed.sha256,bytes:data.length};record.reopenWarning=true;}
  else{const clean=await rollback(vaults,r.vaultId,published);record.state=clean?'rolled-back':'needs-recovery';record.error=error.code||'IO_FAILED';await journal(vaults,id,record).catch(()=>{});if(!clean)fail('FILE_OPERATION_RECOVERY');throw error;}
 }
 record.state='complete';record.completedAt=time();let journalWarning;try{await journal(vaults,id,record);}catch{journalWarning='The merged board is saved; its completion receipt could not be updated.';}
 const history=r.mode==='intoTarget'&&!sidecars.writes.length?await vaults.boardHistory.recordTransition(r,targetSnap.data,data):{canUndo:false,canRedo:false,...(r.mode==='intoTarget'&&sidecars.writes.length?{warning:'This merge has independent companion files. Its complete pre-merge backup is retained; single-file Undo is unavailable.'}:{})};
 return{path:outputPath,name:path.posix.basename(outputPath),kind:'board',board:plan.board,...saved,mode:r.mode,sourcePath:r.sourcePath,sourceSHA256:sourceSnap.sha256,translation:plan.translation,sourceBounds:plan.sourceBounds,outputBounds:plan.outputBounds,focusRect:plan.focusRect,mergedCounts:plan.counts,history,journalID:id,recoveryRecordPath:path.join(vaults.dataDirectory,'board-merge-transactions',id+'.json'),preMergeBackupId:record.boardBackupId,warnings:[...(plan.board.pdfWritebackSuspended?['Merged notes preserve their source PDFs; automatic PDF writeback is paused.']:[]),...(history.warning?[history.warning]:[]),...(journalWarning?[journalWarning]:[])]};
 });}
module.exports={mergeBoards,inspectBoardMerge,undoBoardMerge,buildMerged,translateWeb,rebaseURI,validateTape};

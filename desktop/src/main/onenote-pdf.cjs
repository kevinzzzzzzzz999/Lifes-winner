'use strict';
// OneNote prints a canvas in row-major tiles, sometimes repeating a band of
// ink at a smart page break. Keep the source objects, register matching paths,
// and give each repeated band one owner. Never rasterize the source document.
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const crypto=require('node:crypto');
const {scanPathClips,validateInkOwnership,validateImageOwnership}=require('./onenote-geometry-guard.cjs');
const VERSION='onenote-grid-v1';
const MAX_INPUT=128*1024*1024,MAX_DECODED=256*1024*1024,MAX_PAGES=256;
const number='[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)';
const median=a=>{const v=[...a].sort((x,y)=>x-y);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function refuse(message,code='ONENOTE_LAYOUT_UNSUPPORTED'){throw Object.assign(Error(message),{code});}
function parseTile(raw,width,height,index,{graphicsStates={}}={}){
 const rect=new RegExp(`(${number})\\s+(${number})\\s+(${number})\\s+(${number})\\s+re\\s+W\\*?\\s+n`,'g');
 const bodyRects=[...raw.matchAll(rect)].map(m=>m.slice(1,5).map(Number)).filter(r=>Math.abs(r[0])<.01&&r[2]>=width*.95&&r[2]<=width+2&&r[3]>height*.5&&r[1]>24&&r[1]+r[3]<=height);
 const counts=new Map();for(const r of bodyRects){const k=r.join(',');counts.set(k,(counts.get(k)||0)+1);}
 const body=counts.size?[...counts].sort((a,b)=>b[1]-a[1])[0][0].split(',').map(Number):null;
 let footerBlocks=0;
 // Remove the actual printing footer's text operators, not just its pixels:
 // invisible footer text would otherwise prevent image OCR on native readers.
 const text=raw.replace(/BT\b[\s\S]*?\bET/g,block=>{
  const tm=[...block.matchAll(new RegExp(`1\\s+0\\s+0\\s+1\\s+(${number})\\s+(${number})\\s+Tm`,'g'))];
  if(tm.length&&tm.every(m=>Number(m[2])>=14&&Number(m[2])<=18)){footerBlocks++;return '';}
  return block;
 });
 const paths=[],images=[];let pointCount=0;
 const hasTypedText=/BT\b/.test(text),textClipRects=[];
 if(hasTypedText){
  let clip=[0,0,width,height];const stack=[];
  const tokens=new RegExp(`BT\\b[\\s\\S]*?\\bET|(${number})\\s+(${number})\\s+(${number})\\s+(${number})\\s+re\\s+W\\*?\\s+n|(?:^|\\s)(q|Q)(?=\\s|$)`,'g');
  for(const token of text.matchAll(tokens)){
   if(token[0].startsWith('BT')){textClipRects.push([...clip]);continue;}
   if(token[5]==='q')stack.push([...clip]);else if(token[5]==='Q'){if(!stack.length)refuse('Unbalanced OneNote graphics state.');clip=stack.pop();}
   else{const [x,y,w,h]=token.slice(1,5).map(Number);clip=[Math.max(clip[0],x),Math.max(clip[1],y),Math.min(clip[2],x+w),Math.min(clip[3],y+h)];}
  }
 }
 // Registration below deliberately supports OneNote's axis-aligned print
 // coordinates. A separate transform would invalidate the measured bounds.
 for(const cm of raw.matchAll(new RegExp(`(${number})\\s+(${number})\\s+(${number})\\s+(${number})\\s+(${number})\\s+(${number})\\s+cm`,'g'))){
  if(Number(cm[2])!==0||Number(cm[3])!==0||Number(cm[1])<=0||Number(cm[4])<=0||!/^\s*\/\w+\s+Do\b/.test(raw.slice(cm.index+cm[0].length)))refuse('This OneNote drawing uses a separate transform. Use ordinary PDF import.');
 }
 if(/(?:^|\s)(?:v|y)\s*(?:\r?\n|$)/m.test(raw))refuse('This OneNote drawing uses unsupported curve operations. Use ordinary PDF import.');
 const unmarked=text.replace(/\s\/P\s*<<\s*\/MCID\s+\d+\s*>>\s*BDC[\s\S]*?\bEMC/g,'');
 if(/(?:^|\s)(?:m|l|c|f|f\*|Do)\s*(?:\r?\n|$)/m.test(unmarked))refuse('This OneNote PDF contains unmarked drawing content. Use ordinary PDF import.');
 const geometryScan=scanPathClips(raw,graphicsStates),pathClips=geometryScan.paths;
 for(const tagged of raw.matchAll(/\/P\s*<<\s*\/MCID\s+(\d+)\s*>>\s*BDC([\s\S]*?)\bEMC/g)){
  const group=tagged[2],mcid=Number(tagged[1]);
  const image=[...group.matchAll(new RegExp(`(${number})\\s+0\\s+0\\s+(${number})\\s+(${number})\\s+(${number})\\s+cm\\s+\\/(\\w+)\\s+Do`,'g'))];
  for(const m of image){const [w,h,x,y]=m.slice(1,5).map(Number);if(w<=0||h<=0)refuse('Unsupported OneNote image transform.');const clips=geometryScan.imageClips.get(mcid+'|'+m[5]);if(!clips?.length)refuse('OneNote image has no verified graphics clip.');images.push({name:m[5],bbox:[x,y,x+w,y+h],guardClip:clips.shift()});}
  if(!group.includes('Do')&&!/[\s\d]m\s/.test(group)&&/\bre\s+(?:f\*?|F)\b/.test(group))refuse('A standalone OneNote rectangle cannot be safely joined. Use ordinary PDF import.');
  if(group.includes('Do')||!/[\s\d]m\s/.test(group))continue;
  const values=[],ops=[];let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const pattern=new RegExp(`((?:${number}\\s+)+)([mlc])\\s`,'g');
  for(const m of group.matchAll(pattern)){const nums=m[1].trim().split(/\s+/).map(Number);if(nums.length!==(m[2]==='c'?6:2))refuse('Unsupported OneNote path.');ops.push(m[2]);for(let n=0;n<nums.length;n+=2){values.push(nums[n],nums[n+1]);minX=Math.min(minX,nums[n]);maxX=Math.max(maxX,nums[n]);minY=Math.min(minY,nums[n+1]);maxY=Math.max(maxY,nums[n+1]);}}
  pointCount+=values.length/2;if(pointCount>4000000)refuse('OneNote tile exceeds the path budget.','TOO_LARGE');
  if(values.length){const paint=group.match(new RegExp(`(?:${number}\\s+){1,4}(?:rg|g|k)\\b`))?.[0].trim().replace(/\s+/g,' ')||'';const shape=digest(ops.join('')+'|'+paint);const geometry=pathClips.get(mcid);if(!geometry?.painted)refuse('OneNote ink has no supported complete fill operation.');paths.push({shape,coords:Float64Array.from(values),bbox:[minX,minY,maxX,maxY],guardClip:geometry.clip,guardStroked:!!geometry.stroked,guardShape:digest(ops.join('')+'|'+geometry.paintKey)});}
 }
 if(!body&&(paths.length||images.length))refuse(`Page ${index+1} has no supported OneNote print boundary.`);
 if(!footerBlocks)refuse(`Page ${index+1} has no recognized OneNote printing footer.`);
 return {index,width,height,text,body,paths,images,footerBlocks,hasTypedText,textClipRects,hasStrokedInk:paths.some(p=>p.guardStroked)};
}
function register(a,b,axis){
 const map=new Map();for(const p of b.paths){const list=map.get(p.shape)||[];list.push(p);map.set(p.shape,list);}
 const matches=[];
 for(const p of a.paths){if(p.coords.length<60)continue;for(const q of map.get(p.shape)||[]){
  if(p.coords.length!==q.coords.length)continue;
  const dx0=p.coords[0]-q.coords[0],dy0=q.coords[1]-p.coords[1];
  if(axis==='y'?(Math.abs(dx0)>.09||dy0<100||dy0>a.height):(Math.abs(dy0)>.09||dx0<100||dx0>a.width+2))continue;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;const xs=[],ys=[];
  for(let i=0;i<p.coords.length;i+=2){const dx=p.coords[i]-q.coords[i],dy=q.coords[i+1]-p.coords[i+1];minX=Math.min(minX,dx);maxX=Math.max(maxX,dx);minY=Math.min(minY,dy);maxY=Math.max(maxY,dy);xs.push(dx);ys.push(dy);}
  if(maxX-minX>.085||maxY-minY>.085)continue;const dx=median(xs),dy=median(ys);
  if(Math.abs(axis==='y'?dx:dy)>.08)continue;
  matches.push({offset:axis==='y'?dy:dx,points:p.coords.length/2});
 }}
 if(!matches.length)return null;const offset=median(matches.map(m=>m.offset));const consistent=matches.filter(m=>Math.abs(m.offset-offset)<.12);
 // One matching large freehand path is strong evidence; tiny coincident marks
 // alone are not allowed to change the page order or cut line.
 if(consistent.length<2&&consistent.reduce((s,m)=>s+m.points,0)<150)return null;
 return {offset,matchedPaths:consistent.length,matchedPoints:consistent.reduce((s,m)=>s+m.points,0),maxOffsetDeviation:Math.max(...consistent.map(m=>Math.abs(m.offset-offset)))};
}
async function compose(data,{columns=2}={}){
 if(!Number.isInteger(columns)||columns<1||columns>8)refuse('Choose between one and eight OneNote columns.','INVALID_REQUEST');
 const {PDFDocument,PDFName,PDFArray,PDFRawStream,decodePDFRawStream}=require('pdf-lib');
 if(!data?.length||data.length>MAX_INPUT)refuse('The source PDF exceeds 128 MiB.','TOO_LARGE');
 const source=await PDFDocument.load(data,{updateMetadata:false,throwOnInvalidObject:true});
 if(source.isEncrypted)refuse('Use an unlocked OneNote PDF.','INTEROP_ENCRYPTED');
 if(!/onenote/i.test(`${source.getCreator()||''} ${source.getProducer()||''}`))refuse('Choose a PDF printed from Microsoft OneNote.');
 const pages=source.getPages();if(!pages.length||pages.length>MAX_PAGES)refuse('OneNote canvas import supports up to 256 print tiles.','TOO_LARGE');
 const width=pages[0].getWidth(),height=pages[0].getHeight(),tiles=[],imageDescriptors=new Map();let decoded=0;
 for(const [index,page] of pages.entries()){
  if(page.getRotation().angle%360||Math.abs(page.getWidth()-width)>.1||Math.abs(page.getHeight()-height)>.1)refuse('OneNote tiles must have the same unrotated paper size.');
  if(page.node.Annots()?.size())refuse('This PDF has independent annotations or links. Use ordinary PDF import to preserve them.');
  const box=page.getCropBox();if(Math.abs(box.x)>.01||Math.abs(box.y)>.01||Math.abs(box.width-width)>.01||Math.abs(box.height-height)>.01)refuse('This OneNote PDF has a custom crop. Use ordinary PDF import.');
  const contents=page.node.Contents(),streams=contents instanceof PDFArray?contents.asArray().map(x=>source.context.lookup(x)):[contents];
  let raw='';for(const stream of streams){if(!(stream instanceof PDFRawStream))refuse('Unsupported OneNote content stream.');const bytes=decodePDFRawStream(stream).decode();decoded+=bytes.length;if(bytes.length>64*1024*1024||decoded>MAX_DECODED)refuse('Decoded OneNote content exceeds the import budget.','TOO_LARGE');raw+=Buffer.from(bytes).toString('latin1')+'\n';}
  // Nested source forms have their own clipping and coordinate systems. Do not
  // guess their layout, lose widgets, or silently fall back to a bitmap.
  const resources=page.node.Resources(),xObjects=resources?.lookup(PDFName.of('XObject'));
  if(xObjects)for(const [,ref] of xObjects.entries()){const obj=source.context.lookup(ref);if(obj?.dict?.lookup(PDFName.of('Subtype'))?.toString()!=='/Image')refuse('This OneNote PDF contains nested drawing forms. Use ordinary PDF import.');}
  const graphicsStates={};const states=resources?.lookup(PDFName.of('ExtGState'));
  if(states)for(const [name,ref] of states.entries()){
   const state=source.context.lookup(ref);if(!state?.entries||state.entries().some(([key])=>!['/Type','/BM','/ca','/CA'].includes(key.toString())))refuse('This OneNote graphics state cannot be safely deduplicated. Use ordinary PDF import.');
   const blend=state.lookup(PDFName.of('BM'));if(blend&&blend.toString()!=='/Normal')refuse('This OneNote blend mode cannot be safely deduplicated. Use ordinary PDF import.');
   const alpha=state.lookup(PDFName.of('ca'));if(alpha&&(typeof alpha.asNumber!=='function'||alpha.asNumber()<0||alpha.asNumber()>1))refuse('Unsupported OneNote fill opacity.');
   graphicsStates[name.toString().slice(1)]={alpha:alpha?.asNumber()};
  }
  const tile=parseTile(raw,width,height,index,{graphicsStates});
  for(const image of tile.images){
   const obj=xObjects?.lookup(PDFName.of(image.name));if(!(obj instanceof PDFRawStream))refuse('Missing OneNote image resource.');
   let descriptor=imageDescriptors.get(obj);if(!descriptor){
    const w=obj.dict.lookup(PDFName.of('Width'))?.asNumber(),h=obj.dict.lookup(PDFName.of('Height'))?.asNumber(),bits=obj.dict.lookup(PDFName.of('BitsPerComponent'))?.asNumber(),space=obj.dict.lookup(PDFName.of('ColorSpace'))?.toString();
    const complex=['Mask','SMask','ImageMask','Decode'].some(key=>obj.dict.has(PDFName.of(key)));
    descriptor={width:w,height:h,bits,space,complex,identity:complex?'original-object-'+imageDescriptors.size:digest(obj.contents)+':'+[w,h,bits,space,obj.dict.lookup(PDFName.of('Filter'))?.toString(),obj.dict.lookup(PDFName.of('DecodeParms'))?.toString()].join('|'),decode:()=>Buffer.from(decodePDFRawStream(obj).decode())};imageDescriptors.set(obj,descriptor);
   }
   image.descriptor=descriptor;
  }
  tiles.push(tile);
 }
 const rows=Array.from({length:Math.ceil(tiles.length/columns)},(_,r)=>tiles.slice(r*columns,(r+1)*columns));
 const defaultBody=[0,0,width,height];
 const rowBodies=rows.map(row=>row.find(t=>t.body)?.body||defaultBody);
 // Empty print tiles keep their column slot; they never shift later pages left.
 const horizontalSeams=[],pitchEvidence=[];
 for(const row of rows)for(let c=1;c<row.length;c++){const match=register(row[c-1],row[c],'x');if(match)pitchEvidence.push(match);}
 const pitch=pitchEvidence.length?median(pitchEvidence.map(v=>v.offset)):width;
 if(pitchEvidence.some(v=>Math.abs(v.offset-pitch)>.15))refuse('This PDF has conflicting horizontal tile positions.');
 for(let c=1;c<columns;c++)horizontalSeams.push({column:c+1,offset:pitch,method:pitchEvidence.length?'matched-handwriting':'paper-width',matchedPaths:pitchEvidence.reduce((s,v)=>s+v.matchedPaths,0)});
 const offsets=[0],verticalSeams=[],lower=[],upper=rows.map(()=>height);
 for(let r=0;r<rows.length-1;r++){
  const evidence=[];for(let c=0;c<Math.min(rows[r].length,rows[r+1].length);c++){const m=register(rows[r][c],rows[r+1][c],'y');if(m)evidence.push(m);}
  let step,cut,method;
  if(evidence.length){step=median(evidence.map(m=>m.offset));if(evidence.some(m=>Math.abs(m.offset-step)>.15))refuse('This PDF has conflicting vertical tile positions.');
   // Use the overlap in actual print rectangles, never page-number margins.
   const lo=rowBodies[r][1],hi=rowBodies[r+1][1]+rowBodies[r+1][3]-step;
   if(hi<lo-.15)refuse('Matching ink falls outside the common print band.');cut=(lo+hi)/2;method='matched-handwriting';
  }else{const nextTop=rowBodies[r+1][1]+rowBodies[r+1][3];cut=rowBodies[r][1];step=nextTop-cut;method='print-boundary-whitespace';}
  if(step<=0||step>height||cut<0||cut>height||cut+step>height+.1)refuse('Unsupported OneNote row boundary.');
  offsets.push(offsets.at(-1)+step);lower[r]=cut;upper[r+1]=cut+step;
  verticalSeams.push({afterPages:rows[r].map(t=>t.index+1),beforePages:rows[r+1].map(t=>t.index+1),step,cut,method,matchedPaths:evidence.reduce((s,m)=>s+m.matchedPaths,0),spacingExact:!!evidence.length});
 }
 const firstTop=rows[0].some(t=>t.hasTypedText||t.hasStrokedInk)?height:Math.max(...rowBodies.map(b=>b[1]+b[3]));upper[0]=firstTop;
 const last=rows.at(-1),lastBody=rowBodies.at(-1),lastBounds=last.flatMap(t=>[...t.images,...t.paths].map(o=>o.bbox)).filter(b=>b[3]>=lastBody[1]&&b[1]<=lastBody[1]+lastBody[3]);
 lower[rows.length-1]=last.some(t=>t.hasTypedText||t.hasStrokedInk)?0:lastBounds.length?Math.max(lastBody[1],Math.min(...lastBounds.map(b=>b[1]))-2):lastBody[1];
 const bottom=lower.at(-1)-offsets.at(-1),outHeight=firstTop-bottom;
 // Keep every column's paper width. Text glyph extents need font metrics; an
 // image/path-only tight crop would silently lose typed notes in blank tiles.
 const outWidth=pitch*(columns-1)+Math.max(width,...rowBodies.map(b=>b[2]));
 if(!Number.isFinite(outWidth)||!Number.isFinite(outHeight)||outWidth<=0||outHeight<=0||outHeight>14400||outWidth>14400)refuse('The continuous canvas exceeds this PDF size. Import fewer rows.','TOO_LARGE');
 const output=await PDFDocument.create();output.setTitle(`${source.getTitle()||'OneNote'} - continuous canvas`);output.setCreator("Life's winner OneNote canvas importer");output.setProducer("Life's winner (original vector PDF objects)");
 const page=output.addPage([outWidth,outHeight]),pageMappings=[],placements=[],boundingBoxes=[];
 let recoveredEdge=0;
 for(const tile of tiles){
  const r=Math.floor(tile.index/columns),c=tile.index%columns;
  let extension=0;
  // At a horizontal seam the original printer's CropBox is slightly narrower
  // than its content clip. Recover existing tiny negative-x path endpoints too.
  if(c>0){const negative=tile.paths.filter(p=>p.bbox[0]<0&&p.bbox[0]>-.5);if(negative.length)extension=Math.max(...negative.map(p=>-p.bbox[0]))+.03;}
  const left=c? -extension:0;
  const next=rows[r][c+1],nextSmall=next?.paths.filter(p=>p.bbox[0]<0&&p.bbox[0]>-.5)||[];
  const nextExtension=nextSmall.length?Math.max(...nextSmall.map(p=>-p.bbox[0]))+.03:0;
  const right=c<columns-1?pitch-nextExtension:Math.max(width,(tile.body||defaultBody)[2]);
  if(lower[r]>=upper[r]||right<=left)refuse('The tile ownership rectangles overlap incorrectly.');
  let text=tile.text;
  if(extension&&tile.body){const b=tile.body;const re=new RegExp(`0\\s+${String(b[1]).replace('.','\\.')}\\s+${String(b[2]).replace('.','\\.')}\\s+${String(b[3]).replace('.','\\.')}\\s+re\\s+W\\*?\\s+n`,'g');text=text.replace(re,`${-extension} ${b[1]} ${b[2]+extension} ${b[3]} re\nW* n`);recoveredEdge=Math.max(recoveredEdge,extension);}
  pages[tile.index].node.set(PDFName.of('Contents'),source.context.register(source.context.flateStream(Buffer.from(text,'latin1'))));
  const bbox={left,bottom:lower[r],right,top:upper[r]};
  // A matching ink band is not evidence that a separately typed paragraph was
  // repeated too. Only accept text whose entire inherited clip is retained;
  // otherwise ordinary import remains available instead of silently losing it.
  if(tile.textClipRects.some(b=>b[0]<bbox.left-.0001||b[1]<bbox.bottom-.0001||b[2]>bbox.right+.0001||b[3]>bbox.top+.0001))refuse('A typed OneNote text region crosses this join and cannot be safely deduplicated. Use ordinary PDF import.');
  boundingBoxes.push(bbox);placements.push({owner:[left,lower[r],right,upper[r]],x:c*pitch,y:-offsets[r]-bottom,extension});
  pageMappings.push({page:tile.index+1,row:r+1,column:c+1,sourceCrop:bbox,xOffset:c*pitch,yOffset:-offsets[r]-bottom,emptyBody:!tile.paths.length&&!tile.images.length,footerTextBlocksRemoved:tile.footerBlocks});
 }
 const inkConservation=validateInkOwnership(tiles,placements);
 const imageConservation=validateImageOwnership(tiles,placements);
 // One copier for the entire source document retains shared image/font objects
 // once, rather than copying the same resources separately for every tile.
 const embedded=await output.embedPages(pages,boundingBoxes);
 for(let i=0;i<embedded.length;i++){const b=boundingBoxes[i],p=placements[i];page.drawPage(embedded[i],{x:p.x+b.left,y:p.y+b.bottom});}
 const report={inkConservation,imageConservation,version:VERSION,sourceSha256:digest(data),pageCount:tiles.length,columns,rowCount:rows.length,outputPageCount:1,outputDimensions:{width:outWidth,height:outHeight},removedFooterTextBlocks:tiles.reduce((s,t)=>s+t.footerBlocks,0),horizontalSeams,verticalSeams,pageMappings,recoveredExistingHorizontalEdgePoints:recoveredEdge,originalUnchanged:true,rasterized:false,limitations:['Rows without matching handwriting are joined at print boundaries; original inter-row whitespace cannot be uniquely recovered.','This preserves PDF ink and images; it does not turn handwriting into native editable strokes or add OCR.']};
 const bytes=await output.save({useObjectStreams:true});return {data:Buffer.from(bytes),report};
}
function buildOneNotePDF(data,options={}){
 return new Promise((resolve,reject)=>{const worker=new Worker(__filename,{workerData:{inkspaceOneNote:true,data,options},resourceLimits:{maxOldGenerationSizeMb:1024}});let done=false;
  const timer=setTimeout(()=>{if(!done){done=true;void worker.terminate();reject(Object.assign(Error('OneNote import timed out; the source was not changed.'),{code:'TOO_LARGE'}));}},90000);
  worker.once('message',message=>{if(done)return;done=true;clearTimeout(timer);if(message.error)reject(Object.assign(Error(message.error.message),{code:message.error.code}));else resolve({data:Buffer.from(message.data),report:message.report});});
  worker.once('error',error=>{if(done)return;done=true;clearTimeout(timer);reject(error);});worker.once('exit',code=>{if(!done){done=true;clearTimeout(timer);reject(Object.assign(Error(`OneNote import worker exited (${code}).`),{code:'IO_FAILED'}));}});
 });
}
if(!isMainThread&&workerData?.inkspaceOneNote)compose(Buffer.from(workerData.data),workerData.options).then(result=>parentPort.postMessage(result)).catch(error=>parentPort.postMessage({error:{code:error.code||'ONENOTE_LAYOUT_UNSUPPORTED',message:error.message}}));
module.exports={VERSION,buildOneNotePDF,parseTile,register};

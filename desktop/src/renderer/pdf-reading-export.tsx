import {getDocument,GlobalWorkerOptions,type PDFDocumentLoadingTask,type PDFPageProxy,type RenderTask} from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {OpenedFile,PDFLayerProjection,ApiResult} from '../shared/desktop-api';
import {orderedBlocks,type ExtendBlock,type ExtendProjection} from '../shared/pdf-extend';
import {drawSnapshotAnnotations} from './pdf-visual-snapshot';
import type {ExportSheet} from './board-export';

// PDF points are 1/72 inch. Raster quality is fixed, unrelated to reader zoom,
// screen size, device pixel ratio, or the currently mounted reader pages.
const RASTER_SCALE=3, CSS_SCALE=96/72;
const LIMITS={pages:500,pagePixels:32_000_000,totalPixels:600_000_000,sourceBytes:256*1024*1024,dataBytes:192*1024*1024,dimension:14400,notes:5000,points:2_000_000,deadline:300_000};
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function fail(message:string):never{throw Error(message);}
const finite=(n:number,min=0,max=Infinity)=>Number.isFinite(n)&&n>=min&&n<=max;
const sourceChanged=()=>fail('PDF 或笔记已改变，请刷新后重新导出。 / The PDF or notes changed. Refresh and export again.');
function value<T>(result:ApiResult<T>):T{if(!result.ok)fail(result.error.message);return result.value;}
function assertWarnings(warnings:string[]|undefined){if(warnings?.length)fail('存在不可读的来源或笔记记录，无法保证完整导出。 / Unreadable source or note records prevent a complete export.');}
function localAsset(url:string){if(!/^vault-asset:\/\/asset\/[a-f0-9-]{36}$/i.test(url))fail('无效的本地 PDF 来源。 / Invalid local PDF source.');return url;}
function imageData(url:string){if(!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(url))fail('留白图片格式无效。 / Invalid note image.');return url;}
function projectionKey(layers:PDFLayerProjection,notes:ExtendProjection){return JSON.stringify({source:layers.sourceSHA256,layers:layers.layers,annotations:layers.annotations,heads:notes.heads,warnings:[...layers.warnings,...notes.warnings]});}

/** All-or-nothing export: saved sidecars are read directly; no virtualized DOM is used. */
export async function pdfReadingExportSheets(file:OpenedFile,vaultId:string,signal:AbortSignal,progress:(s:string)=>void,onlyPage?:number):Promise<ExportSheet[]>{
 const control=new AbortController();let timedOut=false;
 const cancelled=()=>control.abort();signal.addEventListener('abort',cancelled,{once:true});if(signal.aborted)control.abort();
 const timer=setTimeout(()=>{timedOut=true;control.abort();},LIMITS.deadline);
 const check=()=>{if(control.signal.aborted)fail(timedOut?'完整导出超时，未保存部分文件。 / Complete export timed out; no partial file was saved.':'已取消 / Cancelled');};
 const wait=<T,>(promise:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  const abort=()=>{try{check();}catch(error){reject(error);}};
  control.signal.addEventListener('abort',abort,{once:true});
  promise.then(result=>{control.signal.removeEventListener('abort',abort);try{check();resolve(result);}catch(error){reject(error);}},error=>{control.signal.removeEventListener('abort',abort);reject(error);});
  if(control.signal.aborted)abort();
 });
 let loading:PDFDocumentLoadingTask|undefined,render:RenderTask|undefined,page:PDFPageProxy|undefined;
 let canvas:HTMLCanvasElement|undefined,measure:HTMLDivElement|undefined,totalPixels=0,totalData=0,totalPoints=0;
 const cancelRender=()=>{render?.cancel();if(loading)void loading.destroy().catch(()=>{});};
 control.signal.addEventListener('abort',cancelRender,{once:true});
 const charge=(data:string)=>{totalData+=data.length;if(totalData>LIMITS.dataBytes)fail('完整导出超过图片数据上限，未保存部分文件。 / Complete export exceeds the image data budget; no partial file was saved.');return data;};
 const textStyle=(size:number)=>`font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:${size}px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;`;
 const textHeight=(text:string,width:number,size:number)=>{check();measure!.style.cssText=`position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:content-box;margin:0;padding:0;border:0;width:${width}px;${textStyle(size)}`;measure!.textContent=text;return Math.ceil(measure!.getBoundingClientRect().height);};
 const request={vaultId,path:file.path};
 try{
  check();assertWarnings(file.warnings);if(!/\.pdf$/i.test(file.path)||!finite(file.bytes,1,LIMITS.sourceBytes))fail('PDF 来源无效或过大。 / PDF source is invalid or too large.');
  progress('正在检查全部页面、图层和留白 / Checking every page, layer and note');
  const [assetResult,layerResult,noteResult]=await wait(Promise.all([window.desktop.getAssetUrl(request),window.desktop.readPDFLayers(request),window.desktop.readPDFExtend(request)]));
  const asset=value(assetResult),layers=value(layerResult),notes=value(noteResult);
  assertWarnings(layers.warnings);assertWarnings(notes.warnings);
  if(!/^[a-f0-9]{64}$/.test(file.sha256)||asset.sha256!==file.sha256||layers.sourceSHA256!==file.sha256||notes.sourceSHA256!==file.sha256)sourceChanged();
  if(layers.annotations.some(a=>a.sourceSHA256!==file.sha256)||notes.heads.some(e=>e.sourceSHA256!==file.sha256))fail('存在属于其他 PDF 版本的笔记，请先检查版本后再导出。 / Notes for another PDF revision require review before export.');
  const heads=new Map<string,number>();
  for(const event of notes.heads){heads.set(event.targetID,(heads.get(event.targetID)||0)+1);if((heads.get(event.targetID)||0)>1)fail('留白存在并发版本冲突，请先处理后导出。 / Resolve conflicting note versions before exporting.');}
  const blocks=notes.heads.filter(e=>e.kind==='upsert').map(e=>{if(!e.block)fail('留白记录不完整。 / Incomplete note record.');return e.block;});
  if(blocks.length>LIMITS.notes)fail('留白数量超过完整导出上限。 / Too many notes for one complete export.');
  const layerIDs=new Set(layers.layers.map(l=>l.id));
  if(layers.annotations.some(a=>!layerIDs.has(a.layerID)))fail('批注引用了不可读的图层。 / An annotation references an unavailable layer.');
  const visibleIDs=new Set(layers.layers.filter(l=>l.visible).map(l=>l.id));
  const marks=layers.annotations.filter(a=>visibleIDs.has(a.layerID));
  for(const mark of marks){totalPoints+=mark.points.length;if(totalPoints>LIMITS.points)fail('笔迹点超过完整导出上限。 / Ink exceeds the complete export budget.');}
  const initialKey=projectionKey(layers,notes);
  const response=await wait(fetch(localAsset(asset.url),{signal:control.signal}));
  if(!response.ok)fail('无法读取完整 PDF。 / Could not read the complete PDF.');
  const declared=Number(response.headers.get('content-length')||0);if(declared>LIMITS.sourceBytes)fail('PDF 超过完整导出大小上限。 / PDF exceeds the complete export size limit.');
  // Bound the body before allocating a complete source buffer.
  const reader=response.body?.getReader();if(!reader)fail('无法读取 PDF 数据。 / PDF data is unavailable.');
  const chunks:Uint8Array[]=[];let sourceBytes=0;
  try{for(;;){const next=await wait(reader.read());if(next.done)break;sourceBytes+=next.value.byteLength;if(sourceBytes>LIMITS.sourceBytes)fail('PDF 超过完整导出大小上限。 / PDF exceeds the complete export size limit.');chunks.push(next.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  const data=new Uint8Array(sourceBytes);let cursor=0;for(const chunk of chunks){data.set(chunk,cursor);cursor+=chunk.length;}chunks.length=0;
  const digest=Array.from(new Uint8Array(await wait(crypto.subtle.digest('SHA-256',data)))).map(n=>n.toString(16).padStart(2,'0')).join('');if(digest!==file.sha256)sourceChanged();
  GlobalWorkerOptions.workerSrc=workerURL;
  const resourceBase=new URL('./pdfjs/',document.baseURI).href;
  loading=getDocument({data,cMapUrl:resourceBase+'cmaps/',cMapPacked:true,standardFontDataUrl:resourceBase+'standard_fonts/',wasmUrl:resourceBase+'wasm/',stopAtErrors:true});
  const pdf=await wait(loading.promise);
  if(!Number.isSafeInteger(pdf.numPages)||pdf.numPages<1||pdf.numPages>LIMITS.pages)fail('完整导出支持最多 500 页，未保存部分文件。 / Complete export supports at most 500 pages; no partial file was saved.');
  if(onlyPage!==undefined&&(!Number.isSafeInteger(onlyPage)||onlyPage<1||onlyPage>pdf.numPages))fail('当前页无效，请重新打开导出窗口。 / Invalid current page. Reopen export.');
  if([...blocks,...marks].some(b=>!Number.isSafeInteger(b.page)||b.page<1||b.page>pdf.numPages))fail('笔记页码超出 PDF 范围。 / A note refers to a missing PDF page.');
  await wait(document.fonts.ready);measure=document.createElement('div');document.body.append(measure);
  const images=new Map<string,string>();
  const noteHTML=async(b:ExtendBlock,width:number):Promise<{html:string;height:number}>=>{
   check();if(!finite(b.anchorX,0,1)||!finite(b.anchorY,0,1)||!finite(b.height,.12,8)||!['inline','margin','collapsed'].includes(b.mode))fail('留白几何数据无效。 / Invalid note geometry.');
   const font=.025*width,left=.025*width,top=.036*width;
   const mode=b.mode==='inline'?'正文内 / Inline':b.mode==='margin'?'原页边笔记 · 完整展开 / Originally margin · expanded':'原折叠笔记 · 完整展开 / Originally collapsed · expanded';
   const title=`${b.title}\n${mode}`,headerHeight=textHeight(title,.95*width,.016*width)+.02*width;
   let contentHeight=Math.max(b.height*width,top+textHeight(b.text,.95*width,font)+.01*width);
   const imageHTML:string[]=[];let noteImageBytes=0;
   for(const item of b.images){
    check();if(!finite(item.x,0,1)||!finite(item.y)||!finite(item.width,.001,1)||!finite(item.height,.001,8)||item.x+item.width>1.00000001)fail('留白图片位置无效。 / Invalid note image geometry.');
    const key=item.resource+'|'+item.sha256;let url=images.get(key);
    if(!url){const result=value(await wait(window.desktop.readPDFExtendImage({...request,resource:item.resource,sha256:item.sha256})));url=imageData(result.dataURL);if(url.length>15*1024*1024)fail('留白图片过大。 / Note image is too large.');images.set(key,url);}
    contentHeight=Math.max(contentHeight,(item.y+item.height)*width);
    noteImageBytes+=url.length;if(totalData+noteImageBytes>LIMITS.dataBytes)fail('完整导出超过图片数据上限，未保存部分文件。 / Complete export exceeds the image data budget; no partial file was saved.');
    imageHTML.push(`<img alt="" src="${esc(url)}" style="position:absolute;display:block;left:${item.x*width}px;top:${item.y*width}px;width:${item.width*width}px;height:${item.height*width}px;object-fit:contain"/>`);
   }
   const ink:string[]=[];
   for(const stroke of b.strokes){
    if(!/^#[a-f0-9]{6}$/i.test(stroke.color)||!finite(stroke.width,.0001,.05))fail('留白笔迹无效。 / Invalid note ink.');
    totalPoints+=stroke.points.length;if(totalPoints>LIMITS.points)fail('笔迹点超过完整导出上限。 / Ink exceeds the complete export budget.');
    for(const p of stroke.points){if(!finite(p[0],0,1)||!finite(p[1]))fail('留白笔迹坐标无效。 / Invalid note ink coordinates.');contentHeight=Math.max(contentHeight,(p[1]+stroke.width/2)*width);}
    if(stroke.points.length===1){const p=stroke.points[0];ink.push(`<circle cx="${p[0]*width}" cy="${p[1]*width}" r="${stroke.width*width/2}" fill="${stroke.color}"/>`);}
    else ink.push(`<polyline points="${stroke.points.map(p=>`${p[0]*width},${p[1]*width}`).join(' ')}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width*width}" stroke-linecap="round" stroke-linejoin="round"/>`);
   }
   const height=headerHeight+contentHeight;
   if(!finite(height,1,LIMITS.dimension))fail('完整留白超过单页高度上限，未保存部分文件。 / A complete note exceeds the page height limit; no partial file was saved.');
   return{height,html:`<section style="position:relative;width:${width}px;height:${height}px;background:#faf7eb;color:#203e35;box-sizing:border-box"><header style="box-sizing:border-box;height:${headerHeight}px;padding:${.01*width}px ${left}px 0;${textStyle(.016*width)}">${esc(title)}</header><div style="position:relative;width:${width}px;height:${contentHeight}px"><div style="position:absolute;left:${left}px;top:${top}px;width:${.95*width}px;margin:0;${textStyle(font)}">${esc(b.text)}</div>${imageHTML.join('')}<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${contentHeight}" style="position:absolute;left:0;top:0;width:${width}px;height:${contentHeight}px;overflow:visible">${ink.join('')}</svg></div></section>`};
  };
  const sheets:ExportSheet[]=[];
  for(let number=onlyPage||1;number<=(onlyPage||pdf.numPages);number++){
   check();progress(`正在导出第 ${number}/${pdf.numPages} 页（216 DPI） / Exporting page ${number}/${pdf.numPages} (216 DPI)`);
   page=await wait(pdf.getPage(number));const base=page.getViewport({scale:1}),viewport=page.getViewport({scale:RASTER_SCALE});
   const width=base.width*CSS_SCALE,height=base.height*CSS_SCALE,pixelWidth=Math.ceil(viewport.width),pixelHeight=Math.ceil(viewport.height);
   if(!finite(width,1,LIMITS.dimension)||!finite(height,1,LIMITS.dimension)||pixelWidth*pixelHeight>LIMITS.pagePixels)fail(`第 ${number} 页超过固定清晰度导出上限，未保存部分文件。 / Page ${number} exceeds the fixed-quality export limit; no partial file was saved.`);
   totalPixels+=pixelWidth*pixelHeight;if(totalPixels>LIMITS.totalPixels)fail('完整 PDF 超过像素上限，未降低清晰度或保存部分文件。 / Complete PDF exceeds the pixel budget; quality was not reduced and no partial file was saved.');
   canvas=document.createElement('canvas');canvas.width=pixelWidth;canvas.height=pixelHeight;const context=canvas.getContext('2d');if(!context)fail('无法创建 PDF 导出画布。 / Could not create the PDF export canvas.');
   render=page.render({canvas,canvasContext:context,viewport,annotationMode:1,intent:'print'});await wait(render.promise);render=undefined;check();
   drawSnapshotAnnotations(context,marks.filter(a=>a.page===number),viewport.width,viewport.height);
   const pieces:string[]=[];let originalY=0,extendedHeight=0;
   const fragment=(end:number)=>{
    if(end<=originalY)return;check();const stripHeight=(end-originalY)*height,sy=originalY*viewport.height,sh=(end-originalY)*viewport.height;
    const strip=document.createElement('canvas');strip.width=pixelWidth;strip.height=Math.ceil(sh);
    try{const ctx=strip.getContext('2d');if(!ctx)fail('无法创建 PDF 导出画布。 / Could not create the PDF export canvas.');ctx.drawImage(canvas!,0,sy,viewport.width,sh,0,0,pixelWidth,strip.height);const url=strip.toDataURL('image/png');if(!url.startsWith('data:image/png;base64,'))fail('PDF 页面无法完整编码。 / Could not encode the complete PDF page.');pieces.push(charge(`<img alt="PDF ${number}" src="${url}" style="display:block;width:${width}px;height:${stripHeight}px;margin:0"/>`));extendedHeight+=stripHeight;originalY=end;}finally{strip.width=0;strip.height=0;}
   };
   for(const block of orderedBlocks(blocks,number)){fragment(block.anchorY);const note=await noteHTML(block,width);pieces.push(charge(note.html));extendedHeight+=note.height;}
   fragment(1);
   if(extendedHeight>LIMITS.dimension)fail(`第 ${number} 页展开后超过 14400 像素，未保存部分文件。 / Expanded page ${number} exceeds 14400 CSS pixels; no partial file was saved.`);
   const html=`<div style="width:${width}px;height:${extendedHeight}px;margin:0;padding:0;overflow:visible">${pieces.join('')}</div>`;charge(' '.repeat(html.length-pieces.reduce((n,p)=>n+p.length,0)));
   sheets.push({width:Math.ceil(width),height:Math.ceil(extendedHeight),html});
   canvas.width=0;canvas.height=0;canvas=undefined;page.cleanup();page=undefined;
  }
  check();progress('正在核对完整导出 / Verifying complete export');
  const [lastSource,lastLayers,lastNotes]=await wait(Promise.all([window.desktop.readPDFSourceInfo(request),window.desktop.readPDFLayers(request),window.desktop.readPDFExtend(request)]));
  const currentSource=value(lastSource),currentLayers=value(lastLayers),currentNotes=value(lastNotes);assertWarnings(currentLayers.warnings);assertWarnings(currentNotes.warnings);
  if(currentSource.sourceSHA256!==file.sha256||currentNotes.sourceSHA256!==file.sha256||projectionKey(currentLayers,currentNotes)!==initialKey)sourceChanged();
  check();return sheets;
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',cancelled);control.signal.removeEventListener('abort',cancelRender);
  render?.cancel();if(render)await render.promise.catch(()=>{});if(canvas){canvas.width=0;canvas.height=0;}page?.cleanup();measure?.remove();if(loading)await loading.destroy().catch(()=>{});
 }
}

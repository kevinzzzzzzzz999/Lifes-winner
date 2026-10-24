import {boardPDFOwnerIDs} from '../shared/board-pdf-owners';
import {boardFileSourceResolver} from './board-source';
import {renderToStaticMarkup} from 'react-dom/server';
import BoxContent from './BoxContent';
import {renderPDFPageImage} from './PDFViewer';
import {inkSegmentIntersectsRegion,type ExportRegion} from './export-view';
import {renderBoardExportInk} from './board-export-ink';
import {boardInkStrokeBounds} from './board-ink-clip';
import type {OpenedFile} from '../shared/desktop-api';
export type ExportSheet={html:string;width:number;height:number};
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const color=(c:unknown,fallback:string)=>typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c)?c:fallback;
export function boardBounds(board:any){
 let x=Infinity,y=Infinity,r=-Infinity,b=-Infinity;
 const add=(a:number,c:number,w:number,h:number)=>{if(![a,c,w,h].every(Number.isFinite)||w<0||h<0)throw Error('Invalid export geometry');x=Math.min(x,a);y=Math.min(y,c);r=Math.max(r,a+w);b=Math.max(b,c+h);};
 for(const i of board.items||[]){add(i.x,i.y,i.width,i.height);for(const child of i.childBoards||[])if(child.presentation?.expanded){const p=child.presentation;add(p.x,p.y,p.width,p.height);}}
 for(const s of board.webInk?.strokes||[]){if(s.clipPath!==undefined){const b=boardInkStrokeBounds(s);if(b)add(b.x,b.y,b.width,b.height);}else for(const p of s.points){const w=Math.max(0,p[2]||1);add(p[0]-w,p[1]-w,w*2,w*2);}}
 if(!Number.isFinite(x))return{x:0,y:0,width:600,height:400};
 return{x:x-24,y:y-24,width:Math.max(100,r-x+48),height:Math.max(100,b-y+48)};
}
// All items and original web ink, independent of the reading viewport or detail budget.
export async function boardExportSheet(file:OpenedFile,vaultId:string,signal:AbortSignal,progress:(s:string)=>void,region?:ExportRegion):Promise<ExportSheet>{
 if(region){
  if(![region.x,region.y,region.width,region.height].every(Number.isFinite)||region.width<=0||region.height<=0)throw Error('当前区域无效，请重新打开导出窗口。 / Invalid current area. Reopen export.');
  const overlaps=(r:any)=>r.x+r.width>region.x&&r.x<region.x+region.width&&r.y+r.height>region.y&&r.y<region.y+region.height;
  const segment=(p:number[],q:number[])=>inkSegmentIntersectsRegion(p,q,region);
  const content=(file.board as any);const visible=(content.items||[]).some((i:any)=>i.kind!=='inkGroup'&&overlaps(i)||(i.childBoards||[]).some((c:any)=>c.presentation?.expanded&&overlaps(c.presentation)))||(content.webInk?.strokes||[]).some((s:any)=>{const b=boardInkStrokeBounds(s);return b&&overlaps(b)&&s.points.some((p:number[],i:number)=>segment(p,s.points[i+1]||p));});
  const byID=new Map((content.items||[]).map((i:any)=>[String(i.id).toLowerCase(),i]));const visibleEdge=(content.edges||[]).some((e:any)=>{if(e.style?.opacity===0)return false;const a:any=byID.get(String(e.from).toLowerCase()),b:any=byID.get(String(e.to).toLowerCase());return a&&b&&segment([a.x+a.width/2,a.y+a.height/2,e.style?.strokeWidth||1],[b.x+b.width/2,b.y+b.height/2,e.style?.strokeWidth||1]);});
  if(!visible&&!visibleEdge)throw Error('当前区域没有可导出的内容，请定位笔记或选择完整白板。 / This area has no exportable content. Locate your notes or choose the entire board.');
 }
 const sourceResolvers=new Map<string,ReturnType<typeof boardFileSourceResolver>>();const resolveSource=(owner:OpenedFile,path:string)=>{const key=owner.path+':'+owner.sha256;let resolve=sourceResolvers.get(key);if(!resolve){resolve=boardFileSourceResolver(vaultId,owner);sourceResolvers.set(key,resolve);}return resolve(path);};
 const assetCache=new Map<string,Promise<string>>();let count=0,totalBytes=0,boards=0,totalInkPoints=0,totalClipCommands=0;
 const check=()=>{if(signal.aborted)throw Error('已取消 / Cancelled');};
 const asset=(owner:OpenedFile,path:string,page?:number,boardID?:string[])=>{const key=JSON.stringify([owner.path,owner.sha256,path,page,boardID]);let promise=assetCache.get(key);if(!promise){promise=(async()=>{check();const canonical=await resolveSource(owner,path);const r=await window.desktop.getAssetUrl({vaultId,path:canonical,...(boardID?{hideBoardIDs:boardID}:{})});if(!r.ok)throw Error(`${path}: ${r.error.message}`);if(page)return renderPDFPageImage(r.value.url,page,signal);const response=await fetch(r.value.url,{signal});if(!response.ok)throw Error('无法读取图片 / Image unavailable');const blob=await response.blob();if(blob.size>32*1024*1024)throw Error('图片过大 / Image too large');return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('图片读取失败 / Image read failed'));reader.readAsDataURL(blob);});})();assetCache.set(key,promise);}return promise;};
 const build=async(owner:OpenedFile,board:any,ancestors:string[]):Promise<{html:string;bounds:ReturnType<typeof boardBounds>}>=>{
  check();if(++boards>200)throw Error('子白板过多，请分组导出。 / Too many child boards for one export.');if(!board.webInk&&(board.drawing||(board.items||[]).some((i:any)=>i.inkData)))throw Error('此旧白板缺少完整笔迹预览。请在 iPad 保存一次后再导出。 / Save this legacy board on iPad to include all ink.');
  const bounds=ancestors.length===1&&region?region:boardBounds(board),rect=(i:any)=>`left:${i.x-bounds.x}px;top:${i.y-bounds.y}px;width:${i.width}px;height:${i.height}px;`,pieces:string[]=[];
  const items=board.items||[];count+=items.length;if(count>2000)throw Error('白板超过 2,000 个对象，请分白板导出。 / Export boards with at most 2,000 items separately.');
  const svg:string[]=[];const byID=new Map<string,any>(items.map((i:any)=>[i.id.toLowerCase(),i]));
  for(const e of board.edges||[]){const a=byID.get(e.from.toLowerCase()),b=byID.get(e.to.toLowerCase());if(!a||!b)continue;const s=e.style||{},dx=b.x+b.width/2-a.x-a.width/2,dy=b.y+b.height/2-a.y-a.height/2;const endpoint=(item:any,sign:number)=>{const factor=item.style?.shape==='ellipse'?1/Math.sqrt((dx/(item.width/2))**2+(dy/(item.height/2))**2):Math.min(Math.abs(item.width/(2*dx)),Math.abs(item.height/(2*dy)));const offset=Number.isFinite(factor)?factor:0;return{x:item.x+item.width/2+sign*dx*offset-bounds.x,y:item.y+item.height/2+sign*dy*offset-bounds.y};};const start=endpoint(a,1),end=endpoint(b,-1);svg.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${color(s.strokeColor,'#8bada8')}" stroke-width="${Math.max(1,Math.min(12,s.strokeWidth||1))}" opacity="${s.opacity??1}" stroke-dasharray="${s.dash==='dashed'?'10 6':s.dash==='dotted'?'2 5':s.dash==='dashDot'?'10 5 2 5':''}" ${s.arrow==='both'?'marker-start="url(#export-arrow)"':''} ${['both','end'].includes(s.arrow)?'marker-end="url(#export-arrow)"':''}/>`);}
  pieces.push(`<svg style="position:absolute;inset:0;width:${bounds.width}px;height:${bounds.height}px" width="${bounds.width}" height="${bounds.height}"><defs><marker id="export-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker></defs>${svg.join('')}</svg>`);
  for(let n=0;n<items.length;n++){
   check();const i=items[n];if(i.kind==='pdfPage'&&!i.sourcePath)throw Error('PDF 页面缺少来源，未生成不完整导出。 / Missing PDF source.');progress(`正在准备白板对象 ${n+1}/${items.length} / Preparing board items`);
   let body='',style=i.style||{},image=false;
   if(i.sourcePath&&(i.kind==='pdfPage'||/\.(png|jpe?g|pdf)$/i.test(i.sourcePath))){image=true;const pdf=/\.pdf$/i.test(i.sourcePath);const url=await asset(owner,i.sourcePath,pdf?(i.page||1):undefined,pdf?boardPDFOwnerIDs(board):undefined);totalBytes+=url.length;if(totalBytes>160*1024*1024)throw Error('导出图片总量过大，请分白板导出。 / Export image budget exceeded.');body=`<img src="${esc(url)}" style="width:100%;height:100%;object-fit:${pdf||i.boardNotesObject?'fill':'contain'};display:block"/>`;}
   else if(i.kind==='text'||i.kind==='formula'){body=`<strong>${esc(i.title)}</strong>`+renderToStaticMarkup(<BoxContent text={i.text||''} textFormat={i.textFormat} richTextHTML={i.richTextHTML} fallbackKind={i.kind}/>);}
   else {body=`<strong>${esc(i.title)}</strong><p>${esc(i.text||i.url||i.sourcePath||'')}</p>`;}
   if(i.kind!=='inkGroup')pieces.push(`<div class="export-board-item" style="${rect(i)}${image?'padding:0;border:0;':`padding:10px;border:${Math.max(1,Math.min(8,style.strokeWidth||1))}px solid ${color(style.strokeColor,'#cbd6d2')};background:${color(style.fillColor,'#ffffff')};`}color:${color(style.textColor,'#233c36')};font-size:${Math.max(8,Math.min(72,style.fontSize||16))}px;border-radius:${style.shape==='ellipse'?'50%':style.shape==='rounded'?'16px':'0'}">${body}</div>`);
   for(const child of i.childBoards||[])if(child.presentation?.expanded){
    if(ancestors.includes(child.path)||ancestors.length>=5)throw Error('展开的子白板存在循环或层级过深，请收起后单独导出。 / Export recursive child boards separately.');
    const childPath=await resolveSource(owner,child.path);const result=await window.desktop.readFile({vaultId,path:childPath});if(!result.ok||!result.value.board||String(result.value.board.id).toLowerCase()!==String(child.id).toLowerCase())throw Error(`无法读取子白板 / Child board unavailable: ${child.path}`);
    const p=child.presentation,c=await build(result.value,result.value.board,[...ancestors,child.path]),scale=Math.min(p.width/c.bounds.width,Math.max(1,p.height-30)/c.bounds.height);
    pieces.push(`<section style="position:absolute;${rect(p)}border:1px solid #81a99b;background:white;overflow:hidden"><header style="height:30px;padding:5px">${esc(child.title)}</header><div style="position:relative;transform-origin:0 0;transform:scale(${scale});width:${c.bounds.width}px;height:${c.bounds.height}px">${c.html}</div></section>`);
   }
  }
  totalInkPoints+=(board.webInk?.strokes||[]).reduce((n:number,s:any)=>n+s.points.length,0);if(totalInkPoints>2_000_000)throw Error('笔迹点过多，请分白板导出。 / Too many ink points for one export.');
  totalClipCommands+=(board.webInk?.strokes||[]).reduce((n:number,s:any)=>n+(s.clipPath?.length||0),0);if(totalClipCommands>100000)throw Error('笔迹裁剪数据过多，请分白板导出。 / Too many ink clip commands.');
  const ink=await renderBoardExportInk(board.webInk?.strokes||[],bounds,signal,progress);
  pieces.push(`<svg style="position:absolute;inset:0;width:${bounds.width}px;height:${bounds.height}px" width="${bounds.width}" height="${bounds.height}">${ink}</svg>`);
  const html=pieces.join('');if(html.length>100*1024*1024)throw Error('白板导出内容过大，请分组导出。 / Board export exceeds its preparation budget.');return{html,bounds};
 };
 const result=await build(file,file.board,[file.path]);const scale=Math.min(1,10000/Math.max(result.bounds.width,result.bounds.height));
 return{width:Math.ceil(result.bounds.width*scale),height:Math.ceil(result.bounds.height*scale),html:`<div style="position:relative;width:${result.bounds.width}px;height:${result.bounds.height}px;transform-origin:0 0;transform:scale(${scale})">${result.html}</div>`};
}
export async function printExportSheets(sheets:ExportSheet[],name:string,signal?:AbortSignal,onPrinting?:()=>void,source?:{vaultId:string;path:string;expectedSHA256:string}){
 const check=()=>{if(signal?.aborted)throw Error('已取消 / Cancelled');};
 const wait=<T,>(p:Promise<T>)=>new Promise<T>((resolve,reject)=>{const abort=()=>reject(Error('已取消 / Cancelled'));signal?.addEventListener('abort',abort,{once:true});p.then(value=>{signal?.removeEventListener('abort',abort);try{check();resolve(value);}catch(e){reject(e);}},error=>{signal?.removeEventListener('abort',abort);reject(error);});if(signal?.aborted)abort();});
 const node=document.createElement('div');node.id='inkspace-export-document';const style=document.createElement('style');
 style.textContent=`#inkspace-export-document{display:block;position:fixed;left:-100000px;top:0;pointer-events:none}.export-sheet{position:relative;background:white;color:#111;overflow:hidden;box-sizing:border-box;break-after:page}.export-sheet:last-child{break-after:auto}.export-board-item{position:absolute;box-sizing:border-box;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}.export-board-item .box-content{overflow:visible;max-height:none}.export-board-item table{width:100%;border-collapse:collapse}.export-board-item td,.export-board-item th{border:1px solid #aaa;padding:5px}.export-board-item p{margin:6px 0}@media print{html,body{height:auto!important;overflow:visible!important;margin:0!important;padding:0!important}body>*,body>#root{display:none!important}body>#inkspace-export-document{display:block!important;position:static!important;inset:auto!important;width:auto!important;height:auto!important}#inkspace-export-document canvas{display:block!important}#inkspace-export-document *{print-color-adjust:exact!important;-webkit-print-color-adjust:exact!important}}`+sheets.map((s,i)=>`@page exportpage${i}{size:${s.width}px ${s.height}px;margin:0}`).join('');
 node.innerHTML=sheets.map((s,i)=>`<section class="export-sheet" style="width:${s.width}px;height:${s.height}px;page:exportpage${i}">${s.html}</section>`).join('');document.head.append(style);document.body.append(node);
 try{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));await wait(document.fonts.ready);for(const box of node.querySelectorAll<HTMLElement>('.export-board-item'))if(box.scrollHeight>box.clientHeight+2||box.scrollWidth>box.clientWidth+2)throw Error('有文字框内容超出边界，请先调大该框再导出，避免文字被裁掉。 / Enlarge overflowing text boxes before export so no text is clipped.');await wait(Promise.all(Array.from(node.querySelectorAll('img')).map(i=>i.decode())));await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));check();onPrinting?.();const r=await window.desktop.exportCurrentViewPDF({name,source});if(!r.ok)throw Error(r.error.message);return r.value;}
 finally{node.remove();style.remove();}
}

import {useEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import type {Language} from './i18n';
import {usePDFTranslation,providerLabel,type Capture,type PDFSelectionConfig} from './PDFTranslation';
import {useOfficeTextSelection} from './OfficeTextSelection';
import './document-translation.css';
type Rect={x:number;y:number;width:number;height:number};
const overlaps=(a:DOMRect,b:Rect)=>a.width>0&&a.height>0&&a.right>b.x&&a.left<b.x+b.width&&a.bottom>b.y&&a.top<b.y+b.height;
/** Local-only extraction. Nothing is sent until the confirmation panel is approved. */
export function selectedDocumentText(article:HTMLElement,area:Rect):string{
 const walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT),range=document.createRange();let node:Node|null,visited=0,checks=0,count=0,lastBlock:Element|null=null,result='';
 while((node=walker.nextNode())){
  if(++visited>20000)throw Error('SELECTION_TOO_LARGE');const value=node.textContent||'',parent=node.parentElement;if(!value.trim()||!parent)continue;
  if(parent.closest('script,style,[hidden],[aria-hidden="true"]'))continue;
  const style=getComputedStyle(parent);if(style.visibility!=='visible'||style.display==='none'||Number(style.opacity)===0)continue;
  range.selectNodeContents(node);if(![...range.getClientRects()].some(rect=>overlaps(rect,area)))continue;
  let chosen='';for(let index=0;index<value.length;){if(++checks>40000)throw Error('SELECTION_TOO_LARGE');const char=String.fromCodePoint(value.codePointAt(index)!);range.setStart(node,index);range.setEnd(node,index+char.length);if([...range.getClientRects()].some(rect=>overlaps(rect,area))){chosen+=char;if(++count>12000)throw Error('SELECTION_TOO_LARGE');}index+=char.length;}
  if(!chosen)continue;const block=parent.closest('p,div,h1,h2,h3,h4,h5,h6,li,td,th,section')||parent;
  if(result&&block!==lastBlock)result+='\n';result+=chosen;lastBlock=block;
 }
 return result.trim();
}
function DocumentSelection({content,config}:{content:RefObject<HTMLDivElement|null>;config:PDFSelectionConfig}){
 const element=useRef<HTMLDivElement>(null),gesture=useRef<{id:number;x:number;y:number;bounds:DOMRect;articleBounds:DOMRect}|null>(null),[rect,setRect]=useState<Rect|null>(null);
 const clear=()=>{gesture.current=null;setRect(null);};
 useEffect(()=>{const overlay=element.current;if(!overlay)return;const wheel=(event:WheelEvent)=>{event.preventDefault();clear();content.current?.querySelector('.document-preview')?.scrollBy({left:event.deltaX,top:event.deltaY});};overlay.addEventListener('wheel',wheel,{passive:false});const resize=()=>clear();window.addEventListener('resize',resize);return()=>{overlay.removeEventListener('wheel',wheel);window.removeEventListener('resize',resize);};},[]);
 return <div ref={element} className="document-translation-selection" data-testid="document-translation-selection" tabIndex={0} role="region" aria-label={config.language==='zh'?'拖动圈选可见文字，先预览再翻译':'Select visible text to preview before translation'} onPointerDown={event=>{
  if(event.button!==0)return;event.preventDefault();const article=content.current?.querySelector('article');if(!article)return;const bounds=event.currentTarget.getBoundingClientRect();gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,bounds,articleBounds:article.getBoundingClientRect()};event.currentTarget.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId);setRect({x:event.clientX-bounds.left,y:event.clientY-bounds.top,width:0,height:0});
 }} onPointerMove={event=>{const start=gesture.current;if(!start||start.id!==event.pointerId)return;const x=Math.max(start.bounds.left,Math.min(start.bounds.right,event.clientX)),y=Math.max(start.bounds.top,Math.min(start.bounds.bottom,event.clientY));setRect({x:Math.min(x,start.x)-start.bounds.left,y:Math.min(y,start.y)-start.bounds.top,width:Math.abs(x-start.x),height:Math.abs(y-start.y)});}} onPointerUp={event=>{
  const start=gesture.current;clear();if(!start||start.id!==event.pointerId)return;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);const article=content.current?.querySelector('article');if(!article)return;const now=article.getBoundingClientRect();if(Math.abs(now.x-start.articleBounds.x)>1||Math.abs(now.y-start.articleBounds.y)>1||Math.abs(now.width-start.articleBounds.width)>1){config.onError(config.language==='zh'?'页面位置已改变，请重新圈选。':'The document moved. Select the area again.');return;}
  const x=Math.max(start.bounds.left,Math.min(start.bounds.right,event.clientX)),y=Math.max(start.bounds.top,Math.min(start.bounds.bottom,event.clientY)),area={x:Math.min(x,start.x),y:Math.min(y,start.y),width:Math.abs(x-start.x),height:Math.abs(y-start.y)};if(area.width<5||area.height<5)return;
  try{const text=selectedDocumentText(article,area);if(!text){config.onError(config.language==='zh'?'没有选到可读取的文字。图片中的文字可用“选择画面文字”。':'No readable text in this area. For text inside images, use Select visible text.');return;}config.onSelect({text,width:area.width,height:area.height,label:config.language==='zh'?'文档选区':'Document selection',anchor:area});}catch{config.onError(config.language==='zh'?'选区较大，请缩小范围后重试。':'This selection is too large. Select a smaller area.');}
 }} onPointerCancel={clear} onLostPointerCapture={clear} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();clear();}}}>{rect&&<div className="pdf-translation-rectangle" style={{left:rect.x,top:rect.y,width:rect.width,height:rect.height}}/>}</div>;
}
export default function OfficeTranslationFrame({children,language,owner,revision}:{children:ReactNode;language:Language;owner:string;revision:unknown}){
 const content=useRef<HTMLDivElement>(null),ocr=useOfficeTextSelection({content,language,owner,revision}),translation=usePDFTranslation(owner,language,ocr.clear,'document'),[draft,setDraft]=useState<{capture:Capture;submit:(capture:Capture)=>void;provider:string;endpoint:string;model:string}|null>(null),zh=language==='zh';
 useEffect(()=>{if(!translation.selection)setDraft(null);},[!!translation.selection]);
 // Hold the exact selection and destination locally. Releasing a rectangle does
 // not contact any provider. Only this explicitly labelled button submits it.
 const selection=translation.selection?{...translation.selection,onSelect:(capture:Capture)=>{const service=translation.service;setDraft({capture,submit:translation.selection!.onSelect,provider:providerLabel(service?.provider||'openai'),endpoint:service?.providers.find(p=>p.id===service.provider)?.endpoint||'',model:service?.model||''});}}:undefined;
 return <div className="office-translation-reader" data-testid="office-translation-reader"><div className="office-translation-toolbar">{ocr.controls(()=>{translation.disable();setDraft(null);})}{translation.controls}</div>{ocr.notice}{translation.notice}<div className="office-translation-content" ref={content} onPointerDownCapture={ocr.captureDown} onPointerMoveCapture={ocr.captureMove} onPointerUpCapture={ocr.cancelPress} onPointerCancelCapture={ocr.cancelPress}>{children}{selection&&!draft&&<DocumentSelection content={content} config={selection}/>} {ocr.overlay}</div>{draft&&<section className="office-translation-confirm" data-testid="document-translation-confirm" role="dialog" aria-modal="true" aria-label={zh?'确认翻译选区':'Confirm translation selection'} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape')setDraft(null);}}><h3>{zh?'翻译这些文字':'Translate this selection'}</h3><p>{zh?'仅将下列文字发送给':'Send only the following text to'} <strong>{draft.provider}</strong> · {draft.model}</p><small>{draft.endpoint}</small><pre data-testid="document-selection-preview">{draft.capture.text}</pre><div><button data-testid="document-translation-cancel" onClick={()=>setDraft(null)}>{zh?'取消':'Cancel'}</button><button className="primary" data-testid="document-translation-send" onClick={()=>{const approved=draft;setDraft(null);approved.submit(approved.capture);}}>{zh?'发送并翻译':'Send and translate'}</button></div></section>}{translation.card}</div>;
}

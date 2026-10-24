import {useCallback,useEffect,useLayoutEffect,useRef,type RefObject} from 'react';
import {clampPDFReaderZoom,pdfReaderWheelZoom,pdfReaderZoomAnchor,type PDFReaderZoomAnchor,type PDFReaderZoomPoint} from './pdf-reader-zoom';

/** Chromium delivers a trackpad pinch as a Ctrl+wheel gesture. Consume it only
 * inside this reader; each pane keeps its own document scale, not browser zoom. */
export function usePDFPinchZoom(box:RefObject<HTMLDivElement|null>,zoom:number,onZoom:(zoom:number,anchorPage?:string)=>void,locked:boolean,identity:string){
 const state=useRef({zoom,onZoom,locked});state.current={zoom,onZoom,locked};
 const anchor=useRef<PDFReaderZoomAnchor|null>(null),pointers=useRef(new Set<number>());
 const zoomTo=useCallback((requested:number,point?:PDFReaderZoomPoint)=>{
  const node=box.current;if(!node||state.current.locked||pointers.current.size)return;
  const old=state.current.zoom,next=clampPDFReaderZoom(requested,old);
  if(Math.abs(old-next)<1e-7)return;
  const area=node.getBoundingClientRect(),target=point??{x:area.left+node.clientLeft+node.clientWidth/2,y:area.top+node.clientTop+node.clientHeight/2};
  if(!Number.isFinite(target.x)||!Number.isFinite(target.y))return;
  const pages=Array.from(node.querySelectorAll<HTMLElement>('.pdf-reading-page')).map(page=>({page:page.dataset.page||'',rect:page.getBoundingClientRect()}));
  anchor.current=pdfReaderZoomAnchor(pages,target);
  state.current.zoom=next;state.current.onZoom(next,anchor.current?.page);
 },[box]);
 useEffect(()=>{
  const node=box.current;if(!node)return;
  let frame=0,delta=0,point={x:0,y:0};
  const down=(event:PointerEvent)=>{pointers.current.add(event.pointerId);};
  const up=(event:PointerEvent)=>{pointers.current.delete(event.pointerId);};
  const cancel=()=>{pointers.current.clear();delta=0;cancelAnimationFrame(frame);frame=0;anchor.current=null;};
  const wheel=(event:WheelEvent)=>{
   if(!event.ctrlKey)return;
   // Also suppress browser zoom during a protected stroke/draft or at a scale
   // limit. A denied document gesture must not resize the whole application.
   event.preventDefault();event.stopPropagation();
   if(state.current.locked||pointers.current.size||!Number.isFinite(event.deltaY))return;
   delta+=Math.max(-240,Math.min(240,event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?node.clientHeight:1)));
   point={x:event.clientX,y:event.clientY};
   if(frame)return;
   frame=requestAnimationFrame(()=>{
    frame=0;const amount=delta;delta=0;
    zoomTo(pdfReaderWheelZoom(state.current.zoom,amount),point);
   });
  };
  node.addEventListener('wheel',wheel,{passive:false});node.addEventListener('pointerdown',down,true);
  window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);window.addEventListener('blur',cancel);
  return()=>{cancel();node.removeEventListener('wheel',wheel);node.removeEventListener('pointerdown',down,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);window.removeEventListener('blur',cancel);};
 },[box,identity,zoomTo]);
 useLayoutEffect(()=>{
  const pending=anchor.current,node=box.current;if(!pending||!node)return;anchor.current=null;
  const page=Array.from(node.querySelectorAll<HTMLElement>('.pdf-reading-page')).find(p=>p.dataset.page===pending.page);if(!page)return;
  const rect=page.getBoundingClientRect();node.scrollLeft+=rect.left+pending.x*rect.width-pending.clientX;node.scrollTop+=rect.top+pending.y*rect.width-pending.clientY;
 },[zoom,box]);
 return zoomTo;
}

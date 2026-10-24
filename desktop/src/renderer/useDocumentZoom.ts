import {useEffect,useLayoutEffect,useRef,useState,type RefObject,type CSSProperties} from 'react';
import {clampDocumentZoom,documentWheelZoom,documentZoomShift,type DocumentZoomAnchor} from './document-zoom';

// Store only a scale, never document contents or DOM, while a file is unmounted.
const remembered=new Map<string,number>();
export function useDocumentZoom(viewport:RefObject<HTMLDivElement|null>,page:RefObject<HTMLElement|null>,identity:string,maximumWidth=900,gutter=36,enabled=true){
 const [zoom,setZoom]=useState(()=>remembered.get(identity)||1),[width,setWidth]=useState<number>();
 const latest=useRef(zoom);latest.current=zoom;
 const pending=useRef<DocumentZoomAnchor|null>(null),owner=useRef(identity);owner.current=identity;
 const change=(value:number,point?:{x:number;y:number})=>{
  const node=viewport.current,article=page.current,next=clampDocumentZoom(value);if(!node||!article||next===latest.current)return;
  const box=node.getBoundingClientRect(),rect=article.getBoundingClientRect();
  const x=point?.x??box.left+node.clientWidth/2,y=point?.y??box.top+Math.min(node.clientHeight/2,200);
  pending.current={x:(x-rect.left)/latest.current,y:(y-rect.top)/latest.current,clientX:x,clientY:y};
  latest.current=next;remembered.delete(owner.current);remembered.set(owner.current,next);
  if(remembered.size>100)remembered.delete(remembered.keys().next().value!);setZoom(next);
 };
 const action=useRef(change);action.current=change;
 useLayoutEffect(()=>{pending.current=null;const next=remembered.get(identity)||1;latest.current=next;setZoom(next);},[identity]);
 useLayoutEffect(()=>{const node=viewport.current;if(!enabled||!node)return;const resize=()=>setWidth(Math.max(120,Math.min(maximumWidth,node.clientWidth-gutter)));resize();const observer=new ResizeObserver(resize);observer.observe(node);return()=>observer.disconnect();},[viewport,identity,maximumWidth,gutter,enabled]);
 useEffect(()=>{
  const node=viewport.current;if(!enabled||!node)return;let frame=0,delta=0,point={x:0,y:0};
  const cancel=()=>{cancelAnimationFrame(frame);frame=0;delta=0;pending.current=null;};
  const wheel=(event:WheelEvent)=>{
   if(!event.ctrlKey)return;
   // A trackpad pinch belongs to this document. At either limit it must still
   // not escape and magnify the application chrome or the other reading pane.
   event.preventDefault();event.stopPropagation();if(!Number.isFinite(event.deltaY))return;
   delta+=Math.max(-300,Math.min(300,event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?node.clientHeight:1)));
   point={x:event.clientX,y:event.clientY};if(frame)return;
   frame=requestAnimationFrame(()=>{frame=0;const value=delta;delta=0;action.current(documentWheelZoom(latest.current,value,0,node.clientHeight),point);});
  };
  node.addEventListener('wheel',wheel,{passive:false});window.addEventListener('blur',cancel);
  return()=>{cancel();node.removeEventListener('wheel',wheel);window.removeEventListener('blur',cancel);};
 },[viewport,identity,enabled]);
 useLayoutEffect(()=>{const anchor=pending.current,node=viewport.current,article=page.current;if(!anchor||!node||!article)return;pending.current=null;const shift=documentZoomShift(anchor,article.getBoundingClientRect(),zoom);node.scrollLeft+=shift.x;node.scrollTop+=shift.y;},[zoom,width,viewport,page]);
 return {zoom,change,style:{zoom,...(width?{width,maxWidth:'none',minWidth:width}: {})} satisfies CSSProperties};
}

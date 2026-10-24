import {useLayoutEffect,useRef,useState} from 'react';
import type {PDFRenderRegion} from './board-pdf-resolution';

// Reader detail is bounded by the visible window, never by the size of a
// whole-board PDF. The existing overview stays underneath during a gesture.
export function usePDFReaderRegion(width:number,height:number,from:number,to:number){
 const ref=useRef<HTMLDivElement>(null),[region,setRegion]=useState<PDFRenderRegion>();
 useLayoutEffect(()=>{
  const node=ref.current,root=node?.closest<HTMLDivElement>('.pdf-reading-scroll');
  if(!node||!root)return;
  let frame=0;
  const measure=()=>{
   frame=0;
   const page=node.getBoundingClientRect(),view=root.getBoundingClientRect();
   const left=Math.max(0,view.left+root.clientLeft-page.left-128),right=Math.min(width,view.left+root.clientLeft+root.clientWidth-page.left+128);
   const top=Math.max(from*height,view.top+root.clientTop-page.top-128),bottom=Math.min(to*height,view.top+root.clientTop+root.clientHeight-page.top+128);
   let next:PDFRenderRegion|undefined;
   if(right>left&&bottom>top&&width>0&&height>0){
    // Quantize the crop outwards to avoid replacing the render for every tiny
    // scroll delta. Restrict it to this source fragment, not inserted notes.
    const x=Math.max(0,Math.floor(left/64)*64),y=Math.max(from*height,Math.floor(top/64)*64);
    const w=Math.min(width,Math.ceil(right/64)*64)-x,h=Math.min(to*height,Math.ceil(bottom/64)*64)-y;
    const density=Math.min(2,window.devicePixelRatio||1,4096/w,4096/h,Math.sqrt(8_000_000/(w*h)));
    const value={x,y,width:w,height:h,pageWidth:width,pageHeight:height,pixelWidth:Math.max(1,Math.floor(w*density)),pixelHeight:Math.max(1,Math.floor(h*density))};
    next={...value,key:JSON.stringify(value)};
   }
   setRegion(old=>old?.key===next?.key?old:next);
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
  const resize=new ResizeObserver(schedule);resize.observe(root);resize.observe(node);
  root.addEventListener('scroll',schedule,{passive:true});
  // Continuous-page virtualization can reposition an existing fragment without
  // changing its size. Observe visibility as well as resize and native scroll.
  const intersection=new IntersectionObserver(schedule,{root,rootMargin:'128px'});intersection.observe(node);
  schedule();
  return()=>{cancelAnimationFrame(frame);resize.disconnect();intersection.disconnect();root.removeEventListener('scroll',schedule);};
 },[width,height,from,to]);
 return {ref,region};
}

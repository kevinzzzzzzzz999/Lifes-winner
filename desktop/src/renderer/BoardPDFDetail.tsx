import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {PDFPage} from './PDFViewer';
import type {PDFSelectionConfig} from './PDFTranslation';
import type {PDFRenderRegion} from './board-pdf-resolution';
import {createPDFDetailState,requestPDFDetail,finishPDFDetail,pdfDetailFrameScale,pdfDetailCoversRequest} from './board-pdf-progressive';

/** One finished crop and one independent renderer; camera updates queue only the latest demand. */
export function BoardPDFDetail({url,page,region,translation,onCoverageChange}:{url:string;page:number;region:PDFRenderRegion;translation?:PDFSelectionConfig;onCoverageChange:(covered:boolean)=>void}){
 const [state,setState]=useState(()=>createPDFDetailState(region)),coverageCallback=useRef(onCoverageChange);coverageCallback.current=onCoverageChange;
 useEffect(()=>{setState(old=>requestPDFDetail(old,region));},[region.key]);
 const budget=region.pixelBudget??Infinity;
 const front=state.front&&state.front.region.pixelWidth*state.front.region.pixelHeight<=budget?state.front:undefined;
 const covered=pdfDetailCoversRequest(front?.region,region);
 useLayoutEffect(()=>{coverageCallback.current(covered);},[covered]);
 useEffect(()=>()=>coverageCallback.current(false),[]);
 const active=state.active&&state.active.region.pixelWidth*state.active.region.pixelHeight<=budget?state.active:undefined;
 const frames=[front,active].filter((frame):frame is NonNullable<typeof frame>=>!!frame);
 return <div className="board-pdf-detail" data-testid="board-pdf-progressive" data-ready={!!front} data-coverage-ready={covered} data-front-region={front?.region.key} data-pending-region={active?.region.key} data-latest-region={state.latest.key} data-front-count={front?1:0} data-pending-count={active?1:0} data-frame-pixels={frames.reduce((n,f)=>n+f.region.pixelWidth*f.region.pixelHeight,0)} data-frame-budget={region.pixelBudget}>
  {frames.map(frame=>{const isFront=frame.id===front?.id,scale=pdfDetailFrameScale(frame.region,region);return <div key={frame.id} data-testid={isFront?'board-pdf-front':'board-pdf-pending'} data-detail-frame={frame.id} aria-hidden={!isFront} style={{position:'absolute',left:0,top:0,width:frame.region.pageWidth,height:frame.region.pageHeight,transform:`scale(${scale.x},${scale.y})`,transformOrigin:'top left',visibility:isFront?'visible':'hidden',pointerEvents:isFront?'auto':'none'}}>
   <PDFPage url={url} page={page} region={frame.region} annotationMode={1} renderDelayMs={0} releaseBackingOnDispose captureEnabled={isFront} translation={isFront?translation:undefined} onRendered={()=>setState(old=>finishPDFDetail(old,frame.id,true))} onFailure={()=>setState(old=>finishPDFDetail(old,frame.id,false))}/>
  </div>;})}
 </div>;
}

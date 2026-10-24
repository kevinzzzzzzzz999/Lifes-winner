import type {PDFRenderRegion} from './board-pdf-resolution';
export type PDFDetailFrame={id:number;region:PDFRenderRegion};
export type PDFDetailState={front?:PDFDetailFrame;active?:PDFDetailFrame;latest:PDFRenderRegion;nextID:number;failedKey?:string};
const pixels=(frame:PDFDetailFrame)=>frame.region.pixelWidth*frame.region.pixelHeight;
export function createPDFDetailState(region:PDFRenderRegion):PDFDetailState{return{active:{id:1,region},latest:region,nextID:2};}
export function requestPDFDetail(state:PDFDetailState,region:PDFRenderRegion):PDFDetailState{
 const budget=region.pixelBudget??Infinity;
 const front=state.front&&pixels(state.front)<=budget?state.front:undefined;
 const active=state.active&&pixels(state.active)<=budget?state.active:undefined;
 if(active)return state.latest.key===region.key&&front===state.front&&active===state.active?state:{...state,front,active,latest:region};
 const adequate=front&&pdfDetailCoversRequest(front.region,region)&&pdfDetailFrameScore(front.region,region).density+1e-6>=Math.min(region.pixelWidth/region.width,region.pixelHeight/region.height);
 if(adequate||state.failedKey===region.key)return{...state,front,active:undefined,latest:region};
 return{...state,front,active:{id:state.nextID,region},latest:region,nextID:state.nextID+1,failedKey:undefined};
}
export function finishPDFDetail(state:PDFDetailState,id:number,succeeded:boolean):PDFDetailState{
 if(state.active?.id!==id)return state;
 // A finished but now-distant job must not evict a crop still useful at the
 // latest camera. Compare in current page coordinates, including during zoom.
 const front=succeeded?choosePDFDetailFront(state.front,state.active,state.latest):state.front;
 const failedKey=succeeded?undefined:state.active.region.key;
 const next={...state,front,active:undefined,failedKey};
 return requestPDFDetail(next,state.latest);
}
/** Map an old crop with its original page dimensions into the current page. */
export function pdfDetailFrameScale(frame:PDFRenderRegion,current:PDFRenderRegion){return{x:current.pageWidth/frame.pageWidth,y:current.pageHeight/frame.pageHeight};}
export function pdfDetailFrameScore(frame:PDFRenderRegion,current:PDFRenderRegion){
 const scale=pdfDetailFrameScale(frame,current),x=frame.x*scale.x,y=frame.y*scale.y,width=frame.width*scale.x,height=frame.height*scale.y;
 const overlap=Math.max(0,Math.min(x+width,current.x+current.width)-Math.max(x,current.x))*Math.max(0,Math.min(y+height,current.y+current.height)-Math.max(y,current.y));
 return{coverage:overlap/(current.width*current.height),density:Math.min(frame.pixelWidth/width,frame.pixelHeight/height)};
}
function choosePDFDetailFront(front:PDFDetailFrame|undefined,candidate:PDFDetailFrame,current:PDFRenderRegion){
 const next=pdfDetailFrameScore(candidate.region,current);
 if(!front)return next.coverage>0?candidate:undefined;
 const previous=pdfDetailFrameScore(front.region,current),epsilon=1e-6;
 if(next.coverage>previous.coverage+epsilon)return candidate;
 if(previous.coverage>next.coverage+epsilon||next.coverage===0)return front;
 if(next.density>previous.density+epsilon)return candidate;
 if(previous.density>next.density+epsilon)return front;
 return candidate.region.key===current.key&&front.region.key!==current.key?candidate:front;
}
export function pdfDetailCoversRequest(frame:PDFRenderRegion|undefined,current:PDFRenderRegion){
 if(!frame)return false;const scale=pdfDetailFrameScale(frame,current),epsilon=.01;
 return frame.x*scale.x<=current.x+epsilon&&frame.y*scale.y<=current.y+epsilon&&(frame.x+frame.width)*scale.x+epsilon>=current.x+current.width&&(frame.y+frame.height)*scale.y+epsilon>=current.y+current.height;
}

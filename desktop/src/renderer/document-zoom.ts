export const MIN_DOCUMENT_ZOOM=.25,MAX_DOCUMENT_ZOOM=4;
export function clampDocumentZoom(value:number){return Number.isFinite(value)?Math.max(MIN_DOCUMENT_ZOOM,Math.min(MAX_DOCUMENT_ZOOM,value)):1;}
export function documentWheelZoom(zoom:number,delta:number,mode:number,height:number){
 if(!Number.isFinite(delta))return clampDocumentZoom(zoom);
 const pixels=delta*(mode===1?16:mode===2?Math.max(1,height):1);
 return clampDocumentZoom(clampDocumentZoom(zoom)*Math.exp(-Math.max(-300,Math.min(300,pixels))*.002));
}
export type DocumentZoomAnchor={x:number;y:number;clientX:number;clientY:number};
export function documentZoomShift(anchor:DocumentZoomAnchor,rect:{left:number;top:number},zoom:number){
 return {x:rect.left+anchor.x*zoom-anchor.clientX,y:rect.top+anchor.y*zoom-anchor.clientY};
}

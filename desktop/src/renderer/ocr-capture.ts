/** Shared on-demand OCR pixel budgets. These do not run while writing. */
export const OCR_MAX_DIMENSION=4096;
export const OCR_MAX_PIXELS=12_000_000;
export const OCR_MAX_DATA_URL=8*1024*1024;
export function ocrCaptureScale(width:number,height:number,preferred=3){
 if(![width,height,preferred].every(Number.isFinite)||width<=0||height<=0||preferred<=0)throw Error('INVALID_GEOMETRY');
 return Math.min(preferred,OCR_MAX_DIMENSION/width,OCR_MAX_DIMENSION/height,Math.sqrt(OCR_MAX_PIXELS/(width*height)));
}
export function boundedOCRPNG(canvas:HTMLCanvasElement){
 for(let attempt=0;attempt<9;attempt++){
  const value=canvas.toDataURL('image/png');if(value.length<=OCR_MAX_DATA_URL)return value;
  const smaller=document.createElement('canvas');smaller.width=Math.max(1,Math.floor(canvas.width*.8));smaller.height=Math.max(1,Math.floor(canvas.height*.8));
  try{smaller.getContext('2d')!.drawImage(canvas,0,0,smaller.width,smaller.height);canvas.width=smaller.width;canvas.height=smaller.height;canvas.getContext('2d')!.drawImage(smaller,0,0);}finally{smaller.width=0;smaller.height=0;}
 }
 throw Error('TOO_LARGE');
}
export function selectDOMWordAt(root:HTMLElement,point:{x:number;y:number}){
 const doc=document as Document&{caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;caretRangeFromPoint?:(x:number,y:number)=>Range|null};
 const caret=doc.caretPositionFromPoint?.(point.x,point.y);let range=caret?document.createRange():doc.caretRangeFromPoint?.(point.x,point.y);
 if(caret&&range){range.setStart(caret.offsetNode,caret.offset);range.collapse(true);}
 if(!range||!root.contains(range.startContainer))return;
 const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
 if(range.collapsed){selection?.modify('move','backward','word');selection?.modify('extend','forward','word');}
}

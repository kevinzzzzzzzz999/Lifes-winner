import {applyBoardInkClip} from './board-ink-clip';

export type BoardPaintStroke={points:readonly (readonly number[])[];color:string;opacity:number;clipPath?:readonly unknown[]};

/** Paint one preview stroke without letting its mask affect later strokes. */
export function paintBoardInkStroke(context:CanvasRenderingContext2D,stroke:BoardPaintStroke,stride=1):void {
  const step=Math.max(1,Math.ceil(stride));
  if(!Number.isFinite(step)||stroke.opacity===0||stroke.clipPath?.length===0)return;
  const masked=stroke.clipPath!==undefined;
  if(masked)context.save();
  try {
    if(stroke.clipPath!==undefined)applyBoardInkClip(context,stroke.clipPath);
    context.strokeStyle=/^#[0-9a-f]{6}$/i.test(stroke.color)?stroke.color:'#243b38';
    context.fillStyle=context.strokeStyle;context.globalAlpha=stroke.opacity;context.lineCap='round';context.lineJoin='round';
    for(let index=0;index<stroke.points.length;index+=step){
      const a=stroke.points[index],b=stroke.points[Math.min(index+step,stroke.points.length-1)];
      context.lineWidth=(a[2]+b[2])/2;context.beginPath();context.moveTo(a[0],a[1]);context.lineTo(b[0],b[1]);context.stroke();
      if(index===stroke.points.length-1||stroke.points.length===1){context.beginPath();context.arc(a[0],a[1],a[2]/2,0,Math.PI*2);context.fill();}
    }
  } finally {if(masked)context.restore();}
}

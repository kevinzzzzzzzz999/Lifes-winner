import {memo,useEffect,useRef} from 'react';
import {paintBoardInkStroke,type BoardPaintStroke} from './board-ink-paint';
import {mergePreviewPlan,type MergeRect} from './board-merge-placement';
type Card=MergeRect&{id:string;title?:string;text?:string;kind?:string;page?:number;style?:{fillColor?:string;textColor?:string;strokeColor?:string}};
const color=(value:unknown,fallback:string)=>typeof value==='string'&&/^#[a-f\d]{6}$/i.test(value)?value:fallback;
/** One bounded bitmap per source. Pointer movement only changes the outer DOM transform. */
export default memo(function BoardMergeGhost({raw,bounds}:{raw:Record<string,unknown>;bounds:MergeRect}){
 const canvas=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const node=canvas.current;if(!node)return;
  const strokes=((raw.webInk as {strokes?:BoardPaintStroke[]}|undefined)?.strokes||[]),items=(Array.isArray(raw.items)?raw.items:[]) as Card[];
  let pointCount=0;for(const stroke of strokes)pointCount+=stroke.points?.length||0;
  const plan=mergePreviewPlan(bounds,pointCount);node.width=plan.width;node.height=plan.height;
  const ctx=node.getContext('2d');if(!ctx)return;
  ctx.scale(plan.scale,plan.scale);ctx.translate(-bounds.x,-bounds.y);
  const byID=new Map(items.map(item=>[item.id?.toLowerCase(),item]));
  ctx.lineWidth=2/plan.scale;ctx.strokeStyle='#54776c';
  for(const edge of (Array.isArray(raw.edges)?raw.edges:[]) as {from:string;to:string}[]){const a=byID.get(edge.from?.toLowerCase()),b=byID.get(edge.to?.toLowerCase());if(!a||!b)continue;ctx.beginPath();ctx.moveTo(a.x+a.width/2,a.y+a.height/2);ctx.lineTo(b.x+b.width/2,b.y+b.height/2);ctx.stroke();}
  for(const item of items){
   if(![item.x,item.y,item.width,item.height].every(Number.isFinite)||item.width<=0||item.height<=0)continue;
   ctx.save();ctx.beginPath();ctx.rect(item.x,item.y,item.width,item.height);ctx.clip();
   ctx.fillStyle=color(item.style?.fillColor,'#fffdf7');ctx.fillRect(item.x,item.y,item.width,item.height);ctx.strokeStyle=color(item.style?.strokeColor,'#829c91');ctx.strokeRect(item.x,item.y,item.width,item.height);
   const font=Math.min(32,Math.max(14,18/Math.max(.25,plan.scale)));ctx.font=`${font}px system-ui`;ctx.fillStyle=color(item.style?.textColor,'#23463a');
   const label=item.title||item.kind||'';ctx.fillText(label.slice(0,180),item.x+12,item.y+font+10,Math.max(1,item.width-24));
   const lines=(item.text||'').split('\n',24);for(let i=0;i<Math.min(lines.length,24);i++)ctx.fillText(lines[i].slice(0,240),item.x+12,item.y+font*2.5+i*font*1.35,Math.max(1,item.width-24));
   ctx.restore();
  }
  for(const stroke of strokes){if(!Array.isArray(stroke.points)||!stroke.points.length)continue;paintBoardInkStroke(ctx,stroke,plan.stride);}
  ctx.globalAlpha=1;
  for(const pin of (Array.isArray(raw.pins)?raw.pins:[]) as {x:number;y:number;title?:string}[]){if(![pin.x,pin.y].every(Number.isFinite))continue;ctx.fillStyle='#b47546';ctx.beginPath();ctx.arc(pin.x,pin.y,6/plan.scale,0,Math.PI*2);ctx.fill();}
  return()=>{node.width=1;node.height=1;};
 },[raw,bounds.x,bounds.y,bounds.width,bounds.height]);
 return <canvas ref={canvas} className="board-merge-ghost-bitmap" aria-hidden="true"/>;
});

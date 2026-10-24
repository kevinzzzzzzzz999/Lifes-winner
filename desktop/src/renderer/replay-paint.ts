import type {ReplayStroke} from './ink-replay';

/** Paint disjoint past/future sections so translucent ink is not painted twice. */
export function paintReplayStroke(ctx:CanvasRenderingContext2D,stroke:ReplayStroke,end:number,stride:number,scale:number,start=0,opacity=1){
 const points=stroke.points,from=Math.max(0,Math.min(1,start)),to=Math.max(0,Math.min(1,end));
 if(!points.length||to<=from||opacity<=0)return;
 ctx.strokeStyle=/^#[\da-f]{6}$/i.test(stroke.color)?stroke.color:'#20433b';ctx.fillStyle=ctx.strokeStyle;
 ctx.globalAlpha=Math.min(1,Math.max(0,stroke.opacity))*opacity;ctx.lineCap='round';ctx.lineJoin='round';
 if(points.length===1){ctx.beginPath();ctx.arc(points[0][0],points[0][1],Math.max(points[0][2]/2,.3/scale),0,Math.PI*2);ctx.fill();return;}
 const at=(n:number)=>{const j=Math.floor(n),a=points[j],b=points[Math.min(j+1,points.length-1)],r=n-j;return [a[0]+(b[0]-a[0])*r,a[1]+(b[1]-a[1])*r,a[2]+(b[2]-a[2])*r];};
 const last=(points.length-1)*to;
 for(let i=(points.length-1)*from;i<last;i+=Math.max(1,stride)){const a=at(i),b=at(Math.min(i+Math.max(1,stride),last));ctx.lineWidth=Math.max(.5/scale,(a[2]+b[2])/2);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();}
}

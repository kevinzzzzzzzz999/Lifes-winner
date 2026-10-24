export type ReplayStroke={points:number[][];color:string;opacity:number;startedAt?:number;duration?:number};
export type ReplayEntry={stroke:ReplayStroke;sourceIndex:number;start:number;end:number};
export function inkReplay(strokes:readonly ReplayStroke[]){
 const valid=strokes.slice(0,50000).map((stroke,sourceIndex)=>({stroke,sourceIndex})).filter(({stroke})=>Array.isArray(stroke.points)&&stroke.points.length>0);
 const timed=valid.length>0&&valid.every(({stroke})=>Number.isFinite(stroke.startedAt)&&stroke.startedAt!>=0&&Number.isFinite(stroke.duration)&&stroke.duration!>=0);
 if(timed)valid.sort((a,b)=>a.stroke.startedAt!-b.stroke.startedAt!||a.sourceIndex-b.sourceIndex);
 let end=0,longStrokes=false,compressedGaps=false,minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,pointCount=0;
 const entries:ReplayEntry[]=valid.map(({stroke,sourceIndex},i)=>{
  if(i&&timed){const previous=valid[i-1].stroke,gap=Math.max(0,stroke.startedAt!-(previous.startedAt!+previous.duration!));end+=Math.min(.75,gap);if(gap>.75)compressedGaps=true;}
  const original=timed?stroke.duration!:.65,duration=Math.max(.08,Math.min(30,original));if(original>30)longStrokes=true;
  const start=end;end+=duration;
  for(const p of stroke.points){if(p.length<3||!p.every(Number.isFinite))continue;pointCount++;const r=p[2]/2;minX=Math.min(minX,p[0]-r);minY=Math.min(minY,p[1]-r);maxX=Math.max(maxX,p[0]+r);maxY=Math.max(maxY,p[1]+r);}
  return{stroke,sourceIndex,start,end};
 });
 const bounds=pointCount?{x:minX,y:minY,width:Math.max(1,maxX-minX),height:Math.max(1,maxY-minY)}:{x:0,y:0,width:1,height:1};
 return{entries,total:end,timed,bounds,pointCount,stride:Math.max(1,Math.ceil(pointCount/120000)),longStrokes,compressedGaps};
}

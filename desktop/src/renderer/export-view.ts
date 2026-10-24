import type {OpenedFile} from '../shared/desktop-api';
export type ExportRegion={x:number;y:number;width:number;height:number};
export type ExportView={board?:ExportRegion;pdfPage?:number};
/** Capture the primary reader before a modal changes focus/layout. Never use its saved camera. */
export function captureExportView(file:OpenedFile):ExportView{
 if(file.kind==='board'){
  const stage=Array.from(document.querySelectorAll<HTMLElement>('[data-print-content="true"] .board-stage')).find(el=>{
   const viewer=el.closest('.board-viewer');return viewer&&!viewer.classList.contains('board-embedded-viewer')&&!viewer.classList.contains('is-replay-mode')&&el.getBoundingClientRect().width>0;
  });
  if(!stage)return{};
  const x=Number(stage.dataset.cameraX),y=Number(stage.dataset.cameraY),zoom=Number(stage.dataset.cameraZoom),width=stage.clientWidth,height=stage.clientHeight;
  if(![x,y,zoom,width,height].every(Number.isFinite)||zoom<=0||width<=0||height<=0)return{};
  return{board:{x:x-width/(2*zoom),y:y-height/(2*zoom),width:width/zoom,height:height/zoom}};
 }
 if(/\.pdf$/i.test(file.path)){
  const reader=Array.from(document.querySelectorAll<HTMLElement>('.pdf-reader')).find(el=>el.dataset.sourcePath===file.path);
  const page=Number(reader?.querySelector<HTMLElement>('.pdf-reading-page[data-current="true"]')?.dataset.page);
  return Number.isSafeInteger(page)&&page>0?{pdfPage:page}:{};
 }
 return{};
}
/** Test the same round disks and pressure trapezoid used by the vector exporter. */
export function inkSegmentIntersectsRegion(p:readonly number[],q:readonly number[],rect:ExportRegion):boolean{
 const pr=(p[2]||1)/2,qr=(q[2]||1)/2;
 const disk=(point:readonly number[],r:number)=>{const dx=point[0]-Math.max(rect.x,Math.min(rect.x+rect.width,point[0])),dy=point[1]-Math.max(rect.y,Math.min(rect.y+rect.height,point[1]));return dx*dx+dy*dy<r*r;};
 if(disk(p,pr)||disk(q,qr))return true;
 const dx=q[0]-p[0],dy=q[1]-p[1],length=Math.hypot(dx,dy);if(!length)return false;
 const nx=-dy/length,ny=dx/length;
 const shape=[[p[0]+nx*pr,p[1]+ny*pr],[p[0]-nx*pr,p[1]-ny*pr],[q[0]-nx*qr,q[1]-ny*qr],[q[0]+nx*qr,q[1]+ny*qr]];
 const box=[[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x+rect.width,rect.y+rect.height],[rect.x,rect.y+rect.height]];
 const axes=[[1,0],[0,1],...shape.map((v,i)=>{const next=shape[(i+1)%shape.length];return[-(next[1]-v[1]),next[0]-v[0]];})];
 for(const [ax,ay] of axes){if(!ax&&!ay)continue;const a=shape.map(v=>v[0]*ax+v[1]*ay),b=box.map(v=>v[0]*ax+v[1]*ay);if(Math.max(...a)<=Math.min(...b)||Math.max(...b)<=Math.min(...a))return false;}
 return true;
}

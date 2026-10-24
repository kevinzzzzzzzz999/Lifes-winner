import type {PDFLayerAnnotation} from '../shared/desktop-api';
export type SnapshotAnnotation=PDFLayerAnnotation&{snapshotOpacity?:number};
export type SnapshotRect={x:number;y:number;width:number;height:number};
// The PDF renderer and overlay use the same rotated CropBox, top-left units.
export function drawSnapshotAnnotations(c:CanvasRenderingContext2D,marks:SnapshotAnnotation[],width:number,height:number){
 for(const a of marks){c.save();c.globalAlpha=a.snapshotOpacity??1;c.fillStyle=a.color;c.strokeStyle=a.color;c.lineWidth=a.width*width;c.lineCap='round';c.lineJoin='round';
  if(a.kind==='ink'){c.beginPath();a.points.forEach(([x,y],i)=>i?c.lineTo(x*width,y*height):c.moveTo(x*width,y*height));if(a.points.length===1){c.arc(a.points[0][0]*width,a.points[0][1]*height,c.lineWidth/2,0,Math.PI*2);c.fill();}else c.stroke();}
  else if(a.kind==='highlight'){c.globalAlpha*=.3;c.fillRect(a.rect.x*width,a.rect.y*height,a.rect.width*width,a.rect.height*height);}
  else{const x=a.rect.x*width,y=a.rect.y*height,w=a.rect.width*width,h=a.rect.height*height,font=Math.max(.015,a.width*5)*width;
   c.beginPath();c.rect(x,y,w,h);c.clip();c.font=`${font}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;c.textBaseline='top';let dy=y,line='';
   for(const char of a.text){if(char==='\n'||line&&c.measureText(line+char).width>w){c.fillText(line,x,dy);line='';dy+=font*1.2;if(dy>y+h)break;}if(char!=='\n')line+=char;}if(line&&dy<y+h)c.fillText(line,x,dy);
  }c.restore();
 }
}

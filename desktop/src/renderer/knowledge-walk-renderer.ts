import type {WalkBuilding,WalkPlayer,WalkWorld} from './knowledge-walk-math';

type V={x:number;y:number;z:number};
export type WalkFace={points:V[];color:string;normal:V;glow?:boolean;material?:number;normals?:V[]};
type Face=WalkFace;
export type WalkScene={faces:Face[];world:WalkWorld};
export type WalkView={yaw:number;pitch:number;distance:number;mode?:'first'|'third'};
const v=(x:number,y:number,z:number):V=>({x,y,z});
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n));
const palettes=[['#b1b5b1','#586c73','#567381'],['#b8b3aa','#6d6b65','#627c88'],['#ad9780','#645e55','#67818a'],['#c0c0b5','#526969','#5d787e'],['#939da1','#465863','#617f90']];
function polygon(faces:Face[],points:V[],color:string,glow=false){const a=points[0],b=points[1],c=points[2],u=v(b.x-a.x,b.y-a.y,b.z-a.z),w=v(c.x-b.x,c.y-b.y,c.z-b.z);faces.push({points,color,normal:v(u.y*w.z-u.z*w.y,u.z*w.x-u.x*w.z,u.x*w.y-u.y*w.x),glow});}
function box(faces:Face[],x:number,y:number,z:number,w:number,h:number,d:number,color:string,top=color){
 polygon(faces,[v(x,y,z+d),v(x+w,y,z+d),v(x+w,y+h,z+d),v(x,y+h,z+d)],color);
 polygon(faces,[v(x+w,y,z),v(x,y,z),v(x,y+h,z),v(x+w,y+h,z)],color);
 polygon(faces,[v(x,y,z),v(x,y,z+d),v(x,y+h,z+d),v(x,y+h,z)],color);
 polygon(faces,[v(x+w,y,z+d),v(x+w,y,z),v(x+w,y+h,z),v(x+w,y+h,z+d)],color);
 polygon(faces,[v(x,y+h,z+d),v(x+w,y+h,z+d),v(x+w,y+h,z),v(x,y+h,z)],top);
}
function front(faces:Face[],x:number,y:number,z:number,w:number,h:number,color:string){polygon(faces,[v(x,y,z),v(x+w,y,z),v(x+w,y+h,z),v(x,y+h,z)],color,true);}
function ellipsoid(faces:Face[],x:number,y:number,z:number,rx:number,ry:number,rz:number,color:string,segments=10,rings=7){
 const point=(row:number,col:number)=>{const phi=row/rings*Math.PI,theta=col/segments*Math.PI*2;return v(x+Math.sin(phi)*Math.cos(theta)*rx,y+Math.cos(phi)*ry,z+Math.sin(phi)*Math.sin(theta)*rz);};
 for(let row=0;row<rings;row++)for(let col=0;col<segments;col++){const a=point(row,col),b=point(row+1,col),c=point(row+1,col+1),d=point(row,col+1);const vertices=row===0?[a,c,b]:[a,d,c,b];polygon(faces,vertices,color);faces[faces.length-1].normals=vertices.map(p=>v((p.x-x)/(rx*rx),(p.y-y)/(ry*ry),(p.z-z)/(rz*rz)));}
}
function tree(faces:Face[],x:number,z:number,seed:number){box(faces,x-1,0,z-1,2,21,2,'#645c4d');ellipsoid(faces,x,26,z,10,15+(seed%5),10,'#53644a');ellipsoid(faces,x+5,32,z+3,8,10,8,'#697856');ellipsoid(faces,x-5,26,z-4,8,9,9,'#455b43');}
function building(faces:Face[],b:WalkBuilding){
 const {x,z,width:w,depth:d,seed}=b,h=b.height*(b.height>150?1.8:1),[wall,trim,light]=palettes[b.style.variant];
 // Every visual base occupies its collision footprint. Tall towers then step in.
 box(faces,x-9,-3,z-9,w+18,3,d+18,'#8b8c82','#bebdb1');
 box(faces,x,0,z,w,Math.min(h,32),d,'#777d7b','#adb2ad');
 const inset=h>150?12:0,tx=x+inset,tz=z+inset,tw=w-inset*2,td=d-inset*2;
 box(faces,tx,Math.min(h,32),tz,tw,Math.max(0,h-32),td,wall,trim);
 if(h<100){
  const roof=23+seed%12,peak=x+w/2;
  polygon(faces,[v(x-5,h,z-5),v(x-5,h,z+d+5),v(peak,h+roof,z+d+5),v(peak,h+roof,z-5)],trim);
  polygon(faces,[v(peak,h+roof,z-5),v(peak,h+roof,z+d+5),v(x+w+5,h,z+d+5),v(x+w+5,h,z-5)],wall);
  polygon(faces,[v(x-5,h,z+d+5),v(x+w+5,h,z+d+5),v(peak,h+roof,z+d+5)],light);
  box(faces,x+w*.72,h,z+d*.25,13,28,13,'#b4ad95');
 }else{
  const crown=12+b.style.variant*5;
  box(faces,tx+tw*.14,h,tz+td*.14,tw*.72,crown,td*.72,trim,light);
  if(h>230){box(faces,tx+tw*.3,h+crown,tz+td*.3,tw*.4,22,td*.4,wall,light);box(faces,x+w/2-2,h+crown+22,z+d/2-2,4,45,4,light);}
 }
 // Bounded lit window panels on all facades, a different rhythm for each address.
 const rows=Math.min(24,Math.max(1,Math.floor((h-26)/27))),cols=7;
 for(let row=0;row<rows;row++){
  const wy=36+row*Math.max(22,(h-44)/rows),wh=Math.min(14,Math.max(8,h-wy-3));if(wy+wh>h)continue;
  for(let col=0;col<cols;col++){
   const lit=((seed>>>((row+col)%20))+row*7+col*13)%5!==0,color=lit?light:'#43545c',ww=(tw-24)/cols*.88,wx=tx+12+col*(tw-24)/cols;
   front(faces,wx,wy,tz+td+.35,ww,wh,color);
   polygon(faces,[v(wx+ww,wy,tz-.35),v(wx,wy,tz-.35),v(wx,wy+wh,tz-.35),v(wx+ww,wy+wh,tz-.35)],color,true);
   const wz=tz+12+col*(td-24)/cols,wd=(td-24)/cols*.88;
   polygon(faces,[v(tx-.35,wy,wz),v(tx-.35,wy,wz+wd),v(tx-.35,wy+wh,wz+wd),v(tx-.35,wy+wh,wz)],color,true);
   polygon(faces,[v(tx+tw+.35,wy,wz+wd),v(tx+tw+.35,wy,wz),v(tx+tw+.35,wy+wh,wz),v(tx+tw+.35,wy+wh,wz+wd)],color,true);
  }
 }
 // Broad, luminous doorway and canopy: this is where the reader can enter.
 front(faces,b.door.x-19,0,b.door.z+.7,38,29,'#819597');
 front(faces,b.door.x-14,1,b.door.z+1,12,25,'#354c54');front(faces,b.door.x+2,1,b.door.z+1,12,25,'#354c54');
 box(faces,b.door.x-26,29,b.door.z-2,52,3,14,trim,light);
 box(faces,b.door.x-24,-.2,b.door.z+6,48,.6,24,'#aaa99b');
 tree(faces,x-22,z+d-17,seed);tree(faces,x+w+23,z+d-17,seed+1);
 // Street lamp; emissive cap stays cheap without a real-time light simulation.
 box(faces,x-24,0,z-24,3,63,3,'#465c66');box(faces,x-29,61,z-29,13,5,13,'#ffe9b2');
}
export function makeWalkScene(world:WalkWorld):WalkScene{
 const faces:Face[]=[],b=world.bounds,pad=1700;
 polygon(faces,[v(b.minX-pad,-4,b.maxZ+pad),v(b.maxX+pad,-4,b.maxZ+pad),v(b.maxX+pad,-4,b.minZ-pad),v(b.minX-pad,-4,b.minZ-pad)],'#777b7b');faces[0].material=2;
 const centersX=[...new Set(world.buildings.map(x=>x.x+x.width/2))].sort((a,b)=>a-b),centersZ=[...new Set(world.buildings.map(x=>x.z+x.depth/2))].sort((a,b)=>a-b);
 for(let i=1;i<centersX.length;i++){const x=(centersX[i-1]+centersX[i])/2;for(let z=b.minZ;z<b.maxZ;z+=45)polygon(faces,[v(x-1,-3.8,z+20),v(x+1,-3.8,z+20),v(x+1,-3.8,z),v(x-1,-3.8,z)],'#d3c7a4');}
 for(let i=1;i<centersZ.length;i++){const z=(centersZ[i-1]+centersZ[i])/2;for(let x=b.minX;x<b.maxX;x+=45)polygon(faces,[v(x,-3.8,z+1),v(x+20,-3.8,z+1),v(x+20,-3.8,z-1),v(x,-3.8,z-1)],'#d3c7a4');}
 for(const item of world.buildings)building(faces,item);return{faces,world};
}
// A clipped, perspective camera. Near-plane clipping avoids exploding polygons
// when standing next to a wall or looking up a tower.
function clipNear(points:V[],near=8){const out:V[]=[];for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],ai=a.z>=near,bi=b.z>=near;if(ai)out.push(a);if(ai!==bi){const t=(near-a.z)/(b.z-a.z);out.push(v(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,near));}}return out;}
export function cameraPosition(world:WalkWorld,player:WalkPlayer,view:WalkView):V{
 if(view.mode==='first')return v(player.x,19,player.z);
 const desired=v(player.x-Math.sin(view.yaw)*view.distance,36+(view.distance-100)*.10,player.z+Math.cos(view.yaw)*view.distance),start=v(player.x,14,player.z);
 let fraction=1;
 for(const b of world.buildings){let low=0,high=1;for(const axis of ['x','y','z'] as const){const delta=desired[axis]-start[axis],min=axis==='x'?b.x-3:axis==='z'?b.z-3:0,max=axis==='x'?b.x+b.width+3:axis==='z'?b.z+b.depth+3:b.height+30;if(Math.abs(delta)<1e-6){if(start[axis]<min||start[axis]>max){low=2;break;}continue;}const a=(min-start[axis])/delta,c=(max-start[axis])/delta;low=Math.max(low,Math.min(a,c));high=Math.min(high,Math.max(a,c));if(low>high)break;}if(low<=high&&low>0&&low<1)fraction=Math.min(fraction,Math.max(0,low-.04));}
 return v(start.x+(desired.x-start.x)*fraction,start.y+(desired.y-start.y)*fraction,start.z+(desired.z-start.z)*fraction);
}
export function walkAvatarFaces(p:WalkPlayer,phase:number,moving:boolean):Face[]{
 const local:Face[]=[],faces:Face[]=[],stride=moving?Math.sin(phase)*1.9:0;
 ellipsoid(local,-1.3,6,-stride,1,6,1.05,'#3d454b',8,6);ellipsoid(local,1.3,6,stride,1,6,1.05,'#3d454b',8,6);
 ellipsoid(local,-1.3,.65,-.7-stride,1.05,.65,1.6,'#353a3c',8,5);ellipsoid(local,1.3,.65,-.7+stride,1.05,.65,1.6,'#353a3c',8,5);
 ellipsoid(local,0,13.7,0,3.0,4.4,1.8,'#767c7c',12,8);
 ellipsoid(local,-3.1,12.2,stride*.7,.8,3.6,.8,'#697172',8,6);ellipsoid(local,3.1,12.2,-stride*.7,.8,3.6,.8,'#697172',8,6);
 ellipsoid(local,-3.2,8.8,stride*.7,.55,.8,.55,'#b58f74',8,5);ellipsoid(local,3.2,8.8,-stride*.7,.55,.8,.55,'#b58f74',8,5);
 ellipsoid(local,0,19.5,-.1,1.4,2.1,1.5,'#bb9a80',12,9);ellipsoid(local,0,20.5,.15,1.42,1.3,1.48,'#443f39',12,7);
 for(const f of local){const turn=(q:V)=>v(p.x+q.x*Math.cos(p.yaw)-q.z*Math.sin(p.yaw),q.y,p.z+q.x*Math.sin(p.yaw)+q.z*Math.cos(p.yaw));polygon(faces,f.points.map(turn),f.color);if(f.normals)faces[faces.length-1].normals=f.normals.map(q=>v(q.x*Math.cos(p.yaw)-q.z*Math.sin(p.yaw),q.y,q.x*Math.sin(p.yaw)+q.z*Math.cos(p.yaw)));}return faces;
}
export function paintWalkScene(ctx:CanvasRenderingContext2D,scene:WalkScene,player:WalkPlayer,view:WalkView,width:number,height:number,phase:number,moving:boolean,nearPath?:string){
 const cam=cameraPosition(scene.world,player,view),sy=Math.sin(view.yaw),cy=Math.cos(view.yaw),sp=Math.sin(view.pitch),cp=Math.cos(view.pitch),focal=Math.max(240,height*.86);
 const camera=(p:V)=>{const dx=p.x-cam.x,dy=p.y-cam.y,dz=p.z-cam.z,depth=dx*sy-dz*cy;return v(dx*cy+dz*sy,dy*cp+depth*sp,depth*cp-dy*sp);};
 const screen=(p:V)=>({x:width/2+p.x*focal/p.z,y:height*.46-p.y*focal/p.z});
 const horizon=clamp(height*.46-Math.tan(view.pitch)*focal,-height,height*2);
 const sky=ctx.createLinearGradient(0,0,0,height);sky.addColorStop(0,'#152a45');sky.addColorStop(.48,'#54747e');sky.addColorStop(1,'#b3b6a8');ctx.fillStyle=sky;ctx.fillRect(0,0,width,height);
 ctx.fillStyle='#ebdcc033';ctx.beginPath();ctx.arc(width*.79,Math.max(65,horizon-90),32,0,Math.PI*2);ctx.fill();
 const polygon2=(points:V[],color:string)=>{const clipped=clipNear(points.map(camera));if(clipped.length<3)return;ctx.beginPath();clipped.forEach((p,i)=>{const q=screen(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.closePath();ctx.fillStyle=color;ctx.fill();};
 const bounds=scene.world.bounds,pad=1500;
 polygon2([v(bounds.minX-pad,-4,bounds.maxZ+pad),v(bounds.maxX+pad,-4,bounds.maxZ+pad),v(bounds.maxX+pad,-4,bounds.minZ-pad),v(bounds.minX-pad,-4,bounds.minZ-pad)],'#354b57');
 // Quiet paving and dashed street centerlines establish perspective and scale.
 for(let x=Math.floor(bounds.minX/95)*95;x<bounds.maxX+380;x+=95)polygon2([v(x,-3.8,bounds.maxZ+380),v(x+.55,-3.8,bounds.maxZ+380),v(x+.55,-3.8,bounds.minZ-380),v(x,-3.8,bounds.minZ-380)],'#58707a');
 for(let z=Math.floor(bounds.minZ/95)*95;z<bounds.maxZ+380;z+=95)polygon2([v(bounds.minX-380,-3.7,z),v(bounds.maxX+380,-3.7,z),v(bounds.maxX+380,-3.7,z+.55),v(bounds.minX-380,-3.7,z+.55)],'#58707a');
 for(const b of scene.world.buildings){
  polygon2([v(b.x+12,-3.5,b.z+b.depth+12),v(b.x+b.width+50,-3.5,b.z+b.depth+36),v(b.x+b.width+70,-3.5,b.z-b.height*.27),v(b.x+40,-3.5,b.z-b.height*.27)],'#23384188');
  if(b.entry.path===nearPath)polygon2([v(b.door.x-32,-.1,b.door.z+3),v(b.door.x+32,-.1,b.door.z+3),v(b.door.x+32,-.1,b.door.z+56),v(b.door.x-32,-.1,b.door.z+56)],'#99f2c579');
 }
 const actor=view.mode==='first'||Math.hypot(cam.x-player.x,cam.z-player.z)<25?[]:walkAvatarFaces(player,phase,moving);
 const render=[] as {points:V[];depth:number;color:string;shade:number;glow:boolean}[];
 for(const f of [...scene.faces,...actor]){
  const first=f.points[0],normal=f.normal;if(normal.x*(cam.x-first.x)+normal.y*(cam.y-first.y)+normal.z*(cam.z-first.z)<=0)continue;
  const points=clipNear(f.points.map(camera));if(points.length<3)continue;
  const depth=points.reduce((s,p)=>s+p.z,0)/points.length;if(depth>2800)continue;
  const projected=points.map(screen);if(projected.every(p=>p.x<0)||projected.every(p=>p.x>width)||projected.every(p=>p.y<0)||projected.every(p=>p.y>height))continue;
  const n=Math.hypot(normal.x,normal.y,normal.z),shade=f.glow?0:clamp(.17-(normal.x*.28+normal.y*.65+normal.z*.25)/n,0,.38);
  render.push({points,depth,color:f.color,shade,glow:!!f.glow});
 }
 render.sort((a,b)=>b.depth-a.depth);
 for(const face of render){ctx.beginPath();face.points.forEach((p,i)=>{const q=screen(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.closePath();ctx.fillStyle=face.color;ctx.fill();if(face.shade){ctx.fillStyle=`rgba(9,24,37,${face.shade})`;ctx.fill();}const fog=clamp((face.depth-700)/2400,0,.72);if(fog){ctx.fillStyle=`rgba(116,141,151,${fog})`;ctx.fill();}}
 // Door signs only show on visible front faces; a readable HUD identifies the
 // nearby door in full, while signs give the city its remembered addresses.
 for(const b of scene.world.buildings){if(cam.z<b.door.z+8||Math.hypot(player.x-b.door.x,player.z-b.door.z)>680)continue;const pos=camera(v(b.door.x,Math.min(b.height+20,85),b.door.z+5));if(pos.z<25)continue;const q=screen(pos);if(q.x<40||q.x>width-40||q.y<20||q.y>height-20)continue;
  const letters=Array.from(b.entry.name),font=clamp(17*focal/pos.z,10,17),text=letters.length>25?letters.slice(0,23).join('')+'…':b.entry.name;ctx.font=`600 ${font}px system-ui`;const w=Math.min(230,ctx.measureText(text).width+18);ctx.fillStyle=b.entry.path===nearPath?'#e4ffeef2':'#172d40d9';ctx.beginPath();ctx.roundRect(q.x-w/2,q.y-font-7,w,font+14,5);ctx.fill();ctx.fillStyle=b.entry.path===nearPath?'#1d4d4b':'#edf5f3';ctx.textAlign='center';ctx.fillText(text,q.x,q.y+1,w-12);
 }
 return {faces:render.length,camera:cam};
}

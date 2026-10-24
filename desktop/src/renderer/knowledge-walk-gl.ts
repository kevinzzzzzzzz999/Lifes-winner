import {cameraPosition,walkAvatarFaces,type WalkScene,type WalkView,type WalkFace} from './knowledge-walk-renderer';
import type {WalkPlayer} from './knowledge-walk-math';

const vertex=`#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec3 color;
layout(location=3) in float material;
uniform vec3 camera;uniform vec4 view;uniform vec2 size;
uniform vec3 lightX;uniform vec3 lightY;uniform vec3 sun;uniform vec3 center;uniform float extent;
uniform bool shadowPass;
out vec3 world;out vec3 n;out vec3 albedo;out float mat;out vec3 shadow;
void main(){
 world=position;n=normal;albedo=color;mat=material;
 vec3 offset=position-center;
 vec3 light=vec3(dot(offset,lightX),dot(offset,lightY),-dot(offset,sun))/extent;
 shadow=light*.5+.5;
 if(shadowPass){gl_Position=vec4(light,1.);return;}
 vec3 d=position-camera;
 float depth=d.x*sin(view.x)-d.z*cos(view.x);
 vec3 p=vec3(d.x*cos(view.x)+d.z*sin(view.x),d.y*cos(view.y)+depth*sin(view.y),depth*cos(view.y)-d.y*sin(view.y));
 float near=.5,far=5500.;
 gl_Position=vec4(p.x*view.z*2./size.x,p.y*view.z*2./size.y+.08*p.z,(far+near)/(far-near)*p.z-2.*far*near/(far-near),p.z);
}`;
const fragment=`#version 300 es
precision highp float;
in vec3 world;in vec3 n;in vec3 albedo;in float mat;in vec3 shadow;
uniform vec3 camera;uniform vec3 sun;uniform sampler2D shadowMap;uniform bool shadowPass;
out vec4 outputColor;
float noise(vec3 p){return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453);}
vec3 sky(vec3 d){return mix(vec3(.84,.88,.87),vec3(.30,.49,.64),smoothstep(-.05,.8,d.y));}
float shadowAmount(vec3 N){
 if(any(lessThan(shadow,vec3(0.)))||any(greaterThan(shadow,vec3(1.))))return 1.;
 float sum=0.;float bias=max(.0008,.0016*(1.-max(dot(N,sun),0.)));
 for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){float depth=texture(shadowMap,shadow.xy+vec2(x,y)/2048.).r;sum+=shadow.z-bias>depth?0.:1.;}
 return sum/9.;
}
void main(){
 if(shadowPass){outputColor=vec4(1.);return;}
 vec3 N=normalize(n),V=normalize(camera-world),base=albedo;
 float grain=noise(floor(world*7.))*.09-.045;
 float direct=max(dot(N,sun),0.),shade=shadowAmount(N);
 vec3 light=vec3(.44,.51,.56)+vec3(.84,.76,.61)*direct*mix(.15,1.,shade);
 if(mat<.5){
  base*=1.+grain;
  // Fine stone courses and expansion joints, measured in world units.
  float seam=1.-smoothstep(.03,.13,abs(fract(world.y/16.)-.5));
  if(abs(N.y)<.4)base*=1.-seam*.12;
 }else if(mat<1.5){
  vec3 R=reflect(-V,N);float fresnel=.20+.70*pow(1.-max(dot(N,V),0.),4.);
  vec3 reflection=sky(R);float reflectionBands=smoothstep(.2,.65,sin(R.x*21.+R.z*13.)*.5+.5);
  reflection=mix(reflection,vec3(.39,.47,.51),reflectionBands*.24*(1.-smoothstep(.02,.5,R.y)));
  base=mix(base*.55,reflection,fresnel+.13);
  light=mix(light,vec3(1.),.55);
 }else if(mat<2.5){base*=1.+grain*1.7;}
 else if(mat<3.5){base*=1.+grain*.3;}
 vec3 H=normalize(V+sun);float shininess=mat>.5&&mat<1.5?90.:mat>2.5&&mat<3.5?48.:10.;
 float spec=pow(max(dot(N,H),0.),shininess)*shade*(mat>.5&&mat<1.5?.5:mat>2.5&&mat<3.5?.22:.018);
 vec3 lit=base*light+vec3(1.,.91,.73)*spec;
 float distanceToCamera=length(world-camera),fog=1.-exp(-pow(distanceToCamera/3100.,1.5));
 lit=mix(lit,vec3(.77,.83,.84),clamp(fog,0.,.9));
 // Gentle photographic contrast; preserve detail in shaded facades.
 lit=pow(max(lit,vec3(0.)),vec3(.94));outputColor=vec4(lit,1.);
}`;
const skyVertex=`#version 300 es
out vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,.9999,1.);}`;
const skyFragment=`#version 300 es
precision highp float;in vec2 uv;out vec4 outputColor;uniform vec4 view;uniform vec2 size;uniform vec3 sun;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
void main(){
 vec3 p=normalize(vec3((uv.x-.5)*size.x/view.z,(uv.y-.54)*size.y/view.z,1.));
 float y=p.y*cos(view.y)-p.z*sin(view.y),d=p.y*sin(view.y)+p.z*cos(view.y);
 vec3 ray=normalize(vec3(p.x*cos(view.x)+d*sin(view.x),y,p.x*sin(view.x)-d*cos(view.x)));
 vec3 color=mix(vec3(.84,.88,.87),vec3(.29,.49,.66),smoothstep(-.03,.8,ray.y));
 vec2 cloud=ray.xz/max(.12,ray.y)*1.3;float f=noise(cloud)*.56+noise(cloud*2.1)*.28+noise(cloud*4.3)*.12;
 float cover=smoothstep(.49,.74,f)*smoothstep(.03,.28,ray.y)*.75;color=mix(color,vec3(.96,.96,.92),cover);
 float s=max(dot(ray,sun),0.);color+=vec3(1.,.84,.56)*(pow(s,650.)*.45+pow(s,15.)*.05);
 outputColor=vec4(color,1.);
}`;
const normalized=(x:number,y:number,z:number)=>{const n=Math.hypot(x,y,z);return[x/n,y/n,z/n] as const;};
const SUN=normalized(-.55,1,.35),LX=normalized(SUN[2],0,-SUN[0]),LY=[SUN[1]*LX[2],SUN[2]*LX[0]-SUN[0]*LX[2],-SUN[1]*LX[0]];
// X cross Y = sun; choose an upward light-space axis.
const lightY=[-LY[0],-LY[1],-LY[2]];
function mesh(faces:WalkFace[]){
 const data:number[]=[];
 for(const face of faces){const normal=face.normal,length=Math.hypot(normal.x,normal.y,normal.z);if(length<1e-9)continue;const hex=face.color.slice(1),color=[0,2,4].map(at=>parseInt(hex.slice(at,at+2),16)/255),material=face.material??(face.glow?1:0);
  for(let index=1;index<face.points.length-1;index++)for(const at of [0,index,index+1]){const point=face.points[at],n=face.normals?.[at]||normal,nl=Math.hypot(n.x,n.y,n.z);data.push(point.x,point.y,point.z,n.x/nl,n.y/nl,n.z/nl,...color,material);}
 }
 return new Float32Array(data);
}
export function createWalkGLPainter(destination:CanvasRenderingContext2D){
 const surface=document.createElement('canvas'),gl=surface.getContext('webgl2',{alpha:false,antialias:true,preserveDrawingBuffer:false,powerPreference:'high-performance'});if(!gl)return null;
 const shaders:WebGLShader[]=[],programs:WebGLProgram[]=[],buffers:WebGLBuffer[]=[],arrays:WebGLVertexArrayObject[]=[];
 const compile=(type:number,source:string)=>{const shader=gl.createShader(type)!;shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('CITY_SHADER');return shader;};
 const program=(v:string,f:string)=>{const p=gl.createProgram()!;programs.push(p);gl.attachShader(p,compile(gl.VERTEX_SHADER,v));gl.attachShader(p,compile(gl.FRAGMENT_SHADER,f));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error('CITY_PROGRAM');return p;};
 let texture:WebGLTexture|null=null,dummy:WebGLTexture|null=null,framebuffer:WebGLFramebuffer|null=null;
 const dispose=()=>{for(const b of buffers)gl.deleteBuffer(b);for(const a of arrays)gl.deleteVertexArray(a);for(const p of programs)gl.deleteProgram(p);for(const s of shaders)gl.deleteShader(s);gl.deleteTexture(texture);gl.deleteTexture(dummy);gl.deleteFramebuffer(framebuffer);gl.getExtension('WEBGL_lose_context')?.loseContext();};
 try{
  const main=program(vertex,fragment),sky=program(skyVertex,skyFragment),u=Object.fromEntries(['camera','view','size','lightX','lightY','sun','center','extent','shadowPass','shadowMap'].map(name=>[name,gl.getUniformLocation(main,name)])),su=Object.fromEntries(['view','size','sun'].map(name=>[name,gl.getUniformLocation(sky,name)]));
  const vao=()=>{const array=gl.createVertexArray()!,buffer=gl.createBuffer()!;arrays.push(array);buffers.push(buffer);gl.bindVertexArray(array);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);for(const [index,count,offset] of [[0,3,0],[1,3,3],[2,3,6],[3,1,9]]){gl.enableVertexAttribArray(index);gl.vertexAttribPointer(index,count,gl.FLOAT,false,40,offset*4);}return{array,buffer,count:0};};
  const staticMesh=vao(),actorMesh=vao();gl.bindVertexArray(null);
  texture=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,2048,2048,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  framebuffer=gl.createFramebuffer()!;gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,texture,0);gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('CITY_SHADOW');gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  dummy=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,dummy);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  let lastScene:WalkScene|null=null,extent=1000,center=[0,80,0];
  const upload=(target:typeof staticMesh,faces:WalkFace[],usage:number)=>{const data=mesh(faces);gl.bindBuffer(gl.ARRAY_BUFFER,target.buffer);gl.bufferData(gl.ARRAY_BUFFER,data,usage);target.count=data.length/10;};
  return {dispose,paint(scene:WalkScene,player:WalkPlayer,view:WalkView,width:number,height:number,phase:number,moving:boolean,nearPath?:string){
   if(gl.isContextLost())throw Error('CITY_CONTEXT_LOST');
   const ratio=Math.min(2,window.devicePixelRatio||1),w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));if(surface.width!==w||surface.height!==h){surface.width=w;surface.height=h;}
   if(scene!==lastScene){lastScene=scene;const b=scene.world.bounds;center=[(b.minX+b.maxX)/2,160,(b.minZ+b.maxZ)/2];extent=Math.hypot(b.maxX-b.minX,b.maxZ-b.minZ,1100)/2+160;upload(staticMesh,scene.faces,gl.STATIC_DRAW);}
   const cam=cameraPosition(scene.world,player,view);upload(actorMesh,view.mode==='first'||Math.hypot(cam.x-player.x,cam.z-player.z)<25?[]:walkAvatarFaces(player,phase,moving),gl.DYNAMIC_DRAW);
   const focal=Math.max(240,height*.86);
   gl.useProgram(main);gl.uniform3f(u.camera,cam.x,cam.y,cam.z);gl.uniform4f(u.view,view.yaw,view.pitch,focal,0);gl.uniform2f(u.size,width,height);gl.uniform3fv(u.lightX,LX);gl.uniform3fv(u.lightY,lightY);gl.uniform3fv(u.sun,SUN);gl.uniform3fv(u.center,center);gl.uniform1f(u.extent,extent);gl.uniform1i(u.shadowMap,0);
   const draw=()=>{for(const part of [staticMesh,actorMesh]){gl.bindVertexArray(part.array);gl.drawArrays(gl.TRIANGLES,0,part.count);}gl.bindVertexArray(null);};
   gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,dummy);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.viewport(0,0,2048,2048);gl.clear(gl.DEPTH_BUFFER_BIT);gl.uniform1i(u.shadowPass,1);gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,2);draw();gl.disable(gl.POLYGON_OFFSET_FILL);
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,w,h);gl.clear(gl.DEPTH_BUFFER_BIT);gl.disable(gl.DEPTH_TEST);gl.useProgram(sky);gl.uniform4f(su.view,view.yaw,view.pitch,focal,0);gl.uniform2f(su.size,width,height);gl.uniform3fv(su.sun,SUN);gl.drawArrays(gl.TRIANGLES,0,3);
   gl.enable(gl.DEPTH_TEST);gl.useProgram(main);gl.uniform1i(u.shadowPass,0);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);draw();destination.drawImage(surface,0,0,width,height);
   const sy=Math.sin(view.yaw),cy=Math.cos(view.yaw),sp=Math.sin(view.pitch),cp=Math.cos(view.pitch);
   for(const b of scene.world.buildings){if(cam.z<b.door.z+4||Math.hypot(player.x-b.door.x,player.z-b.door.z)>700)continue;const dx=b.door.x-cam.x,dy=31-cam.y,dz=b.door.z+6-cam.z,depth=dx*sy-dz*cy,z=depth*cp-dy*sp;if(z<10)continue;const x=width/2+(dx*cy+dz*sy)*focal/z,y=height*.46-(dy*cp+depth*sp)*focal/z;if(x<30||x>width-30||y<25||y>height-15)continue;
    const letters=Array.from(b.entry.name),text=letters.length>25?letters.slice(0,23).join('')+'…':b.entry.name,font=Math.max(10,Math.min(15,16*focal/z));destination.font=`500 ${font}px system-ui`;const tw=Math.min(240,destination.measureText(text).width+18);destination.fillStyle=b.entry.path===nearPath?'#e9ecddec':'#243643d9';destination.beginPath();destination.roundRect(x-tw/2,y-font-7,tw,font+14,3);destination.fill();destination.fillStyle=b.entry.path===nearPath?'#263c42':'#f0f3ed';destination.textAlign='center';destination.fillText(text,x,y+1,tw-12);
   }
   return {faces:(staticMesh.count+actorMesh.count)/3,camera:cam,engine:'webgl'};
  }};
 }catch{dispose();return null;}
}

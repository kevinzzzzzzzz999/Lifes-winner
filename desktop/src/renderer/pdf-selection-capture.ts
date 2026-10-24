type Rect={x:number;y:number;width:number;height:number};
type Bounds={left:number;top:number;width:number;height:number};
type Layer={canvas:HTMLCanvasElement;bounds:Bounds};
const validBounds=(b:Bounds)=>[b.left,b.top,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0;
const intersection=(a:Rect,b:Bounds)=>{
 const x=Math.max(a.x,b.left),y=Math.max(a.y,b.top),right=Math.min(a.x+a.width,b.left+b.width),bottom=Math.min(a.y+a.height,b.top+b.height);
 return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
};

/** Capture only the selected PDF rectangle. Ready detail tiles improve the
 * source pixels; caller-supplied ink is composited last in the same CSS space. */
export function capturePDFSelection(canvas:HTMLCanvasElement,rect:Rect,bounds:Bounds,details:HTMLCanvasElement[],overlays:HTMLCanvasElement[],createCanvas:()=>HTMLCanvasElement=()=>document.createElement('canvas')):{imageDataURL:string;width:number;height:number}{
 if(!validBounds(bounds)||!canvas.width||!canvas.height||![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))throw Error('CAPTURE_UNAVAILABLE');
 const screen=intersection({x:bounds.left+rect.x,y:bounds.top+rect.y,width:rect.width,height:rect.height},bounds);
 if(!screen)throw Error('CAPTURE_UNAVAILABLE');
 const base:Layer={canvas,bounds},detailLayers:Layer[]=[],inkLayers:Layer[]=[];
 let density=Math.min(canvas.width/bounds.width,canvas.height/bounds.height);
 for(const tile of details){
  if(tile.dataset.pdfReady!=='true'||!tile.width||!tile.height)continue;
  const b=tile.getBoundingClientRect();if(!validBounds(b)||!intersection(screen,b))continue;
  detailLayers.push({canvas:tile,bounds:b});density=Math.max(density,Math.min(tile.width/b.width,tile.height/b.height));
 }
 for(const ink of overlays){const b=ink.getBoundingClientRect();if(ink.width&&ink.height&&validBounds(b)&&intersection(screen,b))inkLayers.push({canvas:ink,bounds:b});}
 let scale=Math.min(density,4096/screen.width,4096/screen.height,Math.sqrt(4_000_000/(screen.width*screen.height)));
 const out=createCanvas();
 try{for(let attempt=0;attempt<8;attempt++){
  out.width=Math.max(1,Math.floor(screen.width*scale));out.height=Math.max(1,Math.floor(screen.height*scale));
  const ctx=out.getContext('2d');if(!ctx)throw Error('CAPTURE_UNAVAILABLE');ctx.fillStyle='#fff';ctx.fillRect(0,0,out.width,out.height);
  for(const layer of [base,...detailLayers,...inkLayers]){
   const area=intersection(screen,layer.bounds);if(!area)continue;const b=layer.bounds,source=layer.canvas;
   ctx.drawImage(source,(area.x-b.left)/b.width*source.width,(area.y-b.top)/b.height*source.height,area.width/b.width*source.width,area.height/b.height*source.height,(area.x-screen.x)/screen.width*out.width,(area.y-screen.y)/screen.height*out.height,area.width/screen.width*out.width,area.height/screen.height*out.height);
  }
  const imageDataURL=out.toDataURL('image/png');if((imageDataURL.length-22)*3/4<=4*1024*1024)return{imageDataURL,width:out.width,height:out.height};scale*=.7;
 }throw Error('CAPTURE_TOO_LARGE');}finally{out.width=0;out.height=0;}
}

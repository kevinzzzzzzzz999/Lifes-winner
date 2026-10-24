export type PDFRect={x:number;y:number;width:number;height:number};
export type PDFRenderRegion={x:number;y:number;width:number;height:number;pageWidth:number;pageHeight:number;pixelWidth:number;pixelHeight:number;key:string;pixelBudget?:number};
// Pixel backing stores, not PDF count: one root board shares this allowance with
// all its embedded descendants. Overview thumbnails have their separate cache.
export const BOARD_PDF_PIXELS=24_000_000;
export const PDF_PAGE_PIXELS=16_000_000;
const MAX_EDGE=8192;
const positive=(n:number)=>Number.isFinite(n)&&n>0;
export function splitPDFPixelBudget(budget:number,hasPages:boolean,childCount:number){
 const groups=(hasPages?1:0)+Math.max(0,Math.floor(childCount));
 return Math.floor(Math.min(BOARD_PDF_PIXELS,Math.max(0,budget))/(groups||1));
}
/** Rectangles use this board's CSS coordinates; displayScale includes ancestors. */
export function planBoardPDFRegions(pages:Array<PDFRect&{id:string}>,view:{width:number;height:number},displayScale:number,devicePixelRatio:number,budget=BOARD_PDF_PIXELS,progressive=false):Map<string,PDFRenderRegion>{
 const result=new Map<string,PDFRenderRegion>();
 if(!positive(view.width)||!positive(view.height)||!positive(displayScale)||!positive(devicePixelRatio)||!positive(budget))return result;
 const density=displayScale*Math.min(4,devicePixelRatio),buffers=progressive?2:1,pool=Math.min(BOARD_PDF_PIXELS,budget)/buffers;
 const desired=pages.flatMap(page=>{
  if(![page.x,page.y,page.width,page.height].every(Number.isFinite)||!positive(page.width)||!positive(page.height))return[];
  const left=Math.max(0,page.x),top=Math.max(0,page.y),right=Math.min(view.width,page.x+page.width),bottom=Math.min(view.height,page.y+page.height);
  if(right<=left||bottom<=top)return[];
  const quantum=128,margin=256;
  const x=progressive?Math.max(0,Math.floor((left-page.x-margin)/quantum)*quantum):left-page.x;
  const y=progressive?Math.max(0,Math.floor((top-page.y-margin)/quantum)*quantum):top-page.y;
  const endX=progressive?Math.min(page.width,Math.ceil((right-page.x+margin)/quantum)*quantum):right-page.x;
  const endY=progressive?Math.min(page.height,Math.ceil((bottom-page.y+margin)/quantum)*quantum):bottom-page.y;
  const width=endX-x,height=endY-y;
  const scale=Math.min(density,MAX_EDGE/width,MAX_EDGE/height,Math.sqrt(PDF_PAGE_PIXELS/buffers/(width*height)));
  return[{id:page.id,x,y,width,height,pageWidth:page.width,pageHeight:page.height,pixels:width*height*scale*scale,scale}];
 });
 const total=desired.reduce((sum,p)=>sum+p.pixels,0),factor=Math.min(1,Math.sqrt(pool/Math.max(1,total)));
 let remaining=Math.floor(pool);
 for(const page of desired){
  const pixelWidth=Math.max(1,Math.floor(page.width*page.scale*factor)),pixelHeight=Math.max(1,Math.floor(page.height*page.scale*factor));
  if(pixelWidth*pixelHeight>remaining)continue;
  const region={x:page.x,y:page.y,width:page.width,height:page.height,pageWidth:page.pageWidth,pageHeight:page.pageHeight,pixelWidth,pixelHeight,...(progressive?{pixelBudget:Math.min(PDF_PAGE_PIXELS/buffers,Math.floor(pool*page.pixels/Math.max(1,total)))}:{})};
  result.set(page.id,{...region,key:JSON.stringify(region)});remaining-=pixelWidth*pixelHeight;
 }
 return result;
}
/** PDF.js already applies its viewport transform; this maps its full page into a clipped backing store. */
export function pdfRegionTransform(region:PDFRenderRegion,viewport:{width:number;height:number}):number[]{
 const sx=region.pixelWidth/region.width,sy=region.pixelHeight/region.height;
 return[region.pageWidth/viewport.width*sx,0,0,region.pageHeight/viewport.height*sy,-region.x*sx,-region.y*sy];
}

export type PDFWebLink={url:string;left:number;top:number;width:number;height:number};
type Viewport={width:number;height:number;convertToViewportPoint:(x:number,y:number)=>number[]};
// Only ordinary web links get hit targets. Named PDF destinations, embedded
// files, launch actions and local/application schemes remain untouched.
export function pdfWebLinkRegions(annotations:unknown[],viewport:Viewport):PDFWebLink[]{
 if(!Number.isFinite(viewport.width)||!Number.isFinite(viewport.height)||viewport.width<=0||viewport.height<=0)return[];
 const links:PDFWebLink[]=[];
 for(const raw of annotations.slice(0,2000)){
  if(!raw||typeof raw!=='object')continue;const item=raw as Record<string,unknown>;
  if(item.subtype!=='Link'||typeof item.url!=='string'||item.url.length>2048||/[\x00-\x20\x7f]/.test(item.url)||!Array.isArray(item.rect)||item.rect.length!==4||!item.rect.every(Number.isFinite))continue;
  let url:URL;try{url=new URL(item.url);}catch{continue;}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
  const source=item.rect as number[],rect=[...viewport.convertToViewportPoint(source[0],source[1]),...viewport.convertToViewportPoint(source[2],source[3])];if(rect.length!==4||!rect.every(Number.isFinite))continue;
  const x1=Math.max(0,Math.min(rect[0],rect[2])),y1=Math.max(0,Math.min(rect[1],rect[3])),x2=Math.min(viewport.width,Math.max(rect[0],rect[2])),y2=Math.min(viewport.height,Math.max(rect[1],rect[3]));
  if(x2<=x1||y2<=y1)continue;
  links.push({url:url.href,left:x1/viewport.width*100,top:y1/viewport.height*100,width:(x2-x1)/viewport.width*100,height:(y2-y1)/viewport.height*100});if(links.length>=512)break;
 }
 return links;
}

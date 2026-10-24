export type ExtendMode='inline'|'margin'|'collapsed';
export type PDFNativeInkArchive={version:1;referenceWidth:number;data:string};
export type ExtendStroke={id:string;color:string;width:number;points:Array<[number,number]>;nativeInk?:PDFNativeInkArchive};
export type ExtendImage={id:string;resource:string;sha256:string;x:number;y:number;width:number;height:number};
export type ExtendBlock={id:string;page:number;anchorX:number;anchorY:number;height:number;mode:ExtendMode;orderKey:string;title:string;text:string;strokes:ExtendStroke[];images:ExtendImage[]};
export type ExtendEvent={schemaVersion:1;id:string;deviceID:string;createdAt:string;kind:'upsert'|'delete';targetID:string;sourceSHA256:string;baseEventID:string|null;block:ExtendBlock|null};
export type ExtendProjection={sourceSHA256:string;heads:ExtendEvent[];warnings:string[]};
export type PDFSourceAnchor={path:string;page:number;rect:{x:number;y:number;width:number;height:number};sourceSHA256:string;extendBlockID?:string};
export type PDFExcerptImage={dataURL:string;width:number;height:number};
export type PDFExcerpt=PDFSourceAnchor&{title:string;text:string;image?:PDFExcerptImage};
// CropBox after page rotation, top-left, page width is the unit for note content.
export function extendHeight(block:ExtendBlock,width:number){return block.mode==='inline'?block.height*width:block.mode==='collapsed'?32:40;}
export function orderedBlocks(blocks:ExtendBlock[],page:number){return blocks.filter(b=>b.page===page).sort((a,b)=>a.anchorY-b.anchorY||(a.orderKey<b.orderKey?-1:a.orderKey>b.orderKey?1:0)||(a.id<b.id?-1:a.id>b.id?1:0));}
export function originalToExtended(y:number,ratio:number,blocks:ExtendBlock[],width:number){return y*ratio*width+blocks.filter(b=>b.anchorY<=y).reduce((v,b)=>v+extendHeight(b,width),0);}
export function extendedToOriginal(y:number,ratio:number,blocks:ExtendBlock[],width:number){let added=0;for(const b of blocks){const start=b.anchorY*ratio*width+added,h=extendHeight(b,width);if(y>=start&&y<start+h)return{blockID:b.id,y:(y-start)/width};if(y<start)break;added+=h;}return{y:Math.max(0,Math.min(1,(y-added)/(ratio*width)))};}
export type PDFSourceReference=PDFSourceAnchor&{schemaVersion:1;quote:string};
export type PDFSourceFocus=PDFSourceReference&{nonce:number};

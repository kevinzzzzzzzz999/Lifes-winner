import type {Vault} from '../shared/desktop-api';
import type {PDFExcerpt,PDFExcerptImage} from '../shared/pdf-extend';

export const pdfBoardLinksKey='inkspace.pdf-board-links.v1';
export type PDFBoardTarget={path:string;boardID:string};
export type PDFBoardLink={vaultKey:string;sourcePath:string;target:PDFBoardTarget};
export type PDFBoardRequest={id:string;vaultId:string;vaultKey:string;sourcePath:string;excerpt?:PDFExcerpt;textReady?:Promise<string>;imageReady?:()=>Promise<PDFExcerptImage>};
export type PDFExcerptReceiver=(excerpt:PDFExcerpt,textReady?:Promise<string>,imageReady?:()=>Promise<PDFExcerptImage>)=>void;
// Register completed selections synchronously. Text extraction can outlive its page
// without cancelling an already committed excerpt or acquiring a new vault identity.
export function commitPDFExcerpt(excerpt:PDFExcerpt,extract:()=>Promise<string>,receive:PDFExcerptReceiver){
 const textReady=Promise.resolve().then(extract).catch(()=>'');
 receive(excerpt,textReady);
}
const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safe=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/^[\/]|[\\\u0000-\u001f]/.test(v)&&v.split('/').every(p=>p&&p!=='.'&&p!=='..');
export function pdfBoardVaultKey(v:Vault){return v.recentId?'recent:'+v.recentId:'session:'+v.id;}
export function parsePDFBoardLinks(raw:string|null):PDFBoardLink[]{
 try{if(!raw||raw.length>2_000_000)return[];const value=JSON.parse(raw);if(value?.version!==1||!Array.isArray(value.links))return[];
  return value.links.slice(-250).filter((v:PDFBoardLink)=>v&&typeof v.vaultKey==='string'&&v.vaultKey.length<=200&&safe(v.sourcePath)&&/\.pdf$/i.test(v.sourcePath)&&safe(v.target?.path)&&/\.inkspace\.json$/i.test(v.target.path)&&uuid.test(v.target.boardID)).map((v:PDFBoardLink)=>({vaultKey:v.vaultKey,sourcePath:v.sourcePath,target:{path:v.target.path,boardID:v.target.boardID.toLowerCase()}}));
 }catch{return[];}
}
export function updatePDFBoardLink(links:PDFBoardLink[],vaultKey:string,sourcePath:string,target?:PDFBoardTarget){
 const next=links.filter(l=>l.vaultKey!==vaultKey||l.sourcePath!==sourcePath);
 return target?[...next,{vaultKey,sourcePath,target:{...target,boardID:target.boardID.toLowerCase()}}].slice(-250):next;
}
export function remapPDFBoardLinks(links:PDFBoardLink[],vaultKey:string,moves:Array<{from:string;to:string}>,removed:string[]){
 const child=(p:string,r:string)=>p===r||p.startsWith(r+'/');
 const map=(p:string)=>{const m=[...moves].sort((a,b)=>b.from.length-a.from.length).find(m=>child(p,m.from));return m?m.to+p.slice(m.from.length):p;};
 return links.flatMap(l=>l.vaultKey!==vaultKey?[l]:removed.some(r=>child(l.sourcePath,r)||child(l.target.path,r))?[]:[{...l,sourcePath:map(l.sourcePath),target:{...l.target,path:map(l.target.path)}}]);
}
// Find a free position near the reading board's viewport. Successive excerpts must
// remain individually visible instead of stacking at precisely the same origin.
export function excerptPosition(board:Record<string,unknown>,size={width:360,height:220}){
 const items=(Array.isArray(board.items)?board.items:[]) as Array<{x:number;y:number;width:number;height:number}>;
 const view=board.viewport as {x?:number;y?:number}|undefined,W=Number(board.canvasWidth),H=Number(board.canvasHeight);
 const x=Math.max(0,Math.min(W-size.width-20,Number(view?.x)||0)),y=Math.max(0,Math.min(H-size.height-20,Number(view?.y)||0));
 for(let i=0;i<2000;i++){const px=x+Math.floor(i/30)*(size.width+60),py=y+(i%30)*(size.height+60);if(px+size.width>W||py+size.height>H)continue;
  if(!items.some(a=>px<a.x+a.width+16&&px+size.width+16>a.x&&py<a.y+a.height+16&&py+size.height+16>a.y))return{x:px,y:py};
 }
 throw Error('NO_EXCERPT_SPACE');
}
export function sameExcerptNode(node:Record<string,unknown>,e:PDFExcerpt){
 const r=node.sourceReference as Record<string,unknown>|undefined,rect=r?.rect as PDFExcerpt['rect']|undefined;
 return node.kind==='text'&&node.title===e.title&&node.text===e.text&&r?.path===e.path&&r?.sourceSHA256===e.sourceSHA256&&r?.page===e.page&&r?.extendBlockID===e.extendBlockID&&!!rect&&(['x','y','width','height'] as const).every(k=>rect[k]===e.rect[k]);
}

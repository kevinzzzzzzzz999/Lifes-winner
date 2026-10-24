export type StudyNode = Record<string, unknown> & {id:string;title:string;text?:string;kind:string};
export type OutlineRow = {node:StudyNode;depth:number;parentID:string|null;hasChildren:boolean};
const key=(v:unknown)=>String(v||'').toLowerCase();
export function studyNodes(board:Record<string,unknown>):StudyNode[]{
 return (Array.isArray(board.items)?board.items:[]).filter((n):n is StudyNode=>!!n&&typeof n==='object'&&typeof n.id==='string'&&typeof n.title==='string'&&['text','formula','inkGroup','pdfPage','document','link'].includes(n.kind));
}
// A cycle or a second parent never makes a card disappear from the outline.
export function studyOutline(board:Record<string,unknown>):OutlineRow[]{
 const nodes=studyNodes(board),byID=new Map(nodes.map(n=>[key(n.id),n])),parent=new Map<string,string>(),children=new Map<string,string[]>();
 for(const e of Array.isArray(board.edges)?board.edges:[]){
  if(!e||e.relation&&e.relation!=='child')continue;
  const a=key(e.from),b=key(e.to);if(a===b||!byID.has(a)||!byID.has(b)||parent.has(b))continue;
  let cursor:string|undefined=a,cyclic=false;const seen=new Set<string>();
  while(cursor){if(cursor===b||seen.has(cursor)){cyclic=true;break;}seen.add(cursor);cursor=parent.get(cursor);}
  if(cyclic)continue;parent.set(b,a);children.set(a,[...(children.get(a)||[]),b]);
 }
 const result:OutlineRow[]=[],seen=new Set<string>(),visit=(id:string)=>{
  const stack=[{id,depth:0}];while(stack.length){const entry=stack.pop()!;if(seen.has(entry.id))continue;seen.add(entry.id);const node=byID.get(entry.id);if(!node)continue;const next=children.get(entry.id)||[];
   result.push({node,depth:entry.depth,parentID:byID.get(parent.get(entry.id)||'')?.id||null,hasChildren:next.length>0});
   for(let i=next.length-1;i>=0;i--)stack.push({id:next[i],depth:entry.depth+1});
  }
 };
 for(const n of nodes)if(!parent.has(key(n.id)))visit(key(n.id));for(const n of nodes)visit(key(n.id));return result;
}
export function nodeImagePath(node?:StudyNode):string|undefined{return node?.kind==='document'&&typeof node.sourcePath==='string'&&/\.(png|jpe?g)$/i.test(node.sourcePath)?node.sourcePath:undefined;}
export function nodeAnswer(node?:StudyNode):string{
 if(!node)return '';if(typeof node.text==='string'&&node.text.trim())return node.text;
 const ref=node.sourceReference as {quote?:unknown}|undefined;return typeof ref?.quote==='string'?ref.quote:'';
}
function parseCloze(text:string):Array<{text:string;hidden:boolean}>|null{
 const result:Array<{text:string;hidden:boolean}>=[];let cursor=0,hiddenCount=0;
 while(cursor<text.length){const open=text.indexOf('{{',cursor),close=text.indexOf('}}',cursor);
  if(open<0){if(close>=0)return null;result.push({text:text.slice(cursor),hidden:false});break;}
  if(close<open+2)return null;const nested=text.indexOf('{{',open+2);if(nested>=0&&nested<close)return null;
  const value=text.slice(open+2,close);if(!value.trim())return null;
  if(open>cursor)result.push({text:text.slice(cursor,open),hidden:false});result.push({text:value,hidden:true});hiddenCount++;cursor=close+2;
 }
 return hiddenCount?result:null;
}
export function clozeParts(text:string):Array<{text:string;hidden:boolean}>{return parseCloze(text)||[{text,hidden:false}];}
export function validCloze(text:string){return parseCloze(text)!==null;}
// Local title aliases only: never scans or downloads the whole vault.
export function linkedTitles(node:StudyNode,nodes:StudyNode[]):StudyNode[]{
 const text=nodeAnswer(node).toLocaleLowerCase();if(!text)return [];
 return nodes.filter(other=>key(other.id)!==key(node.id)&&other.title.split(/[;；]/).some(title=>{
  const alias=title.trim().toLocaleLowerCase();if(alias.length<2||alias.length>120)return false;
  let index=text.indexOf(alias);while(index>=0){
   const before=text[index-1]||'',after=text[index+alias.length]||'';
   if(!/^[a-z0-9]/.test(alias)||(!/[a-z0-9]/.test(before)&&!/[a-z0-9]/.test(after)))return true;
   index=text.indexOf(alias,index+1);
  }return false;
 })).slice(0,20);
}

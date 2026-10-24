import type {VaultEntry} from '../shared/desktop-api';
export const VAULT_DRAG_TYPE='application/x-inkspace-vault-items';
export type VaultDrag={vaultId:string;paths:string[]};
export function decodeVaultDrag(raw:string,vaultId:string):VaultDrag|null{try{const data=JSON.parse(raw);if(data.vaultId!==vaultId||!Array.isArray(data.paths)||!data.paths.length||data.paths.length>100||data.paths.some((p:unknown)=>typeof p!=='string'||!p||p.startsWith('/')||p.split('/').some(x=>x==='.'||x==='..'||!x)))return null;return {vaultId,paths:[...new Set(data.paths)] as string[]};}catch{return null;}}
export function selectionAfterClick(selected:Set<string>,path:string,rows:string[],anchor:string|null,range:boolean){if(range&&anchor&&rows.includes(anchor)&&rows.includes(path)){const a=rows.indexOf(anchor),b=rows.indexOf(path);return new Set([...selected,...rows.slice(Math.min(a,b),Math.max(a,b)+1)].slice(0,100));}const next=new Set(selected);if(next.has(path))next.delete(path);else if(next.size<100)next.add(path);return next;}
export function reorderPaths(paths:string[],source:string,target:string,placement:'before'|'after'='before'){if(source===target||!paths.includes(source)||!paths.includes(target))return paths;const result=paths.filter(p=>p!==source);result.splice(result.indexOf(target)+(placement==='after'?1:0),0,source);return result;}
export function orderedEntries(entries:VaultEntry[],mode:string,order:string[]=[]){const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});const rank=new Map(order.map((p,i)=>[p,i]));return [...entries].sort((a,b)=>mode==='manual'?(rank.get(a.path)??Infinity)-(rank.get(b.path)??Infinity)||Number(b.kind==='folder')-Number(a.kind==='folder')||collator.compare(a.name,b.name):mode==='size'?b.bytes-a.bytes||collator.compare(a.name,b.name):Number(b.kind==='folder')-Number(a.kind==='folder')||collator.compare(a.name,b.name)*(mode==='descending'?-1:1));}

export type TreeDropIntent={kind:'move';targetPath:string;paths:string[]}|{kind:'reorder';source:string;target:string;placement:'before'|'after'}|{kind:'none';reason:'self'|'descendant'|'same-folder'|'not-folder'|'empty'};
/** Folder centers move. Only a single sibling in manual order can use insertion edges. */
export function treeDropIntent(paths:string[],target:{path:string;kind:string},mode:string,rowFraction:number):TreeDropIntent{
 if(!paths.length)return{kind:'none',reason:'empty'};
 if(paths.includes(target.path))return{kind:'none',reason:'self'};
 const parent=(path:string)=>path.split('/').slice(0,-1).join('/');
 const fraction=Number.isFinite(rowFraction)?Math.max(0,Math.min(1,rowFraction)):.5;
 const placement=target.kind==='folder'?(fraction<.25?'before':fraction>.75?'after':null):(fraction<.5?'before':'after');
 if(mode==='manual'&&paths.length===1&&parent(paths[0])===parent(target.path)&&placement)return{kind:'reorder',source:paths[0],target:target.path,placement};
 if(target.kind!=='folder')return{kind:'none',reason:'not-folder'};
 if(paths.some(path=>target.path.startsWith(path+'/')))return{kind:'none',reason:'descendant'};
 if(paths.some(path=>parent(path)===target.path))return{kind:'none',reason:'same-folder'};
 return{kind:'move',targetPath:target.path,paths:[...paths]};
}

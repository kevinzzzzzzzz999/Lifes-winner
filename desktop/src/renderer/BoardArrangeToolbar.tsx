import {Button} from './ui';
import type {Language} from './i18n';
import type {BoardOperation} from '../shared/desktop-api';

export type BoardTool='read'|'arrange'|'place'|'frameInk';
export type BoardRect={x:number;y:number;width:number;height:number};
export type BoardViewerOperation=BoardOperation;
export type ArrangeItem=BoardRect&{id:string;kind:string;title?:string;sourcePath?:string;sourceCardID?:string};
export const rectangleBetween=(a:{x:number;y:number},b:{x:number;y:number}):BoardRect=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
export function itemsWithin(items:ArrangeItem[],rect:BoardRect):string[]{return items.filter(item=>item.x>=rect.x&&item.y>=rect.y&&item.x+item.width<=rect.x+rect.width&&item.y+item.height<=rect.y+rect.height).map(item=>item.id);}
export function hitBoardItem(items:ArrangeItem[],point:{x:number;y:number}):ArrangeItem|undefined{for(let i=items.length-1;i>=0;i--){const item=items[i];if(point.x>=item.x&&point.y>=item.y&&point.x<=item.x+item.width&&point.y<=item.y+item.height)return item;}return undefined;}
export function sourceCardForSelection(items:ArrangeItem[],ids:string[]):ArrangeItem|null{
 if(!ids.length)return null;const byID=new Map(items.map(item=>[item.id.toLowerCase(),item]));let target:string|undefined;
 for(const id of ids){const item=byID.get(id.toLowerCase());const card=item?.kind==='document'?item.id:item?.kind==='pdfPage'?item.sourceCardID:undefined;if(!card||target&&target!==card.toLowerCase())return null;target=card.toLowerCase();}
 const card=target?byID.get(target):undefined;return card?.kind==='document'?card:null;
}
export function BoardArrangeToolbar({language,tool,onTool,replayActive=false,onReplay,selectedCount,busy,canPlace,canExpand,canCollapse,canUnpack,onExpand,onCollapse,onUnpack,onConnect,onClear}:{language:Language;tool:BoardTool;onTool:(tool:BoardTool)=>void;replayActive?:boolean;onReplay?:()=>void;selectedCount:number;busy:boolean;canPlace:boolean;canExpand:boolean;canCollapse:boolean;canUnpack:boolean;onExpand:()=>void;onCollapse:()=>void;onUnpack:()=>void;onConnect:()=>void;onClear:()=>void}){
 const zh=language==='zh';const modes:[BoardTool,string][]=[['read',zh?'阅读':'Read'],['arrange',zh?'管理移动':'Arrange / move'],['place',zh?'放置资料':'Place file'],['frameInk',zh?'框成节点':'Frame ink node']];
 return <div className="board-arrange-toolbar" role="toolbar" aria-label={zh?'白板管理工具':'Board arrangement tools'}>
  <div className="board-tool-modes">{modes.map(([mode,label])=><Button key={mode} data-testid={'board-mode-'+mode} aria-pressed={!replayActive&&tool===mode} disabled={busy||mode==='place'&&!canPlace} onClick={()=>onTool(mode)}>{label}</Button>)}{onReplay&&<Button data-testid="board-replay" aria-pressed={replayActive} disabled={busy} onClick={onReplay}>{zh?'回放':'Replay'}</Button>}</div>
  {selectedCount>0&&<><span className="board-selection-count" data-testid="board-selection-count">{selectedCount} {zh?'项已选':'selected'}</span><Button data-testid="board-selection-clear" disabled={busy} onClick={onClear}>{zh?'取消选择':'Clear selection'}</Button>
   <Button data-testid="board-connect" disabled={busy||selectedCount<2} onClick={onConnect}>{zh?'连接为分支':'Connect as branches'}</Button>
   {canExpand&&<Button data-testid="board-expand-document" disabled={busy} onClick={onExpand}>{canCollapse?(zh?'重新排列页面':'Rearrange pages'):(zh?'展开资料':'Expand document')}</Button>}
   {canCollapse&&<Button data-testid="board-collapse-document" disabled={busy} onClick={onCollapse}>{zh?'收起页面':'Collapse pages'}</Button>}
   {canUnpack&&<Button data-testid="board-unpack-ink" disabled={busy} onClick={onUnpack}>{zh?'解包手写节点':'Unpack ink node'}</Button>}
  </>}
 </div>;
}

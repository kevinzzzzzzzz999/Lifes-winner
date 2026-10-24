import {useEffect,useMemo,useRef,useState} from 'react';
import {Combine,FolderOpen,MousePointer2,Move,X} from 'lucide-react';
import type {BoardMergeResult,BoardMergeInspection,OpenedFile} from '../shared/desktop-api';
import type {Language} from './i18n';
import {BoardChooser} from './BoardEmbed';
import BoardViewer from './BoardViewer';
import {Button} from './ui';
import {defaultMergePosition,mergePlacementCamera,validMergeBounds,type MergePoint} from './board-merge-placement';
import './board-merge.css';

export type BoardMergePair={source:OpenedFile;target:OpenedFile;inspection:BoardMergeInspection};
export default function BoardMergeDialog({vaultId,sourcePath,language,onPrepare,onMerge,onClose}:{vaultId:string;sourcePath:string;language:Language;onPrepare:(targetPath:string)=>Promise<BoardMergePair>;onMerge:(pair:BoardMergePair,position:MergePoint)=>Promise<BoardMergeResult>;onClose:()=>void}){
 const zh=language==='zh';const[choosing,setChoosing]=useState(true),[pair,setPair]=useState<BoardMergePair|null>(null),[position,setPosition]=useState<MergePoint>({x:120,y:120}),[fixed,setFixed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const committing=useRef(false),mounted=useRef(true),epoch=useRef(0),root=useRef<HTMLElement>(null);
 useEffect(()=>{mounted.current=true;const previous=document.activeElement as HTMLElement|null;return()=>{mounted.current=false;epoch.current++;previous?.isConnected&&previous.focus({preventScroll:true});};},[]);
 useEffect(()=>{if(!choosing)root.current?.focus({preventScroll:true});},[choosing]);
 const choose=async(path:string)=>{
  if(path===sourcePath)throw Error(zh?'请选择另一张白板。':'Choose a different board.');
  const request=++epoch.current,next=await onPrepare(path);if(!mounted.current||request!==epoch.current)return;
  if(!validMergeBounds(next.inspection.sourceBounds))throw Error(zh?'来源内容的范围无法放置，请检查白板。':'The source bounds cannot be placed. Check the board.');
  setPosition(defaultMergePosition(next.inspection.sourceBounds,next.inspection.targetBounds));setFixed(false);setPair(next);setChoosing(false);setError('');
 };
 const merge=async()=>{
  if(!pair||!fixed||committing.current)return;committing.current=true;setBusy(true);setError('');
  try{await onMerge(pair,position);if(mounted.current)onClose();}
  catch(e){if(mounted.current)setError(e instanceof Error?e.message:String(e));}
  finally{committing.current=false;if(mounted.current)setBusy(false);}
 };
 const initialCamera=useMemo(()=>pair?mergePlacementCamera(pair.inspection.sourceBounds,defaultMergePosition(pair.inspection.sourceBounds,pair.inspection.targetBounds),pair.inspection.targetBounds):undefined,[pair]);
 if(choosing)return <BoardChooser vaultId={vaultId} language={language} initialPath={sourcePath.split('/').slice(0,-1).join('/')} notice={zh?'选择目标白板；下一步在目标上点击选位置。当前白板会保留。':'Choose a destination, then click its canvas to place the source. The source is retained.'} onClose={onClose} onChoose={choose}/>;
 if(!pair?.source.board||!pair.target.board)return null;
 const counts=pair.inspection.sourceCounts;
 return <div className="board-merge-placement-shade"><section className="board-merge-placement-workspace" ref={root} role="dialog" aria-modal="true" aria-label={zh?'选择合并位置':'Choose merge position'} tabIndex={-1} aria-busy={busy} onKeyDown={event=>{
  if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();if(!committing.current)onClose();}
  if(event.key==='Tab'){const nodes=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')||[]).filter(node=>node.getClientRects().length>0);const index=nodes.indexOf(document.activeElement as HTMLElement);if(nodes.length&&(index<0||(!event.shiftKey&&index===nodes.length-1)||(event.shiftKey&&index===0))){event.preventDefault();nodes[event.shiftKey?nodes.length-1:0].focus();}}
 }}>
  <header><div><span className="board-merge-eyebrow">{zh?'合并白板 · 选择位置':'MERGE WHITEBOARDS · PLACEMENT'}</span><h2>{pair.source.board.title?String(pair.source.board.title):pair.source.name}<span> → </span>{pair.target.board.title?String(pair.target.board.title):pair.target.name}</h2></div><Button disabled={busy} aria-label={zh?'取消合并':'Cancel merge'} onClick={onClose}><X/></Button></header>
  <div className="board-merge-placement-guidance"><MousePointer2/><span>{zh?'移动鼠标查看完整来源范围，点击选定位置。拖动可平移，滚轮或 + / − 可缩放。':'Move the pointer to preview the entire source, then click to select its position. Drag to pan; use the wheel or + / − to zoom.'}</span><Button disabled={busy} onClick={()=>{epoch.current++;setChoosing(true);}}><FolderOpen/>{zh?'更换目标':'Change destination'}</Button></div>
  <div className="board-merge-canvas" data-testid="merge-placement-canvas" inert={busy||undefined}>
   <BoardViewer key={pair.target.path+':'+pair.target.sha256} raw={pair.target.board} vaultId={vaultId} boardPath={pair.target.path} boardSHA={pair.target.sha256} language={language} onOpen={()=>{}} disabled initialCompact initialDirectoryOpen={false} initialViewport={initialCamera} mergePlacement={{source:pair.source.board,sourceBounds:pair.inspection.sourceBounds,position,fixed,onPositionChange:setPosition,onPlace:point=>{setPosition(point);setFixed(true);}}}/>
  </div>
  <footer><div className="board-merge-placement-state" role="status"><strong>{busy?(zh?'正在备份并合并…':'Backing up and merging…'):fixed?(zh?'位置已选定，确认后保存':'Position selected; confirm to save'):(zh?'请在目标白板上点击放置':'Click the destination canvas to place')}</strong><small>{zh?`${counts.items} 个对象 · ${Math.max(counts.nativeStrokes,counts.webStrokes)} 笔手写；原白板保留，合并后可以撤回。`:`${counts.items} objects · ${Math.max(counts.nativeStrokes,counts.webStrokes)} strokes. Source retained; this merge can be undone.`}</small>{error&&<p role="alert">{error}</p>}</div><Button disabled={busy||!fixed} onClick={()=>setFixed(false)}><Move/>{zh?'重新选位置':'Reposition'}</Button><Button disabled={busy} onClick={onClose}>{zh?'取消':'Cancel'}</Button><Button data-testid="merge-confirm" className="primary" disabled={busy||!fixed} onClick={()=>void merge()}><Combine/>{zh?'确认合并':'Confirm merge'}</Button></footer>
 </section></div>;
}

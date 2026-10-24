import {boardPDFOwnerIDs} from '../shared/board-pdf-owners';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Pause,Play,RotateCcw,LocateFixed,Maximize2,Minus,Plus} from 'lucide-react';
import type {Language} from './i18n';
import {Button,Modal} from './ui';
import {inkReplay,type ReplayStroke} from './ink-replay';
import {replayItems,replayCursor,replayPage,locateReplay,followReplay,overviewReplay,zoomReplay,replayWorld,replayStrokeBounds,replayIntersects,type ReplayCamera} from './ink-replay-camera';
import ReplayBackgrounds from './ReplayBackgrounds';
import {ReplayAssets} from './replay-assets';
import './ink-replay.css';
import ReplayDisplayControl,{useReplayDisplayMode} from './ReplayDisplayControl';
import {futureInkOpacity} from './replay-display';
import {paintReplayStroke as paintStroke} from './replay-paint';
const clock=(n:number)=>Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0');
export default function InkReplayDialog({board,vaultId,language,onClose,embedded=false,initialCamera}:{board:Record<string,unknown>;vaultId:string;language:Language;onClose:()=>void;embedded?:boolean;initialCamera?:ReplayCamera}){
 const zh=language==='zh',snapshot=useMemo(()=>structuredClone(board),[board]);
 const replay=useMemo(()=>inkReplay((snapshot.webInk as {strokes?:ReplayStroke[]}|undefined)?.strokes||[]),[snapshot]),items=useMemo(()=>replayItems(snapshot.items),[snapshot]),bounds=useMemo(()=>replay.entries.map(replayStrokeBounds),[replay]);
 const assets=useMemo(()=>new ReplayAssets(vaultId,String(snapshot.id||''),window.desktop.getAssetUrl,boardPDFOwnerIDs(snapshot)),[vaultId,snapshot]);useEffect(()=>()=>assets.dispose(),[assets]);
 const[displayMode,setDisplayMode]=useReplayDisplayMode();
 const futureCache=useRef<{canvas:HTMLCanvasElement;key:string;start:number}|null>(null);
 useEffect(()=>{cache.current=null;futureCache.current=null;},[replay]);
 const[backgroundStatus,setBackgroundStatus]=useState('');
 const[elapsed,setElapsed]=useState(replay.total),[playing,setPlaying]=useState(false),[speed,setSpeed]=useState(1),[following,setFollowing]=useState(!initialCamera),[size,setSize]=useState({width:820,height:480});
 const initial=replayCursor(replay.entries,replay.total),[camera,setCamera]=useState<ReplayCamera>(()=>initialCamera?{...initialCamera}:initial?locateReplay(initial.point,replayPage(items,initial.point),size):overviewReplay(items,size));
 const canvas=useRef<HTMLCanvasElement>(null),stage=useRef<HTMLDivElement>(null),cache=useRef<{canvas:HTMLCanvasElement;count:number;key:string}|null>(null),drag=useRef<{id:number;x:number;y:number;camera:ReplayCamera}|null>(null),lastPage=useRef<string|undefined>(undefined),measured=useRef(false);
 const cursor=replayCursor(replay.entries,elapsed),page=cursor?replayPage(items,cursor.point):undefined;
 useEffect(()=>{const node=stage.current;if(!node)return;const observer=new ResizeObserver(([entry])=>{const next={width:Math.max(1,entry.contentRect.width),height:Math.max(1,entry.contentRect.height)};setSize(next);if(!measured.current){measured.current=true;const end=replayCursor(replay.entries,replay.total);setCamera(initialCamera?{...initialCamera}:end?locateReplay(end.point,replayPage(items,end.point),next):overviewReplay(items,next));lastPage.current=end?replayPage(items,end.point)?.id:undefined;}});observer.observe(node);return()=>observer.disconnect();},[replay,items]);
 useEffect(()=>{if(!playing)return;let frame:number,last=performance.now();const tick=(now:number)=>{const delta=Math.min(.15,(now-last)/1000);last=now;setElapsed(old=>Math.min(replay.total,old+delta*speed));frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);},[playing,speed,replay.total]);
 useEffect(()=>{if(elapsed>=replay.total)setPlaying(false);},[elapsed,replay.total]);
 useEffect(()=>{if(!following||!cursor)return;const previousPageID=lastPage.current;setCamera(old=>followReplay(old,cursor.point,page,previousPageID,size));lastPage.current=page?.id;},[following,cursor?.point.x,cursor?.point.y,page?.id,size]);
 useEffect(()=>{
  const node=canvas.current;if(!node)return;const dpr=Math.min(2,window.devicePixelRatio||1),width=Math.round(size.width*dpr),height=Math.round(size.height*dpr),key=JSON.stringify([width,height,camera,displayMode]);node.width=width;node.height=height;const ctx=node.getContext('2d');if(!ctx)return;
  const scale=camera.zoom*dpr,tx=width/2-camera.x*scale,ty=height/2-camera.y*scale,world=replayWorld(camera,size),completed=cursor?.completed||0;
  if(!cache.current||cache.current.key!==key||completed<cache.current.count){const layer=document.createElement('canvas');layer.width=width;layer.height=height;cache.current={canvas:layer,count:0,key};}
  const layer=cache.current,base=layer.canvas.getContext('2d');if(!base)return;base.setTransform(scale,0,0,scale,tx,ty);
  for(;layer.count<completed;layer.count++)if(replayIntersects(bounds[layer.count],world))paintStroke(base,replay.entries[layer.count].stroke,1,replay.stride,scale);
  if(displayMode==='dimmed'){
   const start=completed+1;
   if(!futureCache.current||futureCache.current.key!==key||futureCache.current.start!==start){const future=document.createElement('canvas');future.width=width;future.height=height;const f=future.getContext('2d');if(f){f.setTransform(scale,0,0,scale,tx,ty);for(let i=start;i<replay.entries.length;i++)if(replayIntersects(bounds[i],world))paintStroke(f,replay.entries[i].stroke,1,replay.stride,scale,0,futureInkOpacity);}futureCache.current={canvas:future,key,start};}
   ctx.drawImage(futureCache.current.canvas,0,0);
  }
  ctx.drawImage(layer.canvas,0,0);ctx.setTransform(scale,0,0,scale,tx,ty);
  const current=replay.entries[completed];if(current&&replayIntersects(bounds[completed],world)){
   const progress=Math.max(0,Math.min(1,(elapsed-current.start)/(current.end-current.start)));
   if(displayMode==='dimmed'&&progress<1&&!(current.stroke.points.length===1&&progress>0))paintStroke(ctx,current.stroke,1,replay.stride,scale,progress,futureInkOpacity);
   paintStroke(ctx,current.stroke,progress,replay.stride,scale);
  }
 },[elapsed,replay,size,camera,bounds,cursor?.completed,displayMode]);
 useEffect(()=>{const node=stage.current;if(!node)return;const wheel=(event:WheelEvent)=>{event.preventDefault();const rect=node.getBoundingClientRect();setPlaying(false);setFollowing(false);setCamera(old=>zoomReplay(old,size,{x:event.clientX-rect.left,y:event.clientY-rect.top},Math.exp(-Math.max(-100,Math.min(100,event.deltaY))*.006)));};node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);},[size]);
 const positionAt=(time:number)=>{const current=replayCursor(replay.entries,time);if(current){const currentPage=replayPage(items,current.point);setCamera(locateReplay(current.point,currentPage,size));lastPage.current=currentPage?.id;}};
 const manual=(next:ReplayCamera)=>{setPlaying(false);setFollowing(false);setCamera(next);};
 const begin=()=>{if(playing){setPlaying(false);return;}if(elapsed>=replay.total){setElapsed(0);setFollowing(true);positionAt(0);}setPlaying(true);};
 const restart=()=>{setPlaying(false);setElapsed(0);setFollowing(true);positionAt(0);};
 const locate=()=>{positionAt(elapsed);setFollowing(true);};
 const done=cursor?.completed||0;
 const content=<div className={'ink-replay'+(embedded?' is-inline':'')} data-testid={embedded?'ink-replay-inline':'ink-replay-dialog'}>
  <header><strong>{String(snapshot.title||(zh?'白板':'Whiteboard'))}</strong><small>{zh?'只读快照 · 不会修改笔记':'Read-only snapshot · notes stay unchanged'}</small></header>
  <div className="ink-replay-navigation"><Button data-testid="ink-replay-follow" aria-pressed={following} onClick={locate}><LocateFixed/>{zh?'定位／跟随当前笔':'Locate / follow current stroke'}</Button><Button data-testid="ink-replay-overview" onClick={()=>manual(overviewReplay([...items,...bounds],size))}><Maximize2/>{zh?'总览':'Overview'}</Button><span className="spacer"/><Button aria-label={zh?'缩小回放':'Zoom replay out'} onClick={()=>manual(zoomReplay(camera,size,{x:size.width/2,y:size.height/2},1/1.25))}><Minus/></Button><output data-testid="ink-replay-zoom">{camera.zoom<.1?(camera.zoom*100).toFixed(1):Math.round(camera.zoom*100)}%</output><Button aria-label={zh?'放大回放':'Zoom replay in'} onClick={()=>manual(zoomReplay(camera,size,{x:size.width/2,y:size.height/2},1.25))}><Plus/></Button></div>
  <div className="ink-replay-location" role="status" data-testid="ink-replay-location">{page?`${page.title||'PDF'} · ${zh?'第':'Page'} ${page.page||1}${zh?' 页':''}`:zh?'白板书写区域':'Board writing area'} · {following?(zh?'跟随书写':'Following ink'):(zh?'自由查看 · 已关闭跟随':'Free view · following off')}{elapsed>=replay.total&&replay.entries.length?(zh?' · 已显示完整笔记，播放将从头开始':' · Complete ink shown; Play starts at the beginning'):''}</div>
  <div ref={stage} className="ink-replay-stage" data-testid="ink-replay-stage" data-camera={JSON.stringify(camera)} data-stroke-index={cursor?.index??-1} data-playing={playing} data-display-mode={displayMode} tabIndex={0} aria-label={zh?'回放画面，拖动或滚轮缩放；空格播放暂停':'Replay view. Drag to pan, wheel to zoom, Space to play or pause'}
   onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,camera};setPlaying(false);setFollowing(false);}}
   onPointerMove={e=>{const d=drag.current;if(d?.id!==e.pointerId)return;setCamera({...d.camera,x:d.camera.x-(e.clientX-d.x)/d.camera.zoom,y:d.camera.y-(e.clientY-d.y)/d.camera.zoom});}}
   onPointerUp={e=>{if(drag.current?.id===e.pointerId){drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}} onPointerCancel={()=>{drag.current=null;}}
   onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.code==='Space'){e.preventDefault();begin();}else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();manual({...camera,x:camera.x+(e.key==='ArrowRight'?80:e.key==='ArrowLeft'?-80:0)/camera.zoom,y:camera.y+(e.key==='ArrowDown'?80:e.key==='ArrowUp'?-80:0)/camera.zoom});}else if(e.key==='+'||e.key==='='||e.key==='-'){e.preventDefault();manual(zoomReplay(camera,size,{x:size.width/2,y:size.height/2},e.key==='-'?1/1.25:1.25));}}}>
   <ReplayBackgrounds items={items} camera={camera} size={size} assets={assets} language={language} onSummary={setBackgroundStatus}/>
   <canvas ref={canvas} className="ink-replay-ink" aria-label={zh?'只读笔迹回放画面':'Read-only handwriting replay'} data-testid="ink-replay-canvas"/>
   {!replay.entries.length&&<p className="replay-empty" role="status">{zh?'这份白板没有可回放的笔迹预览；可在 iPad 保存后刷新。':'This board has no replayable ink preview. Save it on iPad, then refresh.'}</p>}
  </div>
  <small role="status" aria-live="polite" data-testid="ink-replay-background-status">{backgroundStatus}</small>
  <div className="ink-replay-progress"><input type="range" min="0" max="1000" step="1" value={replay.total?Math.round(elapsed/replay.total*1000):0} disabled={!replay.entries.length} aria-label={zh?'回放进度':'Replay progress'} data-testid="ink-replay-progress" onChange={e=>{const time=Number(e.target.value)/1000*replay.total;setPlaying(false);setElapsed(time);if(following)positionAt(time);}}/><output data-testid="ink-replay-count">{done} / {replay.entries.length} · {clock(elapsed)} / {clock(replay.total)}</output></div>
  <footer><Button autoFocus data-testid="ink-replay-toggle" disabled={!replay.entries.length} className="primary" onClick={begin}>{playing?<Pause/>:<Play/>}{playing?(zh?'暂停':'Pause'):(elapsed>=replay.total?(zh?'从头播放':'Play from beginning'):(zh?'播放':'Play'))}</Button><Button data-testid="ink-replay-restart" disabled={!replay.entries.length} onClick={restart}><RotateCcw/>{zh?'从头开始':'Restart'}</Button><label>{zh?'速度':'Speed'}<select data-testid="ink-replay-speed" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[.5,1,2,4].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></label><ReplayDisplayControl mode={displayMode} onChange={setDisplayMode} language={language}/><Button data-testid="ink-replay-close" onClick={onClose}>{embedded?(zh?'退出回放':'Exit replay'):(zh?'关闭':'Close')}</Button></footer>
  <small className="ink-replay-mode" data-testid="ink-replay-mode">{replay.timed?(zh?'按记录时间回放 · 长停顿压缩至 0.75 秒':'Recorded-time order · long pauses shortened to 0.75 seconds'):(zh?'缺少完整时间记录，按保存的笔画顺序回放':'Complete timestamps unavailable; replaying saved stroke order')}{replay.longStrokes?(zh?' · 单笔最长播放 30 秒':' · Strokes capped at 30 seconds'):''}{replay.stride>1?(zh?' · 大型白板已简化预览采样':' · Large-board preview sampling is reduced'):''}。</small>
  <small>{zh?'背景按当前区域读取；加载失败不会阻止笔迹。隐藏本白板已写回 PDF 的笔迹，保留他人批注。仅回放当前保留的笔迹，不包含已擦除笔迹或子白板内部书写。':'Backgrounds load for the visible area; missing materials do not block ink. This board’s PDF writeback ink is hidden while other annotations remain. Only surviving ink is replayed, excluding erased ink and ink inside child boards.'}</small>
 </div>;
 return embedded?content:<Modal title={zh?'笔迹回放':'Handwriting replay'} closeOnBackdrop={false} onClose={onClose}>{content}</Modal>;
}

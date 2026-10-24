import {useEffect,useRef,useState} from 'react';
import {X,Maximize2} from 'lucide-react';
import {Button,basename} from './ui';
import type {Language} from './i18n';
import VideoPlayer,{type VideoPlaybackState} from './VideoPlayer';
import './floating-video.css';
import PDFWorkspace,{type ReadingLinks} from './PDFWorkspace';
import {ReadingOverlayBase} from './reading-overlay-context';
import {pdfWorkspaceBusy} from './PDFWorkspaceState';
export default function FloatingVideo({vaultId,path,language,onClose,initialPlayback,onDocumentLink,onRootFileLink,onWikiLink,resolveDocumentMedia,onReadingOpen}:{vaultId:string;path:string;language:Language;onClose:()=>void;initialPlayback?:VideoPlaybackState}&ReadingLinks){
 const zh=language==='zh',panel=useRef<HTMLElement>(null);const[position,setPosition]=useState({x:Math.max(12,window.innerWidth-700),y:80});const drag=useRef<{x:number;y:number;left:number;top:number;pointer:number}|null>(null);const[large,setLarge]=useState(false);const[error,setError]=useState('');const[comparison,setComparison]=useState<VideoPlaybackState|null>(null);
 useEffect(()=>{const resize=()=>{setPosition(p=>({x:Math.max(0,Math.min(p.x,window.innerWidth-300)),y:Math.max(0,Math.min(p.y,window.innerHeight-120))}));};window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 const close=()=>{if(comparison&&pdfWorkspaceBusy(vaultId)){setError(zh?'请先完成 PDF 批注或重试保存，再关闭并排阅读。':'Finish PDF annotations or retry saving before closing side-by-side reading.');return;}onClose();};
 return <ReadingOverlayBase.Provider value={70}><section ref={panel} role="region" aria-label={zh?'浮动视频播放器':'Floating video player'} className={`floating-video ${large?'expanded':''}`} data-testid="floating-video" style={large?undefined:{left:position.x,top:position.y}}>
 <header onPointerDown={e=>{if(e.button!==0||large||(e.target as HTMLElement).closest('button'))return;const box=e.currentTarget.parentElement!.getBoundingClientRect();drag.current={x:e.clientX,y:e.clientY,left:box.left,top:box.top,pointer:e.pointerId};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{const start=drag.current;if(!start)return;setPosition({x:Math.max(0,Math.min(start.left+e.clientX-start.x,window.innerWidth-250)),y:Math.max(0,Math.min(start.top+e.clientY-start.y,window.innerHeight-90))});}} onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}>
 <strong title={path}>{basename(path)}</strong><Button aria-label={zh?(large?'还原窗口大小':'放大播放器'):(large?'Restore player size':'Enlarge player')} onClick={()=>setLarge(v=>!v)}><Maximize2/></Button><Button aria-label={zh?'关闭视频':'Close video'} onClick={close}><X/></Button></header>
 {comparison?<PDFWorkspace key={vaultId+':'+path} vaultId={vaultId} initialVideo={{path,name:basename(path),playback:comparison}} language={language} onDocumentLink={onDocumentLink} onRootFileLink={onRootFileLink} onWikiLink={onWikiLink} resolveDocumentMedia={resolveDocumentMedia} onReadingOpen={onReadingOpen}/>:<VideoPlayer onCompare={saved=>{setComparison(saved);setLarge(true);}} vaultId={vaultId} path={path} language={language} autoStart initialPlayback={initialPlayback} onDetach={playback=>{void window.desktop.openVideoWindow({vaultId,path,playback}).then(result=>{if(result.ok)onClose();else setError(zh?'独立窗口暂未打开，请重试。':'Could not open a separate window. Try again.');}).catch(()=>setError(zh?'独立窗口暂未打开，请重试。':'Could not open a separate window. Try again.'));}}/>}{error&&<p role="alert" className="form-error">{error}</p>}
 <p className="floating-video-hint">{zh?'拖动标题移动 · 拖动右下角调整大小':'Drag the title to move · drag the lower-right corner to resize'}</p>
 </section></ReadingOverlayBase.Provider>;
}

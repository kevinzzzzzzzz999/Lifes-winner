import {displayBrand} from '../shared/brand';
import {useEffect,useState} from 'react';
import {Pin,PinOff} from 'lucide-react';
import VideoPlayer,{type VideoPlaybackState} from './VideoPlayer';
import {initialLanguage,type Language} from './i18n';
import type {ApiResult} from '../shared/desktop-api';
import './detached-video-window.css';

type VideoWindowInfo={vaultId:string;path:string;pinned:boolean;playback?:VideoPlaybackState};
declare global{interface Window{videoWindow?:{info:()=>Promise<ApiResult<VideoWindowInfo|null>>;setPinned:(request:{pinned:boolean})=>Promise<ApiResult<{pinned:boolean}>>}}}
export default function DetachedVideoWindow(){
 const [language]=useState<Language>(initialLanguage),[info,setInfo]=useState<VideoWindowInfo|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false);const zh=language==='zh',word=(a:string,b:string)=>zh?a:b;
 useEffect(()=>{let active=true;void window.videoWindow?.info().then(result=>{if(!active)return;if(result.ok&&result.value)setInfo(result.value);else setError(zh?'这个播放器已关闭，请重新打开视频。':'This player has closed. Open the video again.');}).catch(()=>{if(active)setError(zh?'无法读取播放器状态，请重新打开视频。':'Player state is unavailable. Open the video again.');});return()=>{active=false;};},[zh]);
 useEffect(()=>{document.title=(info?.path.split('/').at(-1)||word('独立播放器','Video player'))+' — '+displayBrand(language);},[info?.path,language]);
 const pin=async()=>{if(!info||pending)return;setPending(true);setError('');try{const result=await window.videoWindow?.setPinned({pinned:!info.pinned});if(!result?.ok)throw Error('unavailable');setInfo(current=>current?{...current,pinned:result.value.pinned}:current);}catch{setError(word('置顶设置未完成，请重试。','Could not change the pin setting. Try again.'));}finally{setPending(false);}};
 return <main className="detached-video-window" data-testid="detached-video-window"><header className="detached-video-header"><div><strong>{word('独立播放器','Independent video player')}</strong><small>{info?.path.split('/').at(-1)||word('正在打开…','Opening…')}</small></div><button type="button" data-testid="detached-video-pin" aria-pressed={info?.pinned||false} disabled={!info||pending} onClick={()=>void pin()}>{info?.pinned?<PinOff size={16}/>:<Pin size={16}/>}<span>{info?.pinned?word('取消置顶','Unpin window'):word('置顶窗口','Pin window')}</span></button></header><p className="detached-video-hint">{word('可拖到其他应用上方；使用窗口左上角按钮最小化、缩放或全屏。','Move this window over other apps. Use the native window controls to minimize, resize or enter fullscreen.')}</p>{info?<VideoPlayer vaultId={info.vaultId} path={info.path} language={language} autoStart initialPlayback={info.playback}/>:<p role="status">{word('正在打开视频…','Opening video…')}</p>}{error&&<p role="status" className="detached-video-error">{error}</p>}</main>;
}

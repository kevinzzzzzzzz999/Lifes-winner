import {useEffect,useId,useRef,useState} from 'react';
import type {Language} from './i18n';
import {boardWebURL} from './board-web-links';
import './board-web-card.css';

const ACTIVATE='inkspace-board-web-activate';
export type BoardWebCardProps={url:string;title:string;language:Language;interactive?:boolean;onOpenBrowser?:(url:string)=>void|Promise<void>};
/** A real sandboxed frame. A user gesture is required; only one card is active.
 * We never proxy sites, strip response headers, or grant frame escape permissions. */
export default function BoardWebCard({url,title,language,interactive=true,onOpenBrowser}:BoardWebCardProps){
 const zh=language==='zh',safe=boardWebURL(url),id=useId();
 const waitingTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const finishWaiting=()=>{if(waitingTimer.current)clearTimeout(waitingTimer.current);waitingTimer.current=null;setWaiting(false);};
 const [active,setActive]=useState(false),[generation,setGeneration]=useState(0),[waiting,setWaiting]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setActive(false);setWaiting(false);setError('');},[safe]);
 useEffect(()=>{const pause=(event:Event)=>{if((event as CustomEvent<string>).detail!==id){setActive(false);setWaiting(false);}};window.addEventListener(ACTIVATE,pause);return()=>window.removeEventListener(ACTIVATE,pause);},[id]);
 useEffect(()=>{if(!interactive)setActive(false);},[interactive]);
 useEffect(()=>{if(!active)return;setWaiting(false);waitingTimer.current=setTimeout(()=>setWaiting(true),12000);return()=>{if(waitingTimer.current)clearTimeout(waitingTimer.current);waitingTimer.current=null;};},[active,generation]);
 const browse=()=>{if(!safe||!interactive)return;window.dispatchEvent(new CustomEvent(ACTIVATE,{detail:id}));setError('');setActive(true);};
 const open=async()=>{if(!safe)return;setError('');try{if(onOpenBrowser)await onOpenBrowser(safe);else{if(!window.desktop?.openExternal)throw Error(zh?'请在桌面应用中打开。':'Open this card in the desktop app.');const result=await window.desktop.openExternal({url:safe,application:'browser'});if(!result.ok)throw Error(result.error.message);}}catch(e){setError(e instanceof Error?e.message:String(e));}};
 return <section className="board-web-card" data-testid="board-web-card" data-active={active&&interactive} style={{pointerEvents:interactive?'auto':'none'}} onPointerDown={e=>{if(interactive)e.stopPropagation();}} onDoubleClick={e=>{if(interactive)e.stopPropagation();}}>
  <header><strong title={title}>{title|| (zh?'网页':'Web page')}</strong><span title={safe||url}>{safe?new URL(safe).host:(zh?'无效网址':'Invalid URL')}</span></header>
  <div className="board-web-tools" onPointerDown={e=>e.stopPropagation()}>
   <button type="button" disabled={!safe||!interactive} onClick={()=>active?setActive(false):browse()} data-testid="board-web-browse">{active?(zh?'暂停网页':'Pause page'):(zh?'在白板内浏览':'Browse on board')}</button>
   {active&&<button type="button" onClick={()=>setGeneration(v=>v+1)} aria-label={zh?'重新加载网页':'Reload page'}>↻</button>}
   <button type="button" disabled={!safe||!interactive} onClick={()=>void open()} data-testid="board-web-open-browser">{zh?'内部浏览器':'In-app browser'}</button>
  </div>
  <div className="board-web-content">
   {active&&safe&&interactive?<iframe key={safe+'\n'+generation} src={safe} title={title||new URL(safe).host} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" onLoad={finishWaiting} onError={()=>setError(zh?'网页无法在卡片中加载，请使用内部浏览器。':'This page could not load in a card. Use the in-app browser.')}/>:<div className="board-web-paused"><p>{safe?(interactive?(zh?'点“在白板内浏览”载入网页。其他网页卡会暂停。':'Choose Browse on board to load this page. Other web cards pause.'):(zh?'整理模式可移动、调整卡片。切换阅读模式后浏览网页。':'Move or resize this card in arrange mode. Switch to reading mode to browse.')):(zh?'网页卡只接受不含账号密码的 http / https 地址。':'Web cards require an http / https URL without embedded credentials.')}</p></div>}
  </div>
  <footer role="status">{error|| (waiting?(zh?'网页仍在等待响应。可重新加载，或转到内部浏览器。':'Still waiting for the page. Reload or use the in-app browser.'):(zh?'若网站拒绝嵌入或显示空白，请用内部浏览器打开原链接。':'If a site refuses embedding or appears blank, open the original link in the in-app browser.'))}</footer>
 </section>;
}

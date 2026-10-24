import {useEffect,useRef,useState} from 'react';
import {Pause,Play,Square,Volume2} from 'lucide-react';
import type {Language} from './i18n';
export type SpeechRect={x:number;y:number;width:number;height:number};
export type SpeechPart={text:string;rect:SpeechRect;rectAt?:(offset:number,length:number)=>SpeechRect};
export function BoardSpeech({language,getParts,onHighlight,autoStart=0}:{language:Language;autoStart?:number;getParts:()=>SpeechPart[];onHighlight:(rect:SpeechRect|null)=>void}){
 const zh=language==='zh',[mode,setMode]=useState<'mixed'|'zh-CN'|'en-US'>('mixed'),[rate,setRate]=useState(1),[state,setState]=useState<'idle'|'playing'|'paused'>('idle'),[error,setError]=useState('');
 const epoch=useRef(0),alive=useRef(true),utterance=useRef<SpeechSynthesisUtterance|null>(null),stateRef=useRef(state);stateRef.current=state;
 const stop=()=>{epoch.current++;window.speechSynthesis?.cancel();utterance.current=null;setState('idle');onHighlight(null);void window.desktop.setBoardSpeechActive({active:false});};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;window.speechSynthesis?.cancel();void window.desktop.setBoardSpeechActive({active:false});onHighlight(null);};},[]);
 const play=async()=>{
  stop();setError('');const owner=epoch.current;
  try{if(!window.speechSynthesis)throw Error(zh?'系统朗读暂不可用。':'System speech is unavailable.');
   let voices=speechSynthesis.getVoices().filter(v=>v.localService);if(!voices.length){await new Promise<void>(resolve=>{const timeout=setTimeout(done,1800);function done(){clearTimeout(timeout);speechSynthesis.removeEventListener('voiceschanged',done);resolve();}speechSynthesis.addEventListener('voiceschanged',done);});voices=speechSynthesis.getVoices().filter(v=>v.localService);}
   if(owner!==epoch.current||!alive.current)return;
   const parts=getParts().filter(p=>p.text.trim());if(!parts.length)throw Error(zh?'请先选取要朗读的文字。':'Select text to read first.');
   const segments=parts.flatMap(part=>{const source=part.text.slice(0,30000);const expression=mode==='mixed'?/[\p{Script=Han}]+[^A-Za-z\p{Script=Han}]*|[A-Za-z][A-Za-z0-9\s,.;:!?\-'’]*|[^A-Za-z\p{Script=Han}]+/gu:/[\s\S]{1,220}/g;return Array.from(source.matchAll(expression)).filter(m=>m[0].trim()).flatMap(m=>{const chunks=Array.from(m[0].matchAll(/[\s\S]{1,220}/g));return chunks.map(chunk=>({...part,text:chunk[0],offset:(m.index||0)+(chunk.index||0),lang:mode==='mixed'?(/[\p{Script=Han}]/u.test(chunk[0])?'zh-CN':'en-US'):mode}));});}).slice(0,1200);
   const voiceFor=(lang:string)=>voices.find(v=>v.lang.replace('_','-').toLowerCase()===lang.toLowerCase()&&(/ting|samantha|mei|li/i.test(v.name)))||voices.find(v=>v.lang.replace('_','-').toLowerCase()===lang.toLowerCase());
   if(segments.some(p=>!voiceFor(p.lang)))throw Error(zh?'请在 macOS 辅助功能「朗读内容」中下载普通话和美式英文语音后重试。':'Download Mandarin and American English voices in macOS Spoken Content, then retry.');
   const active=await window.desktop.setBoardSpeechActive({active:true});if(!active.ok)throw Error(active.error.message);if(owner!==epoch.current||!alive.current){void window.desktop.setBoardSpeechActive({active:false});return;}
   setState('playing');let index=0;
   const speakNext=()=>{if(owner!==epoch.current||!alive.current)return;if(index>=segments.length){stop();return;}const part=segments[index++],u=new SpeechSynthesisUtterance(part.text);u.voice=voiceFor(part.lang)!;u.lang=part.lang;u.rate=rate;utterance.current=u;u.onstart=()=>{if(owner===epoch.current)onHighlight(part.rect);};u.onboundary=event=>{if(owner===epoch.current)onHighlight(part.rectAt?.(part.offset+event.charIndex,event.charLength||1)||part.rect);};u.onend=()=>speakNext();u.onerror=e=>{if(owner!==epoch.current||e.error==='canceled'||e.error==='interrupted')return;stop();setError(zh?'系统朗读中断，请重试。':'System speech was interrupted. Try again.');};speechSynthesis.speak(u);};speakNext();
  }catch(error){if(owner!==epoch.current||!alive.current)return;stop();setError(error instanceof Error?error.message:String(error));}
 };
 useEffect(()=>{if(autoStart)void play();},[autoStart]);
 return <div className="board-speech" data-testid="board-speech" data-state={state}>
  <select aria-label={zh?'朗读语言':'Reading language'} value={mode} disabled={state!=='idle'} onChange={e=>setMode(e.target.value as typeof mode)}><option value="mixed">{zh?'中英混读':'Chinese + English'}</option><option value="zh-CN">{zh?'普通话':'Mandarin'}</option><option value="en-US">{zh?'美式英文':'American English'}</option></select>
  <select aria-label={zh?'朗读速度':'Reading speed'} value={rate} disabled={state!=='idle'} onChange={e=>setRate(Number(e.target.value))}>{[.7,1,1.25,1.5,2].map(v=><option key={v} value={v}>{v}×</option>)}</select>
  {state==='idle'?<button data-testid="board-speech-play" onClick={()=>void play()}><Volume2/>{zh?'朗读选区':'Read selection'}</button>:<><button data-testid="board-speech-toggle" onClick={()=>{if(state==='paused'){void window.desktop.setBoardSpeechActive({active:true});speechSynthesis.resume();setState('playing');}else{speechSynthesis.pause();void window.desktop.setBoardSpeechActive({active:false});setState('paused');}}}>{state==='paused'?<Play/>:<Pause/>}{state==='paused'?(zh?'继续':'Resume'):(zh?'暂停':'Pause')}</button><button data-testid="board-speech-stop" onClick={stop}><Square/>{zh?'停止':'Stop'}</button></>}
  {error&&<span role="status">{error}</span>}
 </div>;
}

import {useEffect,useRef,useState} from 'react';
import {Search,ArrowUpRight,FileText,X} from 'lucide-react';
import type {Language} from './i18n';
import './command-palette.css';
export type QuickAction={id:string;title:string;detail?:string;keywords?:string;run:()=>void;file?:boolean};
export default function CommandPalette({language,actions,onClose}:{language:Language;actions:QuickAction[];onClose:()=>void}){
 const zh=language==='zh',[query,setQuery]=useState(''),[selected,setSelected]=useState(0);const input=useRef<HTMLInputElement>(null),dialog=useRef<HTMLElement>(null);
 const words=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean),results=actions.filter(a=>words.every(w=>(a.title+' '+(a.detail||'')+' '+(a.keywords||'')).toLocaleLowerCase().includes(w))).slice(0,40),activeIndex=Math.max(0,Math.min(selected,results.length-1));
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;input.current?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[]);
 useEffect(()=>{setSelected(0);},[query]);
 useEffect(()=>{setSelected(index=>Math.max(0,Math.min(index,results.length-1)));},[results.length]);
 useEffect(()=>{dialog.current?.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});},[activeIndex,query]);
 const execute=(action:QuickAction)=>{onClose();queueMicrotask(action.run);};
 return <div className="command-shade" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section ref={dialog} role="dialog" aria-modal="true" aria-label={zh?'快速前往':'Quick switcher'} className="command-palette" onKeyDown={e=>{
 if(e.nativeEvent.isComposing)return;
 if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}
 if(e.key==='Tab'){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('input,button')||[]);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 }}><div className="command-search"><Search/><input ref={input} role="combobox" aria-expanded="true" aria-controls="quick-results" aria-activedescendant={results[activeIndex]?'quick-option-'+activeIndex:undefined} aria-autocomplete="list" aria-label={zh?'搜索功能或已打开的资料':'Find a tool or recent file'} placeholder={zh?'前往文件、白板或功能…':'Find a file, whiteboard, or tool…'} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setSelected(i=>Math.max(0,Math.min(results.length-1,i+(e.key==='ArrowDown'?1:-1))));}else if(e.key==='Enter'&&results[activeIndex]){e.preventDefault();execute(results[activeIndex]);}}}/><button aria-label={zh?'关闭快捷入口':'Close quick switcher'} onClick={onClose}><X/></button></div>
 <div id="quick-results" role="listbox" aria-label={zh?'可前往的内容':'Destinations'} className="command-results">{results.map((a,i)=><div role="option" aria-selected={i===activeIndex} id={'quick-option-'+i} key={a.id} onMouseMove={()=>setSelected(i)} onMouseDown={e=>e.preventDefault()} onClick={()=>execute(a)}>{a.file?<FileText/>:<ArrowUpRight/>}<span><strong>{a.title}</strong>{a.detail&&<small>{a.detail}</small>}</span></div>)}{!results.length&&<p className="command-empty">{zh?'没有匹配项。可回到首页搜索知识库中的文件内容。':'No match. Use library search on Home to search document contents.'}</p>}</div>
 <footer><span>{zh?'↑ ↓ 选择 · Enter 打开 · Esc 关闭':'↑ ↓ Select · Enter Open · Esc Close'}</span><span>{zh?'当前文件夹与最近资料':'Current folder & recent files'}</span></footer></section></div>;
}

import {useState} from 'react';
import {Star,Trash2} from 'lucide-react';
import {Button,Modal} from './ui';
import type {Language} from './i18n';
import type {BoardPaperBackground} from '../shared/desktop-api';
import {DEFAULT_PAPER,PAPER_PRESETS,PAPER_LIBRARY_KEY,cleanPaper,validPaper,parsePaperLibrary,paperScreenStyle,type PaperLibrary} from './board-paper';
import './board-paper.css';

export default function BoardPaperDialog({current,language,onClose,onApply}:{current:unknown;language:Language;onClose:()=>void;onApply:(value:BoardPaperBackground|null)=>Promise<void>}){
 const zh=language==='zh';
 const [draft,setDraft]=useState<BoardPaperBackground>(validPaper(current)?cleanPaper(current):{...DEFAULT_PAPER});
 const [library,setLibrary]=useState<PaperLibrary>(()=>{try{return parsePaperLibrary(localStorage.getItem(PAPER_LIBRARY_KEY));}catch{return{version:1,favorites:[]};}});
 const [libraryError]=useState(()=>{try{parsePaperLibrary(localStorage.getItem(PAPER_LIBRARY_KEY));return '';}catch(e){return String(e);}});
 const [name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [baseline,setBaseline]=useState(()=>{try{return localStorage.getItem(PAPER_LIBRARY_KEY);}catch{return null;}});
 function persist(next:PaperLibrary){
  try{if(libraryError)throw Error(libraryError);if(localStorage.getItem(PAPER_LIBRARY_KEY)!==baseline)throw Error(zh?'另一窗口已修改收藏，请关闭后重新打开。':'The library changed in another window. Reopen this dialog.');const text=JSON.stringify(next);parsePaperLibrary(text);localStorage.setItem(PAPER_LIBRARY_KEY,text);if(localStorage.getItem(PAPER_LIBRARY_KEY)!==text)throw Error('Paper save failed');setBaseline(text);setLibrary(next);setError('');return true;}catch(e){setError(e instanceof Error?e.message:String(e));return false;}
 }
 async function apply(value:BoardPaperBackground|null){setBusy(true);setError('');try{await onApply(value&&cleanPaper(value));onClose();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 const patch=(value:Partial<BoardPaperBackground>)=>setDraft(old=>({...old,...value}));
 if(current!=null&&!validPaper(current))return <Modal title={zh?'纸张与网格':'Paper & grid'} onClose={onClose}><p>{zh?'这张白板的背景来自其他版本，已保留原数据。当前版本可以继续阅读和编辑笔记，暂不能修改此背景。':'This background uses a different format. Its original data is preserved; you can continue editing notes, but cannot change this background here.'}</p></Modal>;
 return <Modal title={zh?'纸张与网格':'Paper & grid'} closeOnBackdrop={false} onClose={()=>{if(!busy)onClose();}}><div className="board-paper-dialog">
  <p>{zh?'只改变白板背景，笔迹、文件和位置保持。应用后可以撤销；收藏仅保存在本机。':'Changes the background only. Ink, files and positions stay intact. Applying can be undone; favorites stay on this device.'}</p>
  <div className="board-paper-presets">{PAPER_PRESETS.map(p=><Button key={p.nameEn} disabled={busy} onClick={()=>setDraft({...p.value})}>{zh?p.name:p.nameEn}</Button>)}</div>
  <div className="board-paper-preview" aria-label={zh?'纸张预览':'Paper preview'} style={paperScreenStyle(draft,{x:180,y:55,zoom:1},{width:360,height:110})}><span>Aa · 123</span></div>
  <div className="board-paper-fields">
   <label>{zh?'样式':'Pattern'}<select value={draft.kind} disabled={busy} onChange={e=>patch({kind:e.target.value as BoardPaperBackground['kind']})}><option value="plain">{zh?'纯色 / 关闭格线':'Plain / no lines'}</option><option value="ruled">{zh?'横线':'Ruled'}</option><option value="grid">{zh?'方格':'Grid'}</option><option value="dots">{zh?'点阵':'Dots'}</option></select></label>
   <label>{zh?'纸张颜色':'Paper color'}<input aria-label={zh?'纸张颜色':'Paper color'} type="color" value={draft.color} disabled={busy} onChange={e=>patch({color:e.target.value})}/></label>
   <label>{zh?'格线颜色':'Line color'}<input aria-label={zh?'格线颜色':'Line color'} type="color" value={draft.lineColor} disabled={busy} onChange={e=>patch({lineColor:e.target.value})}/></label>
   <label>{zh?'间距':'Spacing'}<input aria-label={zh?'格线间距':'Grid spacing'} type="number" min={8} max={240} value={draft.spacing} disabled={busy} onChange={e=>patch({spacing:Number(e.target.value)})}/></label>
   <label>{zh?'线宽':'Line width'}<input aria-label={zh?'格线线宽':'Grid line width'} type="number" min={.25} max={4} step={.25} value={draft.lineWidth} disabled={busy} onChange={e=>patch({lineWidth:Number(e.target.value)})}/></label>
   <label>{zh?'格线深浅':'Line opacity'}<input aria-label={zh?'格线深浅':'Grid opacity'} type="range" min={0} max={1} step={.05} value={draft.opacity} disabled={busy} onChange={e=>patch({opacity:Number(e.target.value)})}/></label>
  </div>
  <div className="board-paper-favorite-add"><input aria-label={zh?'模板名称':'Template name'} placeholder={zh?'收藏这个模板…':'Favorite this template…'} maxLength={60} value={name} disabled={busy||!!libraryError} onChange={e=>setName(e.target.value)}/><Button disabled={busy||!!libraryError||!name.trim()||!validPaper(draft)||library.favorites.length>=50} onClick={()=>{if(persist({...library,favorites:[...library.favorites,{id:crypto.randomUUID(),name:name.trim(),background:cleanPaper(draft)}]}))setName('');}}><Star/>{zh?'收藏':'Favorite'}</Button></div>
  {library.favorites.length>0&&<div className="board-paper-favorites" aria-label={zh?'收藏模板':'Favorite templates'}>{library.favorites.map(f=><div key={f.id}><Button disabled={busy} onClick={()=>setDraft({...f.background})}>{f.name}</Button><Button aria-label={(zh?'移除收藏：':'Remove favorite: ')+f.name} disabled={busy||!!libraryError} onClick={()=>persist({...library,favorites:library.favorites.filter(x=>x.id!==f.id)})}><Trash2/></Button></div>)}</div>}
  {(error||libraryError)&&<p className="inline-error" role="alert">{error||libraryError}</p>}
  <div className="modal-actions"><Button disabled={busy} onClick={()=>void apply(null)}>{zh?'恢复原始背景':'Reset original background'}</Button><Button disabled={busy} onClick={onClose}>{zh?'取消':'Cancel'}</Button><Button className="primary" disabled={busy||!validPaper(draft)} onClick={()=>void apply(draft)}>{busy?(zh?'正在保存…':'Saving…'):(zh?'应用到白板':'Apply to board')}</Button></div>
 </div></Modal>;
}

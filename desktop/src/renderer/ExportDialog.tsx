import {useRef,useState} from 'react';
import type {OpenedFile} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button,Modal} from './ui';
import type {ExportView} from './export-view';
import {boardExportSheet,printExportSheets} from './board-export';
export default function ExportDialog({file,vaultId,language,view,onClose,onCurrentView,onSaved}:{file:OpenedFile;vaultId:string;language:Language;view:ExportView;onClose:()=>void;onCurrentView:()=>Promise<void>;onSaved:()=>void}){
 const zh=language==='zh',[busy,setBusy]=useState(false),[cancellable,setCancellable]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');const control=useRef<AbortController|null>(null);
 const isPDF=/\.pdf$/i.test(file.path),isBoard=file.kind==='board';
 const run=async(kind:'source'|'reading'|'view')=>{
  if(control.current)return;const c=new AbortController();control.current=c;setBusy(true);setError('');setMessage(zh?'准备导出…':'Preparing export…');let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   let saved=false;
   if(kind==='source'){const result=await window.desktop.exportSourceFile({vaultId,path:file.path,expectedSHA256:file.sha256});if(!result.ok)throw Error(result.error.message);saved=result.value.saved;}
   else if(kind==='view'&&!isBoard&&!isPDF){await onCurrentView();onClose();return;}
   else{
    setCancellable(true);timer=setTimeout(()=>c.abort(),180000);
    const preparing=isBoard?boardExportSheet(file,vaultId,c.signal,setMessage,kind==='view'?view.board:undefined).then(sheet=>[sheet]):import('./pdf-reading-export').then(m=>m.pdfReadingExportSheets(file,vaultId,c.signal,setMessage,kind==='view'?view.pdfPage:undefined));
    const sheets=await new Promise<Awaited<typeof preparing>>((resolve,reject)=>{const abort=()=>reject(Error(zh?'导出已取消或超时；未保存部分文件。':'Export cancelled or timed out. No partial file was saved.'));c.signal.addEventListener('abort',abort,{once:true});preparing.then(value=>{c.signal.removeEventListener('abort',abort);resolve(value);},e=>{c.signal.removeEventListener('abort',abort);reject(e);});if(c.signal.aborted)abort();});
    if(c.signal.aborted)throw Error(zh?'导出已取消或准备超时；未保存不完整文件。':'Export cancelled or preparation timed out. No partial file was saved.');
    const fresh=await window.desktop.readFile({vaultId,path:file.path});if(!fresh.ok||fresh.value.sha256!==file.sha256)throw Error(zh?'原文件已变化，请关闭此窗口后重试导出。':'Source changed. Close this dialog and retry.');
    if(c.signal.aborted)throw Error(zh?'已取消':'Cancelled');setMessage(zh?'准备完整页面…':'Preparing complete pages…');
    const name=file.name.replace(/\.(inkspace\.json|pdf)$/i,'')+(kind==='view'?(isBoard?(zh?'.当前区域.pdf':'.current-area.pdf'):(zh?'.第'+view.pdfPage+'页.pdf':'.page-'+view.pdfPage+'.pdf')):(zh?'.阅读版.pdf':'.reading.pdf')); 
    saved=(await printExportSheets(sheets,name.slice(0,190),c.signal,()=>{clearTimeout(timer);setCancellable(false);setMessage(zh?'选择保存位置…':'Choose where to save…');},{vaultId,path:file.path,expectedSHA256:file.sha256})).saved;
   }
   if(saved){onSaved();onClose();}else setMessage(zh?'已取消保存，没有生成新文件。':'Save cancelled. No new file was created.');
  }catch(e){setError(e instanceof Error?e.message:String(e));setMessage('');}
  finally{clearTimeout(timer);control.current=null;setBusy(false);setCancellable(false);}
 };
 return <Modal title={zh?'下载与导出':'Download & export'} closeOnBackdrop={false} onClose={()=>{if(!busy)onClose();}}><p><strong>{file.name}</strong></p>
 <div style={{display:'grid',gap:14}}>
  {(isPDF||isBoard)&&<section><Button className="primary" data-testid="export-reading-full" disabled={busy} onClick={()=>void run('reading')}>{isBoard?(zh?'完整白板 → PDF':'Entire board → PDF'):(zh?'全部页面与笔记 → PDF':'All pages & notes → PDF')}</Button><p className="muted">{isBoard?(zh?'包含视野外的对象、笔迹和展开的子白板。视频与网页以文件卡片保留。':'Includes off-screen items, ink and expanded child boards. Videos and web pages remain reference cards.'):(zh?'包含可见图层和全部留白；页边及折叠笔记在对应位置展开。PDF 原页以 216 DPI 图像保存，原始矢量和可选文字请使用下方原文件副本。':'Includes visible layers and all extended notes. Margin and collapsed notes expand at their anchors. Source pages are 216 DPI images; use the original copy below to preserve original vectors and selectable text.')}</p></section>}
  <section><Button data-testid="export-source-copy" disabled={busy} onClick={()=>void run('source')}>{zh?'另存原文件副本':'Save original file copy'}</Button><p className="muted">{isBoard?(zh?'保留白板 JSON；关联文件仍位于原资料库，此副本不包含外部附件。':'Copies the board JSON. Linked files remain in the original library; attachments are not bundled.'):(zh?'保持原文件内容和格式；独立批注和留白不合并到此副本。':'Preserves the original file and format. Separate annotations and extended notes are not merged.')}</p></section>
  <details><summary>{zh?'其他导出方式':'Other export options'}</summary><Button data-testid="export-current-view" disabled={busy||(isBoard&&!view.board)||(isPDF&&!view.pdfPage)} onClick={()=>void run('view')}>{isBoard?(zh?'当前白板区域 → PDF':'Current board area → PDF'):isPDF?(zh?'当前页与笔记 → PDF':'Current page & notes → PDF'):(zh?'仅当前视图 → PDF':'Current view only → PDF')}</Button><p className="muted">{isBoard?(view.board?(zh?'使用当前阅读位置和缩放，包含此区域中的笔迹与资料。':'Uses the current reading position and zoom, including ink and materials in this area.'):(zh?'请切换到白板阅读或整理模式后导出当前区域。':'Switch to board reading or arrangement mode to export the current area.')):isPDF?(zh?'保存当前页的完整内容、可见图层与留白。':'Saves the complete current page, visible layers and notes.'):(zh?'仅保存目前显示的区域。':'Saves the currently displayed area.')}</p></details>
 </div>{message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}{cancellable&&<Button onClick={()=>control.current?.abort()}>{zh?'取消准备':'Cancel preparation'}</Button>}</Modal>;
}

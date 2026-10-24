import {useEffect,useRef,useState} from 'react';
import type {BoardOperation,BoardRelinkPreview,BoardRelinkProgress,DirectoryListing} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button,Modal} from './ui';
import {PDFPage} from './PDFViewer';
import './board-relink.css';

export default function BoardRelinkDialog({vaultId,boardPath,boardSHA,id,field,oldPath,language,blocked,onConfirm,onClose}:{vaultId:string;boardPath:string;boardSHA:string;id:string;field:'sourcePath'|'originalSourcePath';oldPath:string;language:Language;blocked:boolean;onConfirm:(operation:BoardOperation)=>Promise<boolean>;onClose:()=>void}) {
 const zh=language==='zh',epoch=useRef(0),saving=useRef(false);
 const [listing,setListing]=useState<DirectoryListing|null>(null),[preview,setPreview]=useState<BoardRelinkPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false);
 const [requestId,setRequestId]=useState<string|null>(null),[progress,setProgress]=useState<BoardRelinkProgress|null>(null),[cancelling,setCancelling]=useState(false);
 const activeRequest=useRef<string|null>(null);
 const label=(cn:string,en:string)=>zh?cn:en;
 useEffect(()=>{if(!requestId)return;let active=true;const poll=async()=>{try{const result=await window.desktop.getBoardRelinkProgress({vaultId,requestId});if(active&&result.ok)setProgress(result.value);}catch{}};void poll();const timer=setInterval(()=>void poll(),400);return()=>{active=false;clearInterval(timer);};},[requestId,vaultId]);
 useEffect(()=>()=>{if(activeRequest.current)void window.desktop.cancelBoardRelink({vaultId,requestId:activeRequest.current});},[vaultId]);
 const beginWork=()=>{const id=crypto.randomUUID();activeRequest.current=id;setRequestId(id);setProgress(null);setCancelling(false);return id;};
 const endWork=()=>{activeRequest.current=null;setRequestId(null);setProgress(null);setCancelling(false);};
 const cancelWork=async()=>{if(!requestId||!progress?.cancellable||cancelling)return;setCancelling(true);try{await window.desktop.cancelBoardRelink({vaultId,requestId});}catch{setCancelling(false);}};
 const errorMessage=(code:string,message:string)=>({
  RELINK_SOURCE_AVAILABLE:label('原路径的文件仍可读取，无需重新关联。请刷新白板。','The original path is readable. Refresh the board; no relink is needed.'),
  RELINK_TYPE_MISMATCH:label('候选文件类型与原资料不同，请重新选择。','Choose a candidate with the same file type.'),
  RELINK_CONTENT_MISMATCH:label('候选内容与已记录的原资料指纹不同，已阻止关联。同名文件不代表同一份资料。','The candidate does not match the recorded original fingerprint. Relinking was blocked; matching names are not proof.'),
  RELINK_PAGE_MISSING:label('候选 PDF 缺少白板引用的页码，已阻止关联。','The candidate PDF lacks a referenced page. Relinking was blocked.'),
  CANCELLED:label('核验已取消，原引用和文件均保留。','Verification cancelled; references and files are unchanged.'),
  RELINK_PDF_METADATA_UNAVAILABLE:label('PDF页数读取工具不可用，文件和白板未改动。','The PDF metadata reader is unavailable; files and the board are unchanged.'),
  CONFLICT:label('白板或候选文件已变化。请关闭此窗口、刷新白板后重新选择。','The board or candidate changed. Close this dialog, refresh the board and select again.')
 } as Record<string,string>)[code]||message;
 async function load(path:string) {
  const ticket=++epoch.current;setBusy(true);setError('');setPreview(null);setConfirmed(false);
  try {const result=await window.desktop.listDirectory({vaultId,path});if(ticket!==epoch.current)return;if(!result.ok)throw Error(result.error.message);setListing(result.value);}
  catch(e){if(ticket===epoch.current)setError(e instanceof Error?e.message:String(e));}finally{if(ticket===epoch.current)setBusy(false);}
 }
 useEffect(()=>{void load('');return()=>{epoch.current++;};},[vaultId,boardPath,id,field]);
 async function inspect(candidatePath:string) {
  const ticket=++epoch.current;setBusy(true);setError('');setPreview(null);setConfirmed(false);const requestId=beginWork();
  try {const result=await window.desktop.prepareBoardRelink({vaultId,path:boardPath,expectedSHA256:boardSHA,id,field,candidatePath,requestId});if(ticket!==epoch.current)return;if(!result.ok)throw Error(errorMessage(result.error.code,result.error.message));setPreview(result.value);}
  catch(e){if(ticket===epoch.current)setError(e instanceof Error?e.message:String(e));}finally{if(ticket===epoch.current){setBusy(false);endWork();}}
 }
 async function save() {
  if(!preview||!confirmed||busy||blocked||saving.current)return;saving.current=true;setBusy(true);setError('');const requestId=beginWork();
  try {const saved=await onConfirm({type:'relinkSource',id,field,oldPath:preview.oldPath,candidatePath:preview.candidatePath,candidateSHA256:preview.candidateSHA256,confirmed:true,requestId});if(saved)onClose();else setError(label('重新关联未完成，原引用已保留。请查看白板提示并重新选择。','Relinking did not complete; the original reference remains. Check the board message and select again.'));}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{saving.current=false;setBusy(false);endWork();}
 }
 const ext=(value:string)=>value.slice(value.lastIndexOf('.')).toLowerCase().replace(/^\.jpeg$/,'.jpg');
 const entries=listing?.entries.filter(entry=>entry.kind==='folder'||ext(entry.path)===ext(oldPath))||[];
 return <Modal title={label('重新关联失联资料','Relink missing source')} closeOnBackdrop={false} onClose={()=>{if(!busy)onClose();}}><div className="board-relink" data-testid="board-relink-dialog">
  <p>{label('从当前资料库选择移动或改名后的原文件。仅更新这张资料卡及其从属展开页的引用；原文件不移动、不覆盖。保存后可用白板“撤销”恢复旧引用。','Choose the moved or renamed original in this vault. This updates the selected card and its expanded pages. Files are never moved or overwritten. Board Undo restores the old references.')}</p>
  <p>{label('原资料路径','Original source path')}<code data-testid="relink-old-path">{preview?.oldFullPath||oldPath}</code></p>
  {!preview?<><div className="board-relink-location"><Button disabled={busy||!listing?.path} onClick={()=>void load(listing?.parent||'')}>{label('上层','Parent')}</Button><Button disabled={busy||!listing?.path} onClick={()=>void load('')}>{label('根目录','Root')}</Button><code>{listing?.path||'/'}</code><Button disabled={busy} onClick={()=>void load(listing?.path||'')}>{label('刷新','Refresh')}</Button></div>
  <div className="board-relink-files">{entries.map(entry=><Button key={entry.path} data-relink-path={entry.path} disabled={busy} onClick={()=>entry.kind==='folder'?void load(entry.path):void inspect(entry.path)}>{entry.kind==='folder'?'▸ ':''}{entry.name}</Button>)}{listing&&!entries.length&&<p>{label('此文件夹没有相同类型的候选资料。','No candidate of the same type in this folder.')}</p>}</div>
  <p className="muted">{label('若文件被移到资料库之外，请先自行放回当前资料库内，再刷新选择。不会搜索或自动连接同名文件。','If moved outside this vault, first place the file inside this vault and refresh. Matching names are never connected automatically.')}</p></>:<>
   <p>{label('新资料路径','New source path')}<code data-testid="relink-new-path">{preview.candidateFullPath}</code></p>
   <p>{label(`将更新 ${preview.affectedCount} 个对象 · ${preview.bytes.toLocaleString()} 字节`,`Updates ${preview.affectedCount} objects · ${preview.bytes.toLocaleString()} bytes`)}{preview.pageCount!=null&&label(` · PDF 共 ${preview.pageCount} 页`,` · ${preview.pageCount} PDF pages`)}</p>
   <p role="status">{preview.fingerprintMatched?label('内容指纹与原资料记录一致。','Content fingerprint matches the recorded original.'):label('此旧引用未记录内容指纹，无法自动证明是同一文件。请核对完整路径和下方预览；文件名相同并不足以确认。','This older reference has no recorded fingerprint. Verify the full path and preview; a matching name alone does not prove identity.')}</p>
   <details><summary>{label('候选文件内容指纹','Candidate content fingerprint')}</summary><code>{preview.candidateSHA256}</code></details>
   {preview.previewURL&&<div className="board-relink-preview">{ext(preview.candidatePath)==='.pdf'?<PDFPage url={preview.previewURL} page={preview.page}/>:<img src={preview.previewURL} alt={label('候选资料预览','Candidate source preview')}/>}</div>}
   {preview.previewUnavailable&&<p>{label('大文件已完成分块指纹核验；此窗口不加载整份预览。请核对完整路径、文件大小及 PDF 页数。','Large-file fingerprint verification is complete. This dialog does not load a full preview; check the complete path, size and PDF page count.')}</p>}
   <label className="board-relink-confirm"><input data-testid="relink-acknowledge" type="checkbox" checked={confirmed} disabled={busy||blocked} onChange={event=>setConfirmed(event.target.checked)}/>{label('我已核对，这就是移动或改名后的原资料。','I checked that this is the moved or renamed original.')}</label>
  </>}
  {error&&<p role="alert">{error}</p>}{busy&&<div role="status" data-testid="relink-progress"><p>{progress?.phase==='hashing'?label(`正在核验内容：${(progress.bytesDone/1048576).toFixed(1)} / ${(progress.bytesTotal/1048576).toFixed(1)} MiB`,`Verifying content: ${(progress.bytesDone/1048576).toFixed(1)} / ${(progress.bytesTotal/1048576).toFixed(1)} MiB`):progress?.phase==='metadata'?label('正在读取 PDF 页数…','Reading PDF page count…'):progress?.phase==='saving'?label('正在保存引用…','Saving references…'):label('正在检查文件…','Checking the file…')}</p>{progress?.phase==='hashing'&&<progress max={Math.max(1,progress.bytesTotal)} value={progress.bytesDone}/>}<Button data-testid="relink-cancel-work" disabled={!progress?.cancellable||cancelling} onClick={()=>void cancelWork()}>{cancelling?label('正在取消…','Cancelling…'):label('取消核验','Cancel verification')}</Button></div>}
  <div className="modal-actions"><Button disabled={busy} onClick={onClose}>{label('取消','Cancel')}</Button>{preview&&<><Button disabled={busy} onClick={()=>{setPreview(null);setConfirmed(false);setError('');}}>{label('重新选择','Choose another')}</Button><Button data-testid="relink-confirm" className="primary" disabled={busy||blocked||!confirmed} onClick={()=>void save()}>{label('确认重新关联并保存','Confirm relink and save')}</Button></>}</div>
 </div></Modal>;
}

import {useEffect,useRef,useState} from 'react';
import {Copy,FileText,ScanText,Square} from 'lucide-react';
import type {LocalOCRResult,Vault} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button,Modal,basename} from './ui';
import './local-ocr.css';
import ocrEnglish from './local-ocr-english.json';
export default function LocalOCRDialog({vault,path,language,onClose,onSaved}:{vault:Vault;path:string;language:Language;onClose:()=>void;onSaved:(path:string)=>Promise<void>}){
 const zh=language==='zh',pdf=/\.pdf$/i.test(path);const[start,setStart]=useState(1),[end,setEnd]=useState(1),[available,setAvailable]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState(''),[result,setResult]=useState<LocalOCRResult|null>(null),[saved,setSaved]=useState<string|null>(null);
 const request=useRef<string|null>(null),alive=useRef(true);
 const message=(code:string,fallback:string)=>zh?({OCR_UNAVAILABLE:'这台 Mac 暂无可用的本机识别组件。',OCR_PAGE_RANGE:'请选择 PDF 中实际存在的页码，每次最多 10 页。',OCR_LOCKED:'PDF 已加密，请使用已解锁副本识别。',OCR_TIMEOUT:'识别超过时间上限，请等待文件下载完成或缩小页码范围。',OCR_FAILED:'暂时无法识别，请检查原文件已下载且可正常阅读。',OCR_OUTPUT_LIMIT:'文字超过本次输出上限，请缩小页码范围。',OCR_RESULT_EXPIRED:'识别结果已过期，请重新识别。',CANCELLED:'已停止，原文件未改变。',CONFLICT:'原文件已变化，请重新识别后保存。',TOO_LARGE:'文件超过识别上限：PDF 256 MB、图片 64 MB 或 8000 万像素。'}[code]||fallback):fallback;
 useEffect(()=>{alive.current=true;void window.desktop.localOCRInfo().then(response=>{if(!alive.current)return;if(response.ok)setAvailable(response.value.available);else{setAvailable(false);setError(message(response.error.code,response.error.message));}}).catch(()=>{if(alive.current){setAvailable(false);setError(zh?'无法检查本机识别组件。':'Could not check local OCR.');}});return()=>{alive.current=false;if(request.current)void window.desktop.cancelLocalOCR({requestId:request.current});};},[]);
 const stop=()=>{if(request.current)void window.desktop.cancelLocalOCR({requestId:request.current});};
 const run=async()=>{
  const id=crypto.randomUUID();request.current=id;setBusy(true);setError('');setStatus('');setResult(null);setSaved(null);
  try{const response=await window.desktop.recognizeLocalOCR({vaultId:vault.id,path,requestId:id,startPage:start,endPage:end});if(!alive.current)return;if(!response.ok)throw Error(message(response.error.code,response.error.message));setResult(response.value);}
  catch(error){if(alive.current)setError(error instanceof Error?error.message:String(error));}finally{if(request.current===id)request.current=null;if(alive.current)setBusy(false);}
 };
 const copy=async()=>{if(!result)return;setError('');const response=await window.desktop.copyLocalOCR({vaultId:vault.id,path,resultId:result.id});if(response.ok)setStatus(zh?'识别文字已复制。':'Recognized text copied.');else setError(message(response.error.code,response.error.message));};
 const save=async()=>{if(!result||saving)return;setSaving(true);setError('');try{const response=await window.desktop.saveLocalOCR({vaultId:vault.id,path,resultId:result.id});if(!response.ok)throw Error(message(response.error.code,response.error.message));setSaved(response.value.path);setStatus(zh?'已另存为独立笔记，原文件未改变。':'Saved a separate note. The original is unchanged.');}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setSaving(false);}};
 const valid=Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=1&&end>=start&&end-start<10&&end<=100000;
 const hasText=result?.pages.some(page=>page.text.trim());
 return <Modal title={zh?'图文识别 OCR':'Local OCR'} closeOnBackdrop={false} onClose={()=>{if(busy)stop();else if(!saving)onClose();}}><div className="local-ocr" data-testid="local-ocr-dialog" aria-busy={busy||saving}>
  <div className="local-ocr-source"><ScanText/><span><strong>{basename(path)}</strong><small>{vault.name} / {path}</small></span></div>
  <p className="local-ocr-notice">{zh?'在本机识别中英文，不上传文件。数学公式、手写和复杂排版可能不准确，请核对原文。':'Recognize Chinese and English on this Mac without uploading files. Check formulas, handwriting and complex layouts against the original.'}</p>
  <div className="local-ocr-controls">{pdf?<><label>{zh?'起始页':'First page'}<input autoFocus data-testid="ocr-start" type="number" min="1" max="100000" value={start} disabled={busy||saving} onChange={e=>setStart(Number(e.target.value))}/></label><label>{zh?'结束页':'Last page'}<input data-testid="ocr-end" type="number" min={start} max={Math.min(start+9,100000)} value={end} disabled={busy||saving} onChange={e=>setEnd(Number(e.target.value))}/></label></>:<span>{zh?'图片 · 第 1 页':'Image · Page 1'}</span>}<Button autoFocus={!pdf} className="primary" data-testid="ocr-run" disabled={!available||busy||saving||!valid} onClick={()=>void run()}><ScanText/>{busy?(zh?'识别中…':'Recognizing…'):(zh?'识别文字':'Recognize text')}</Button>{busy&&<Button data-testid="ocr-stop" onClick={stop}><Square/>{zh?'停止':'Stop'}</Button>}</div>
  <p className="muted small">{zh?'每次最多 10 页 · PDF 256 MB / 图片 64 MB · 最多 90 秒':'Up to 10 pages · PDF 256 MB / image 64 MB · 90 second limit'}{result?` · ${zh?'原件共':'Source:'} ${result.pageCount} ${zh?'页':'pages'}`:''}</p>
  {available===false&&!error&&<p role="alert" className="form-error">{zh?'这台 Mac 暂无可用的本机识别组件。':'The local recognition component is unavailable on this Mac.'}</p>}
  {busy&&<p role="status">{zh?'正在准备原文件并识别文字，请稍候…':'Preparing the source and recognizing text…'}</p>}
  {result&&<div className="local-ocr-results" data-testid="ocr-results">{result.pages.map(page=><section key={page.page}><h3>{zh?'第 '+page.page+' 页':'Page '+page.page}</h3><pre>{page.text}</pre>{page.error&&<p role="status">{zh?page.error:(ocrEnglish as Record<string,string>)[page.error]||page.error}</p>}</section>)}{result.outputLimited&&<p role="status">{zh?'结果达到文字上限，请缩小页码范围后继续。':'The text limit was reached. Continue with a smaller range.'}</p>}{result.cancelled&&<p>{zh?'识别已停止，以下是已完成的结果。':'Recognition stopped; completed results are shown.'}</p>}</div>}
  {error&&<p role="alert" className="form-error">{error}</p>}{status&&<p role="status">{status}</p>}
  <footer><Button data-testid="ocr-copy" disabled={!hasText||saving||busy} onClick={()=>void copy()}><Copy/>{zh?'复制文字':'Copy text'}</Button><Button data-testid="ocr-save" disabled={!hasText||saving||busy||!!saved} onClick={()=>void save()}><FileText/>{saving?(zh?'保存中…':'Saving…'):(zh?'另存 OCR 笔记':'Save OCR note')}</Button>{saved&&<Button data-testid="ocr-open-note" onClick={()=>void onSaved(saved).then(onClose).catch(error=>setError(String(error)))}>{zh?'打开笔记':'Open note'}</Button>}<Button disabled={busy||saving} onClick={onClose}>{zh?'关闭':'Close'}</Button></footer>
  <small className="muted">{saved|| (zh?'保存为原文件同一文件夹中的 .ocr.md；不会覆盖已有文件。':'Save a new .ocr.md beside the source. Existing files are never overwritten.')}</small>
 </div></Modal>;
}

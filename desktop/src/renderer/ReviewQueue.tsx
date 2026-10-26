import WordAnnotationQueue from './WordAnnotationQueue';
import type {WordAnnotationTarget} from '../shared/word-annotations';
import {useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {CheckCheck,FileText,LocateFixed,MessageSquareText,RefreshCw,Search,X} from 'lucide-react';
import type {ReviewQueueResponse,ReviewRecord} from '../shared/desktop-api';
import type {Language} from './i18n';
import {ReadingOverlayBase} from './reading-overlay-context';
import {Button,basename} from './ui';
import {filterReviewQueue,reviewQueueSource,type ReviewQueueKind,type ReviewQueueLocation,type ReviewQueueSort} from './review-queue';
import PDFAnnotationQueue from './PDFAnnotationQueue';
import type {PDFAnnotationTarget} from '../shared/pdf-annotations';
import './review-queue.css';

type Props={vaultId:string;folderPath:string;language:Language;onLocate:(review:ReviewRecord)=>Promise<void>|void;onOpenSource:(review:ReviewRecord)=>Promise<void>|void;onOpenPDFAnnotation:(target:PDFAnnotationTarget)=>Promise<void>;onOpenWordAnnotation:(target:WordAnnotationTarget)=>Promise<void>;onClose:()=>void};
const PAGE_SIZE=30;
export default function ReviewQueue(props:Props){
 const [view,setView]=useState<'independent'|'pdf'|'word'>('independent');
 return view==='word'?<WordAnnotationQueue vaultId={props.vaultId} folderPath={props.folderPath} language={props.language} onOpen={props.onOpenWordAnnotation} onClose={props.onClose} onIndependent={()=>setView('independent')} onPDF={()=>setView('pdf')}/>:view==='pdf'?<PDFAnnotationQueue vaultId={props.vaultId} folderPath={props.folderPath} language={props.language} onOpen={props.onOpenPDFAnnotation} onClose={props.onClose} onIndependent={()=>setView('independent')} onWord={()=>setView('word')}/>:<IndependentReviewQueue {...props} onPDF={()=>setView('pdf')} onWord={()=>setView('word')}/>;
}
/** One read-only view of the original independent annotation records. */
function IndependentReviewQueue({vaultId,folderPath,language,onLocate,onOpenSource,onClose,onPDF,onWord}:Props&{onPDF:()=>void;onWord:()=>void}){
 const zh=language==='zh',label=(cn:string,en:string)=>zh?cn:en;
 const [scope,setScope]=useState<'folder'|'vault'>('folder'),[query,setQuery]=useState(''),[kind,setKind]=useState<ReviewQueueKind>('all'),[location,setLocation]=useState<ReviewQueueLocation>('all'),[source,setSource]=useState(''),[sort,setSort]=useState<ReviewQueueSort>('oldest'),[page,setPage]=useState(0);
 const scopePath=scope==='vault'?'':folderPath,key=JSON.stringify([vaultId,scopePath]);
 const [value,setValue]=useState<{key:string;data:ReviewQueueResponse}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[navigating,setNavigating]=useState<string|null>(null);
 const alive=useRef(false),current=useRef(key),pending=useRef<string|null>(null),panel=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null),overlay=useContext(ReadingOverlayBase);
 current.current=key;
 const cancel=useCallback((requestId:string)=>{void window.desktop.cancelReviewQueue?.({requestId}).catch(()=>{});},[]);
 const reload=useCallback(async()=>{
  const requestId=crypto.randomUUID(),previous=pending.current;pending.current=requestId;if(previous)cancel(previous);
  setLoading(true);setError('');
  try{
   if(!window.desktop.listReviewQueue)throw Error(language==='zh'?'请更新应用以使用待批注总览。':'Update the app to use the review queue.');
   const result=await window.desktop.listReviewQueue({vaultId,folderPath:scopePath,requestId});
   if(!alive.current||current.current!==key||pending.current!==requestId)return;
   if(!result.ok)throw Error(result.error.message);
   setValue({key,data:result.value});
  }catch(issue){if(alive.current&&current.current===key&&pending.current===requestId)setError(issue instanceof Error?issue.message:String(issue));}
  finally{if(alive.current&&current.current===key&&pending.current===requestId){pending.current=null;setLoading(false);}}
 },[vaultId,scopePath,key,language,cancel]);
 useEffect(()=>{
  alive.current=true;void reload();
  const focus=()=>{if(!document.hidden)void reload();};
  window.addEventListener('focus',focus);const timer=setInterval(focus,15000);
  const off=window.desktop.onVaultChange?.(event=>{if(event.vaultId===vaultId&&(event.rescan||event.paths.some(path=>path==='.inkspace-reviews'||path.startsWith('.inkspace-reviews/'))))focus();});
  return()=>{alive.current=false;const requestId=pending.current;pending.current=null;if(requestId)cancel(requestId);clearInterval(timer);window.removeEventListener('focus',focus);off?.();};
 },[reload,vaultId,cancel]);
 useEffect(()=>{search.current?.focus();},[]);
 const data=value?.key===key?value.data:null,reviews=data?.reviews||[];
 const sources=useMemo(()=>[...new Set(reviews.map(reviewQueueSource))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})),[data]);
 const rows=useMemo(()=>filterReviewQueue(reviews,query,kind,location,source,sort),[data,query,kind,location,source,sort]);
 useEffect(()=>setPage(0),[key,query,kind,location,source,sort]);
 useEffect(()=>{if(source&&data&&!sources.includes(source))setSource('');},[data,sources,source]);
 const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE)),currentPage=Math.min(page,pages-1),fileCount=new Set(rows.map(reviewQueueSource)).size;
 const navigate=async(review:ReviewRecord,toSource=false)=>{
  if(navigating)return;setNavigating(review.id);setError('');
  try{await(toSource?onOpenSource(review):onLocate(review));if(alive.current)onClose();}
  catch(issue){if(alive.current)setError(issue instanceof Error?issue.message:String(issue));}
  finally{if(alive.current)setNavigating(null);}
 };
 const content=<div className="review-queue-shade" style={overlay?{zIndex:overlay+10}:undefined} onKeyDown={event=>{
  event.stopPropagation();if(event.nativeEvent.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();onClose();}
  if(event.key==='Tab'){
   const elements=[...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')||[]].filter(element=>element.getClientRects().length);
   const first=elements[0],last=elements.at(-1);
   if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}>
  <section className="review-queue" role="dialog" aria-modal="true" aria-label={label('待批注总览','Review queue')} tabIndex={-1} ref={panel} data-testid="review-queue">
   <header><div className="review-queue-heading"><MessageSquareText/><div><span>{label('一起处理，逐条回到原处','A CLEAR VIEW OF WHAT NEEDS ATTENTION')}</span><h2>{label('待批注总览','Review queue')}</h2></div></div><Button className="icon-button" aria-label={label('关闭待批注总览','Close review queue')} onClick={onClose}><X/></Button></header>
   <nav className="review-queue-tabs" aria-label={label('批注来源','Annotation source')}><Button aria-current="page">{label('独立批注','Independent reviews')}</Button><Button data-testid="review-queue-pdf-tab" onClick={onPDF}>{label('PDF原有批注','Annotations inside PDFs')}</Button><Button data-testid="review-queue-word-tab" onClick={onWord}>{label('Word批注与修订','Word comments and revisions')}</Button></nav>
   <div className="review-queue-scope"><label>{label('范围','Scope')}<select aria-label={label('批注范围','Review scope')} value={scope} onChange={event=>setScope(event.target.value as 'folder'|'vault')}><option value="folder">{folderPath?label('当前文件夹及子文件夹','Current folder and subfolders'):label('整个资料库','Entire library')}</option>{folderPath&&<option value="vault">{label('整个资料库','Entire library')}</option>}</select></label><span title={scopePath||'/'}>{scopePath||label('资料库根目录','Library root')}</span><Button aria-label={label('刷新待批注总览','Refresh review queue')} onClick={()=>void reload()} disabled={loading}><RefreshCw/>{label('刷新','Refresh')}</Button></div>
   <p className="review-queue-guide">{label('汇总白板及关联资料上的高亮、圈画和提醒。点“定位”回到原来的批注位置，修改后可在原批注列表移除。','Highlights, marks and reminders from boards and linked materials. Locate a mark to review it, then remove it from its original annotation list.')}</p>
   <div className="review-queue-filters"><label className="review-queue-search"><Search/><input ref={search} type="search" aria-label={label('搜索批注','Search reviews')} placeholder={label('搜索提醒、文件名或路径','Search comments, filenames or paths')} value={query} onChange={event=>setQuery(event.target.value)}/></label><label>{label('类型','Type')}<select aria-label={label('批注类型','Review type')} value={kind} onChange={event=>setKind(event.target.value as ReviewQueueKind)}><option value="all">{label('全部类型','All types')}</option><option value="comment">{label('圈画与提醒','Marks and comments')}</option><option value="highlight">{label('高亮','Highlights')}</option></select></label><label>{label('位置','Location')}<select aria-label={label('批注位置类型','Review location type')} value={location} onChange={event=>setLocation(event.target.value as ReviewQueueLocation)}><option value="all">{label('全部位置','All locations')}</option><option value="board">{label('白板笔记','Board notes')}</option><option value="document">{label('关联资料','Linked materials')}</option></select></label></div>
   <div className="review-queue-summary"><span aria-live="polite" data-testid="review-queue-count">{label(`${rows.length} / ${reviews.length} 条 · ${fileCount} 份资料`,`${rows.length} of ${reviews.length} reviews · ${fileCount} sources`)}</span><label>{label('资料','Source')}<select aria-label={label('筛选批注资料','Filter review source')} value={source} onChange={event=>setSource(event.target.value)}><option value="">{label('全部资料','All sources')}</option>{sources.map(path=><option key={path} value={path}>{path}</option>)}</select></label><label>{label('排序','Sort')}<select aria-label={label('批注排序','Review order')} value={sort} onChange={event=>setSort(event.target.value as ReviewQueueSort)}><option value="oldest">{label('最早的在前','Oldest first')}</option><option value="newest">{label('最新的在前','Newest first')}</option></select></label></div>
   {error&&<p className="review-queue-error" role="alert">{error}</p>}
   {(data?.truncated||!!data?.warnings.length)&&<p className="review-queue-warning" role="status">{label('有些批注暂未读取，当前结果可能不完整。请检查资料同步或重新刷新；原批注保留。','Some reviews are unavailable and this list may be incomplete. Check sync or refresh; original annotations are retained.')}</p>}
   <div className="review-queue-list" aria-busy={loading}>
    {loading&&<p className="review-queue-loading" role="status">{label('正在读取独立批注…','Reading annotations…')}</p>}
    {!loading&&!rows.length&&!error&&!data?.truncated&&!data?.warnings.length&&<div className="review-queue-empty"><CheckCheck/><h3>{query||kind!=='all'||location!=='all'||source?label('没有匹配的批注','No matching reviews'):label('这里暂时没有待批注','No pending reviews here')}</h3><p>{query||kind!=='all'||location!=='all'||source?label('试试其他词语或筛选条件。','Try a different search or filter.'):label('在手机或 iPad 留下的批注，随同资料同步到本机后会出现在这里。','Reviews left on your phone or iPad appear here when their records sync to this library.')}</p></div>}
    {rows.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE).map(review=><article key={review.id} className="review-queue-card" data-review-queue-id={review.id}><div className="review-queue-card-body"><div className="review-queue-card-meta"><span className="review-queue-dot" style={{background:review.color}}/>{review.style==='highlight'?label('高亮','Highlight'):label('圈画与提醒','Mark / comment')}{review.anchor?.page&&<span>{label(`第 ${review.anchor.page} 页`,`Page ${review.anchor.page}`)}</span>}<time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString(zh?'zh-CN':'en')}</time></div><p>{review.comment||label('查看圈画的位置','See the marked area')}</p><div className="review-queue-source" title={reviewQueueSource(review)}><FileText/><strong>{basename(reviewQueueSource(review))}</strong><span>{reviewQueueSource(review)}</span></div>{reviewQueueSource(review)!==review.boardPath&&<small title={review.boardPath}>{label('所属白板：','Board: ')}{review.boardPath}</small>}</div><div className="review-queue-card-actions"><Button className="primary" disabled={!!navigating} data-testid={`review-queue-locate-${review.id}`} onClick={()=>void navigate(review)}><LocateFixed/>{label('定位','Locate')}</Button>{(review.anchor?.sourcePath||review.anchor?.originalSourcePath)&&<Button disabled={!!navigating} data-testid={`review-queue-source-${review.id}`} onClick={()=>void navigate(review,true)}><FileText/>{label('打开原文件','Open source')}</Button>}</div></article>)}
   </div>
   <footer><span>{label('只读取独立批注 · 原文保持不变','Reads independent annotations · Originals stay unchanged')}</span>{pages>1&&<nav aria-label={label('批注分页','Review pages')}><Button disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>{label('上一页','Previous')}</Button><span>{currentPage+1} / {pages}</span><Button disabled={currentPage===pages-1} onClick={()=>setPage(currentPage+1)}>{label('下一页','Next')}</Button></nav>}</footer>
  </section>
 </div>;
 return overlay?createPortal(content,document.body):content;
}

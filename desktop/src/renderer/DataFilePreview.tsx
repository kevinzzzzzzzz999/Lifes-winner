import {useEffect,useMemo,useRef,useState} from 'react';
import DOMPurify from 'dompurify';
import type {Language} from './i18n';
import {detectDelimiter,parseDelimited,type Delimiter} from './data-file-parsers';
import './data-file-preview.css';

const htmlTags=['h1','h2','h3','h4','h5','h6','p','div','span','article','section','main','header','footer','nav','aside','address','blockquote','pre','code','strong','b','em','i','s','del','ins','u','small','sub','sup','br','hr','wbr','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col','a','img','figure','figcaption','details','summary','time','mark','abbr'];
const imageData=/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const localImage=/\.(?:png|jpe?g)$/i;
const localReference=(value:string)=>!!value&&!/^[a-z][a-z0-9+.-]*:/i.test(value)&&!value.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/.test(value);
const documentStyle='html{color-scheme:light}body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20302d;background:#fff;margin:0;padding:28px;overflow-wrap:anywhere}main,article{max-width:1100px;margin:auto}h1,h2,h3{line-height:1.3}h1{font-size:2em}h2{font-size:1.5em}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{border:1px solid #d8e0dd;padding:8px 12px;vertical-align:top}th{background:#f2f6f4}img{max-width:100%;max-height:1000px;height:auto;object-fit:contain}pre{white-space:pre-wrap;background:#f4f6f5;padding:16px;border-radius:6px}blockquote{border-left:3px solid #96b7ac;padding-left:16px;color:#596c65}a{color:#007b71;text-decoration:underline;cursor:pointer}hr{border:0;border-top:1px solid #d8e0dd}';
export type HTMLPreviewVariant='webpage'|'notebook';
const notebookDocumentStyle='html{overflow-x:hidden}body{font:14px/20px "Helvetica Neue",Helvetica,Arial,sans-serif;color:#000;padding:0 6px;overflow-wrap:break-word;min-height:0;height:auto}main,article{max-width:none;margin:0}body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}.notebook-table-scroll{max-width:100%;overflow-x:auto;overflow-y:hidden;margin:0 0 8px}table{display:table;width:max-content;max-width:none;overflow:visible;border-collapse:collapse;margin:0;font:12px/15px "Helvetica Neue",Helvetica,Arial,sans-serif;color:#000}td,th{border:0;padding:6px;vertical-align:middle;text-align:right;white-space:nowrap;overflow-wrap:normal;word-break:normal}thead th{font-weight:700;background:transparent;border-bottom:1px solid #000}tbody th{font-weight:700}tbody tr:nth-child(even){background:#f5f5f5}[data-notebook-number]{text-align:right}pre{font:14px/17px Menlo,Monaco,Consolas,monospace;margin:0;padding:5px 4px;white-space:pre-wrap;overflow-wrap:break-word;border-radius:2px}a{color:#337ab7}img{display:block;max-width:100%;height:auto}';
export function sanitizedHTMLDocument(text:string,variant:HTMLPreviewVariant='webpage'){
 const fragment=DOMPurify.sanitize(text,{ALLOWED_TAGS:htmlTags,ALLOWED_ATTR:['href','src','alt','title','id','colspan','rowspan','scope','start','reversed','open','datetime'],ALLOW_DATA_ATTR:false,RETURN_DOM_FRAGMENT:true});
 let images=0,embeddedBytes=0;
 for(const node of fragment.querySelectorAll('img')){
  const source=(node.getAttribute('src')||'').trim();node.removeAttribute('src');
  if(++images>32)continue;
  if(source.length<=2*1024*1024&&embeddedBytes+source.length<=4*1024*1024&&imageData.test(source)){embeddedBytes+=source.length;node.setAttribute('src',source);}
  else if(source.length<4096&&localReference(source)&&localImage.test(source.split(/[?#]/)[0]))node.setAttribute('data-local-image',source.split(/[?#]/)[0]);
 }
 for(const node of fragment.querySelectorAll('a')){
  const href=(node.getAttribute('href')||'').trim();node.removeAttribute('href');
  if(href.length<=4096&&(href.startsWith('#')||localReference(href)||/^https?:\/\//i.test(href))){node.setAttribute('data-document-link',href);node.setAttribute('href','#');}
 }
 if(variant==='notebook'){
  for(const table of [...fragment.querySelectorAll('table')]){
   const scroll=document.createElement('div');scroll.className='notebook-table-scroll';table.replaceWith(scroll);scroll.append(table);
   for(const cell of table.querySelectorAll('td,tbody th'))if(/^[+\-−]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?%?$/i.test(cell.textContent?.trim()||''))cell.setAttribute('data-notebook-number','');
  }
 }
 const container=document.createElement('div');container.append(fragment);
 return '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data: vault-asset:; connect-src \'none\'; media-src \'none\'; object-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'"><style>'+documentStyle+(variant==='notebook'?notebookDocumentStyle:'')+'</style></head><body>'+container.innerHTML+'</body></html>';
}

type HTMLProps={text:string;language:Language;title?:string;variant?:HTMLPreviewVariant;onLocalLink?:(path:string)=>void;onExternalLink?:(url:string)=>void;resolveMedia?:(source:string)=>Promise<string|undefined>};
export function HtmlPreview({text,language,title,variant='webpage',onLocalLink,onExternalLink,resolveMedia}:HTMLProps){
 const iframe=useRef<HTMLIFrameElement>(null),callbacks=useRef({onLocalLink,onExternalLink,resolveMedia});callbacks.current={onLocalLink,onExternalLink,resolveMedia};
 const source=useMemo(()=>sanitizedHTMLDocument(text,variant),[text,variant]);const [loaded,setLoaded]=useState(0),[contentHeight,setContentHeight]=useState(40);
 useEffect(()=>{
  const frame=iframe.current,doc=frame?.contentDocument;if(!doc)return;let stopped=false;
  const click=(event:Event)=>{const target=event.target as Element|null;const link=target?.closest?.('a[data-document-link]');if(!link)return;event.preventDefault();const href=link.getAttribute('data-document-link')||'';if(href.startsWith('#')){try{doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();}catch{}}else if(/^https?:\/\//i.test(href)){callbacks.current.onExternalLink?.(href);}else if(localReference(href)){callbacks.current.onLocalLink?.(href.split(/[?#]/)[0]);}};
  doc.addEventListener('click',click);doc.addEventListener('auxclick',click);
  const nodes=[...doc.querySelectorAll<HTMLImageElement>('img[data-local-image]')];
  // A small worker pool avoids dozens of simultaneous iCloud hydration requests.
  let index=0;const worker=async()=>{while(!stopped&&index<nodes.length){const node=nodes[index++],path=node.getAttribute('data-local-image')||'';try{const url=await callbacks.current.resolveMedia?.(path);if(!stopped&&node.isConnected&&node.ownerDocument===frame?.contentDocument&&url&&/^vault-asset:\/\/asset\/[a-f0-9-]+$/i.test(url))node.src=url;}catch{/* Unavailable local pictures do not stop the readable page. */}}};void worker();void worker();
  return()=>{stopped=true;doc.removeEventListener('click',click);doc.removeEventListener('auxclick',click);};
 },[source,loaded,resolveMedia]);
 useEffect(()=>{
  if(variant!=='notebook')return;
  const frame=iframe.current,doc=frame?.contentDocument,body=doc?.body;if(!frame||!doc||!body)return;
  let stopped=false,request=0;
  const measure=()=>{request=0;if(stopped||!frame.isConnected||frame.contentDocument!==doc)return;const height=Math.max(40,Math.min(600,Math.ceil(body.getBoundingClientRect().height)));setContentHeight(previous=>previous===height?previous:height);};
  const schedule=()=>{if(!stopped&&!request)request=window.requestAnimationFrame(measure);};
  // Observe content rather than the iframe viewport: viewport measurements cannot shrink
  // a previously tall output and can feed ResizeObserver height changes back into themselves.
  const observer=new ResizeObserver(schedule);observer.observe(body);doc.addEventListener('load',schedule,true);doc.addEventListener('error',schedule,true);window.addEventListener('resize',schedule);schedule();
  return()=>{stopped=true;observer.disconnect();if(request)window.cancelAnimationFrame(request);doc.removeEventListener('load',schedule,true);doc.removeEventListener('error',schedule,true);window.removeEventListener('resize',schedule);};
 },[source,loaded,variant]);
 return <section className={'data-html-preview'+(variant==='notebook'?' data-html-preview-notebook':'')} data-testid="html-preview">{variant!=='notebook'&&<p className="data-preview-notice">{language==='zh'?'已保存网页 · 阅读页面内容，链接按点击打开。':'Saved webpage · Read its content and open links with a click.'}</p>}<iframe ref={iframe} title={title|| (language==='zh'?(variant==='notebook'?'Notebook 输出':'HTML 网页内容'):(variant==='notebook'?'Notebook output':'HTML page content'))} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={source} style={variant==='notebook'?{height:contentHeight}:undefined} onLoad={()=>setLoaded(n=>n+1)} data-testid="html-preview-frame"/></section>;
}

export function CsvPreview({text,language,delimiter}:{text:string;language:Language;delimiter?:Delimiter}){
 const [choice,setChoice]=useState<Delimiter|'auto'>(delimiter||'auto'),[header,setHeader]=useState(true),[page,setPage]=useState(0);
 const detected=useMemo(()=>detectDelimiter(text),[text]),separator=choice==='auto'?detected:choice;
 const base=useMemo(()=>parseDelimited(text,separator,{maxRows:0}),[text,separator]);
 const count=Math.max(0,base.rowCount-(header&&base.rowCount?1:0)),pages=Math.max(1,Math.ceil(count/100)),current=Math.min(page,pages-1),start=current*100+(header?1:0);
 const parsed=useMemo(()=>parseDelimited(text,separator,{startRow:start,maxRows:100}),[text,separator,start]);
 useEffect(()=>{setPage(0);},[text,separator,header]);
 const cols=Math.min(100,parsed.columnCount),name=(d:Delimiter)=>d===','?(language==='zh'?'逗号':'Comma'):d==='\t'?(language==='zh'?'制表符':'Tab'):d===';'?(language==='zh'?'分号':'Semicolon'):(language==='zh'?'竖线':'Pipe');
 return <section className="data-csv-preview" data-testid="csv-preview"><div className="data-csv-toolbar"><strong data-testid="csv-count">{language==='zh'?`${count.toLocaleString()} 行 · ${base.columnCount.toLocaleString()} 列`:`${count.toLocaleString()} rows · ${base.columnCount.toLocaleString()} columns`}</strong><label>{language==='zh'?'分隔符':'Delimiter'}<select aria-label={language==='zh'?'分隔符':'Delimiter'} value={choice} onChange={e=>{setChoice(e.target.value as Delimiter|'auto');setPage(0);}}><option value="auto">{language==='zh'?'自动':'Auto'} · {name(detected)}</option>{([',','\t',';','|'] as Delimiter[]).map(d=><option key={d} value={d}>{name(d)}</option>)}</select></label><label><input type="checkbox" checked={header} onChange={e=>setHeader(e.target.checked)}/>{language==='zh'?'第一行为标题':'First row is a header'}</label></div>
 {(base.malformed||base.inconsistentRows>0)&&<p role="status" className="data-preview-notice">{language==='zh'?'部分行的引号或列数不一致，请检查分隔符或源文件。':'Some rows have unmatched quotes or different column counts. Check the delimiter or source.'}</p>}
 {(base.columnCount>100||parsed.truncatedCells)&&<p className="data-preview-notice">{language==='zh'?'表格每页最多显示 100 行、前 100 列；超长单元格仅显示开头。可在源码中查看完整内容。':'The table shows 100 rows per page and the first 100 columns. Long cells show a preview; the source retains their full content.'}</p>}
 <div className="data-csv-scroll">{base.rowCount?<table><thead><tr><th className="data-row-number" scope="col">#</th>{Array.from({length:cols},(_,i)=><th scope="col" key={i}>{header?parsed.firstRow[i]||`${language==='zh'?'列':'Column'} ${i+1}`:`${language==='zh'?'列':'Column'} ${i+1}`}</th>)}</tr></thead><tbody>{parsed.rows.map(row=><tr key={row.index}><th className="data-row-number" scope="row">{row.index+(header?0:1)}</th>{Array.from({length:cols},(_,i)=><td key={i}>{row.cells[i]||''}</td>)}</tr>)}</tbody></table>:<p className="data-preview-notice">{language==='zh'?'这是一个空表格。':'This table is empty.'}</p>}</div>
 <div className="data-csv-pages"><button disabled={current===0} onClick={()=>setPage(current-1)}>{language==='zh'?'上一页':'Previous'}</button><span>{current+1} / {pages}</span><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>{language==='zh'?'下一页':'Next'}</button><span className="data-csv-hint">{language==='zh'?'阅读表格 · 切换“源码”编辑原 CSV':'Read table · Switch to Source to edit the CSV'}</span></div></section>;
}

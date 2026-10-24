import {useCallback,useMemo,useRef,useState} from 'react';
import type {OpenedFile} from '../shared/desktop-api';
import type {VideoPlaybackState} from '../shared/video-playback';
import {parseNotebook,notebookCellKey,notebookCellSource,notebookMultilineText,NOTEBOOK_LIMITS,type NotebookCell,type NotebookOutput} from '../shared/notebook-format';
import type {Language} from './i18n';
import DocumentPreview,{Formula} from './DocumentPreview';
import {HtmlPreview,CsvPreview} from './DataFilePreview';
import BoardViewer from './BoardViewer';
import {Button} from './ui';
import './readonly-file-pane.css';
import NotebookCode from './NotebookCode';
import {useOfficeTextSelection} from './OfficeTextSelection';

export type ReadOnlyFilePaneProps={
 file:OpenedFile;vaultId:string;language:Language;
 onLocalLink?:(path:string)=>void;onRootFileLink?:(path:string)=>void;onWikiLink?:(target:string)=>void;
 resolveMedia?:(source:string)=>Promise<string|undefined>;
 onOpen?:(path:string,page?:number,playback?:VideoPlaybackState)=>void;
};
const extension=(path:string)=>path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase()||'';
const openExternal=(url:string)=>{void window.desktop.openExternal({url}).catch(()=>{});};
const removeANSI=(text:string)=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
function embeddedImage(data:Record<string,unknown>,types=['image/png','image/jpeg','image/gif','image/webp']){
 for(const mime of types){const base64=notebookMultilineText(data[mime]).replace(/\s/g,'');if(base64&&base64.length<=NOTEBOOK_LIMITS.outputBytes&&/^[A-Za-z0-9+/]*={0,2}$/.test(base64))return 'data:'+mime+';base64,'+base64;}
}
function SavedOutput({output,language}:{output:NotebookOutput;language:Language}){
 const zh=language==='zh',[expanded,setExpanded]=useState(false);let text='',content;
 if(output.output_type==='stream')text=notebookMultilineText(output.text);
 else if(output.output_type==='error')text=removeANSI((Array.isArray(output.traceback)?output.traceback.join('\n'):'')||String(output.ename||'Error')+': '+String(output.evalue||''));
 else if(output.output_type==='display_data'||output.output_type==='execute_result'){
  const data=(output.data||{}) as Record<string,unknown>,image=embeddedImage(data,['image/png','image/jpeg']);
  if(image)content=<img loading="lazy" decoding="async" alt={zh?'已保存的代码输出图像':'Saved code output image'} src={image}/>;
  else if(data['text/html'])content=<div className="readonly-notebook-html"><HtmlPreview variant="notebook" text={notebookMultilineText(data['text/html'])} language={language} title={zh?'已保存的单元格输出':'Saved cell output'} onExternalLink={openExternal}/></div>;
  else if(data['text/latex'])content=<Formula text={notebookMultilineText(data['text/latex']).replace(/^\$\$?|\$\$?$/g,'')}/>;
  else text=notebookMultilineText(data['text/plain'])||(zh?'这个输出的格式暂不能展示，请在原 Notebook 中查看。':'This output format cannot be displayed here. View it in the original notebook.');
 }else text=zh?'这个输出的格式暂不能展示，请在原 Notebook 中查看。':'This output format cannot be displayed here. View it in the original notebook.';
 return <div className={'readonly-notebook-output '+(output.output_type==='error'||output.name==='stderr'?'has-error':'')} data-testid="readonly-notebook-output">{content||<><pre>{expanded?text:text.slice(0,50000)}</pre>{text.length>50000&&<Button onClick={()=>setExpanded(value=>!value)}>{expanded?(zh?'收起输出':'Collapse output'):(zh?'展开完整输出':'Show complete output')}</Button>}</>}</div>;
}
function SavedCell({cell,index,language,onLocalLink,onRootFileLink,onWikiLink,resolveMedia}:{cell:NotebookCell;index:number}&Pick<ReadOnlyFilePaneProps,'language'|'onLocalLink'|'onRootFileLink'|'onWikiLink'|'resolveMedia'>){
 const zh=language==='zh',[limit,setLimit]=useState(30),source=notebookCellSource(cell),outputs=cell.outputs||[];
 const attachments=useCallback((reference:string)=>{
  if(!reference.startsWith('attachment:'))return resolveMedia?.(reference)||Promise.resolve(undefined);
  let name=reference.slice(11);try{name=decodeURIComponent(name);}catch{return Promise.resolve(undefined);}
  const value=(cell.attachments as Record<string,Record<string,unknown>>|undefined)?.[name];
  return Promise.resolve(value?embeddedImage(value):undefined);
 },[cell.attachments,resolveMedia]);
 return <article className="readonly-notebook-cell" data-testid="readonly-notebook-cell" data-cell-index={index} data-cell-type={cell.cell_type}>
  <header>{cell.cell_type==='code'?<span>In [{cell.execution_count??' '}]:</span>:<><span>{index+1}</span><strong>{cell.cell_type==='markdown'?'Markdown':cell.cell_type==='raw'?'Raw':cell.cell_type}</strong></>}</header>
  {cell.cell_type==='markdown'?<DocumentPreview notebookFormatting text={source} format="md" language={language} allowAttachments resolveMedia={attachments} onLocalLink={onLocalLink} onRootFileLink={onRootFileLink} onWikiLink={onWikiLink}/>:cell.cell_type==='code'?<NotebookCode className="readonly-notebook-code" source={source}/>:<pre className="readonly-notebook-code">{source}</pre>}
  {outputs.slice(0,limit).map((output,i)=><SavedOutput key={i} output={output} language={language}/>)}
  {outputs.length>limit&&<Button data-testid="readonly-notebook-more-outputs" onClick={()=>setLimit(value=>value+30)}>{zh?'继续显示输出':'Show more outputs'} ({Math.min(limit,outputs.length)}/{outputs.length})</Button>}
 </article>;
}
function SavedNotebook({text,...links}:{text:string}&Pick<ReadOnlyFilePaneProps,'language'|'onLocalLink'|'onRootFileLink'|'onWikiLink'|'resolveMedia'>){
 const zh=links.language==='zh',parsed=useMemo(()=>{try{return{document:parseNotebook(text),error:''};}catch(error){return{document:null,error:error instanceof Error?error.message:String(error)};}},[text]);
 return <div className="readonly-notebook" data-testid="readonly-notebook"><p className="readonly-file-notice">{zh?'阅读代码、文字与已保存输出。此窗格不运行代码，不修改 Notebook。':'Read code, Markdown and saved outputs. This pane does not run code or change the notebook.'}</p>{parsed.document?<>{parsed.document.cells.map((cell,index)=><SavedCell key={notebookCellKey(cell,index)} cell={cell} index={index} {...links}/>)}{!parsed.document.cells.length&&<p className="readonly-file-notice">{zh?'这个 Notebook 还没有单元格。':'This notebook has no cells.'}</p>}</>:<p className="readonly-file-notice" role="alert">{zh?'暂时无法读取单元格，可切换原文查看：':'Could not read cells. Switch to Source to inspect the original: '}{parsed.error}</p>}</div>;
}
function TextPane({file,language,onLocalLink,onRootFileLink,onWikiLink,resolveMedia,vaultId,onOpen}:ReadOnlyFilePaneProps){
 const [raw,setRaw]=useState(false),zh=language==='zh',ext=extension(file.path),text=file.text||'',preview=['md','markdown','tex','html','htm','csv','tsv','ipynb'].includes(ext);
 return <div className="readonly-text-pane">{preview&&<div className="readonly-file-controls"><Button data-testid="readonly-source-toggle" aria-pressed={raw} onClick={()=>setRaw(value=>!value)}>{raw?(zh?'阅读预览':'Reading preview'):(zh?'查看原文':'View source')}</Button><span>{zh?'只读 · 可选择并复制文字':'Read only · Select and copy text'}</span></div>}{!preview||raw?<pre className="readonly-text-scroll" data-testid="readonly-text-scroll" tabIndex={0}>{text}</pre>:ext==='ipynb'?<SavedNotebook text={text} language={language} onLocalLink={onLocalLink} onRootFileLink={onRootFileLink} onWikiLink={onWikiLink} resolveMedia={resolveMedia}/>:ext==='html'||ext==='htm'?<HtmlPreview text={text} title={file.name} language={language} onLocalLink={onLocalLink} onExternalLink={openExternal} resolveMedia={resolveMedia}/>:ext==='csv'||ext==='tsv'?<CsvPreview text={text} language={language} delimiter={ext==='tsv'?'\t':undefined}/>:<DocumentPreview text={text} format={ext==='markdown'?'md':ext} language={language} vaultId={vaultId} onBoardOpen={onOpen} onLocalLink={onLocalLink} onRootFileLink={onRootFileLink} onWikiLink={onWikiLink} resolveMedia={resolveMedia}/>}</div>;
}
function ImagePane({file,language}:{file:OpenedFile;language:Language}){
 const zh=language==='zh',[zoom,setZoom]=useState<number|null>(null),[failed,setFailed]=useState(false),[natural,setNatural]=useState({width:0,height:0}),image=useRef<HTMLImageElement>(null),content=useRef<HTMLDivElement>(null);
 const ocr=useOfficeTextSelection({content,language,owner:file.path+':'+file.assetUrl,revision:JSON.stringify([file.sha256,zoom,natural.width,natural.height,failed])});
 const step=(factor:number)=>{const fitted=natural.width?(image.current?.clientWidth||natural.width)/natural.width:1;setZoom(value=>Math.max(.01,Math.min(8,(value??fitted)*factor)));};
 return <div className="readonly-image-pane"><div className="readonly-file-controls"><Button data-testid="readonly-image-zoom-out" disabled={!natural.width||failed} aria-label={zh?'缩小图片':'Zoom image out'} onClick={()=>step(1/1.25)}>−</Button><span>{zoom===null?(zh?'适合窗口':'Fit to pane'):Math.round(zoom*100)+'%'}</span><Button data-testid="readonly-image-zoom-in" disabled={!natural.width||failed} aria-label={zh?'放大图片':'Zoom image in'} onClick={()=>step(1.25)}>+</Button><Button data-testid="readonly-image-zoom-fit" onClick={()=>setZoom(null)}>{zh?'适合窗口':'Fit to pane'}</Button>{ocr.controls(()=>{})}</div>{ocr.notice}<div className="readonly-image-content" ref={content} onPointerDownCapture={ocr.captureDown} onPointerMoveCapture={ocr.captureMove} onPointerUpCapture={ocr.cancelPress} onPointerCancelCapture={ocr.cancelPress}><div className={'readonly-image-scroll '+(zoom===null?'fit':'scaled')} data-testid="readonly-image-scroll" tabIndex={0}>{failed?<p className="readonly-file-notice" role="alert">{zh?'图片暂不可读，请刷新文件后重试。':'This image is unavailable. Refresh the file and try again.'}</p>:<img ref={image} data-testid="readonly-image" src={file.assetUrl} alt={file.name} draggable={false} style={zoom!==null&&natural.width?{width:Math.round(natural.width*zoom),height:Math.round(natural.height*zoom)}:undefined} onLoad={event=>setNatural({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>setFailed(true)}/>}</div>{ocr.overlay}</div></div>;
}

/** A secondary reading surface. Only view state changes here; no editor, kernel,
 * source save or whiteboard mutation callback is attached. */
export default function ReadOnlyFilePane(props:ReadOnlyFilePaneProps){
 const {file,vaultId,language,onOpen,onRootFileLink}=props,owner=useRef(crypto.randomUUID()),identity=vaultId+':'+file.path,ext=extension(file.path),zh=language==='zh';
 const resolveMedia=useCallback((source:string)=>Promise.resolve().then(()=>props.resolveMedia?.(source)).catch(()=>undefined),[props.resolveMedia]);
 let content;
 if(file.kind==='text')content=<TextPane key={identity} {...props} resolveMedia={resolveMedia}/>;
 else if(file.kind==='board'&&file.board)content=<div className="readonly-board-pane" data-testid="readonly-board-pane"><BoardViewer key={identity} raw={file.board} boardPath={file.path} boardSHA={file.sha256} assetRevision={file.sha256} embedded vaultId={vaultId} language={language} onOpen={(path,page,playback)=>onOpen?onOpen(path,page,playback):onRootFileLink?.(path)}/></div>;
 else if(file.kind==='media'&&file.assetUrl&&['png','jpg','jpeg'].includes(ext))content=<ImagePane key={identity+':'+file.assetUrl} file={file} language={language}/>;
 else if(['docx','pptx','spreadsheet'].includes(file.kind)&&typeof file.html==='string')content=<DocumentPreview zoomKey={identity} documentKey={owner.current+':'+identity+':'+file.sha256} html={file.html} format={file.kind} language={language} onLocalLink={props.onLocalLink} onRootFileLink={props.onRootFileLink} onWikiLink={props.onWikiLink} resolveMedia={resolveMedia}/>;
 else content=<div className="readonly-file-empty"><p role="status">{zh?'这个格式需要使用对应的专用阅读器。':'This format needs its dedicated reader.'}</p>{onOpen&&<Button onClick={()=>onOpen(file.path)}>{zh?'打开文件':'Open file'}</Button>}</div>;
 return <section className="readonly-file-pane" data-testid="readonly-file-pane" data-path={file.path} data-kind={file.kind}>{content}</section>;
}

import {useEffect,useLayoutEffect,useMemo,useRef,useState,type KeyboardEvent} from 'react';
import {Play,Square,RotateCcw,Plus,ArrowUp,ArrowDown,Trash2,Code2,FileText,Undo2,Redo2} from 'lucide-react';
import {EditorView} from '@codemirror/view';
import {StateEffect} from '@codemirror/state';
import {restoreNotebookSession,normalizeNotebookSession,notebookViewportScroll,type NotebookEditorSession} from './notebook-session';
import NotebookCSVPicker from './NotebookCSVPicker';
import NotebookCSVExport from './NotebookCSVExport';
import NotebookOutline from './NotebookOutline';
import {buildNotebookOutline,notebookReadingHeading,type NotebookHeading} from './notebook-outline';
import {selectedCellIndices,pasteNotebookCells,splitNotebookCell,mergeNotebookCells,insertNotebookCode,notebookCSVVariables,notebookIdentifiers} from './notebook-actions';
import {NotebookShortcutHelp} from './NotebookShortcutHelp';
import {isSaveShortcut} from './app-shortcuts';
import type {NotebookRuntimeInfo} from '../shared/desktop-api';
import {parseNotebook,serializeNotebook,notebookCellSource,notebookCellKey,notebookWarnings,updateNotebookCell,addNotebookCell,removeNotebookCell,moveNotebookCell,clearNotebookOutputs,NOTEBOOK_LIMITS,type NotebookCell,type NotebookOutput} from '../shared/notebook-format';
import type {NotebookRunState} from './NotebookRuns';
import type {Language} from './i18n';
import {Button,Modal} from './ui';
import EditorPane from './EditorPane';
import DocumentPreview,{Formula} from './DocumentPreview';
import {HtmlPreview} from './DataFilePreview';
import NotebookCode from './NotebookCode';
import './notebook.css';
let cellClipboard:NotebookCell[]=[];

const outputText=(value:unknown)=>typeof value==='string'?value:Array.isArray(value)?value.filter(v=>typeof v==='string').join(''):'';
const stripANSI=(text:string)=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
function Output({output,language}:{output:NotebookOutput;language:Language}){
 const [expanded,setExpanded]=useState(false);const zh=language==='zh';
 let text='';let content;
 if(output.output_type==='stream')text=outputText(output.text);
 else if(output.output_type==='error')text=stripANSI(outputText(Array.isArray(output.traceback)?output.traceback.map(v=>String(v)+'\n'):[])||String(output.ename||'Error')+': '+String(output.evalue||''));
 else if(output.output_type==='display_data'||output.output_type==='execute_result'){
  const data=(output.data||{}) as Record<string,unknown>;const mime=['image/png','image/jpeg'].find(type=>typeof data[type]==='string'||Array.isArray(data[type]));
  if(mime){const encoded=outputText(data[mime]).replace(/\s/g,'');if(encoded.length<=NOTEBOOK_LIMITS.outputBytes&&/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))content=<img loading="lazy" decoding="async" className="notebook-figure" alt={zh?'代码生成的图像':'Image produced by code'} src={'data:'+mime+';base64,'+encoded}/>;}
  if(!content&&data['text/html'])content=<div className="notebook-rich-output"><HtmlPreview variant="notebook" text={outputText(data['text/html'])} language={language} title={zh?'单元格输出':'Cell output'}/></div>;
  if(!content&&data['text/latex'])content=<Formula text={outputText(data['text/latex']).replace(/^\$\$?|\$\$?$/g,'')}/>;
  if(!content)text=outputText(data['text/plain'])||(zh?'此输出类型暂不能显示；保存时会保留原始数据。':'This output cannot be displayed yet; its data is preserved when saving.');
 }else text=zh?'此输出类型暂不能显示；保存时会保留原始数据。':'This output cannot be displayed yet; its data is preserved when saving.';
 return <div className={'notebook-output '+(output.output_type==='error'||output.name==='stderr'?'notebook-error-output':'')} data-testid="notebook-output">{content||<><pre>{expanded?text:text.slice(0,50000)}</pre>{text.length>50000&&<Button onClick={()=>setExpanded(v=>!v)}>{expanded?(zh?'收起':'Collapse'):(zh?'显示完整文本':'Show full text')}</Button>}</>}</div>;
}
export default function NotebookEditor({value,path,language,runState,onChange,onRun,onInterrupt,onRestart,onSave,vaultId,resolveMedia,onLocalLink,session,onSessionChange}:{value:string;path:string;language:Language;runState?:NotebookRunState;onChange:(text:string)=>void;onRun:(indices:number[])=>void;onInterrupt:()=>void;onRestart:()=>void;onSave:()=>void;vaultId:string;resolveMedia?:(source:string)=>Promise<string|undefined>;onLocalLink?:(path:string)=>void;session?:NotebookEditorSession;onSessionChange?:(session:NotebookEditorSession)=>void}){
 const zh=language==='zh';
 const parsed=useMemo(()=>{try{return {doc:parseNotebook(value),error:''};}catch(e){return {doc:null,error:e instanceof Error?e.message:String(e)};}},[value]);
 const initial=useRef<NotebookEditorSession|null>(null);if(!initial.current)initial.current=restoreNotebookSession(session,parsed.doc?.cells.map(cell=>cell.id||'')||[]);
 const [selected,setSelected]=useState(initial.current.selected),[anchor,setAnchor]=useState(initial.current.anchor),[editing,setEditing]=useState(initial.current.editing),[raw,setRaw]=useState(initial.current.raw),[restartConfirm,setRestartConfirm]=useState(false),[help,setHelp]=useState(false),[csvPicker,setCSVPicker]=useState(false),[csvExport,setCSVExport]=useState(false),[runtime,setRuntime]=useState<NotebookRuntimeInfo|null>(null);
 const root=useRef<HTMLElement|null>(null),editor=useRef<EditorView|null>(null),sequence=useRef({key:'',time:0}),appliedFocusRevision=useRef(0),selectUsedPointer=useRef(false);
 const [focusRevision,setFocusRevision]=useState(0),[lineNumbers,setLineNumbers]=useState<Record<string,boolean>>(initial.current.lineNumbers),[hiddenOutputs,setHiddenOutputs]=useState<Record<string,boolean>>(initial.current.hiddenOutputs),[scrollOutputs,setScrollOutputs]=useState<Record<string,boolean>>(initial.current.scrollOutputs);

 const doc=parsed.doc,busy=runState?.running===true,restarting=runState?.restarting===true;
 const headings=useMemo(()=>buildNotebookOutline(doc?.cells||[]),[doc]);
 const [outlineOpen,setOutlineOpen]=useState(()=>initial.current!.outlineOpen??headings.length>0),[outlineCollapsedIDs,setOutlineCollapsedIDs]=useState(initial.current.outlineCollapsedIDs||[]),[outlineNavigation,setOutlineNavigation]=useState<{heading:NotebookHeading;nonce:number}|null>(null);
 const headingText=(element:Element)=>(element.textContent||'').replace(/\s+/g,' ').trim();
 const editorOwner=useRef<{index:number;id?:string}|null>(null),lastCursor=useRef(initial.current.editorSelection),boundEditors=useRef(new WeakSet<EditorView>()),sessionFrame=useRef<number|null>(null),sessionScroll=useRef({top:initial.current.scrollTop,left:initial.current.scrollLeft}),viewportAnchor=useRef(initial.current.viewportAnchor),anchorDirty=useRef(false),restoringViewport=useRef(false);
 const sessionCallback=useRef(onSessionChange);sessionCallback.current=onSessionChange;
 const sessionValues=useRef({doc,selected,anchor,editing,raw,lineNumbers,hiddenOutputs,scrollOutputs,outlineOpen,outlineCollapsedIDs});sessionValues.current={doc,selected,anchor,editing,raw,lineNumbers,hiddenOutputs,scrollOutputs,outlineOpen,outlineCollapsedIDs};
 const rememberCursor=()=>{const view=editor.current,owner=editorOwner.current;
  if(view&&owner&&view.dom.isConnected){try{const selection=view.state.selection.main;lastCursor.current={cellIndex:owner.index,...(owner.id?{cellID:owner.id}:{}),anchor:selection.anchor,head:selection.head,scrollTop:view.scrollDOM.scrollTop,scrollLeft:view.scrollDOM.scrollLeft};}catch{}}
 };
 // Cell boxes remain ordered even when content-visibility defers their contents.
 // Binary search avoids forcing layout for every one of a thousand cells.
 const sampleViewport=()=>{
  if(!anchorDirty.current||restoringViewport.current)return;anchorDirty.current=false;
  const host=root.current;if(!host||sessionValues.current.raw)return;
  const cells=host.querySelector(':scope > .notebook-cells')?.children;if(!cells?.length){viewportAnchor.current=undefined;return;}
  const viewport=host.getBoundingClientRect();let low=0,high=cells.length;
  while(low<high){const middle=(low+high)>>>1;if(cells[middle].getBoundingClientRect().bottom<=viewport.top)low=middle+1;else high=middle;}
  const cell=cells[low] as HTMLElement|undefined;if(!cell)return;const rect=cell.getBoundingClientRect();if(rect.top>=viewport.bottom)return;
  const cellIndex=Number(cell.dataset.cellIndex);if(!Number.isSafeInteger(cellIndex))return;
  const cellID=sessionValues.current.doc?.cells[cellIndex]?.id;viewportAnchor.current={cellIndex,...(cellID?{cellID}:{}),offset:rect.top-viewport.top};
 };
 const publishSession=useRef(()=>{});publishSession.current=()=>{
  const current=sessionValues.current;rememberCursor();sampleViewport();
  if(root.current)sessionScroll.current={top:root.current.scrollTop,left:root.current.scrollLeft};
  sessionCallback.current?.(normalizeNotebookSession({schemaVersion:1,selected:current.selected,anchor:current.anchor,selectedCellID:current.doc?.cells[current.selected]?.id,anchorCellID:current.doc?.cells[current.anchor]?.id,editing:current.editing,raw:current.raw,scrollTop:sessionScroll.current.top,scrollLeft:sessionScroll.current.left,editorSelection:lastCursor.current,viewportAnchor:viewportAnchor.current,lineNumbers:current.lineNumbers,hiddenOutputs:current.hiddenOutputs,scrollOutputs:current.scrollOutputs,outlineOpen:current.outlineOpen,outlineCollapsedIDs:current.outlineCollapsedIDs},current.doc?.cells.length));
 };
 const scheduleSession=useRef(()=>{});scheduleSession.current=()=>{if(sessionFrame.current===null)sessionFrame.current=requestAnimationFrame(()=>{sessionFrame.current=null;publishSession.current();});};
 useLayoutEffect(()=>{
  const host=root.current,saved=initial.current!;if(!host)return;
  host.scrollTop=saved.scrollTop;host.scrollLeft=saved.scrollLeft;
  let stopped=false,frame:number|null=null,timer:ReturnType<typeof setTimeout>|undefined,observer:ResizeObserver|undefined,target:HTMLElement|null=null,previousVisibility='';
  const finish=()=>{if(stopped)return;stopped=true;restoringViewport.current=false;if(frame!==null)cancelAnimationFrame(frame);if(timer!==undefined)clearTimeout(timer);observer?.disconnect();if(target){if(previousVisibility)target.style.contentVisibility=previousVisibility;else target.style.removeProperty('content-visibility');}for(const event of ['wheel','pointerdown','touchstart','keydown'])host.removeEventListener(event,finish,true);};
  if(!saved.raw&&saved.viewportAnchor){
   const anchor=saved.viewportAnchor;target=host.querySelector<HTMLElement>('[data-cell-index="'+anchor.cellIndex+'"]');
   if(target){
    restoringViewport.current=true;previousVisibility=target.style.contentVisibility;target.style.contentVisibility='visible';
    let corrections=0;const deadline=performance.now()+400;
    const correct=()=>{if(stopped||!target?.isConnected)return;if(++corrections>8||performance.now()>deadline){finish();return;}host.scrollTop=notebookViewportScroll({scrollTop:host.scrollTop,cellTop:target.getBoundingClientRect().top,viewportTop:host.getBoundingClientRect().top,offset:anchor.offset,maxScrollTop:Math.max(0,host.scrollHeight-host.clientHeight)});};
    for(const event of ['wheel','pointerdown','touchstart','keydown'])host.addEventListener(event,finish,{capture:true,passive:true});
    observer=new ResizeObserver(correct);observer.observe(target);observer.observe(host);
    const settle=()=>{frame=null;correct();if(!stopped&&corrections<5)frame=requestAnimationFrame(settle);};correct();frame=requestAnimationFrame(settle);timer=setTimeout(finish,400);
   }
  }
  return()=>{finish();if(sessionFrame.current!==null)cancelAnimationFrame(sessionFrame.current);anchorDirty.current=true;publishSession.current();};
 },[]);
 useEffect(()=>{publishSession.current();},[selected,anchor,editing,raw,lineNumbers,hiddenOutputs,scrollOutputs,outlineOpen,outlineCollapsedIDs]);
 const editorReady=(view:EditorView,index:number,id?:string)=>{
  editor.current=view;editorOwner.current={index,id};if(!boundEditors.current.has(view)){
   boundEditors.current.add(view);const saved=lastCursor.current;
   if(saved&&(saved.cellID?!!id&&saved.cellID===id:saved.cellIndex===index)){const max=view.state.doc.length;view.dispatch({selection:{anchor:Math.min(saved.anchor,max),head:Math.min(saved.head,max)}});view.scrollDOM.scrollTop=saved.scrollTop;view.scrollDOM.scrollLeft=saved.scrollLeft;}
   view.dispatch({effects:StateEffect.appendConfig.of(EditorView.updateListener.of(update=>{if(update.selectionSet||update.docChanged){rememberCursor();scheduleSession.current();}if(update.focusChanged&&!update.view.hasFocus){anchorDirty.current=true;publishSession.current();}}))});
  }
  if(focusRevision&&!raw&&!help&&!csvPicker&&!csvExport&&!restartConfirm&&canFocus()){view.focus();appliedFocusRevision.current=focusRevision;}
 };
 const [localError,setLocalError]=useState(''),[historyTick,setHistoryTick]=useState(0),[queuedRun,setQueuedRun]=useState<{source:string;indices:number[]}|null>(null);const undo=useRef<string[]>([]),redo=useRef<string[]>([]),lastWritten=useRef(value);
 const remember=(stack:string[],text:string)=>{stack.push(text);while(stack.length>20||stack.reduce((sum,item)=>sum+item.length*2,0)>32*1024*1024)stack.shift();};
 useEffect(()=>{if(busy||value!==lastWritten.current){undo.current=[];redo.current=[];setHistoryTick(n=>n+1);}lastWritten.current=value;},[value,busy]);
 useEffect(()=>{let stopped=false;if(window.desktop.notebookInfo)void window.desktop.notebookInfo().then(r=>{if(!stopped&&r.ok)setRuntime(r.value);});return()=>{stopped=true;};},[]);
 useEffect(()=>{if(doc&&selected>=doc.cells.length){setSelected(Math.max(0,doc.cells.length-1));setAnchor(Math.max(0,doc.cells.length-1));}},[doc?.cells.length,selected]);
 useEffect(()=>{if(queuedRun&&value===queuedRun.source){setQueuedRun(null);onRun(queuedRun.indices);}},[queuedRun,value]);
 // A finishing kernel must not take the keyboard from the other document pane.
 const canFocus=()=>{const host=root.current;return !!host&&!host.closest('[inert]')&&(host.contains(document.activeElement)||focusRevision!==appliedFocusRevision.current&&document.activeElement===document.body);};
 useEffect(()=>{if(!focusRevision||raw||help||csvPicker||csvExport||restartConfirm||!canFocus())return;const cell=root.current?.querySelector<HTMLElement>(`[data-cell-index="${selected}"]`);const input=editing&&!busy?cell?.querySelector<HTMLElement>('.cm-content'):undefined;(input||cell)?.focus({preventScroll:true});if(input||!editing||busy)appliedFocusRevision.current=focusRevision;cell?.scrollIntoView({block:'nearest'});},[selected,editing,busy,focusRevision,raw,help,csvPicker,csvExport,restartConfirm]);
 const focusCell=(index:number,edit=false,extend=false)=>{const target=Math.max(0,Math.min(index,(doc?.cells.length||1)-1));setSelected(target);if(!extend)setAnchor(target);setEditing(edit);setFocusRevision(n=>n+1);sequence.current={key:'',time:0};};
 const change=(next:NonNullable<typeof doc>)=>{if(busy)return null;try{const text=serializeNotebook(next);if(text!==value){remember(undo.current,value);redo.current=[];lastWritten.current=text;setHistoryTick(n=>n+1);setLocalError('');onChange(text);}return text;}catch(e){setLocalError(e instanceof Error?e.message:String(e));return null;}};
 const safe=(action:()=>void)=>{try{action();}catch(e){setLocalError(e instanceof Error?e.message:String(e));}};
 // Capture the live editor before opening recovery controls; no save/read can
 // replace the App-owned draft or its existing outputs during kernel restart.
 const flushEditorDraft=()=>{try{
  const view=editor.current,owner=editorOwner.current;
  if(doc&&!raw&&view?.dom.isConnected&&owner){const index=owner.id?doc.cells.findIndex(cell=>cell.id===owner.id):owner.index;const cell=doc.cells[index];if(!cell)throw Error(zh?'当前单元格已改变，请关闭提示后重试。':'The current cell changed. Close this dialog and try again.');const source=view.state.doc.toString();if(source!==notebookCellSource(cell)&&change(updateNotebookCell(doc,index,{source}))===null)return false;}
  anchorDirty.current=true;publishSession.current();return true;
 }catch(error){setLocalError(error instanceof Error?error.message:String(error));return false;}};
 const openRestart=()=>{if(!restarting&&flushEditorDraft())setRestartConfirm(true);};
 const travel=(back:boolean)=>{if(busy)return;const from=back?undo.current:redo.current,to=back?redo.current:undo.current,text=from.pop();if(text===undefined)return;remember(to,value);lastWritten.current=text;setHistoryTick(n=>n+1);onChange(text);setEditing(false);setFocusRevision(n=>n+1);};
 const indices=doc?selectedCellIndices(doc.cells.length,selected,anchor):[];
 const mutateAt=(next:NonNullable<typeof doc>,index:number,edit=false)=>{if(change(next)!==null){setSelected(index);setAnchor(index);setEditing(edit);setFocusRevision(n=>n+1);}};
 const add=(type:'code'|'markdown',above=false)=>{if(!doc||busy)return;const index=doc.cells.length?(above?Math.min(...indices):Math.max(...indices)+1):0;safe(()=>mutateAt(addNotebookCell(doc,type,index-1),index));};
 const insertCodes=(sources:string[])=>{if(!doc||busy||!sources.length)return;const after=doc.cells.length?Math.max(...indices):-1;safe(()=>{let next=doc;for(const [offset,source]of sources.entries())next=insertNotebookCode(next,after+offset,source);if(change(next)!==null){setCSVPicker(false);setSelected(after+1);setAnchor(after+1);setEditing(sources.length===1);setFocusRevision(n=>n+1);}});};
 const insertCode=(source:string)=>insertCodes([source]);
 const removeSelected=(cut=false)=>{if(!doc||busy||!indices.length)return;if(indices.some(i=>!['code','markdown','raw'].includes(doc.cells[i].cell_type)))return;if(cut)cellClipboard=structuredClone(indices.map(i=>doc.cells[i]));const deleted=new Set(indices);mutateAt({...doc,cells:doc.cells.filter((_,i)=>!deleted.has(i))},Math.max(0,Math.min(Math.min(...indices),doc.cells.length-indices.length-1)));};
 const runCells=(how:'stay'|'next'|'insert',only?:number)=>{if(!doc||busy||restarting||queuedRun||runtime?.available===false)return;const chosen=only===undefined?indices:[only];if(!chosen.length)return;const last=Math.max(...chosen),code=chosen.filter(i=>doc.cells[i].cell_type==='code');let next=doc,target=last,edit=false;
  if(how==='insert'||how==='next'&&last===doc.cells.length-1){next=addNotebookCell(doc,'code',last);target=last+1;edit=true;}else if(how==='next')target=last+1;
  const text=next===doc?value:change(next);if(text===null)return;
  setSelected(target);setAnchor(target);setEditing(edit);setFocusRevision(n=>n+1);
  if(code.length)setQueuedRun({source:text,indices:code});
 };
 const command=(event:KeyboardEvent<HTMLElement>)=>{
  if(event.defaultPrevented||event.nativeEvent.isComposing||event.keyCode===229)return;
  const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey,singleMod=event.ctrlKey!==event.metaKey,plain=!mod&&!event.altKey&&!event.shiftKey;
  if(help||csvPicker||csvExport||restartConfirm){if(key==='escape'&&plain){event.preventDefault();event.stopPropagation();setHelp(false);setCSVPicker(false);setCSVExport(false);setRestartConfirm(false);setFocusRevision(n=>n+1);}return;}
  if(document.querySelector('[role="dialog"]'))return;
  if(raw||!doc||event.target instanceof Element&&event.target.closest('.modal-shade'))return;
  const target=event.target as HTMLElement,inEditor=!!target.closest('.notebook-source .cm-editor'),control=!!target.closest('input,select,textarea,button,a,[contenteditable="true"]');
  const consume=()=>{event.preventDefault();event.stopPropagation();};
  const markdownMenu=target.closest<HTMLDetailsElement>('.notebook-markdown-actions');
  if(markdownMenu){
   if(key==='escape'&&plain){consume();markdownMenu.open=false;markdownMenu.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});}
   else if(isSaveShortcut({...event,isComposing:event.nativeEvent.isComposing})){consume();onSave();}
   return;
  }
  if(key==='escape'&&plain||key==='m'&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey){consume();focusCell(selected);return;}
  if(isSaveShortcut({...event,isComposing:event.nativeEvent.isComposing})){consume();onSave();return;}
  if(control&&!inEditor)return;
  const runNext=event.shiftKey&&!mod&&!event.altKey,runStay=singleMod&&!event.shiftKey&&!event.altKey,runInsert=event.altKey&&!mod&&!event.shiftKey;
  if(key==='enter'&&(runNext||runStay||runInsert)){consume();safe(()=>runCells(runInsert?'insert':runNext?'next':'stay'));return;}
  if(inEditor&&singleMod&&event.shiftKey&&!event.altKey&&(key==='-'||key==='_')){consume();if(!busy)safe(()=>mutateAt(splitNotebookCell(doc,selected,editor.current?.state.selection.main.head||0),selected+1,true));return;}
  if(inEditor||editing)return;
  if(!doc.cells.length){if(!mod&&!event.altKey){if(['a','b'].includes(key)&&!event.shiftKey){consume();add('code');}else if(key==='?'||key==='h'&&!event.shiftKey){consume();setHelp(true);}}return;}
  if(singleMod&&!event.altKey&&!event.shiftKey&&key==='a'){consume();setAnchor(0);setSelected(doc.cells.length-1);return;}
  if(singleMod&&!event.altKey&&event.shiftKey&&key==='m'){consume();if(!busy)safe(()=>{const chosen=indices.length>1?indices:selected<doc.cells.length-1?[selected,selected+1]:[];if(chosen.length)mutateAt(mergeNotebookCells(doc,chosen),Math.min(...chosen));});return;}
  if(mod||event.altKey||event.shiftKey&&!['arrowup','arrowdown','j','k','l','o','v','z','m','?'].includes(key))return;
  const previous=sequence.current;sequence.current={key:'',time:0};
  if(key==='d'||key==='i'||key==='0'){consume();if(event.repeat)return;if(previous.key===key&&performance.now()-previous.time<800){if(key==='d')removeSelected();if(key==='i'&&busy)onInterrupt();if(key==='0')openRestart();}else sequence.current={key,time:performance.now()};return;}
  if(key==='enter'){consume();if(!busy)focusCell(selected,true);return;}
  if(['arrowup','arrowdown','j','k'].includes(key)){consume();focusCell(selected+(['arrowup','k'].includes(key)?-1:1),false,event.shiftKey);return;}
  if(key==='h'||key==='?'){consume();setHelp(true);return;}
  if(key==='s'){consume();onSave();return;}
  if(key==='c'){consume();cellClipboard=structuredClone(indices.map(i=>doc.cells[i]));return;}
  if(key==='l'){consume();setLineNumbers(old=>{const next={...old};const targets=event.shiftKey?doc.cells.map((_,i)=>i):indices;const value=!(old[notebookCellKey(doc.cells[selected],selected)]??true);for(const i of targets)next[notebookCellKey(doc.cells[i],i)]=value;return next;});return;}
  if(key==='o'){consume();const update=event.shiftKey?setScrollOutputs:setHiddenOutputs;update(old=>{const next={...old};for(const i of indices){const id=notebookCellKey(doc.cells[i],i);next[id]=!old[id];}return next;});return;}
  if(busy||queuedRun)return;
  if(key==='a'||key==='b'){consume();add('code',key==='a');return;}
  if(key==='x'){consume();removeSelected(true);return;}
  if(key==='v'){consume();if(cellClipboard.length)safe(()=>{const position=event.shiftKey?Math.min(...indices):Math.max(...indices)+1;mutateAt(pasteNotebookCells(doc,cellClipboard,position),position);});return;}
  if(key==='z'){consume();travel(!event.shiftKey);return;}
  if(key==='m'&&event.shiftKey){consume();safe(()=>{const chosen=indices.length>1?indices:selected<doc.cells.length-1?[selected,selected+1]:[];if(chosen.length)mutateAt(mergeNotebookCells(doc,chosen),Math.min(...chosen));});return;}
  if(['m','y','r'].includes(key)||/^[1-6]$/.test(key)){consume();safe(()=>{let next=doc;for(const i of indices){const heading=/^[1-6]$/.test(key);next=updateNotebookCell(next,i,{cell_type:key==='y'?'code':key==='r'?'raw':'markdown',...(heading?{source:'#'.repeat(Number(key))+' '+notebookCellSource(doc.cells[i]).replace(/^#{1,6}\s*/,'')}:{})});}change(next);focusCell(selected);});return;}
 };
 const warnings=doc?notebookWarnings(doc):[];
 const reason=runState?.reason;const status=restarting?(zh?'正在重启…':'Restarting…'):busy?(zh?'运行中':'Running'):runState?.error?(zh?'运行未完成':'Run failed'):reason==='completed'?(zh?'运行完成':'Completed'):reason==='error'?(zh?'代码报错，后续单元格已停止':'Code error; following cells stopped'):reason==='restarted'?(zh?'环境已重置 · Python 变量已清空，代码和输出保留':'Kernel reset · Python variables cleared; code and outputs retained'):reason?(zh?'运行已停止：':'Run stopped: ')+reason:runState?.kernelAlive?(zh?'运行环境就绪':'Kernel ready'):(zh?'尚未运行':'Not run yet');
 // Navigation reveals the actual cell before measuring a heading. Correct only
 // this scroll container, and stop immediately when the user takes control.
 useLayoutEffect(()=>{
  if(!outlineNavigation||raw)return;const host=root.current,heading=outlineNavigation.heading;if(!host)return;
  const index=heading.cellID?doc?.cells.findIndex(cell=>cell.id===heading.cellID):heading.cellIndex;if(index===undefined||index<0)return;
  const cell=host.querySelector<HTMLElement>('[data-cell-index="'+index+'"]');if(!cell)return;
  const previousVisibility=cell.style.contentVisibility;cell.style.contentVisibility='visible';restoringViewport.current=true;
  let stopped=false,frame:number|null=null,count=0,timer:ReturnType<typeof setTimeout>|undefined;const deadline=performance.now()+400;
  const finish=()=>{if(stopped)return;stopped=true;restoringViewport.current=false;if(frame!==null)cancelAnimationFrame(frame);if(timer!==undefined)clearTimeout(timer);if(previousVisibility)cell.style.contentVisibility=previousVisibility;else cell.style.removeProperty('content-visibility');for(const event of ['wheel','pointerdown','touchstart','keydown'])host.removeEventListener(event,finish,true);anchorDirty.current=true;publishSession.current();};
  const correct=()=>{if(stopped||!cell.isConnected||++count>8||performance.now()>deadline){finish();return;}
   const rendered=[...cell.querySelectorAll<HTMLElement>('.notebook-markdown h1,.notebook-markdown h2,.notebook-markdown h3,.notebook-markdown h4,.notebook-markdown h5,.notebook-markdown h6')];
   const matches=rendered.filter(node=>node.tagName==='H'+heading.level&&headingText(node)===heading.text),same=headings.filter(value=>value.cellIndex===heading.cellIndex&&value.level===heading.level&&value.text===heading.text),ordinal=same.findIndex(value=>value.id===heading.id);
   // Ambiguous/raw-HTML or truncated Markdown safely falls back to its cell.
   const target=matches.length===same.length&&ordinal>=0?matches[ordinal]:cell;
   const inset=(host.querySelector<HTMLElement>(':scope > .notebook-toolbar')?.getBoundingClientRect().height||0)+12;
   host.scrollTop=notebookViewportScroll({scrollTop:host.scrollTop,cellTop:target.getBoundingClientRect().top,viewportTop:host.getBoundingClientRect().top,offset:inset,maxScrollTop:Math.max(0,host.scrollHeight-host.clientHeight)});
  };
  for(const event of ['wheel','pointerdown','touchstart','keydown'])host.addEventListener(event,finish,{capture:true,passive:true});
  const settle=()=>{frame=null;correct();if(!stopped&&count<5)frame=requestAnimationFrame(settle);};correct();frame=requestAnimationFrame(settle);timer=setTimeout(finish,400);return finish;
 },[outlineNavigation,raw]);
 const navigateHeading=(heading:NotebookHeading)=>{if(!flushEditorDraft())return;setRaw(false);setEditing(false);setSelected(heading.cellIndex);setAnchor(heading.cellIndex);sequence.current={key:'',time:0};setOutlineNavigation({heading,nonce:performance.now()});};
 const attachments=(cell:NotebookCell)=>(source:string)=>{if(source.startsWith('attachment:')){let name=source.slice(11);try{name=decodeURIComponent(name);}catch{}const bundle=(cell.attachments as Record<string,Record<string,unknown>>|undefined)?.[name];if(bundle)for(const mime of ['image/png','image/jpeg','image/gif','image/webp']){const b64=outputText(bundle[mime]).replace(/\s/g,'');if(b64&&b64.length<=NOTEBOOK_LIMITS.outputBytes&&/^[A-Za-z0-9+/]*={0,2}$/.test(b64))return Promise.resolve('data:'+mime+';base64,'+b64);}return Promise.resolve(undefined);}return resolveMedia?.(source)||Promise.resolve(undefined);};
 return <section ref={root} tabIndex={-1} onKeyDownCapture={command} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget)){anchorDirty.current=true;publishSession.current();}}} onScrollCapture={event=>{if(root.current)sessionScroll.current={top:root.current.scrollTop,left:root.current.scrollLeft};if(event.target===event.currentTarget&&!restoringViewport.current)anchorDirty.current=true;rememberCursor();scheduleSession.current();}} data-mode={editing?'edit':'command'} className="notebook-workspace" data-outline-open={outlineOpen} data-testid="notebook-workspace" aria-label={zh?'Notebook 工作区':'Notebook workspace'}>
  <NotebookOutline headings={headings} open={outlineOpen} onOpenChange={setOutlineOpen} collapsedIDs={outlineCollapsedIDs} onCollapsedIDsChange={setOutlineCollapsedIDs} activeHeadingID={outlineNavigation?.heading.cellIndex===selected?outlineNavigation.heading.id:notebookReadingHeading(headings,selected,0)?.id} language={language} onNavigate={navigateHeading}/>
  <div className="notebook-toolbar"><div className="segmented"><button className={!raw?'selected':''} onClick={()=>{setRaw(false);focusCell(selected);}}>{zh?'单元格':'Cells'}</button><button disabled={busy} className={raw?'selected':''} onClick={()=>setRaw(true)}>JSON</button></div><Button data-testid="notebook-run-all" className="primary" disabled={busy||restarting||!doc||raw||runtime?.available===false||!doc.cells.some(c=>c.cell_type==='code')} onClick={()=>{if(doc){focusCell(selected);onRun(doc.cells.flatMap((c,i)=>c.cell_type==='code'?[i]:[]));}}}><Play/>{zh?'运行全部':'Run all'}</Button><Button data-testid="notebook-interrupt" disabled={!busy||restarting} onClick={()=>{focusCell(selected);onInterrupt();}}><Square/>{zh?'中断':'Interrupt'}</Button><Button data-testid="notebook-restart" disabled={restarting} onClick={openRestart}><RotateCcw/>{zh?'重启环境':'Restart kernel'}</Button><Button onClick={()=>setHelp(true)}>{zh?'快捷键':'Shortcuts'}</Button><span className="spacer"/><span className="notebook-kernel-state" role="status">{status}</span></div>
  <div className="notebook-context"><span data-testid="notebook-mode">{editing?(zh?'编辑模式 · Esc 退出编辑':'Edit mode · Esc to exit'):(zh?'命令模式 · Enter 编辑':'Command mode · Enter to edit')}{indices.length>1?` · ${indices.length} ${zh?'格已选':'selected'}`:''}</span><span>Python · IPython{runtime?.packages?.pandas?' · pandas · NumPy · Matplotlib':''}</span><span>{zh?'运行时从当前文件夹读取数据 · Shift+Enter 运行当前格':'Data is read from this folder · Shift+Enter runs the current cell'}</span></div>
  {localError&&<p className="form-error" role="alert">{localError}</p>}
  {runState?.error&&<p className="form-error" role="alert">{runState.error}</p>}
  {runtime?.available===false&&<p className="preview-notice">{zh?'此版本没有可用的 Notebook 运行环境，仍可阅读和编辑。':'This version has no available Notebook runtime. Reading and editing remain available.'}</p>}
  {parsed.error&&<div className="preview-notice" role="alert">{zh?'未能打开单元格：':'Could not open cells: '}{parsed.error}<p>{zh?'原内容仍保留，可切换 JSON 检查。':'The original content is preserved. Switch to JSON to inspect it.'}</p></div>}
  {raw?<div className="notebook-json"><EditorPane path={path+'.json'} value={value} onChange={onChange}/></div>:doc&&<>
   {warnings.length>0&&<details className="notebook-warnings"><summary>{zh?'文件兼容性提示':'File compatibility notes'} ({warnings.length})</summary>{warnings.map((w,i)=><p key={i}>{zh?w.message:(w.code==='cell-id-repair'?'Missing or duplicate cell IDs will be repaired when saved.':w.code==='unknown-cell'?'An unfamiliar cell type is preserved without execution.':'An unfamiliar output type is preserved.')}</p>)}</details>}
   <div className="notebook-add-toolbar" data-history-revision={historyTick}><Button disabled={busy||!undo.current.length} onClick={()=>travel(true)} aria-label={zh?'撤销单元格修改':'Undo cell change'}><Undo2/></Button><Button disabled={busy||!redo.current.length} onClick={()=>travel(false)} aria-label={zh?'重做单元格修改':'Redo cell change'}><Redo2/></Button><Button disabled={busy} onClick={()=>add('code')}><Plus/><Code2/>{zh?'代码单元格':'Code cell'}</Button><Button disabled={busy} onClick={()=>add('markdown')}><Plus/><FileText/>{zh?'文字单元格':'Markdown cell'}</Button><Button disabled={busy} onClick={()=>safe(()=>{if(change(clearNotebookOutputs(doc))!==null)focusCell(selected);})}>{zh?'清空所有输出':'Clear all outputs'}</Button><Button disabled={busy} onClick={()=>setCSVPicker(true)}>{zh?'导入 Excel / CSV':'Import Excel / CSV'}</Button><Button disabled={busy} onClick={()=>setCSVExport(true)}>{zh?'导出 CSV 代码':'CSV export code'}</Button><span className="spacer"/><span>{doc.cells.length} {zh?'个单元格':'cells'}</span></div>
   <div className="notebook-cells">{doc.cells.map((cell,index)=>{
    const type=cell.cell_type,editable=['code','markdown','raw'].includes(type),source=notebookCellSource(cell),active=selected===index;
    const cellKey=notebookCellKey(cell,index);
    const controls=<div className="notebook-cell-header"><select aria-label={zh?'单元格类型':'Cell type'} value={type} disabled={busy||!editable} onPointerDown={()=>{selectUsedPointer.current=true;}} onKeyDown={()=>{selectUsedPointer.current=false;}} onChange={e=>safe(()=>{if(change(updateNotebookCell(doc,index,{cell_type:e.target.value as 'code'|'markdown'|'raw'}))!==null){if(selectUsedPointer.current)focusCell(index);else{setSelected(index);setAnchor(index);setEditing(false);}}})}>{!editable&&<option value={type}>{type}</option>}<option value="code">Python</option><option value="markdown">Markdown</option><option value="raw">Raw</option></select><span className="spacer"/><Button disabled={busy||index===0} aria-label={zh?'上移单元格':'Move cell up'} onClick={e=>{e.stopPropagation();safe(()=>mutateAt(moveNotebookCell(doc,index,index-1),index-1));}}><ArrowUp/></Button><Button disabled={busy||index===doc.cells.length-1} aria-label={zh?'下移单元格':'Move cell down'} onClick={e=>{e.stopPropagation();safe(()=>mutateAt(moveNotebookCell(doc,index,index+1),index+1));}}><ArrowDown/></Button><Button disabled={busy||!editable} aria-label={zh?'删除单元格':'Delete cell'} onClick={e=>{e.stopPropagation();safe(()=>mutateAt(removeNotebookCell(doc,index),Math.max(0,Math.min(index,doc.cells.length-2))));}}><Trash2/></Button></div>;
    return <article key={cellKey} tabIndex={active?0:-1} aria-label={(zh?'单元格 ':'Cell ')+(index+1)} className={'notebook-cell '+(indices.includes(index)?'selected ':'')+(active&&editing?'editing ':'')+(busy&&runState?.cellIndex===index?'running':'')} data-testid="notebook-cell" data-cell-index={index} data-cell-type={type} onClick={e=>{const target=e.target as HTMLElement;if(target.closest('button,select,a'))return;if(target.closest('.notebook-source')){setSelected(index);setAnchor(index);setEditing(true);}else if(target.closest('.notebook-source-read')){focusCell(index,true);}else focusCell(index,false,e.shiftKey);}}>

     <div className="notebook-cell-gutter"><span>{type==='code'?'In ['+(busy&&runState?.cellIndex===index?'*':cell.execution_count??' ')+']:':index+1}</span>{type==='code'&&<Button data-testid="notebook-run-cell" disabled={busy||restarting||runtime?.available===false} title={zh?'运行此单元格':'Run this cell'} aria-label={zh?'运行此单元格':'Run this cell'} onClick={()=>safe(()=>runCells('stay',index))}><Play/></Button>}</div>
     <div className="notebook-cell-content"><details className="notebook-markdown-actions" onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}><summary aria-label={zh?(type==='markdown'?'文字单元格操作':'代码单元格操作'):(type==='markdown'?'Markdown cell actions':'Code cell actions')} title={zh?'单元格操作':'Cell actions'}><span aria-hidden="true">⋯</span></summary>{controls}</details>
      {editable?(active&&!busy&&editing?<div className="notebook-source"><EditorPane notebook showLineNumbers={lineNumbers[cellKey]??true} onReady={view=>editorReady(view,index,cell.id)} path={'cell-'+index+(type==='code'?'.py':type==='markdown'?'.md':'.txt')} value={source} onChange={text=>{try{change(updateNotebookCell(doc,index,{source:text}));}catch(e){setLocalError(e instanceof Error?e.message:String(e));}}}/></div>:type==='markdown'?<div className="notebook-markdown" title={zh?'双击编辑文字':'Double-click to edit text'} onDoubleClick={()=>{if(!busy){focusCell(index,true);}}}><DocumentPreview notebookFormatting text={source} format="md" language={language} onLocalLink={onLocalLink} resolveMedia={attachments(cell)} allowAttachments/></div>:type==='code'?<NotebookCode className="notebook-source-read" source={source}/>:<pre className="notebook-source-read" tabIndex={0}>{source||' '}</pre>):<p className="preview-notice">{zh?'此单元格类型暂只保留原数据。':'This cell type is preserved as original data.'}</p>}
      {type==='code'&&Array.isArray(cell.outputs)&&cell.outputs.length>0&&<div className={"notebook-outputs "+(scrollOutputs[cellKey]?"scroll-output":"")} hidden={hiddenOutputs[cellKey]}>{cell.outputs.slice(0,200).map((output,i)=><Output key={i} output={output} language={language}/>)}{cell.outputs.length>200&&<p>{zh?'仅显示前 200 条输出；保存会保留全部。':'Showing the first 200 outputs; all are preserved when saving.'}</p>}</div>}
     </div>
    </article>;
   })}</div>
  </>}
  {help&&<NotebookShortcutHelp language={language} onClose={()=>{setHelp(false);setFocusRevision(n=>n+1);}}/>}
  {csvPicker&&<NotebookCSVPicker vaultId={vaultId} notebookPath={path} language={language} reservedNames={notebookIdentifiers(doc!)} legacyAlias={doc!.cells.every(cell=>!notebookCellSource(cell).trim())} onInsert={insertCodes} onClose={()=>{setCSVPicker(false);setFocusRevision(n=>n+1);}}/>}
  {csvExport&&doc&&<NotebookCSVExport language={language} variables={notebookCSVVariables(doc)} preferredVariable={doc.cells[selected]?notebookCSVVariables({...doc,cells:[doc.cells[selected]]})[0]:undefined} onInsert={source=>{setCSVExport(false);insertCode(source);}} onClose={()=>{setCSVExport(false);setFocusRevision(n=>n+1);}}/>}
  {restartConfirm&&<Modal title={zh?'重启运行环境':'Restart kernel'} onClose={()=>setRestartConfirm(false)}><p>{zh?'当前变量会清空。单元格内容和已有输出仍然保留。':'Current variables will be cleared. Cells and existing outputs will be preserved.'}</p><div className="modal-actions"><Button onClick={()=>setRestartConfirm(false)}>{zh?'取消':'Cancel'}</Button><Button disabled={restarting} onClick={()=>{if(flushEditorDraft()){setQueuedRun(null);setRestartConfirm(false);onRestart();}}}>{zh?'重启':'Restart'}</Button></div></Modal>}
 </section>;
}

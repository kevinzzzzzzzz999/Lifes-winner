import {useEffect,useRef,useState} from 'react';
import type {EditableDocumentModel,OpenedFile} from '../shared/desktop-api';
import type {Language} from './i18n';
import type {NotebookRunState} from './NotebookRuns';
import NotebookEditor from './NotebookEditor';
import EditorPane from './EditorPane';
import StandaloneDocumentEditor from './StandaloneDocumentEditor';
import {Button} from './ui';
import {isSaveShortcut} from './app-shortcuts';
import type {NotebookEditorSession} from './notebook-session';

/** A pane only presents the tab-owned draft. Saving and kernels stay with App. */
export default function WorkspaceFileEditor({file,draft,document,dirty,language,runState,vaultId,onPrepare,onChange,onSave,onRun,onInterrupt,onRestart,resolveMedia,onLocalLink,notebookSession,onNotebookSessionChange}:{notebookSession?:NotebookEditorSession;onNotebookSessionChange?:(session:NotebookEditorSession)=>void;file:OpenedFile;draft?:string;document?:EditableDocumentModel;dirty:boolean;language:Language;runState?:NotebookRunState;vaultId:string;onPrepare:()=>Promise<unknown>;onChange:(value:string)=>void;onSave:()=>Promise<boolean>;onRun:(indices:number[])=>void;onInterrupt:()=>void;onRestart:()=>void;resolveMedia:(source:string)=>Promise<string|undefined>;onLocalLink:(path:string)=>void}){
 const zh=language==='zh',[preparing,setPreparing]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const prepare=useRef(onPrepare);prepare.current=onPrepare;
 const load=async()=>{setPreparing(true);setError('');try{await prepare.current();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPreparing(false);}};
 useEffect(()=>{if(draft===undefined)void load();},[vaultId,file.path]);
 const save=async()=>{if(saving)return;setSaving(true);setError('');try{if(!await onSave())setError(zh?'尚未保存，请稍后重试。修改仍保留。':'Not saved yet. Your edits are retained; try again.');}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}};
 if(draft===undefined)return <div className="split-file-editor"><p role="status">{preparing?(zh?'正在准备编辑…':'Preparing editor…'):(zh?'编辑内容尚未载入。':'Editor not loaded.')}</p>{error&&<p role="alert">{error}</p>}<Button disabled={preparing} onClick={()=>void load()}>{zh?'重试':'Retry'}</Button></div>;
 let model:EditableDocumentModel|undefined;try{model=document?JSON.parse(draft):undefined;}catch{return <p role="alert">{zh?'文档草稿无法解析；原内容仍保留。':'Document draft could not be parsed; contents are retained.'}</p>;}
 return <section className="split-file-editor" data-testid="split-file-editor" data-path={file.path} onKeyDownCapture={event=>{if(isSaveShortcut({...event,keyCode:event.keyCode,isComposing:event.nativeEvent.isComposing})&&!globalThis.document.querySelector('[role="dialog"]')){event.preventDefault();event.stopPropagation();void save();}}}>
  <div className="split-editor-savebar"><span role="status">{saving?(zh?'保存中…':'Saving…'):dirty?(zh?'有未保存的修改':'Unsaved changes'):(zh?'已保存':'Saved')}</span><Button data-testid="split-editor-save" disabled={saving||!dirty||runState?.running} onClick={()=>void save()}>{zh?'保存此文档':'Save this document'}</Button></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {model?<StandaloneDocumentEditor zoomKey={vaultId+':'+file.path} value={model} onChange={value=>onChange(JSON.stringify(value))} language={language}/>:/\.ipynb$/i.test(file.path)?<NotebookEditor session={notebookSession} onSessionChange={onNotebookSessionChange} vaultId={vaultId} value={draft} path={file.path} language={language} runState={runState} onChange={onChange} onRun={onRun} onInterrupt={onInterrupt} onRestart={onRestart} onSave={()=>void save()} resolveMedia={resolveMedia} onLocalLink={onLocalLink}/>:<EditorPane path={file.path} value={draft} onChange={onChange}/>}
 </section>;
}

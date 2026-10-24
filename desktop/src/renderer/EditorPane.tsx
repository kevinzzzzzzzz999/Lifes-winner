import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { EditorView, type ViewUpdate } from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { StreamLanguage,HighlightStyle,syntaxHighlighting } from '@codemirror/language';
import {tags} from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { extname, Button } from './ui';
import {Undo2,Redo2,Trash2} from 'lucide-react';
import {undo,redo,undoDepth,redoDepth,indentMore,indentLess,toggleComment} from '@codemirror/commands';
import {keymap} from '@codemirror/view';
import {Prec} from '@codemirror/state';
import {completionStatus,currentCompletions,acceptCompletion,startCompletion} from '@codemirror/autocomplete';
import {selectNotebookWord} from './notebook-word-selection';
const editorTheme=EditorView.theme({'&':{height:'100%',fontSize:'16px',backgroundColor:'#fff'},'.cm-scroller':{overflow:'auto',fontFamily:'"SFMono-Regular",Consolas,"Liberation Mono",monospace',lineHeight:'1.72'},'.cm-content':{padding:'10px 0'},'.cm-line':{paddingLeft:'20px'},'.cm-gutters':{background:'#fff',borderRight:'1px solid #edf0f2',color:'#73808f',minWidth:'58px'},'.cm-gutterElement':{paddingLeft:'12px',paddingRight:'18px'},'.cm-activeLine':{background:'#f8fafb'},'.cm-activeLineGutter':{background:'#f4f7f8'},'.cm-focused':{outline:'none'}});
// CodeMirror paints selection behind its lines. An opaque active-line color
// hides the selected word even though copy/replace already sees the selection.
const notebookSelectionTheme=EditorView.theme({'& .cm-content .cm-activeLine':{background:'transparent'},'&.cm-editor .cm-scroller .cm-selectionLayer .cm-selectionBackground':{backgroundColor:'#d6e4f2'},'&.cm-editor.cm-focused .cm-scroller .cm-selectionLayer .cm-selectionBackground':{backgroundColor:'#b3d7ff'}});
const notebookDocumentTheme=EditorView.theme({'&':{fontSize:'14px',backgroundColor:'#f7f7f7',color:'#000'},'.cm-scroller':{fontFamily:'Menlo,Monaco,Consolas,"Liberation Mono",monospace',lineHeight:'17px'},'.cm-content':{padding:'5px 0'},'.cm-line':{paddingLeft:'4px',paddingRight:'4px'},'.cm-gutters':{backgroundColor:'#f7f7f7',minWidth:'40px'},'.cm-gutterElement':{paddingLeft:'5px',paddingRight:'8px'}});
const notebookPythonHighlight=HighlightStyle.define([{tag:tags.keyword,color:'#008000',fontWeight:'700'},{tag:tags.comment,color:'#408080',fontStyle:'italic'},{tag:[tags.string,tags.special(tags.string)],color:'#ba2121'},{tag:tags.number,color:'#008000'},{tag:[tags.bool,tags.null],color:'#008000',fontWeight:'700'},{tag:tags.operator,color:'#666'},{tag:tags.meta,color:'#aa22ff'}]);
export default function EditorPane({path,value,onChange,notebook=false,showLineNumbers=true,onReady,autoFocus=false}:{path:string;value:string;onChange:(v:string)=>void;notebook?:boolean;showLineNumbers?:boolean;onReady?:(view:EditorView)=>void;autoFocus?:boolean}) {const view=useRef<EditorView|null>(null);const [controls,setControls]=useState({undo:false,redo:false,selection:false});
const completionRequest=useRef<{view:EditorView;doc:EditorView['state']['doc'];selection:EditorView['state']['selection'];pending:boolean}|null>(null);
useEffect(()=>()=>{completionRequest.current=null;view.current=null;},[]);
// Editor configuration updates also emit onUpdate. Only actual toolbar changes
// should rerender this component; a render must not reconfigure itself forever.
const syncControls=useCallback((editor:EditorView)=>{const next={undo:undoDepth(editor.state)>0,redo:redoDepth(editor.state)>0,selection:editor.state.selection.ranges.some(r=>!r.empty)};setControls(previous=>previous.undo===next.undo&&previous.redo===next.redo&&previous.selection===next.selection?previous:next);},[]);
const onEditorUpdate=useCallback((update:ViewUpdate)=>{
 syncControls(update.view);
 const request=completionRequest.current;if(!request||request.view!==update.view)return;
 if(update.docChanged||update.selectionSet||!update.view.hasFocus){completionRequest.current=null;return;}
 if(completionStatus(update.state)==='pending'){request.pending=true;return;}
 if(!request.pending)return;
 if(currentCompletions(update.state).length){completionRequest.current=null;return;}
 request.pending=false;
 // Completion queries are asynchronous. An empty result should still indent,
 // but only while this exact editor, text and cursor still own the key press.
 queueMicrotask(()=>{const editor=request.view;if(completionRequest.current!==request)return;completionRequest.current=null;if(view.current===editor&&editor.hasFocus&&editor.state.doc===request.doc&&editor.state.selection.eq(request.selection)&&completionStatus(editor.state)!=='pending'&&!currentCompletions(editor.state).length)indentMore(editor);});
},[syncControls]);
const onEditorCreate=useCallback((editor:EditorView)=>{view.current=editor;onReady?.(editor);if(autoFocus)editor.focus();syncControls(editor);},[onReady,autoFocus,syncControls]);
const basicSetup=useMemo(()=>({lineNumbers:showLineNumbers,foldGutter:true,highlightActiveLine:true,autocompletion:true}),[showLineNumbers]);const zh=document.documentElement.lang.startsWith('zh');const command=(back:boolean)=>{if(view.current){(back?undo:redo)(view.current);view.current.focus();}};const extensions=useMemo(()=>{const ext=extname(path);return [...(notebook?[Prec.highest(keymap.of([{key:'Tab',run:editor=>{
 completionRequest.current=null;
 if(currentCompletions(editor.state).length){acceptCompletion(editor);return true;}
 if(!editor.state.selection.main.empty||!/[\w.]$/.test(editor.state.doc.sliceString(0,editor.state.selection.main.head)))return indentMore(editor);
 const request={view:editor,doc:editor.state.doc,selection:editor.state.selection,pending:completionStatus(editor.state)==='pending'};completionRequest.current=request;
 if(request.pending||startCompletion(editor))return true;completionRequest.current=null;return indentMore(editor);
}},{key:'Shift-Tab',run:editor=>{completionRequest.current=null;return indentLess(editor);}},{key:'Ctrl-/',run:toggleComment}])),EditorView.domEventHandlers({blur:()=>{completionRequest.current=null;},dblclick:(event,editor)=>selectNotebookWord(editor,event)})]:[]),editorTheme,...(notebook?[Prec.high(notebookDocumentTheme),notebookSelectionTheme,...(ext==='py'?[syntaxHighlighting(notebookPythonHighlight)]:[])]:[]),ext==='py'?python():ext==='md'?markdown():ext==='json'?json():ext==='tex'?StreamLanguage.define(stex):['ts','js'].includes(ext)?javascript({typescript:ext==='ts'}):EditorView.lineWrapping];},[path,notebook]);return <div className="editor-pane"><div className="text-edit-actions" role="toolbar" aria-label={zh?'文字编辑':'Text editing'}><Button aria-label={zh?'撤销':'Undo'} disabled={!controls.undo} onMouseDown={e=>e.preventDefault()} onClick={()=>command(true)}><Undo2/>{zh?'撤销':'Undo'}</Button><Button aria-label={zh?'重做':'Redo'} disabled={!controls.redo} onMouseDown={e=>e.preventDefault()} onClick={()=>command(false)}><Redo2/>{zh?'重做':'Redo'}</Button><Button aria-label={zh?'删除选中文字':'Delete selected text'} disabled={!controls.selection} onMouseDown={e=>e.preventDefault()} onClick={()=>{const editor=view.current;if(editor){editor.dispatch(editor.state.replaceSelection(''));editor.focus();}}}><Trash2/>{zh?'删除选中':'Delete selection'}</Button></div><CodeMirror onCreateEditor={onEditorCreate} onUpdate={onEditorUpdate} value={value} onChange={onChange} height="100%" extensions={extensions} basicSetup={basicSetup} aria-label={path}/></div>;}

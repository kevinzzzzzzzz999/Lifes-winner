import {useState,useRef,useEffect} from 'react';
import {ArrowUp,ArrowDown,Plus,Trash2,Undo2,Redo2} from 'lucide-react';
import type {EditableDocumentModel,EditableDocumentBlock} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button} from './ui';
import './document-editing.css';
import './document-zoom.css';
import {useDocumentZoom} from './useDocumentZoom';
import DocumentZoomControls from './DocumentZoomControls';

export function initialDocument(format:EditableDocumentModel['format'],title:string):EditableDocumentModel{
 return {version:1,format,title,blocks:[],...(format==='pptx'?{slides:[{title,blocks:[{kind:'paragraph' as const,text:''}]}]}:{blocks:[{kind:'paragraph' as const,text:''}]})};
}
export default function StandaloneDocumentEditor({value,onChange,language,zoomKey}:{zoomKey?:string;value:EditableDocumentModel;onChange:(v:EditableDocumentModel)=>void;language:Language}){
 const scroll=useRef<HTMLDivElement>(null),page=useRef<HTMLElement>(null),documentZoom=useDocumentZoom(scroll,page,zoomKey||'editable-document',800,48);
 const undo=useRef<EditableDocumentModel[]>([]),redo=useRef<EditableDocumentModel[]>([]),expected=useRef(JSON.stringify(value)),latest=useRef(value),lastEdit=useRef(0);const[,tick]=useState(0);latest.current=value;
 useEffect(()=>{const signature=JSON.stringify(value);if(signature!==expected.current){undo.current=[];redo.current=[];lastEdit.current=0;tick(v=>v+1);}expected.current=signature;},[value]);
 const change=(next:EditableDocumentModel)=>{if(JSON.stringify(next)===JSON.stringify(value))return;const now=Date.now();if(now-lastEdit.current>500){undo.current.push(value);if(undo.current.length>50)undo.current.shift();}lastEdit.current=now;redo.current=[];expected.current=JSON.stringify(next);onChange(next);tick(v=>v+1);};
 const history=(back:boolean)=>{const source=back?undo.current:redo.current,destination=back?redo.current:undo.current,next=source.pop();if(!next)return;destination.push(latest.current);lastEdit.current=0;expected.current=JSON.stringify(next);onChange(next);tick(v=>v+1);};
 const zh=language==='zh';const[slide,setSlide]=useState(0);const[preview,setPreview]=useState(false);const slides=value.slides||[];const index=Math.min(slide,Math.max(0,slides.length-1));const isSlides=value.format==='pptx';const current=slides[index];
 const blocks=isSlides?current?.blocks||[]:value.blocks;
 const changeBlocks=(next:EditableDocumentBlock[])=>change(isSlides?{...value,slides:slides.map((s,i)=>i===index?{...s,blocks:next}:s)}:{...value,blocks:next});
 const move=(i:number,delta:number)=>{const next=[...blocks];[next[i],next[i+delta]]=[next[i+delta],next[i]];changeBlocks(next);};
 const count=value.blocks.length+slides.reduce((n,s)=>n+s.blocks.length,0);
 const pageTitle=isSlides?current?.title||'':value.title;
 return <section onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.stopPropagation();history(!e.shiftKey);}}} className="standalone-document" data-testid="document-editor"><header className="document-editor-toolbar"><strong>{value.format.toUpperCase()} · {zh?'文档编写':'Document writing'}</strong><span className="spacer"/><DocumentZoomControls zoom={documentZoom.zoom} onZoom={documentZoom.change} language={language}/><Button aria-label={zh?'撤销':'Undo'} disabled={!undo.current.length} onClick={()=>history(true)}><Undo2/>{zh?'撤销':'Undo'}</Button><Button aria-label={zh?'重做':'Redo'} disabled={!redo.current.length} onClick={()=>history(false)}><Redo2/>{zh?'重做':'Redo'}</Button><Button onClick={()=>setPreview(v=>!v)}>{preview?(zh?'继续编辑':'Continue editing'):(zh?'阅读预览':'Read preview')}</Button></header>
 <p className="document-editor-hint">{zh?'支持标题、段落与列表；保存时生成标准文件，可在其他应用打开。':'Compose headings, paragraphs and lists. Saving creates a standard file you can open in other apps.'}</p>
 <div className="document-editor-body">{isSlides&&<nav className="slide-list" aria-label={zh?'幻灯片':'Slides'}>{slides.map((s,i)=><button className={index===i?'selected':''} key={i} onClick={()=>setSlide(i)}><span>{i+1}</span>{s.title|| (zh?'无标题':'Untitled')}</button>)}<Button disabled={slides.length>=200} onClick={()=>{change({...value,slides:[...slides,{title:zh?'新幻灯片':'New slide',blocks:[{kind:'paragraph',text:''}]}]});setSlide(slides.length);}}><Plus/>{zh?'新幻灯片':'New slide'}</Button><Button disabled={slides.length<=1} onClick={()=>{change({...value,slides:slides.filter((_,i)=>i!==index)});setSlide(Math.max(0,index-1));}}><Trash2/>{zh?'删除这一页':'Delete this slide'}</Button></nav>}
 <div className="document-sheet-scroll" ref={scroll}><article ref={page} style={documentZoom.style} className={`document-sheet document-zoom-page ${isSlides?'slide-sheet':''} ${preview?'reading':''}`}>
 {preview?<><h1>{pageTitle}</h1>{blocks.map((block,i)=>block.kind==='heading'?<h2 key={i}>{block.text}</h2>:block.kind==='bullet'?<ul key={i}><li>{block.text}</li></ul>:<p key={i}>{block.text||'\u00a0'}</p>)}</>:<>
 <label className="document-title-label">{zh?'标题':'Title'}<input data-testid="document-title" value={pageTitle} maxLength={10000} onChange={e=>change(isSlides?{...value,slides:slides.map((s,i)=>i===index?{...s,title:e.target.value}:s)}:{...value,title:e.target.value})}/></label>
 {blocks.map((block,i)=><div className={'document-block block-'+block.kind} key={i}><div className="document-block-tools"><select aria-label={(zh?'段落类型 ':'Block type ')+(i+1)} value={block.kind} onChange={e=>changeBlocks(blocks.map((b,j)=>i===j?{...b,kind:e.target.value as EditableDocumentBlock['kind']}:b))}><option value="paragraph">{zh?'正文':'Paragraph'}</option><option value="heading">{zh?'小标题':'Heading'}</option><option value="bullet">{zh?'列表':'Bullet'}</option></select><span className="spacer"/><Button aria-label={zh?'上移':'Move up'} disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp/></Button><Button aria-label={zh?'下移':'Move down'} disabled={i===blocks.length-1} onClick={()=>move(i,1)}><ArrowDown/></Button><Button aria-label={zh?'删除段落':'Delete block'} onClick={()=>changeBlocks(blocks.filter((_,j)=>j!==i))}><Trash2/></Button></div><textarea data-testid="document-block-text" aria-label={(zh?'段落内容 ':'Block content ')+(i+1)} rows={block.kind==='heading'?1:3} value={block.text} maxLength={100000} onChange={e=>changeBlocks(blocks.map((b,j)=>i===j?{...b,text:e.target.value}:b))}/></div>)}
 <Button className="add-document-block" disabled={count>=5000} onClick={()=>changeBlocks([...blocks,{kind:'paragraph',text:''}])}><Plus/>{zh?'添加段落':'Add paragraph'}</Button></>}
 </article></div></div><article className="document-print"><h1>{pageTitle}</h1>{blocks.map((block,i)=>block.kind==='heading'?<h2 key={i}>{block.text}</h2>:block.kind==='bullet'?<ul key={i}><li>{block.text}</li></ul>:<p key={i}>{block.text||'\u00a0'}</p>)}</article></section>;
}

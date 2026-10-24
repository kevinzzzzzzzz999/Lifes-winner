import {useLayoutEffect,useRef,type ReactNode} from 'react';
import type {OpenedFile} from '../shared/desktop-api';
import type {PDFSourceReference} from '../shared/pdf-extend';
import type {Language} from './i18n';
import type {PDFBoardTarget} from './pdf-board-links';
import {Button,basename} from './ui';
import './pdf-board-study.css';

export type PDFBoardStudyState={vaultId:string;ownerPath:string;sourcePath:string;target:PDFBoardTarget;mode:'split'|'board'|'document';ratio:number;autoLocate:boolean;focus?:{id:string;nonce:number};lastExcerptID?:string;navigation?:{file:OpenedFile;page?:number;nonce:number};camera?:{x:number;y:number;zoom:number}};
/** Keep both real editors mounted when changing layout. Hidden panes retain their
 * last visible dimensions, so a zero-width resize cannot alter the reading view. */
export default function PDFBoardStudyLayout({study,language,reader,board,blocked,onChange,onLocate,onSave,dirty,onBoardFocus}:{study?:PDFBoardStudyState;language:Language;reader:ReactNode;board?:ReactNode;blocked:boolean;onChange:(patch:Partial<PDFBoardStudyState>)=>void;onLocate:()=>void;onSave:()=>void;dirty:boolean;onBoardFocus?:()=>void}){
 const zh=language==='zh',root=useRef<HTMLDivElement>(null),left=useRef<HTMLDivElement>(null),right=useRef<HTMLDivElement>(null),sizes=useRef({left:600,right:600}),visible=useRef({left:true,right:false});
 const hasBoard=!!study&&!!board,mode=hasBoard?study.mode:'document',ratio=study?.ratio??.5;
 visible.current={left:mode!=='board',right:hasBoard&&mode!=='document'};
 useLayoutEffect(()=>{const observer=new ResizeObserver(entries=>{for(const entry of entries){const side=entry.target===left.current?'left':'right';if(visible.current[side]&&entry.contentRect.width>0)sizes.current[side]=entry.contentRect.width;}});if(left.current)observer.observe(left.current);if(right.current)observer.observe(right.current);return()=>observer.disconnect();},[hasBoard]);
 const width=(side:'left'|'right')=>visible.current[side]?{flexBasis:mode==='split'?(side==='left'?ratio:1-ratio)*100+'%':'100%'}:{width:sizes.current[side]};
 const resize=(value:number)=>{if(!blocked)onChange({ratio:Math.max(.28,Math.min(.72,value))});};
 return <div className="pdf-board-study" data-testid="pdf-board-study" data-mode={mode} data-board-path={study?.target.path} data-source-path={study?.sourcePath}>
  {hasBoard&&<header className="pdf-board-study-toolbar" aria-label={zh?'PDF与白板学习布局':'PDF and board study layout'}>
   <div className="segmented" role="group" aria-label={zh?'学习布局':'Study layout'}>{([['document',zh?'PDF':'PDF'],['split',zh?'PDF＋白板':'PDF + board'],['board',zh?'全白板':'Board']] as const).map(([value,label])=><button key={value} data-testid={'pdf-study-mode-'+value} aria-pressed={mode===value} className={mode===value?'selected':''} disabled={blocked} onClick={()=>onChange({mode:value})}>{label}</button>)}</div>
   <Button data-testid="pdf-study-save-board" disabled={blocked||!dirty} onClick={onSave}>{dirty?(zh?'保存白板':'Save board'):(zh?'白板已保存':'Board saved')}</Button><span className="pdf-study-board-name" title={study.target.path}>{basename(study.target.path).replace(/\.inkspace\.json$/i,'')}</span>
   <Button data-testid="pdf-study-locate-excerpt" disabled={blocked||!study.lastExcerptID} onClick={onLocate}>{zh?'定位摘录':'Locate excerpt'}</Button>
   <label className="pdf-study-auto-locate" title={zh?'加入摘录后自动定位白板卡片':'Locate new cards after adding an excerpt'}><input type="checkbox" data-testid="pdf-study-auto-locate" checked={study.autoLocate} disabled={blocked} onChange={e=>onChange({autoLocate:e.target.checked})}/>{zh?'跟随摘录':'Follow excerpts'}</label>
  </header>}
  <div className="pdf-board-study-body" ref={root}>
   <section ref={left} className={'pdf-study-reader '+(!visible.current.left?'pdf-study-hidden':'')} style={width('left')} inert={!visible.current.left||undefined} aria-hidden={!visible.current.left||undefined} data-testid="pdf-study-reader">{reader}</section>
   {hasBoard&&<><div className={'pdf-study-divider '+(mode!=='split'?'pdf-study-divider-hidden':'')} role="separator" aria-orientation="vertical" aria-label={zh?'调整PDF与白板宽度':'Resize PDF and board panes'} aria-valuemin={28} aria-valuemax={72} aria-valuenow={Math.round(ratio*100)} tabIndex={mode==='split'?0:-1} data-testid="pdf-study-divider" onPointerDown={e=>{if(e.button!==0||blocked)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId)){const rect=root.current!.getBoundingClientRect();resize((e.clientX-rect.left)/rect.width);}}} onPointerUp={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();resize(e.key==='Home'?.28:e.key==='End'?.72:ratio+(e.key==='ArrowLeft'?-.03:.03));}}}/><section ref={right} onPointerDownCapture={onBoardFocus} onFocusCapture={onBoardFocus} className={'pdf-study-board '+(!visible.current.right?'pdf-study-hidden':'')} style={width('right')} inert={!visible.current.right||undefined} aria-hidden={!visible.current.right||undefined} data-testid="pdf-linked-board-pane">{board}</section></>}
  </div>
 </div>;
}

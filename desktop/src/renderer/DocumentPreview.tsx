import {localizeOfficeHTML} from './office-reading-labels';
import type {VideoPlaybackState} from '../shared/video-playback';
import { useEffect,useMemo,useRef } from 'react';
import type {ReviewRecord} from '../shared/desktop-api';
import BoardEmbed from './BoardEmbed';
import OfficeTranslationFrame from './DocumentTranslationSelection';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import katex from 'katex';
import {useDocumentZoom} from './useDocumentZoom';
import DocumentZoomControls from './DocumentZoomControls';
import './document-zoom.css';
import {notebookHTMLFormattingClasses} from './notebook-html-format';
import './notebook-html-format.css';

import 'katex/dist/katex.min.css';
import {internalFileAnchor,internalFilePathFromAnchor} from '../shared/internal-file-links';
import { type Language,tr } from './i18n';
const escapeHTML=(s:string)=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));
const markdownParser=new Marked({extensions:[{name:'wikiLink',level:'inline',start:src=>src.indexOf('[['),tokenizer(src){const m=/^\[\[([^\]\n]+?)\]\]/.exec(src);if(m){const parts=m[1].split('|');return{type:'wikiLink',raw:m[0],target:parts[0],text:parts.slice(1).join('|')||parts[0]};}},renderer(token){return '<a class="wiki-link" href="#inkspace-note='+encodeURIComponent(token.target)+'">'+escapeHTML(token.text)+'</a>';}},{name:'mathBlock',level:'block',start:src=>src.indexOf('$$'),tokenizer(src){const m=/^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);if(m)return{type:'mathBlock',raw:m[0],text:m[1]};},renderer(token){return '<div class="inkspace-math-display">'+escapeHTML(token.text)+'</div>';}},{name:'mathInline',level:'inline',start:src=>src.indexOf('$'),tokenizer(src){const m=/^\$([^$\n]+?)\$/.exec(src);if(m)return{type:'mathInline',raw:m[0],text:m[1]};},renderer(token){return '<span class="inkspace-math-inline">'+escapeHTML(token.text)+'</span>';}}]});
const PURIFY={FORBID_TAGS:['script','iframe','object','embed','form','input','button','style','link','meta'],FORBID_ATTR:['style','srcset','target'],ALLOW_DATA_ATTR:false};
export function Formula({text}:{text:string}){const html=useMemo(()=>katex.renderToString(text.slice(0,10000),{displayMode:true,throwOnError:false,trust:false,maxExpand:200,maxSize:20,strict:'ignore'}),[text]);return <div className="formula" dangerouslySetInnerHTML={{__html:html}}/>;}
function safeHTML(html:string,allowAttachments=false,notebookFormatting=false){
 const attachmentMarker='#inkspace-attachment=';
 const purifier=DOMPurify(window);
 if(notebookFormatting)purifier.addHook('uponSanitizeElement',node=>{
  if(node instanceof HTMLElement&&node.namespaceURI==='http://www.w3.org/1999/xhtml'&&node.hasAttribute('style')){
   const classes=notebookHTMLFormattingClasses(node.tagName,node.style);
   if(classes.length)node.classList.add(...classes);
  }
 });
 purifier.addHook('uponSanitizeAttribute',(node,event)=>{
  if(node.nodeName!=='A'||event.attrName!=='href')return;
  const fragment=internalFileAnchor(event.attrValue);
  if(fragment!==null)event.attrValue=fragment;
  else if(/^inkspace:/i.test(event.attrValue)||(event.attrValue.startsWith('#inkspace-file=')&&internalFilePathFromAnchor(event.attrValue)===null))event.keepAttr=false;
 });
 if(allowAttachments)purifier.addHook('uponSanitizeAttribute',(node,event)=>{if(node.nodeName==='IMG'&&event.attrName==='src'&&event.attrValue.startsWith('attachment:'))event.attrValue=attachmentMarker+encodeURIComponent(event.attrValue);});
 const fragment=purifier.sanitize(html,{...PURIFY,RETURN_DOM_FRAGMENT:true});
 for(const node of fragment.querySelectorAll('img')){if(notebookFormatting){node.loading='lazy';node.decoding='async';}if(!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(node.getAttribute('src')||'')){
  let source=node.getAttribute('src')||'';node.removeAttribute('src');
  if(allowAttachments&&source.startsWith(attachmentMarker)){try{source=decodeURIComponent(source.slice(attachmentMarker.length));}catch{source='';}}
  if(source&&((allowAttachments&&source.startsWith('attachment:'))||(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)&&!source.startsWith('//'))))node.setAttribute('data-local-source',source);
 }}const container=document.createElement('div');container.append(fragment);return container.innerHTML;
}
type PreviewPiece={kind:'html'|'board';content:string};
function previewPieces(text:string,html:string|undefined,format:string,allowAttachments=false,language:Language='en',notebookFormatting=false):PreviewPiece[]{
 if(html!==undefined)return[{kind:'html',content:localizeOfficeHTML(safeHTML(html,allowAttachments,notebookFormatting),language)}];
 // Notebook sources already have per-cell and document limits. Cutting a cell
 // here can split an embedded image URL and hide the image and its caption.
 const tokens=markdownParser.lexer(notebookFormatting&&format==='md'?text:text.slice(0,200000));
 const pieces:PreviewPiece[]=[];let pending:typeof tokens=[] as unknown as typeof tokens;let count=0;
 const flush=()=>{if(pending.length){pieces.push({kind:'html',content:safeHTML(markdownParser.parser(pending),allowAttachments,notebookFormatting)});pending=[] as unknown as typeof tokens;}};
 for(const token of tokens){if(format==='md'&&token.type==='code'&&token.lang?.trim()==='inkspace'&&count<12){flush();pieces.push({kind:'board',content:token.text});count++;}else pending.push(token);}
 flush();return pieces;
}
export default function DocumentPreview({text,html,format,language,onLocalLink,onRootFileLink,onWikiLink,resolveMedia,allowAttachments=false,notebookFormatting=false,vaultId,documentKey,zoomKey,assetRevision=0,onBoardOpen,onBoardReview}:{text?:string;html?:string;format:string;language:Language;onLocalLink?:(path:string)=>void;onRootFileLink?:(path:string)=>void;onWikiLink?:(target:string)=>void;resolveMedia?:(source:string)=>Promise<string|undefined>;allowAttachments?:boolean;notebookFormatting?:boolean;vaultId?:string;documentKey?:string;zoomKey?:string;assetRevision?:number;onBoardOpen?:(path:string,page?:number,playback?:VideoPlaybackState)=>void;onBoardReview?:(review:ReviewRecord)=>void}){const ref=useRef<HTMLElement>(null),viewport=useRef<HTMLDivElement>(null),zoomable=['docx','pptx','spreadsheet'].includes(format),documentZoom=useDocumentZoom(viewport,ref,zoomKey||documentKey||format,900,36,zoomable);const pieces=useMemo(()=>previewPieces(text||'',html,format,allowAttachments,language,notebookFormatting),[text,html,format,allowAttachments,language,notebookFormatting]);const content=pieces,selectionRevision=useMemo(()=>[pieces,documentZoom.zoom],[pieces,documentZoom.zoom]);
 useEffect(()=>{if(ref.current&&resolveMedia)for(const node of ref.current.querySelectorAll<HTMLImageElement>('img[data-local-source]')){void resolveMedia(node.getAttribute('data-local-source')||'').then(url=>{if(url&&node.isConnected)node.src=url;});}if(ref.current&&format==='md')for(const node of ref.current.querySelectorAll<HTMLElement>('.inkspace-math-inline,.inkspace-math-display')){const formula=node.getAttribute('data-formula-source')||node.textContent||'';node.setAttribute('data-formula-source',formula);katex.render(formula,node,{displayMode:node.classList.contains('inkspace-math-display'),throwOnError:false,trust:false,maxExpand:200,maxSize:20,strict:'ignore'});}},[content,format,resolveMedia]);
 if(format==='tex'){const source=(text||'').slice(0,200000);const formulas=[...source.matchAll(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\begin\{(equation\*?|align\*?)\}([\s\S]*?)\\end\{\3\}/g)].map(m=>m[1]||m[2]||(m[3].startsWith('align')?'\\begin{aligned}'+m[4]+'\\end{aligned}':m[4]));return <div className="document-preview"><p className="preview-notice">{tr(language,'latexHint')}</p><article className="paper">{formulas.length?formulas.slice(0,100).map((formula,i)=><Formula key={i} text={formula}/>):/\\documentclass|\\begin\{document\}/.test(source)?<p>{tr(language,'previewEmpty')}</p>:<Formula text={source}/>}</article></div>;}
 const reportImageFailure=(image:HTMLImageElement)=>{const figure=image.closest('.office-embedded-pictures figure');if(!figure||figure.querySelector('.office-image-error'))return;const notice=document.createElement('p');notice.className='office-image-error';notice.setAttribute('role','status');notice.textContent=language==='zh'?'此图片无法解码；其他文字和图片仍可阅读。请用原应用查看。':'This image could not be decoded. Other text and images remain available; open the original application to inspect it.';figure.append(notice);};
 const page=<article ref={ref} className={'paper'+(zoomable?' document-zoom-page':'')} style={zoomable?documentZoom.style:undefined} onErrorCapture={event=>{if(event.target instanceof HTMLImageElement)reportImageFailure(event.target);}} onClick={event=>{const target=(event.target as HTMLElement).closest('a');if(target){event.preventDefault();const href=target.getAttribute('href')||'';if(href.startsWith('#inkspace-file=')){const file=internalFilePathFromAnchor(href);if(file!==null)onRootFileLink?.(file);}else if(href.startsWith('#inkspace-note=')){try{onWikiLink?.(decodeURIComponent(href.slice(15)));}catch{}}else if(href.startsWith('#')){const anchor=href.slice(1);if(anchor)ref.current?.querySelector('#'+CSS.escape(anchor))?.scrollIntoView({block:'nearest'});}else if(/^https?:\/\//i.test(href)){void window.desktop.openExternal({url:href});}else if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)&&!href.startsWith('//'))onLocalLink?.(href);}}}>{pieces.map((piece,index)=>piece.kind==='board'&&vaultId&&onBoardOpen?<BoardEmbed key={index} source={piece.content} vaultId={vaultId} language={language} revision={assetRevision} onOpen={onBoardOpen} onReview={onBoardReview}/>:<div key={index} dangerouslySetInnerHTML={{__html:piece.kind==='html'?piece.content:'<pre><code>'+escapeHTML(piece.content)+'</code></pre>'}}/>)}</article>;
 const notices=<>{format==='docx'&&<p className="preview-notice">{tr(language,'wordHint')} {tr(language,'wordOriginal')}</p>}{!(notebookFormatting&&format==='md')&&(text?.length||0)>200000&&<p className="preview-notice">{tr(language,'previewLarge')}</p>}</>;
 const preview=zoomable?<div className="document-preview with-document-zoom"><div className="document-zoom-toolbar"><DocumentZoomControls zoom={documentZoom.zoom} onZoom={documentZoom.change} language={language}/></div>{notices}<div className="document-zoom-scroll" ref={viewport}>{page}</div></div>:<div className={'document-preview'+(notebookFormatting?' notebook-formatting':'')}>{notices}{page}</div>;
 return ['docx','pptx','spreadsheet'].includes(format)?<OfficeTranslationFrame key={documentKey||format} owner={documentKey||format} language={language} revision={selectionRevision}>{preview}</OfficeTranslationFrame>:preview;
}

import {useMemo,useState} from 'react';
import type {MouseEvent,KeyboardEvent,PointerEvent} from 'react';
import {sanitizeRichTextHTML,safeExternalLink,plainTextToRichHTML} from './clipboard-rich-text';
import {boxMarkdown,renderRichTextMath} from './rich-text-math';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './box-content.css';

export type BoxTextFormat='richText'|'markdown'|'latex'|'python';
export type BoxContentProps={text:string;textFormat?:string;richTextHTML?:string;fallbackKind?:string;onOpenWebLink?:(url:string)=>void|Promise<void>};
const FORMATS=new Set<string>(['richText','markdown','latex','python']);
/** An unknown future format stays readable without interpreting its extra data. */
export function resolvedBoxFormat(format:string|undefined,kind?:string):BoxTextFormat|'plain' {
 if(format!=null)return FORMATS.has(format)?format as BoxTextFormat:'plain';
 return kind==='formula'?'latex':'richText';
}
/** Shared presentational sanitizer retains editable tables and bounded formatting.
 * Only safe web links and bounded formatting survive; resources never load here. */
export function sanitizedBoxHTML(source:string,format:'richText'|'markdown'):string {
 const html=format==='markdown'?boxMarkdown.parse(source.slice(0,100000),{async:false}) as string:source;
 return sanitizeRichTextHTML(html);
}
export default function BoxContent({text,textFormat,richTextHTML,fallbackKind,onOpenWebLink}:BoxContentProps){
 const format=resolvedBoxFormat(textFormat,fallbackKind);const [linkError,setLinkError]=useState('');
 const anchorFor=(target:EventTarget|null,container:HTMLElement)=>{const node=target instanceof Element?target.closest('a[href]'):null;return node instanceof HTMLAnchorElement&&container.contains(node)?node:null;};
 const openLink=(url:string)=>{setLinkError('');if(onOpenWebLink){void Promise.resolve().then(()=>onOpenWebLink(url)).catch(()=>setLinkError('无法打开链接，请稍后重试 / Could not open link. Please try again.'));return;}if(!window.desktop?.openExternal){setLinkError('请在桌面应用中打开链接 / Open this link in the desktop app.');return;}void window.desktop.openExternal({url}).then(result=>{if(!result.ok)setLinkError('无法打开链接 / Could not open link. '+result.error.message);}).catch(()=>setLinkError('无法打开链接，请稍后重试 / Could not open link. Please try again.'));};
 const clickLink=(event:MouseEvent<HTMLDivElement>)=>{const anchor=anchorFor(event.target,event.currentTarget);if(!anchor)return;event.preventDefault();event.stopPropagation();const url=safeExternalLink(anchor.getAttribute('href')||'');if(url)openLink(url);};
 const keyLink=(event:KeyboardEvent<HTMLDivElement>)=>{const anchor=anchorFor(event.target,event.currentTarget);if(!anchor)return;event.stopPropagation();if(event.key==='Enter'){event.preventDefault();const url=safeExternalLink(anchor.getAttribute('href')||'');if(url)openLink(url);}};
 const pointerLink=(event:PointerEvent<HTMLDivElement>)=>{if(anchorFor(event.target,event.currentTarget))event.stopPropagation();};
 const html=useMemo(()=>{
  if(format==='markdown')return renderRichTextMath(sanitizedBoxHTML(text,'markdown'));
  if(format==='richText'&&richTextHTML)return renderRichTextMath(sanitizedBoxHTML(richTextHTML,'richText'));
  if(format==='latex'){
   try{return katex.renderToString(text.slice(0,10000),{displayMode:true,throwOnError:false,trust:false,maxExpand:200,maxSize:20,strict:'ignore'});}catch{return null;}
  }
  if(format==='plain'||format==='richText'){const source=plainTextToRichHTML(text);const linked=source.replace(/https?:\/\/[^\s<>]+/gi,raw=>{const decoded=raw.replace(/&amp;/g,'&').replace(/&quot;/g,'\"').replace(/&#39;/g,"'");const safe=safeExternalLink(decoded);return safe?`<a href="${safe.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${raw}</a>`:raw;});if(format==='richText')return renderRichTextMath(sanitizedBoxHTML(linked,'richText'));if(linked!==source)return sanitizedBoxHTML(linked,'richText');}
  return null;
 },[text,format,richTextHTML]);
 if(format==='python')return <pre className="box-content box-python" data-box-format="python"><code>{text}</code></pre>;
 if(html)return <><div className={`box-content box-${format}`} data-box-format={format} onClick={clickLink} onKeyDown={keyLink} onPointerDown={pointerLink} onDoubleClick={event=>{if(anchorFor(event.target,event.currentTarget)){event.preventDefault();event.stopPropagation();}}} dangerouslySetInnerHTML={{__html:html}}/>{linkError&&<p className="box-link-error" role="status">{linkError}</p>}</>;
 return <div className="box-content box-plain" data-box-format={format}>{text}</div>;
}

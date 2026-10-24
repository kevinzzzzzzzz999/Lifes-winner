import {useEffect,useRef,useState} from 'react';
import {X,Minus,Plus} from 'lucide-react';
import type {Language} from './i18n';
import {Button} from './ui';
import './math-workbench.css';

export default function MathWorkbench({language,open,onClose}:{language:Language;open:boolean;onClose:()=>void}) {
 const [collapsed,setCollapsed]=useState(false),[position,setPosition]=useState({x:80,y:100});
 const panel=useRef<HTMLElement>(null),drag=useRef<{id:number;x:number;y:number;px:number;py:number}|null>(null);
 const frame=useRef<HTMLIFrameElement>(null),exportBusy=useRef(false);
 const source=new URL('./math-lab/simple.html',window.location.href);source.searchParams.set('lang',language);
 const clamp=(x:number,y:number)=>({x:Math.max(8,Math.min(x,window.innerWidth-(panel.current?.offsetWidth??380)-8)),y:Math.max(8,Math.min(y,window.innerHeight-(panel.current?.offsetHeight??540)-8))});
 useEffect(()=>{const resized=()=>setPosition(p=>clamp(p.x,p.y));window.addEventListener('resize',resized);return()=>window.removeEventListener('resize',resized);},[]);
 useEffect(()=>{
  let active=true;
  const receive=async(event:MessageEvent)=>{
   const target=frame.current?.contentWindow,request=event.data;
   if(!target||event.source!==target||event.origin!==source.origin)return;
   if(request?.type==='calculator-copy'){
    const text=request.text;
    if(typeof text!=='string'||text.length>128||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text)||!Number.isFinite(Number(text)))return;
    let copied=false;try{const result=await window.desktop.copyBoardText({text});copied=result.ok&&result.value.copied;}catch{}
    if(active)target.postMessage({type:'calculator-copy-result',copied},source.origin==='null'?'*':source.origin);return;
   }
   if(request?.type!=='math-lab-export')return;
   const reply=(value:{saved?:boolean;error?:string})=>{if(active)target.postMessage({type:'math-lab-export-result',...value},source.origin==='null'?'*':source.origin);};
   if(exportBusy.current){reply({error:language==='zh'?'请先完成当前导出。':'Finish the current export first.'});return;}
   if(request.mime!=='image/png'||typeof request.name!=='string'||typeof request.dataBase64!=='string'||request.dataBase64.length>12*1024*1024){reply({error:language==='zh'?'导出内容无效或过大。':'Invalid or oversized export.'});return;}
   exportBusy.current=true;
   try{const result=await window.desktop.exportMathWorksheet({name:request.name,mime:request.mime,dataBase64:request.dataBase64});reply(result.ok?result.value:{error:result.error.message});}
   catch{reply({error:language==='zh'?'暂时无法导出，请重试。':'Export failed. Please retry.'});}
   finally{exportBusy.current=false;}
  };
  window.addEventListener('message',receive);return()=>{active=false;window.removeEventListener('message',receive);};
 },[language,source.origin]);
 useEffect(()=>{if(open&&!collapsed)frame.current?.contentWindow?.postMessage({type:'math-lab-visibility',visible:true},source.origin==='null'?'*':source.origin);},[open,collapsed,source.origin]);
 return <section ref={panel} className={`calculator-float ${collapsed?'collapsed':''}`} hidden={!open} role="dialog" aria-modal="false" aria-label={language==='zh'?'科学计算器':'Scientific calculator'} style={{left:position.x,top:position.y}}>
  <header><strong tabIndex={0} title={language==='zh'?'拖动标题移动；拖动右下角调整大小':'Drag title to move; drag lower corner to resize'} onPointerDown={e=>{if(e.button!==0)return;drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,px:position.x,py:position.y};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{const d=drag.current;if(d?.id===e.pointerId)setPosition(clamp(d.px+e.clientX-d.x,d.py+e.clientY-d.y));}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>{language==='zh'?'科学计算器':'Calculator'}</strong><Button aria-label={language==='zh'?'折叠或展开':'Collapse or expand'} onClick={()=>setCollapsed(v=>!v)}>{collapsed?<Plus/>:<Minus/>}</Button><Button onClick={onClose} aria-label={language==='zh'?'关闭计算器':'Close calculator'}><X/></Button></header>
  <iframe ref={frame} hidden={collapsed} title={language==='zh'?'科学计算与函数绘图':'Scientific and graphing calculator'} src={source.href} sandbox="allow-scripts allow-same-origin"/>
 </section>;
}

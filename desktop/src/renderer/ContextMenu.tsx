import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import './context-menu.css';

export type ContextMenuItem={id:string;label:string;shortcut?:string;disabled?:boolean;danger?:boolean;separatorBefore?:boolean;action:()=>void|Promise<void>};
export type ContextMenuState={x:number;y:number;title?:string;items:ContextMenuItem[]};
export default function ContextMenu({menu,onClose}:{menu:ContextMenuState|null;onClose:()=>void}){
 const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
 const [position,setPosition]=useState({left:0,top:0});
 useLayoutEffect(()=>{
  if(!menu||!ref.current)return;
  const box=ref.current.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(menu.x,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(menu.y,window.innerHeight-box.height-8))});
 },[menu]);
 useEffect(()=>{
  if(!menu)return;
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const frame=requestAnimationFrame(()=>ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
  const dismiss=()=>close.current();
  const outside=(event:Event)=>{if(!ref.current?.contains(event.target as Node))dismiss();};
  const key=(event:KeyboardEvent)=>{
   if(!ref.current)return;
   const buttons=[...ref.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);
   if(['ArrowDown','ArrowUp','Home','End','Escape','Tab'].includes(event.key)){
    event.preventDefault();event.stopImmediatePropagation();
    if(event.key==='Escape'||event.key==='Tab'){dismiss();return;}
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(index+1)%buttons.length:(index-1+buttons.length)%buttons.length;buttons[next]?.focus();
   }
  };
  document.addEventListener('pointerdown',outside,true);document.addEventListener('scroll',outside,true);window.addEventListener('resize',dismiss);window.addEventListener('blur',dismiss);window.addEventListener('keydown',key,true);
  return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',outside,true);window.removeEventListener('resize',dismiss);window.removeEventListener('blur',dismiss);window.removeEventListener('keydown',key,true);if(previous?.isConnected&&(document.activeElement===document.body||ref.current?.contains(document.activeElement)))previous.focus({preventScroll:true});};
 },[!!menu,menu?.x,menu?.y,menu?.title]);
 if(!menu)return null;
 const invoke=(item:ContextMenuItem)=>{
  if(item.disabled)return;onClose();
  try{void Promise.resolve(item.action()).catch(error=>window.dispatchEvent(new CustomEvent('inkspace-context-menu-error',{detail:error instanceof Error?error.message:String(error)})));}
  catch(error){window.dispatchEvent(new CustomEvent('inkspace-context-menu-error',{detail:error instanceof Error?error.message:String(error)}));}
 };
 return createPortal(<div ref={ref} role="menu" aria-label={menu.title||'Context menu'} className="context-menu" style={position} data-testid="context-menu" onPointerDown={e=>e.stopPropagation()} onPointerUp={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>{e.preventDefault();e.stopPropagation();}} onKeyDown={e=>e.stopPropagation()}>
  {menu.title&&<div className="context-menu-title" title={menu.title}>{menu.title}</div>}
  {menu.items.map(item=><div key={item.id} role="none">{item.separatorBefore&&<div role="separator" className="context-menu-separator"/>}<button role="menuitem" tabIndex={-1} disabled={item.disabled} className={item.danger?'context-menu-danger':''} data-context-action={item.id} onClick={()=>invoke(item)}><span>{item.label}</span>{item.shortcut&&<kbd>{item.shortcut}</kbd>}</button></div>)}
 </div>,document.body);
}

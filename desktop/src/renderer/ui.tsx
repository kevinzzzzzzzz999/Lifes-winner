import {useContext,type ButtonHTMLAttributes,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {ReadingOverlayBase} from './reading-overlay-context';
import { X } from 'lucide-react';
export function Button({children, className = '', ...props}: ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={`button ${className}`} {...props}>{children}</button>; }
export function Modal({title,children,onClose,closeOnBackdrop=true}: {title:string;children:ReactNode;onClose:()=>void;closeOnBackdrop?:boolean}) { const overlay=useContext(ReadingOverlayBase);const content=<div style={overlay?{zIndex:overlay+10}:undefined} className="modal-shade" onClick={closeOnBackdrop?onClose:undefined} onKeyDown={event=>{if(!closeOnBackdrop&&event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();onClose();}}}><section className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><header><h2>{title}</h2><Button aria-label="Close" onClick={onClose}><X/></Button></header>{children}</section></div>;return overlay?createPortal(content,document.body):content; }
export const basename = (path: string) => path.split('/').at(-1) || path;
export const extname = (path: string) => path.split('.').at(-1)?.toLowerCase() || '';

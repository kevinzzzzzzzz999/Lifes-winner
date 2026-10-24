import {useEffect,useRef,useState} from 'react';
import {Button,Modal,basename} from './ui';
import type {Language} from './i18n';
export default function RenameFileDialog({path,isFolder=false,language,onClose,onRename}:{path:string;isFolder?:boolean;language:Language;onClose:()=>void;onRename:(name:string)=>Promise<void>}){
 const zh=language==='zh',old=basename(path),suffix=isFolder?'':old.toLowerCase().endsWith('.inkspace.json')?old.slice(-14):old.toLowerCase().endsWith('.notes.md')?old.slice(-9):old.match(/\.[^.]+$/)?.[0]||'';
 const [name,setName]=useState(suffix?old.slice(0,-suffix.length):old),[busy,setBusy]=useState(false),[error,setError]=useState('');const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{input.current?.focus();input.current?.select();},[]);
 const full=name+suffix;
 return <Modal title={zh?'重命名':'Rename'} onClose={()=>{if(!busy)onClose();}}><form onSubmit={event=>{event.preventDefault();if(busy||!name.trim()||full===old)return;setBusy(true);setError('');void onRename(full).then(onClose).catch(error=>setError(error instanceof Error?error.message:String(error))).finally(()=>setBusy(false));}}>
  <p className="muted">{path}</p><label>{zh?'新名称':'New name'}<div className="rename-name-row"><input ref={input} aria-label={zh?'新名称':'New name'} value={name} disabled={busy} maxLength={200} onChange={e=>setName(e.target.value)}/>{suffix&&<span>{suffix}</span>}</div></label>
  <p className="muted">{zh?'白板关联会跟随新名称更新。':'Board references will follow the new name.'}</p>{error&&<p className="form-error" role="alert">{error}</p>}
  <div className="modal-actions"><Button type="button" disabled={busy} onClick={onClose}>{zh?'取消':'Cancel'}</Button><Button className="primary" type="submit" disabled={busy||!name.trim()||full===old}>{busy?(zh?'正在保存…':'Saving…'):(zh?'重命名':'Rename')}</Button></div>
 </form></Modal>;
}

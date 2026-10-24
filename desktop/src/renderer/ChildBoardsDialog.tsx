import {useRef,useState} from 'react';
import {Plus,FolderOpen,Trash2} from 'lucide-react';
import {Modal,Button} from './ui';
import type {Language} from './i18n';
import type {BoardChildLink} from '../shared/desktop-api';
import {BoardChooser} from './BoardEmbed';

export default function ChildBoardsDialog({vaultId,parentPath,title,links,language,onCreate,onLink,onRemove,onOpen,onClose}:{
 vaultId:string;parentPath:string;title:string;links:BoardChildLink[];language:Language;
 onCreate:(name:string,folder:string)=>Promise<void>;onLink:(path:string)=>Promise<void>;
 onRemove:(id:string)=>Promise<void>;onOpen:(path:string)=>void;onClose:()=>void;
}){
 const zh=language==='zh';
 const[choosing,setChoosing]=useState<'board'|'folder'|null>(null);
 const[folder,setFolder]=useState(parentPath),[name,setName]=useState('');
 const[busy,setBusy]=useState(false),[error,setError]=useState('');
 const working=useRef(false);
 const run=async(fn:()=>Promise<void>)=>{
  if(working.current)return;
  working.current=true;setBusy(true);setError('');
  try{await fn();setName('');}catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{working.current=false;setBusy(false);}
 };
 if(choosing)return <BoardChooser vaultId={vaultId} language={language} kind={choosing} initialPath={folder}
  onClose={()=>setChoosing(null)} onChoose={async path=>{
   if(choosing==='folder')setFolder(path);else await onLink(path);
   setChoosing(null);
  }}/>;
 return <Modal title={zh?'子白板':'Child boards'} onClose={()=>{if(!working.current)onClose();}}>
  <p>{title}</p>
  <p className="muted">{zh?'子白板可保存在不同课程文件夹。主白板里的展开区域与子白板原文件联动，收起或移除关联会保留文件。':'Save child boards in different course folders. Expanded areas edit the same child file; collapsing or unlinking keeps that file.'}</p>
  <div className="file-manager-folders">{links.map(link=><div key={link.id}>
   <div className="tree-management"><Button disabled={busy} onClick={()=>onOpen(link.path)}><FolderOpen/>{link.title}</Button>
   <Button disabled={busy} aria-label={(zh?'移除关联 ':'Remove link ')+link.title} onClick={()=>void run(()=>onRemove(link.id))}><Trash2/></Button></div>
   <p className="muted" style={{overflowWrap:'anywhere'}}>{link.path}</p>
  </div>)}</div>
  <form onSubmit={e=>{e.preventDefault();void run(()=>onCreate(name.trim()||(zh?`子白板 ${links.length+1}`:`Child board ${links.length+1}`),folder));}}>
   <label className="form-label">{zh?'新子白板名称':'New child board name'}<input autoFocus value={name} maxLength={160} disabled={busy} onChange={e=>setName(e.target.value)} placeholder={zh?`子白板 ${links.length+1}`:`Child board ${links.length+1}`}/></label>
   <div className="form-label">{zh?'保存文件夹':'Save folder'}<div className="board-chooser-location"><span style={{overflowWrap:'anywhere'}}>{folder||'/'}</span><Button disabled={busy} type="button" onClick={()=>setChoosing('folder')}><FolderOpen/>{zh?'选择文件夹':'Choose folder'}</Button></div></div>
   <div className="modal-actions"><Button disabled={busy||links.length>=100} type="button" onClick={()=>setChoosing('board')}>{zh?'关联已有白板':'Link existing board'}</Button><Button className="primary" disabled={busy||links.length>=100} type="submit"><Plus/>{zh?'新建子白板':'New child board'}</Button></div>
  </form>
  {busy&&<p role="status">{zh?'正在保存关联…':'Saving link…'}</p>}
  {error&&<p role="alert" className="form-error">{error}</p>}
 </Modal>;
}

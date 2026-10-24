import {useState} from 'react';
import {Modal,Button} from './ui';
import {createNotebook,serializeNotebook} from '../shared/notebook-format';
import type {Language} from './i18n';
export type NewDocumentKind='folder'|'board'|'md'|'py'|'tex'|'txt'|'docx'|'pdf'|'pptx'|'ipynb'|'csv'|'html';
export const newExtension=(kind:NewDocumentKind)=>kind==='folder'?'':kind==='board'?'.inkspace.json':'.'+kind;
export function documentName(name:string,kind:NewDocumentKind){
 if(kind==='folder')return name.trim();
 const base=name.trim().replace(/(?:\.inkspace\.json|\.(?:markdown|md|py|tex|txt|docx|pdf|pptx|ipynb|csv|html))$/i,'');
 return base+newExtension(kind);
}
export function textTemplate(kind:NewDocumentKind,zh:boolean){
 if(kind==='ipynb')return serializeNotebook(createNotebook());
 if(kind==='csv')return 'name,value\nExample,1\n';
 if(kind==='html')return '<!doctype html>\n<html><head><meta charset="UTF-8"><title>Notes</title></head><body><h1>'+ (zh?'笔记':'Notes')+'</h1><p>'+ (zh?'在这里编写内容。':'Write here.')+'</p></body></html>\n';
 if(kind==='py')return zh?'# 在这里编写 Python，然后点击“运行”\nprint("Hello, world!")\n':'# Write Python here, then click Run.\nprint("Hello, world!")\n';
 if(kind==='tex')return '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{xeCJK}\n\\IfFontExistsTF{PingFang SC}{\\setCJKmainfont{PingFang SC}}{\\setCJKmainfont{Microsoft YaHei}}\n\\begin{document}\n\\section{Notes}\n'+(zh?'在这里编写正文。':'Write your document here.')+'\n\\[\n  \\int_0^1 x^2\\,dx = \\frac{1}{3}\n\\]\n\\end{document}\n';
 return kind==='md'?'# '+(zh?'新笔记':'New note')+'\n\n':'';
}
export default function NewDocumentDialog({language,folder,onClose,onCreate,error,initialKind='md'}:{language:Language;folder:string;initialKind?:NewDocumentKind;onClose:()=>void;onCreate:(kind:NewDocumentKind,name:string)=>Promise<void>;error:string}){
 const zh=language==='zh';const[kind,setKind]=useState<NewDocumentKind>(initialKind);const[name,setName]=useState(documentName(initialKind==='board'?(zh?'新白板':'New board'):(zh?'新笔记':'Notes'),initialKind));const[busy,setBusy]=useState(false);
 const labels:Record<NewDocumentKind,string>={folder:zh?'文件夹':'Folder',board:zh?'白板／思维导图':'Board / mind map',md:'Markdown',py:'Python',tex:'LaTeX',txt:zh?'纯文字':'Plain text',docx:'Word (.docx)',pdf:'PDF',pptx:'PowerPoint (.pptx)',ipynb:'Jupyter Notebook (.ipynb)',csv:'CSV (.csv)',html:'HTML (.html)'};
 return <Modal title={zh?'新建文件或文件夹':'New file or folder'} onClose={()=>{if(!busy)onClose();}}><form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);void onCreate(kind,documentName(name,kind)).finally(()=>setBusy(false));}}>
 <label className="form-label">{zh?'类型':'Type'}<select data-testid="new-file-type" value={kind} disabled={busy} onChange={e=>{const selected=e.target.value as NewDocumentKind;setKind(selected);setName(selected==='folder'?(zh?'新文件夹':'New folder'):documentName(kind==='folder'?(zh?'新笔记':'Notes'):name,selected));}}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
 <label className="form-label">{kind==='folder'?(zh?'文件夹名称':'Folder name'):(zh?'文件名':'File name')}<input autoFocus value={name} onChange={e=>setName(e.target.value)} required disabled={busy} maxLength={180}/></label>
 <p className="new-file-hint">{zh?'保存到：':'Save in: '}{folder}</p><p className="muted small">{['docx','pdf','pptx'].includes(kind)?(zh?'新建可继续编辑的标准文件，支持标题、段落和列表。':'Create a standard document with editable headings, paragraphs and lists.'):(zh?'文件保存在所选文件夹，其他设备可打开同一份内容。':'Files are saved in the selected folder and can be opened on your other devices.')}</p>
 {error&&<p role="alert" className="form-error">{error}</p>}<div className="modal-actions"><Button type="button" disabled={busy} onClick={onClose}>{zh?'取消':'Cancel'}</Button><Button className="primary" type="submit" disabled={busy||!name.trim()}>{busy?(zh?'创建中…':'Creating…'):(zh?'创建':'Create')}</Button></div>
 </form></Modal>;
}

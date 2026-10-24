import {useEffect,useRef,useState} from 'react';
import {ArrowUp,ChevronRight,FolderOpen,RefreshCw,Search} from 'lucide-react';
import type {DirectoryListing,Vault,VaultEntry} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button,Modal} from './ui';
import {FileIcon} from './Sidebar';
import {matchesWorkspaceFile,type WorkspaceFileKind} from './workspace-file-kinds';
import './workspace-file-picker.css';
export default function WorkspaceFilePicker({vault,initialPath,kind,language,onOpen,onClose}:{vault:Vault;initialPath:string;kind:WorkspaceFileKind;language:Language;onOpen:(path:string)=>Promise<void>;onClose:()=>void}){
 const zh=language==='zh';const[path,setPath]=useState(initialPath),[query,setQuery]=useState(''),[listing,setListing]=useState<DirectoryListing|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[opening,setOpening]=useState<string|null>(null),[revision,setRevision]=useState(0),[visibleCount,setVisibleCount]=useState(250);
 const epoch=useRef(0);
 const labels:Record<WorkspaceFileKind,string>={ocr:zh?'图文识别 OCR':'Local OCR',py:'Python',ipynb:'Jupyter Notebook',md:'Markdown',tex:'LaTeX',pdf:zh?'扫描件 / PDF':'Scans / PDF',reviews:zh?'接续手机批注':'Continue phone reviews',originals:zh?'打开原文件':'Open original file'};
 const title=kind==='reviews'||kind==='originals'?labels[kind]:(zh?'打开 ':'Open ')+labels[kind];
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;return()=>{if(previous?.isConnected)previous.focus();};},[]);
 useEffect(()=>{
  const request=++epoch.current;setLoading(true);setError('');setListing(null);setVisibleCount(250);
  void window.desktop.listDirectory({vaultId:vault.id,path}).then(result=>{if(epoch.current!==request)return;if(!result.ok)throw Error(result.error.message);setListing(result.value);}).catch(error=>{if(epoch.current===request)setError(error instanceof Error?error.message:String(error));}).finally(()=>{if(epoch.current===request)setLoading(false);});
  return()=>{epoch.current++;};
 },[vault.id,path,revision]);
 const navigate=(next:string)=>{if(opening)return;setQuery('');setPath(next);};
 const choose=async(entry:VaultEntry)=>{
  if(entry.kind==='folder'){navigate(entry.path);return;}
  if(opening)return;setOpening(entry.path);setError('');
  try{await onOpen(entry.path);onClose();}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setOpening(null);}
 };
 const needle=query.trim().toLocaleLowerCase();
 const rows=(listing?.entries||[]).filter(entry=>matchesWorkspaceFile(entry,kind)&&(!needle||entry.name.toLocaleLowerCase().includes(needle))).sort((a,b)=>Number(b.kind==='folder')-Number(a.kind==='folder')||a.name.localeCompare(b.name,zh?'zh-CN':'en',{numeric:true}));
 const folders=path.split('/').filter(Boolean).map((_,i,a)=>a.slice(0,i+1).join('/'));
 return <Modal title={title} closeOnBackdrop={false} onClose={()=>{if(!opening)onClose();}}><div className="workspace-file-picker" data-testid="workspace-file-picker" data-kind={kind} aria-busy={loading||!!opening}>
  <p className="workspace-file-purpose">{kind==='ocr'?(zh?'选择 PDF 或图片，在本机识别文字，原文件保持不变。':'Choose a PDF or image for local text recognition. The original stays unchanged.'):kind==='reviews'?(zh?'选择留下批注的白板或原文件，打开后直接查看待修改批注。':'Choose the board or source file you reviewed to see its pending marks.'):kind==='pdf'?(zh?'进入手机扫描时选择的文件夹，打开已同步到本机的 PDF。':'Go to the folder chosen while scanning on your phone and open the PDF available on this Mac.'):kind==='originals'?(zh?'文本文件在这里编辑；Office 文件可选择在本应用阅读或交给原应用编辑。':'Edit text here. For Office files, choose to read here or edit in the original application.'):zh?'打开现有文件继续编辑；这里只列出当前文件夹中的对应类型。':'Continue an existing file. Only matching files in this folder are listed.'}</p>
  <div className="workspace-file-location"><Button disabled={!path||!!opening} aria-label={zh?'上一级':'Parent folder'} data-testid="workspace-file-up" onClick={()=>navigate(path.split('/').slice(0,-1).join('/'))}><ArrowUp/></Button><nav aria-label={zh?'文件夹位置':'Folder location'}><button disabled={!!opening} onClick={()=>navigate('')}>{vault.name}</button>{folders.map(folder=><span key={folder}><ChevronRight/><button disabled={!!opening} onClick={()=>navigate(folder)}>{folder.split('/').at(-1)}</button></span>)}</nav><Button disabled={loading||!!opening} aria-label={zh?'刷新文件夹':'Refresh folder'} onClick={()=>setRevision(n=>n+1)}><RefreshCw/></Button></div>
  <label className="workspace-file-search"><Search/><input autoFocus value={query} onChange={e=>{setQuery(e.target.value);setVisibleCount(250);}} placeholder={zh?'搜索当前文件夹中的文件名':'Search names in this folder'} aria-label={zh?'搜索当前文件夹中的文件名':'Search names in this folder'} data-testid="workspace-file-search"/></label>
  <div className="workspace-file-list">{loading?<p role="status">{zh?'正在读取当前文件夹…':'Loading this folder…'}</p>:<>{rows.slice(0,visibleCount).map(entry=><button key={entry.path} disabled={!!opening} onClick={()=>void choose(entry)} data-workspace-file={entry.path}><FileIcon kind={entry.kind} path={entry.path}/><span><strong>{entry.name}</strong><small>{entry.kind==='folder'?(zh?'进入文件夹':'Open folder'):entry.path}</small></span>{entry.kind==='folder'?<ChevronRight/>:opening===entry.path?<span>{zh?'打开中…':'Opening…'}</span>:null}</button>)}{!rows.length&&!error&&<div className="workspace-file-empty"><FolderOpen/><p>{needle?(zh?'当前文件夹没有匹配项。':'No matching files in this folder.'):(zh?'当前文件夹没有这种文件。可返回上一级，或进入其他文件夹。':'No matching files here. Go up or choose another folder.')}</p></div>}{rows.length>visibleCount&&<Button onClick={()=>setVisibleCount(n=>n+250)}>{zh?'显示更多':'Show more'}</Button>}</>}</div>
  {error&&<p className="form-error" role="alert">{error}</p>}{listing?.warnings.map((warning,i)=><p className="muted small" key={i}>{warning}</p>)}
  <footer><span>{zh?'同一资料文件夹 · 文件到达本机后可用':'Same shared folder · Files must arrive on this Mac'}</span><Button disabled={!!opening} onClick={onClose}>{zh?'关闭':'Close'}</Button></footer>
 </div></Modal>;
}

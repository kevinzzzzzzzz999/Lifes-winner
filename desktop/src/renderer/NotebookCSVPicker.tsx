import {useEffect,useRef,useState} from 'react';
import {Folder,FileSpreadsheet,ArrowUp,Search,Trash2} from 'lucide-react';
import {Modal,Button} from './ui';
import type {DirectoryListing} from '../shared/desktop-api';
import type {Language} from './i18n';
import {notebookDataReadCodes,notebookDataFileKind,notebookDataIdentity,csvVariableName,excelVariableName,validCSVVariable,type NotebookDataSelection,type NotebookExcelSelection} from './notebook-actions';
const noNames:string[]=[];
type WorkbookInfo={path:string;loading:boolean;error:string;sheets:Array<{name:string;hidden:boolean}>};
export default function NotebookCSVPicker({vaultId,notebookPath,language,reservedNames=noNames,legacyAlias=false,onInsert,onClose}:{vaultId:string;notebookPath:string;language:Language;reservedNames?:string[];legacyAlias?:boolean;onInsert:(codes:string[])=>void;onClose:()=>void}){
 const zh=language==='zh',initial=notebookPath.split('/').slice(0,-1).join('/'),closed=useRef(false);
 const [path,setPath]=useState(initial),[listing,setListing]=useState<DirectoryListing|null>(null),[error,setError]=useState(''),[search,setSearch]=useState(''),[selected,setSelected]=useState<NotebookDataSelection[]>([]),[loading,setLoading]=useState(false),[submitError,setSubmitError]=useState(''),[directoryRetry,setDirectoryRetry]=useState(0);
 const [workbook,setWorkbook]=useState<string|null>(null),[workbookInfo,setWorkbookInfo]=useState<WorkbookInfo|null>(null),[workbookRetry,setWorkbookRetry]=useState(0);
 useEffect(()=>{closed.current=false;return()=>{closed.current=true;};},[]);
 useEffect(()=>{
  let current=true;setLoading(true);setError('');setListing(null);setSearch('');
  void window.desktop.listDirectory({vaultId,path}).then(r=>{if(current&&!closed.current){if(r.ok)setListing(r.value);else setError(r.error.message);}}).catch(e=>{if(current&&!closed.current)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(current&&!closed.current)setLoading(false);});
  return()=>{current=false;};
 },[vaultId,path,directoryRetry]);
 useEffect(()=>{
  if(!workbook)return;let current=true;const requestedPath=workbook;
  setWorkbookInfo({path:requestedPath,loading:true,error:'',sheets:[]});
  void window.desktop.notebookDataInfo({vaultId,path:requestedPath}).then(r=>{
   if(!current||closed.current)return;
   if(r.ok)setWorkbookInfo({path:requestedPath,loading:false,error:'',sheets:r.value.sheets});
   else setWorkbookInfo({path:requestedPath,loading:false,error:r.error.message,sheets:[]});
  }).catch(e=>{if(current&&!closed.current)setWorkbookInfo({path:requestedPath,loading:false,error:e instanceof Error?e.message:String(e),sheets:[]});});
  // IPC has no abort handle. Retire this request so a late workbook/folder reply
  // can never replace the current selection or update a closed picker.
  return()=>{current=false;};
 },[vaultId,workbook,workbookRetry]);
 const close=()=>{closed.current=true;onClose();};
 const go=(next:string)=>{setWorkbook(null);setPath(next);};
 const update=(identity:string,patch:Partial<NotebookDataSelection>)=>{setSubmitError('');setSelected(old=>old.map(item=>notebookDataIdentity(item)===identity?{...item,...patch} as NotebookDataSelection:item));};
 const remove=(identity:string)=>{setSubmitError('');setSelected(old=>old.filter(item=>notebookDataIdentity(item)!==identity));};
 const toggleCSV=(itemPath:string)=>{
  setSubmitError('');setSelected(old=>old.some(item=>item.kind!=='excel'&&item.path===itemPath)?old.filter(item=>!(item.kind!=='excel'&&item.path===itemPath)):[...old,{path:itemPath,variable:csvVariableName(itemPath,[...reservedNames,...old.map(item=>item.variable)]),separator:/\.tsv$/i.test(itemPath)?'\t':',',encoding:'utf-8-sig',header:true}]);
 };
 const toggleSheet=(itemPath:string,sheet:string)=>{
  setSubmitError('');setSelected(old=>old.some(item=>item.kind==='excel'&&item.path===itemPath&&item.sheet===sheet)?old.filter(item=>!(item.kind==='excel'&&item.path===itemPath&&item.sheet===sheet)):[...old,{kind:'excel',path:itemPath,sheet,header:true,variable:excelVariableName(itemPath,sheet,[...reservedNames,...old.map(item=>item.variable)])}]);
 };
 const names=new Set(reservedNames),identities=new Set<string>();let selectionError='';
 for(const item of selected){const identity=notebookDataIdentity(item);if(!validCSVVariable(item.variable))selectionError=zh?'请输入有效的 Python 变量名，不能是关键字或 pd。':'Use a valid Python identifier, excluding keywords and pd.';else if(names.has(item.variable))selectionError=zh?'变量名重复或已使用，请指定独立名称。':'A name is duplicated or already used. Choose independent names.';else if(identities.has(identity))selectionError=zh?'同一文件或工作表不能重复选择。':'The same file or worksheet cannot be selected twice.';names.add(item.variable);identities.add(identity);}
 const sheets=workbookInfo?.path===workbook?workbookInfo:null;
 return <Modal title={zh?'导入 Excel／CSV 数据':'Import Excel / CSV data'} onClose={close}><div className="notebook-csv-picker" data-testid="notebook-csv-picker">
 <p>{zh?'可跨文件夹多选 CSV、TSV、XLSX、XLSM 和 XLS。同一工作簿可选择多张工作表，每张表使用独立变量。运行时读取完整数据，head() 只预览前几行；不转换或改写原文件。':'Select CSV, TSV, XLSX, XLSM and XLS across folders. Select multiple worksheets from one workbook, each with its own variable. Running reads the full data; head() only previews a few rows. Original files are not converted or changed.'}</p>
 <div className="notebook-csv-location"><Button disabled={!path||loading} aria-label={zh?'上层文件夹':'Parent folder'} onClick={()=>go(path.split('/').slice(0,-1).join('/'))}><ArrowUp/></Button><Button disabled={!path||loading} onClick={()=>go('')}>{zh?'根目录':'Root'}</Button><span>{path||'/'}</span></div>
 <label className="notebook-csv-search"><Search/><input aria-label={zh?'搜索 Excel／CSV':'Search Excel / CSV'} placeholder={zh?'搜索当前文件夹':'Search this folder'} value={search} onChange={e=>setSearch(e.target.value)}/></label>
 {loading&&<p role="status">{zh?'正在读取文件夹…':'Reading folder…'}</p>}{error&&<div><p className="form-error" role="alert">{error}</p><Button onClick={()=>setDirectoryRetry(n=>n+1)}>{zh?'重试文件夹':'Retry folder'}</Button></div>}
 <div className="notebook-csv-files">{listing?.entries.filter(e=>(e.kind==='folder'||notebookDataFileKind(e.path)!==null)&&e.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(e=>e.kind==='folder'?<button key={e.path} type="button" data-csv-path={e.path} onClick={()=>go(e.path)}><Folder/><span>{e.name}</span><span>›</span></button>:notebookDataFileKind(e.path)==='excel'?<button key={e.path} type="button" data-csv-path={e.path} data-testid="notebook-workbook-open" aria-pressed={workbook===e.path} onClick={()=>setWorkbook(e.path)}><FileSpreadsheet/><span>{e.name}</span><span>{selected.filter(item=>item.kind==='excel'&&item.path===e.path).length||''} ›</span></button>:<label key={e.path} data-csv-path={e.path} className={'notebook-csv-file '+(selected.some(item=>item.kind!=='excel'&&item.path===e.path)?'selected':'')}><input type="checkbox" checked={selected.some(item=>item.kind!=='excel'&&item.path===e.path)} onChange={()=>toggleCSV(e.path)}/><FileSpreadsheet/><span>{e.name}</span></label>)}</div>
 {!loading&&listing&&!listing.entries.some(e=>e.kind==='folder'||notebookDataFileKind(e.path)!==null)&&<p>{zh?'当前文件夹没有 Excel／CSV／TSV，可返回上层选择。':'No Excel/CSV/TSV files here. Browse the parent folder.'}</p>}
 {workbook&&<section className="notebook-csv-basket" data-testid="notebook-workbook-sheets" aria-label={zh?'选择 Excel 工作表':'Choose Excel worksheets'}><div className="notebook-csv-item-path"><FileSpreadsheet/><strong>{workbook}</strong><Button onClick={()=>setWorkbook(null)}>{zh?'收起工作表':'Hide worksheets'}</Button></div>
  {(!sheets||sheets.loading)&&<p role="status">{zh?'正在读取工作表名称…':'Reading worksheet names…'}</p>}
  {sheets?.error&&<><p className="form-error" role="alert">{sheets.error}</p><Button data-testid="notebook-workbook-retry" onClick={()=>setWorkbookRetry(n=>n+1)}>{zh?'重试工作表':'Retry worksheets'}</Button></>}
  {sheets&&!sheets.loading&&!sheets.error&&sheets.sheets.length===0&&<p>{zh?'这个工作簿没有可读取的工作表。':'This workbook has no readable worksheets.'}</p>}
  {sheets&&!sheets.loading&&!sheets.error&&sheets.sheets.map(sheet=><label key={sheet.name} className={'notebook-csv-file '+(selected.some(item=>item.kind==='excel'&&item.path===workbook&&item.sheet===sheet.name)?'selected':'')} data-workbook-sheet-name={sheet.name}><input type="checkbox" checked={selected.some(item=>item.kind==='excel'&&item.path===workbook&&item.sheet===sheet.name)} onChange={()=>toggleSheet(workbook,sheet.name)}/><span>{sheet.name}{sheet.hidden?(zh?'（隐藏工作表）':' (hidden worksheet)'):''}</span></label>)}
 </section>}
 <div className="notebook-csv-basket" data-testid="notebook-csv-selected"><strong>{zh?'已选数据表':'Selected tables'} ({selected.length})</strong>{selected.map(item=>{const identity=notebookDataIdentity(item),excel=item.kind==='excel'?item as NotebookExcelSelection:null,labelSuffix=item.path+(excel?' '+excel.sheet:'');return <div className="notebook-csv-item" key={identity} data-selected-csv-path={item.path} data-selected-sheet={excel?.sheet}>
  <div className="notebook-csv-item-path"><FileSpreadsheet/><span>{item.path}{excel?' — '+excel.sheet:''}</span><Button aria-label={(zh?'移除 ':'Remove ')+labelSuffix} onClick={()=>remove(identity)}><Trash2/></Button></div>
  <div className="notebook-csv-options"><label>{zh?'变量名':'Variable'}<input aria-label={(excel?'Excel variable ':'CSV variable ')+labelSuffix} value={item.variable} spellCheck={false} onChange={e=>update(identity,{variable:e.target.value})}/></label>
   {item.kind!=='excel'&&<><label>{zh?'分隔符':'Delimiter'}<select aria-label={'CSV delimiter '+item.path} value={item.separator} onChange={e=>update(identity,{separator:e.target.value})}><option value=",">{zh?'逗号':'Comma'}</option><option value={'\t'}>Tab</option><option value=";">{zh?'分号':'Semicolon'}</option><option value="|">|</option><option value="auto">{zh?'自动识别':'Detect automatically'}</option></select></label><label>{zh?'编码':'Encoding'}<select aria-label={'CSV encoding '+item.path} value={item.encoding} onChange={e=>update(identity,{encoding:e.target.value})}><option value="utf-8-sig">UTF-8 / BOM</option><option value="gb18030">GB18030 / GBK</option><option value="utf-16">UTF-16</option><option value="latin1">Latin-1</option></select></label></>}
   <label>{zh?'表头':'Header'}<select aria-label={(excel?'Excel header ':'CSV header ')+labelSuffix} value={item.header===false?'none':'first'} onChange={e=>update(identity,{header:e.target.value==='first'})}><option value="first">{zh?'第一行为表头':'First row is header'}</option><option value="none">{zh?'无表头':'No header'}</option></select></label>
  </div>
 </div>;})}</div>
 {(selectionError||submitError)&&<p className="form-error" role="alert">{selectionError||submitError}</p>}
 <div className="modal-actions"><Button onClick={close}>{zh?'取消':'Cancel'}</Button><Button data-testid="notebook-insert-csv" className="primary" disabled={!selected.length||!!selectionError} onClick={()=>{try{onInsert(notebookDataReadCodes(notebookPath,selected,reservedNames,legacyAlias));}catch(error){setSubmitError(error instanceof Error?error.message:String(error));}}}>{zh?'插入读取代码':'Insert reading code'}{selected.length>0?' ('+selected.length+')':''}</Button></div>
 </div></Modal>;
}

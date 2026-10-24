import {useId,useState} from 'react';
import {Modal,Button} from './ui';
import type {Language} from './i18n';
import {csvExportCode,validCSVVariable} from './notebook-actions';
import './notebook-csv-export.css';

export default function NotebookCSVExport({language,variables,preferredVariable,onInsert,onClose}:{language:Language;variables:string[];preferredVariable?:string;onInsert:(source:string)=>void;onClose:()=>void}){
 const zh=language==='zh',listID=useId();
 const [variable,setVariable]=useState(preferredVariable||(variables.length===1?variables[0]:'')),[name,setName]=useState('results.csv');
 const valid=validCSVVariable(variable)&&!!name.trim()&&!name.includes('\0');
 return <Modal title={zh?'导出 CSV 代码':'CSV export code'} onClose={onClose}>
  <div className="notebook-csv-export">
   <p>{zh?'选择要导出的 DataFrame 变量，再插入并运行代码。多个 CSV 各自独立，不会自动覆盖旧文件。':'Choose the DataFrame variable, then insert and run the code. Existing files are preserved.'}</p>
   <label>{zh?'DataFrame 变量':'DataFrame variable'}<input aria-label={zh?'要导出的 DataFrame 变量':'DataFrame variable to export'} list={listID} value={variable} onChange={e=>setVariable(e.target.value.trim())} spellCheck={false} autoFocus/></label>
   <datalist id={listID}>{variables.map(value=><option value={value} key={value}/>)}</datalist>
   {variables.length>1&&<div className="notebook-csv-export-variables" aria-label={zh?'已导入的 CSV 变量':'Imported CSV variables'}>{variables.map(value=><Button key={value} aria-pressed={variable===value} onClick={()=>setVariable(value)}>{value}</Button>)}</div>}
   <label>{zh?'文件名或相对路径':'Filename or relative path'}<input aria-label={zh?'导出 CSV 文件名':'CSV export filename'} value={name} onChange={e=>setName(e.target.value)}/></label>
   <p>{zh?'也可填写你计算得到的其他 DataFrame 变量名。运行代码前可继续修改。':'You can also enter another DataFrame variable created by your calculations. The inserted code remains editable.'}</p>
   <div className="modal-actions"><Button onClick={onClose}>{zh?'取消':'Cancel'}</Button><Button className="primary" disabled={!valid} onClick={()=>onInsert(csvExportCode(name.trim(),variable))}>{zh?'插入导出代码':'Insert export code'}</Button></div>
  </div>
 </Modal>;
}

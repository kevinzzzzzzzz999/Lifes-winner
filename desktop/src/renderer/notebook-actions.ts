import {addNotebookCell,updateNotebookCell,notebookCellSource,type NotebookCell,type NotebookDocument} from '../shared/notebook-format';

/** Notebook commands are immutable so a multi-cell operation is one undo step. */
export function selectedCellIndices(length:number,active:number,anchor=active){
 const lo=Math.max(0,Math.min(active,anchor)),hi=Math.min(length-1,Math.max(active,anchor));
 return Array.from({length:Math.max(0,hi-lo+1)},(_,i)=>lo+i);
}
export function pasteNotebookCells(doc:NotebookDocument,cells:NotebookCell[],index:number):NotebookDocument{
 const pasted=structuredClone(cells).map(cell=>({...cell,id:crypto.randomUUID()}));
 return {...doc,cells:[...doc.cells.slice(0,index),...pasted,...doc.cells.slice(index)]};
}
export function splitNotebookCell(doc:NotebookDocument,index:number,offset:number):NotebookDocument{
 const cell=doc.cells[index],source=notebookCellSource(cell);if(!['code','markdown','raw'].includes(cell.cell_type))throw Error('Cannot split this cell type.');
 const position=Math.max(0,Math.min(offset,source.length));
 const left={...cell,source:source.slice(0,position)},right={...structuredClone(cell),id:crypto.randomUUID(),source:source.slice(position)};
 for(const c of [left,right])if(c.cell_type==='code'){c.outputs=[];c.execution_count=null;}
 return {...doc,cells:[...doc.cells.slice(0,index),left,right,...doc.cells.slice(index+1)]};
}
export function mergeNotebookCells(doc:NotebookDocument,indices:number[]):NotebookDocument{
 if(indices.length<2)return doc;
 const selected=indices.map(i=>doc.cells[i]);if(selected.some(c=>!['code','markdown','raw'].includes(c.cell_type)))throw Error('Unknown cell types cannot be merged.');
 const source=selected.map(notebookCellSource).join('\n\n');
 let next=updateNotebookCell(doc,indices[0],{source});const first={...next.cells[indices[0]]};
 const attachments:Record<string,unknown>={};for(const c of selected)for(const[name,data]of Object.entries((c.attachments||{})as Record<string,unknown>)){
  if(name in attachments&&JSON.stringify(attachments[name])!==JSON.stringify(data))throw Error('Rename conflicting attachment names before merging cells. / 请先重命名重复的附件。');attachments[name]=data;
 }
 if(Object.keys(attachments).length)first.attachments=attachments;
 first.metadata={...first.metadata,inkspaceMergedCellMetadata:selected.slice(1).map(c=>({id:c.id||null,cell_type:c.cell_type,metadata:c.metadata}))};
 const remove=new Set(indices.slice(1));return {...next,cells:next.cells.map((c,i)=>i===indices[0]?first:c).filter((_,i)=>!remove.has(i))};
}
export function insertNotebookCode(doc:NotebookDocument,after:number,source:string){return updateNotebookCell(addNotebookCell(doc,'code',after),after+1,{source});}
export function relativeNotebookDataPath(notebookPath:string,dataPath:string){
 const parent=notebookPath.split('/').slice(0,-1),target=dataPath.split('/');let shared=0;while(parent[shared]!==undefined&&parent[shared]===target[shared])shared++;
 return [...parent.slice(shared).map(()=>'..'),...target.slice(shared)].join('/');
}
export type NotebookCSVSelection={kind?:'csv';path:string;variable:string;separator:string;encoding:string;header?:boolean};
export type NotebookExcelSelection={kind:'excel';path:string;variable:string;sheet:string;header:boolean};
export type NotebookDataSelection=NotebookCSVSelection|NotebookExcelSelection;
export function notebookDataFileKind(path:string):'csv'|'excel'|null{
 return /\.(csv|tsv)$/i.test(path)?'csv':/\.(xlsx|xlsm|xls)$/i.test(path)?'excel':null;
}
/** Workbook identity includes its worksheet; CSV identity remains its original path. */
export function notebookDataIdentity(item:NotebookDataSelection){return JSON.stringify(item.kind==='excel'?['excel',item.path,item.sheet]:['csv',item.path]);}
const pythonKeywords=new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type'.split(' '));
export function validCSVVariable(value:string){return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)&&!pythonKeywords.has(value)&&value!=='pd';}
/** Conservatively reserve every code identifier, including function arguments. */
export function notebookIdentifiers(doc:NotebookDocument){return [...new Set(doc.cells.filter(cell=>cell.cell_type==='code').flatMap(cell=>notebookCellSource(cell).match(/[A-Za-z_][A-Za-z0-9_]*/g)||[]))];}
export function csvVariableName(dataPath:string,reserved:Iterable<string>=[]){
 const occupied=new Set(reserved);if(!occupied.has('df'))return 'df';
 const stem=dataPath.split('/').at(-1)!.replace(/\.(csv|tsv|xlsx|xlsm|xls)$/i,'').replace(/[^A-Za-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64)||'table';
 const base='df_'+stem;let name=base,index=2;while(occupied.has(name))name=base+'_'+index++;return name;
}
export function excelVariableName(dataPath:string,sheet:string,reserved:Iterable<string>=[]){
 const stem=dataPath.split('/').at(-1)!.replace(/\.(xlsx|xlsm|xls)$/i,'');
 // Include the worksheet even for the first selection, so a workbook's tables
 // remain distinguishable in the generated code and the CSV-export chooser.
 return csvVariableName(stem+'_'+sheet+'.csv',new Set(['df',...reserved]));
}
export function csvReadCode(notebookPath:string,dataPath:string,separator:string,encoding:string,variable='data',header=true){
 if(!validCSVVariable(variable))throw Error('Choose a valid, independent Python variable name. / 请输入有效的独立 Python 变量名。');
 if(![',','\t',';','|','auto'].includes(separator)||!['utf-8-sig','gb18030','utf-16','latin1'].includes(encoding))throw Error('Invalid CSV delimiter or encoding. / CSV 分隔符或编码无效。');
 const relative=relativeNotebookDataPath(notebookPath,dataPath);
 return `import pandas as pd\n\n${variable} = pd.read_csv(${JSON.stringify(relative)}, sep=${separator==='auto'?"None, engine=\"python\"":JSON.stringify(separator)}, encoding=${JSON.stringify(encoding)}${header===false?', header=None':''})\n${variable}.head()`;
}
export function excelReadCode(notebookPath:string,dataPath:string,sheet:string,header=true,variable='data'){
 if(!validCSVVariable(variable))throw Error('Choose a valid, independent Python variable name. / 请输入有效的独立 Python 变量名。');
 if(notebookDataFileKind(dataPath)!=='excel'||typeof sheet!=='string'||!sheet.length||sheet.includes('\0')||typeof header!=='boolean')throw Error('Choose a valid Excel workbook and worksheet. / 请选择有效的 Excel 文件和工作表。');
 const engine=/\.xls$/i.test(dataPath)?'xlrd':'openpyxl',relative=relativeNotebookDataPath(notebookPath,dataPath);
 return `import pandas as pd\n\n${variable} = pd.read_excel(${JSON.stringify(relative)}, sheet_name=${JSON.stringify(sheet)}, header=${header?'0':'None'}, engine=${JSON.stringify(engine)})\n${variable}.head()`;
}
export function notebookDataReadCodes(notebookPath:string,items:NotebookDataSelection[],reserved:Iterable<string>=[],legacyAlias=false){
 if(!items.length)throw Error('Choose at least one CSV file or Excel worksheet. / 请至少选择一个 CSV 文件或 Excel 工作表。');
 const occupied=new Set(reserved),paths=new Set<string>();
 return items.map((item,index)=>{
  const identity=notebookDataIdentity(item);
  if(paths.has(identity)||occupied.has(item.variable))throw Error('Data sources and variable names must be independent. / 数据来源和变量名不能重复或覆盖现有变量。');
  paths.add(identity);occupied.add(item.variable);
  let code=item.kind==='excel'?excelReadCode(notebookPath,item.path,item.sheet,item.header,item.variable):csvReadCode(notebookPath,item.path,item.separator,item.encoding,item.variable,item.header??true);
  if(item.kind!=='excel'&&legacyAlias&&index===0&&items.length===1&&item.variable==='df'&&!occupied.has('data'))code=code.replace('\ndf.head()','\n# Compatibility with existing CSV export code\ndata = df\ndf.head()');
  return code;
 });
}
/** Existing CSV integrations keep their signature and compatibility alias. */
export function csvReadCodes(notebookPath:string,items:NotebookCSVSelection[],reserved:Iterable<string>=[],legacyAlias=false){return notebookDataReadCodes(notebookPath,items,reserved,legacyAlias);}
export function notebookCSVVariables(doc:NotebookDocument){
 const names=new Set<string>();
 for(const cell of doc.cells)if(cell.cell_type==='code')for(const line of notebookCellSource(cell).split('\n')){
  const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*pd\.read_(?:csv|excel)\s*\(/);
  if(match&&validCSVVariable(match[1]))names.add(match[1]);
 }
 return [...names];
}
export function csvExportCode(name='results.csv',variable='data'){
 if(!validCSVVariable(variable))throw Error('Choose the DataFrame variable to export. / 请选择要导出的 DataFrame 变量。');
 // x mode deliberately preserves an existing result; user can edit the code to overwrite.
 return `from pathlib import Path\n\noutput_path = Path(${JSON.stringify(name)})\n${variable}.to_csv(output_path, index=False, encoding="utf-8-sig", mode="x")\nprint(output_path.resolve())`;
}

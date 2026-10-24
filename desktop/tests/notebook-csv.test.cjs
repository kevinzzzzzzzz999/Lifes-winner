'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{registerHooks}=require('node:module'),{execFileSync}=require('node:child_process');
const hooks=registerHooks({resolve(specifier,context,next){return next(specifier==='../shared/notebook-format'&&context.parentURL?.endsWith('/notebook-actions.ts')?specifier+'.ts':specifier,context);}});
const {relativeNotebookDataPath,csvReadCode,csvReadCodes,csvVariableName,validCSVVariable,notebookIdentifiers,insertNotebookCode,selectedCellIndices,csvExportCode,notebookCSVVariables,notebookDataFileKind,notebookDataIdentity,excelVariableName,excelReadCode,notebookDataReadCodes}=require('../src/renderer/notebook-actions.ts');hooks.deregister();
const doc=cells=>({nbformat:4,nbformat_minor:5,metadata:{course:'preserved'},cells:cells.map((source,index)=>({id:'cell-'+index,cell_type:'code',metadata:{index},source,execution_count:null,outputs:[]}))});
const item=(path,variable='df',separator=',',encoding='utf-8-sig')=>({path,variable,separator,encoding});

test('CSV paths remain relative to a nested Notebook across sibling and ancestor folders',()=>{
 for(const [notebook,data,expected]of [['course/week/lesson.ipynb','course/week/data.csv','data.csv'],['course/week/lesson.ipynb','course/other/data.csv','../other/data.csv'],['course/week/lesson.ipynb','shared/data.csv','../../shared/data.csv'],['lesson.ipynb','course/data.tsv','course/data.tsv']])assert.equal(relativeNotebookDataPath(notebook,data),expected);
});
test('selections sharing a basename get independent names across folders and later appends',()=>{
 const reserved=['df','data','df_prices','df_prices_2'];assert.equal(csvVariableName('B/prices.csv',reserved),'df_prices_3');
 assert.equal(csvVariableName('A/a-b.csv',['df']),'df_a_b');assert.equal(csvVariableName('A/统计.csv',['df']),'df_table');assert.equal(csvVariableName('A/2.csv',['df']),'df_2');
 const used=[];for(let i=0;i<60;i++){const name=csvVariableName('folder-'+i+'/prices.csv',used);assert(validCSVVariable(name));used.push(name);}assert.equal(new Set(used).size,60);
});
test('existing code identifiers are conservatively reserved without changing the Notebook',()=>{
 const value=doc(['data = 8\ndf = "existing"\ndef f(df_prices):\n    return df_prices','x = data']);const before=structuredClone(value),names=notebookIdentifiers(value);
 for(const name of ['df','data','df_prices','f','x'])assert(names.includes(name));assert.deepEqual(value,before);assert.equal(csvVariableName('prices.csv',names),'df_prices_2');
});
test('invalid names, duplicate paths and overwrite attempts reject the whole batch',()=>{
 for(const variable of ['class','for','pd','bad-name','4data','x;print(1)',''])assert.equal(validCSVVariable(variable),false);
 assert.throws(()=>csvReadCodes('a.ipynb',[item('a.csv','df'),item('b.csv','df')]));
 assert.throws(()=>csvReadCodes('a.ipynb',[item('a.csv','df'),item('a.csv','df_other')]));
 assert.throws(()=>csvReadCodes('a.ipynb',[item('a.csv','existing')],['existing']));
 assert.throws(()=>csvReadCode('a.ipynb','a.csv','not-a-delimiter','utf-8-sig'));
 assert.throws(()=>csvReadCode('a.ipynb','a.csv',',','not-an-encoding'));
});
test('legacy single-file code keeps data while new blank single-file import exposes df and safe data alias',()=>{
 assert.match(csvReadCode('a.ipynb','a.csv',',','utf-8-sig'),/\ndata = pd\.read_csv/);
 assert.match(csvReadCodes('a.ipynb',[item('a.csv')],[],true)[0],/\ndata = df\ndf\.head\(\)/);
 assert.doesNotMatch(csvReadCodes('a.ipynb',[item('a.csv')],['data'],true)[0],/\ndata = df/);
 assert.doesNotMatch(csvReadCodes('a.ipynb',[item('a.csv')],[],false)[0],/\ndata = df/);
 assert(csvReadCodes('a.ipynb',[item('a.csv'),item('b.csv','df_b')],[],true).every(code=>!code.includes('\ndata = df')));
});
test('real Python parses and executes generated reads with independent options and safely escaped paths',()=>{
 const items=[item('datasets/a"quote.csv','df',',','utf-8-sig'),item('elsewhere/统计.tsv','df_stats','\t','gb18030'),item('course/week/auto.csv','df_auto','auto','latin1')];
 const codes=csvReadCodes('course/week/lesson.ipynb',items,['data']);
 const program=`import ast,json,sys,types\npayload=json.loads(sys.stdin.read())\ncalls=[]\nclass Frame:\n def __init__(self,path): self.path=path\n def head(self): return self\ndef read_csv(path,**kwargs):\n calls.append({'path':path,**kwargs}); return Frame(path)\nsys.modules['pandas']=types.SimpleNamespace(read_csv=read_csv)\nscope={'data':'KEEP'}\nfor code in payload['codes']:\n ast.parse(code); exec(code,scope)\nassert scope['data']=='KEEP'\nassert len({id(scope[name]) for name in payload['names']})==len(payload['names'])\nprint(json.dumps(calls,ensure_ascii=False))`;
 const calls=JSON.parse(execFileSync('/usr/bin/python3',['-c',program],{input:JSON.stringify({codes,names:items.map(item=>item.variable)}),encoding:'utf8'}));
 assert.deepEqual(calls,[{path:'../../datasets/a"quote.csv',sep:',',encoding:'utf-8-sig'},{path:'../../elsewhere/统计.tsv',sep:'\t',encoding:'gb18030'},{path:'auto.csv',sep:null,engine:'python',encoding:'latin1'}]);
});
test('a batch can append separate cells without altering existing source, outputs or metadata',()=>{
 const value=doc(['sentinel = 42']);value.cells[0].outputs=[{output_type:'stream',name:'stdout',text:'keep\n'}];const before=structuredClone(value);
 const codes=csvReadCodes('nested/a.ipynb',[item('one.csv','df_one'),item('two.tsv','df_two','\t','utf-16')]);
 let next=value;for(const [offset,code]of codes.entries())next=insertNotebookCode(next,offset,code);
 assert.equal(next.cells.length,3);assert.deepEqual(next.cells[0],before.cells[0]);assert.deepEqual(value,before);assert.deepEqual(next.metadata,before.metadata);assert.equal(new Set(next.cells.map(cell=>cell.id)).size,3);
 assert.equal(selectedCellIndices(next.cells.length,2)[0],2);
});
test('reopening the picker for repeated additions reserves both earlier df and its data compatibility alias',()=>{
 let value=doc(['']);const first=csvReadCodes('course/a.ipynb',[item('course/prices.csv')],[],true)[0];
 value=insertNotebookCode(value,0,first);const names=notebookIdentifiers(value),secondName=csvVariableName('another/prices.csv',names);
 assert.equal(secondName,'df_prices');const second=csvReadCodes('course/a.ipynb',[item('another/prices.csv',secondName)],names,true)[0];
 assert.doesNotMatch(second,/\n(?:df|data) =/);assert.match(second,/\ndf_prices = pd\.read_csv\("\.\.\/another\/prices\.csv"/);
 value=insertNotebookCode(value,1,second);assert.equal(csvVariableName('third/prices.csv',notebookIdentifiers(value)),'df_prices_2');
});
test('multi-file CSV export explicitly targets the selected DataFrame and preserves existing output files',()=>{
 const value=doc(csvReadCodes('a.ipynb',[item('first.csv','df'),item('second.csv','df_second')]));
 assert.deepEqual(notebookCSVVariables(value),['df','df_second']);
 const code=csvExportCode('second-results.csv','df_second');assert.match(code,/\ndf_second\.to_csv/);assert.doesNotMatch(code,/\ndata\.to_csv/);assert.match(code,/mode="x"/);
 for(const variable of ['','class','df;evil()'])assert.throws(()=>csvExportCode('results.csv',variable));
 const program=`import ast,json,sys\ncode=json.loads(sys.stdin.read())\nast.parse(code)\ncalls=[]\nclass Frame:\n def to_csv(self,path,**kwargs): calls.append((str(path),kwargs))\nexec(code,{'df_second':Frame(),'data':None})\nassert calls==[('second-results.csv',{'index':False,'encoding':'utf-8-sig','mode':'x'})]\n`;
 execFileSync('/usr/bin/python3',['-c',program],{input:JSON.stringify(code),encoding:'utf8'});
});

const excel=(path,sheet,variable,header=true)=>({kind:'excel',path,sheet,variable,header});
test('Excel types and independent worksheet identities do not replace the CSV path contract',()=>{
 for(const path of ['a.xlsx','A.XLSM','folder/legacy.xls'])assert.equal(notebookDataFileKind(path),'excel');
 for(const path of ['a.csv','a.TSV'])assert.equal(notebookDataFileKind(path),'csv');
 for(const path of ['a.pdf','a.xlsx.exe','a.xlsb'])assert.equal(notebookDataFileKind(path),null);
 const one=excel('a.xlsx','A','df_a'),two=excel('a.xlsx','B','df_b');
 assert.notEqual(notebookDataIdentity(one),notebookDataIdentity(two));
 assert.equal(notebookDataIdentity(item('a.csv')),notebookDataIdentity({...item('a.csv'),header:false}));
 assert.notEqual(notebookDataIdentity(excel('a|b.xlsx','C','x')),notebookDataIdentity(excel('a.xlsx','b|C','x')));
});
test('Excel default names describe workbook and sheet, are valid, and avoid previous variables',()=>{
 assert.equal(excelVariableName('datasets/Budget.xlsx','Revenue'),'df_Budget_Revenue');
 assert.equal(excelVariableName('datasets/Budget.xlsx','Costs'),'df_Budget_Costs');
 assert.equal(excelVariableName('datasets/Budget.xlsx','Revenue',['df_Budget_Revenue']),'df_Budget_Revenue_2');
 for(const sheet of ['2026 Q1','中文表','A-B','class','quote"sheet'])assert(validCSVVariable(excelVariableName('folder/数据.xlsm',sheet)));
});
test('Excel read code selects exact worksheet/header/engine and limits only the displayed head',()=>{
 const cases=[excel('a.xlsx','Revenue','df_a'),excel('a.xlsm','Costs','df_b',false),excel('legacy.xls','2019','df_old')];
 const codes=notebookDataReadCodes('course/lesson.ipynb',cases);
 assert.match(codes[0],/sheet_name="Revenue", header=0, engine="openpyxl"/);
 assert.match(codes[1],/sheet_name="Costs", header=None, engine="openpyxl"/);
 assert.match(codes[2],/sheet_name="2019", header=0, engine="xlrd"/);
 for(const [index,code]of codes.entries()){
  assert.equal(code.endsWith(cases[index].variable+'.head()'),true);
  assert.doesNotMatch(code,/nrows|usecols|read_csv|to_csv|to_excel/);
 }
});
test('mixed CSV and multiple Excel sheets use independent variables and preserve legacy aliases only for CSV',()=>{
 const selections=[item('a.csv','df_csv'),excel('b.xlsx','Revenue','df_revenue'),excel('b.xlsx','Costs','df_costs',false)];
 const original=structuredClone(selections),codes=notebookDataReadCodes('nested/a.ipynb',selections,['sentinel'],true);
 assert.equal(codes.length,3);assert.deepEqual(selections,original);
 assert(codes.every(code=>!code.includes('\ndata = df')));
 assert.match(codes[0],/df_csv = pd.read_csv/);
 assert.match(codes[1],/df_revenue = pd.read_excel/);
 assert.match(codes[2],/df_costs = pd.read_excel/);
 assert.doesNotMatch(notebookDataReadCodes('a.ipynb',[excel('a.xlsx','A','df')],[],true)[0],/\ndata = df/);
 assert.match(csvReadCodes('a.ipynb',[{...item('a.csv'),header:false}],[],true)[0],/encoding="utf-8-sig", header=None/);
});
test('duplicate worksheets/names and invalid workbook options fail before inserting any cells',()=>{
 assert.throws(()=>notebookDataReadCodes('a.ipynb',[excel('a.xlsx','A','x'),excel('a.xlsx','A','y')]));
 assert.throws(()=>notebookDataReadCodes('a.ipynb',[excel('a.xlsx','A','x'),excel('a.xlsx','B','x')]));
 assert.throws(()=>notebookDataReadCodes('a.ipynb',[excel('a.xlsx','A','existing')],['existing']));
 assert.throws(()=>notebookDataReadCodes('a.ipynb',[]));
 for(const [path,sheet,header,variable]of [['a.csv','A',true,'df'],['a.xlsx','',true,'df'],['a.xlsx','A\0B',true,'df'],['a.xlsx','A','false','df'],['a.xlsx','A',true,'pd']])assert.throws(()=>excelReadCode('a.ipynb',path,sheet,header,variable));
});
test('real Python parses and executes all mixed generated reads without truncating their DataFrames',()=>{
 const selections=[item('datasets/a.csv','df_csv'),excel('datasets/book"quote.xlsx','中文 "Q1"','df_q1'),excel('datasets/book"quote.xlsx','Q2','df_q2',false),excel('archive/old.xls','2019','df_old')];
 const codes=notebookDataReadCodes('course/week/lesson.ipynb',selections);
 const program=`import ast,json,sys,types\npayload=json.loads(sys.stdin.read())\ncalls=[]\nclass Frame:\n def __init__(self): self.row_count=1234567; self.previewed=False\n def head(self): self.previewed=True; return 'preview only'\ndef read(kind,path,**kwargs):\n calls.append({'kind':kind,'path':path,**kwargs}); return Frame()\nsys.modules['pandas']=types.SimpleNamespace(read_csv=lambda path,**kw:read('csv',path,**kw),read_excel=lambda path,**kw:read('excel',path,**kw))\nscope={'sentinel':'KEEP'}\nfor code in payload['codes']: ast.parse(code); exec(code,scope)\nfor name in payload['names']: assert scope[name].row_count==1234567 and scope[name].previewed\nassert len({id(scope[name]) for name in payload['names']})==len(payload['names'])\nassert scope['sentinel']=='KEEP'\nassert all('nrows' not in call and 'usecols' not in call for call in calls)\nprint(json.dumps(calls,ensure_ascii=False))`;
 const calls=JSON.parse(execFileSync('/usr/bin/python3',['-c',program],{input:JSON.stringify({codes,names:selections.map(s=>s.variable)}),encoding:'utf8'}));
 assert.deepEqual(calls,[{kind:'csv',path:'../../datasets/a.csv',sep:',',encoding:'utf-8-sig'},{kind:'excel',path:'../../datasets/book"quote.xlsx',sheet_name:'中文 "Q1"',header:0,engine:'openpyxl'},{kind:'excel',path:'../../datasets/book"quote.xlsx',sheet_name:'Q2',header:null,engine:'openpyxl'},{kind:'excel',path:'../../archive/old.xls',sheet_name:'2019',header:0,engine:'xlrd'}]);
});
test('CSV export discovers Excel variables too and still writes only the explicitly chosen frame',()=>{
 const notebook=doc(notebookDataReadCodes('a.ipynb',[item('a.csv','df_csv'),excel('book.xlsx','A','df_a'),excel('book.xlsx','B','df_b')]));
 assert.deepEqual(notebookCSVVariables(notebook),['df_csv','df_a','df_b']);
 const code=csvExportCode('sheet-b.csv','df_b');assert.match(code,/df_b\.to_csv/);assert.match(code,/mode="x"/);assert.doesNotMatch(code,/df_a\.to_csv|data\.to_csv/);
});

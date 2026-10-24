'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{registerHooks}=require('node:module');
const hooks=registerHooks({resolve(specifier,context,next){return next(specifier==='../shared/notebook-format'&&context.parentURL?.endsWith('/notebook-actions.ts')?specifier+'.ts':specifier,context);}});
const actions=require('../src/renderer/notebook-actions.ts');hooks.deregister();
const compiledPromise=import('vite').then(async({transformWithOxc})=>{
 const result=await transformWithOxc(fs.readFileSync(path.join(__dirname,'../src/renderer/NotebookCSVPicker.tsx'),'utf8'),'NotebookCSVPicker.tsx',{jsx:{runtime:'automatic'}});
 // Only module import/export glue changes; the real component/effect bodies execute unchanged.
 return result.code.replace(/^import \{([^}]+)\} from ([^;]+);/gm,(_,names,specifier)=>'const {'+names.replace(/\bas\b/g,':')+'} = require('+specifier+');').replace(/^export default /m,'exports.default = ');
});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const result=sheets=>({ok:true,value:{sheets}});
const entry=(path,kind='text')=>({path,name:path.split('/').at(-1),kind});
function elements(tree,predicate){const found=[];const walk=node=>{if(Array.isArray(node)){node.forEach(walk);return;}if(!node||typeof node!=='object'||!node.props)return;if(predicate(node))found.push(node);walk(node.props.children);};walk(tree);return found;}
function text(tree){if(Array.isArray(tree))return tree.map(text).join('');if(tree===null||tree===undefined||typeof tree==='boolean')return '';if(typeof tree==='string'||typeof tree==='number')return String(tree);return text(tree.props?.children);}
/** Execute the real picker and its effects under deterministic hook scheduling.
 * No DOM/runtime/filesystem actions are stubbed as successful product actions.
 * This checks asynchronous selection contracts, not browser layout or React paint. */
async function fixture(t,{listDirectory,notebookDataInfo}={}){
 const slots=[],pending=[];let cursor=0,dirty=false,alive=true,tree,setCalls=0;const inserted=[],closes=[];
 const Modal=Symbol('Modal'),Button=Symbol('Button');
 const jsx=(type,props)=>({type,props:props||{}});
 const react={useState(initial){const index=cursor++;if(!slots[index])slots[index]={kind:'state',value:typeof initial==='function'?initial():initial};return[slots[index].value,value=>{setCalls++;const next=typeof value==='function'?value(slots[index].value):value;if(!Object.is(next,slots[index].value)){slots[index].value=next;dirty=true;}}];},useRef(initial){const index=cursor++;if(!slots[index])slots[index]={kind:'ref',current:initial};return slots[index];},useEffect(callback,deps){const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){pending.push(()=>{old?.cleanup?.();const cleanup=callback();slots[index]={kind:'effect',deps,cleanup};});}}};
 const exports={},sandbox={exports,window:{desktop:{listDirectory:listDirectory||(async()=>({ok:true,value:{path:'course',entries:[entry('course/A.xlsx'),entry('course/B.xlsx')]}})),notebookDataInfo:notebookDataInfo||(async()=>result([{name:'Data',hidden:false}]))}},require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:Symbol('Fragment')};if(name==='lucide-react')return{Folder:Symbol('Folder'),FileSpreadsheet:Symbol('FileSpreadsheet'),ArrowUp:Symbol('ArrowUp'),Search:Symbol('Search'),Trash2:Symbol('Trash2')};if(name==='./ui')return{Modal,Button};if(name==='./notebook-actions')return actions;throw Error('Unexpected picker import: '+name);}};
 vm.runInNewContext(await compiledPromise,sandbox,{filename:'NotebookCSVPicker.compiled.cjs'});
 const props={vaultId:'synthetic-only',notebookPath:'course/Lesson.ipynb',language:'en',reservedNames:['sentinel'],onInsert:codes=>inserted.push(codes),onClose:()=>closes.push(true)};
 const render=()=>{if(!alive)throw Error('Unmounted fixture');let count=0;do{dirty=false;cursor=0;tree=exports.default(props);while(pending.length)pending.shift()();if(++count>12)throw Error('Hook update did not settle');}while(dirty);return tree;};
 const unmount=()=>{if(!alive)return;alive=false;for(const slot of slots)if(slot?.kind==='effect')slot.cleanup?.();};t.after(unmount);
 render();
 const find=predicate=>{const match=elements(render(),predicate)[0];assert(match,'Expected rendered picker control');return match;};
 return{render,find,inserted,closes,unmount,get setCalls(){return setCalls;},open:path=>find(node=>node.props['data-csv-path']===path&&typeof node.props.onClick==='function').props.onClick(),chooseSheet:name=>{const label=find(node=>node.props['data-workbook-sheet-name']===name);elements(label,node=>node.type==='input')[0].props.onChange();},chooseCSV:path=>{const label=find(node=>node.props['data-csv-path']===path&&node.type==='label');elements(label,node=>node.type==='input')[0].props.onChange();},button:label=>find(node=>node.type===Button&&text(node)===label),close:()=>render().props.onClose()};
}

test('picker keeps CSV and multiple workbook sheets across folders and generates each selected table',async t=>{
 const f=await fixture(t,{listDirectory:async({path})=>({ok:true,value:{path,entries:path==='course'?[entry('course/data.csv'),entry('course/Book.xlsx'),entry('course/other','folder')]:[entry('course/other/Old.xls')]}}),notebookDataInfo:async({path})=>result(path.endsWith('.xlsx')?[{name:'Revenue',hidden:false},{name:'Costs',hidden:true}]:[{name:'2019',hidden:false}])});
 await flush();f.chooseCSV('course/data.csv');f.open('course/Book.xlsx');f.render();await flush();
 f.chooseSheet('Revenue');f.chooseSheet('Costs');
 const input=f.find(node=>node.props['aria-label']==='Excel header course/Book.xlsx Costs');input.props.onChange({target:{value:'none'}});
 f.open('course/other');f.render();await flush();f.open('course/other/Old.xls');f.render();await flush();f.chooseSheet('2019');
 const tree=f.render();assert.match(text(tree),/Selected tables \(4\)/);assert.match(text(tree),/course\/Book.xlsx — Revenue/);assert.match(text(tree),/course\/Book.xlsx — Costs/);
 const submit=f.find(node=>node.props['data-testid']==='notebook-insert-csv');assert.equal(submit.props.disabled,false);submit.props.onClick();
 assert.equal(f.inserted.length,1);assert.equal(f.inserted[0].length,4);
 assert.match(f.inserted[0][0],/df = pd\.read_csv/);assert.match(f.inserted[0][1],/df_Book_Revenue = pd\.read_excel/);assert.match(f.inserted[0][2],/sheet_name="Costs", header=None/);assert.match(f.inserted[0][3],/engine="xlrd"/);
});

test('a late workbook metadata reply cannot replace a newer workbook, and hidden sheets are explicit',async t=>{
 const a=deferred(),b=deferred(),f=await fixture(t,{notebookDataInfo:({path})=>path.endsWith('A.xlsx')?a.promise:b.promise});
 await flush();f.open('course/A.xlsx');f.render();f.open('course/B.xlsx');f.render();
 b.resolve(result([{name:'B-current',hidden:true}]));await flush();assert.match(text(f.render()),/B-current \(hidden worksheet\)/);
 a.resolve(result([{name:'A-stale',hidden:false}]));await flush();const tree=f.render();assert.doesNotMatch(text(tree),/A-stale/);assert.match(text(tree),/B-current/);assert.equal(elements(tree,node=>node.props['data-workbook-sheet-name']&&node.props.children?.[0]?.props?.checked).length,0);
});

test('metadata failure shows a retry which can recover without changing selected CSV data',async t=>{
 let calls=0;const f=await fixture(t,{listDirectory:async()=>({ok:true,value:{path:'course',entries:[entry('course/data.csv'),entry('course/A.xlsx')]}}),notebookDataInfo:async()=>++calls===1?{ok:false,error:{message:'Workbook is still downloading'}}:result([{name:'Recovered',hidden:false}])});
 await flush();f.chooseCSV('course/data.csv');f.open('course/A.xlsx');f.render();await flush();assert.match(text(f.render()),/Workbook is still downloading/);
 f.find(node=>node.props['data-testid']==='notebook-workbook-retry').props.onClick();f.render();await flush();f.chooseSheet('Recovered');const tree=f.render();assert.doesNotMatch(text(tree),/Workbook is still downloading/);assert.match(text(tree),/Selected tables \(2\)/);assert.equal(calls,2);
});

test('closing a picker retires metadata and directory replies before they can set state',async t=>{
 const metadata=deferred(),f=await fixture(t,{notebookDataInfo:()=>metadata.promise});await flush();f.open('course/A.xlsx');f.render();f.close();const before=f.setCalls;f.unmount();metadata.resolve(result([{name:'Late',hidden:false}]));await flush();assert.equal(f.closes.length,1);assert.equal(f.setCalls,before);
 const directory=deferred(),g=await fixture(t,{listDirectory:()=>directory.promise});g.close();const directoryBefore=g.setCalls;g.unmount();directory.resolve({ok:true,value:{path:'course',entries:[]}});await flush();assert.equal(g.setCalls,directoryBefore);
});

test('changing folders retires the previous metadata request while preserving earlier selections',async t=>{
 const pending=deferred(),f=await fixture(t,{listDirectory:async({path})=>({ok:true,value:{path,entries:path==='course'?[entry('course/data.csv'),entry('course/A.xlsx'),entry('course/next','folder')]:[]}}),notebookDataInfo:()=>pending.promise});
 await flush();f.chooseCSV('course/data.csv');f.open('course/A.xlsx');f.render();f.open('course/next');f.render();await flush();pending.resolve(result([{name:'Wrong folder reply',hidden:false}]));await flush();const tree=f.render();assert.doesNotMatch(text(tree),/Wrong folder reply/);assert.match(text(tree),/Selected tables \(1\)/);assert.equal(elements(tree,node=>node.props['data-testid']==='notebook-workbook-sheets').length,0);
});

test('directory failures can retry, without requiring the user to close the picker',async t=>{
 let calls=0;const f=await fixture(t,{listDirectory:async()=>++calls===1?{ok:false,error:{message:'Folder unavailable'}}:{ok:true,value:{path:'course',entries:[entry('course/A.xlsx')]}}});
 await flush();assert.match(text(f.render()),/Folder unavailable/);f.button('Retry folder').props.onClick();f.render();await flush();assert.doesNotMatch(text(f.render()),/Folder unavailable/);f.find(node=>node.props['data-csv-path']==='course/A.xlsx');assert.equal(calls,2);
});

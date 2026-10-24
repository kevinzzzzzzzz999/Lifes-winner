'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {
 NOTEBOOK_LIMITS,validateNotebook,parseNotebook,serializeNotebook,
 notebookCellSource,notebookStats,updateNotebookCell,
}=require('../src/shared/notebook-format.ts');
const {VaultService,MAX_TEXT,MAX_NOTEBOOK:VAULT_NOTEBOOK_BYTES,textLimit,digest}=require('../src/main/vault-service.cjs');
const {MAX_NOTEBOOK:RUNTIME_NOTEBOOK_BYTES,readCells}=require('../src/main/notebook-service.cjs');
const MiB=1024*1024;
const bytes=value=>Buffer.byteLength(value,'utf8');
const markdown=(source,id='markdown-1')=>({cell_type:'markdown',id,metadata:{preserved:true},source});
const code=(source,id='code-1')=>({cell_type:'code',id,metadata:{preserved:true},source,execution_count:null,outputs:[]});
const book=cells=>({nbformat:4,nbformat_minor:5,metadata:{syntheticCapacityTest:true},cells});
const hasCode=code=>error=>error?.code===code;
const wire=cells=>Buffer.from(JSON.stringify(book(cells)));

test('Notebook byte contracts agree across model, vault opening/saving, and runtime snapshots',()=>{
 assert.equal(NOTEBOOK_LIMITS.cellSourceBytes,8*MiB);
 assert.equal(NOTEBOOK_LIMITS.sourceBytes,32*MiB);
 assert.equal(NOTEBOOK_LIMITS.outputBytes,64*MiB);
 assert.equal(NOTEBOOK_LIMITS.fileBytes,128*MiB);
 assert.equal(VAULT_NOTEBOOK_BYTES,NOTEBOOK_LIMITS.fileBytes);
 assert.equal(RUNTIME_NOTEBOOK_BYTES,NOTEBOOK_LIMITS.fileBytes);
 for(const name of ['lesson.ipynb','course/LESSON.IPYNB'])assert.equal(textLimit(name),NOTEBOOK_LIMITS.fileBytes);
 assert.equal(MAX_TEXT,4*MiB);
 for(const name of ['notes.txt','lesson.py','lesson.ipynb.txt'])assert.equal(textLimit(name),MAX_TEXT);
 assert(Object.isFrozen(NOTEBOOK_LIMITS));
});

test('UTF-8 source arrays survive the new 8 MiB cell boundary, while one extra byte cannot edit or overwrite it',{timeout:30000},()=>{
 const prefix='# Synthetic UTF-8 capacity boundary\n',remaining=8*MiB-bytes(prefix);
 const source=[prefix,'汉'.repeat(Math.floor(remaining/3)),'x'.repeat(remaining%3)];
 const original=book([markdown(source)]),joined=notebookCellSource(original.cells[0]);
 assert.equal(bytes(joined),8*MiB);
 assert(bytes(joined)>512*1024);
 assert(joined.length<bytes(joined),'The boundary must count UTF-8 bytes, not JavaScript characters.');
 assert.doesNotThrow(()=>validateNotebook(original));
 const reopened=parseNotebook(serializeNotebook(original));
 assert(Array.isArray(reopened.cells[0].source));
 assert.equal(digest(Buffer.from(notebookCellSource(reopened.cells[0]))),digest(Buffer.from(joined)));
 assert.deepEqual(reopened.cells[0].metadata,original.cells[0].metadata);
 const tooLarge=book([markdown([...source,'x'])]);
 assert.throws(()=>validateNotebook(tooLarge),hasCode('cell-source-limit'));
 assert.throws(()=>updateNotebookCell(original,0,{source:joined+'x'}),hasCode('cell-source-limit'));
 assert.equal(bytes(notebookCellSource(original.cells[0])),8*MiB,'Rejected edits must preserve the original cell.');
});

test('the 32 MiB aggregate source boundary permits four full cells and rejects one extra byte',{timeout:30000},()=>{
 const source='s'.repeat(8*MiB),original=book(Array.from({length:4},(_,index)=>markdown(source,'source-'+index)));
 assert.equal(notebookStats(original).sourceBytes,32*MiB);
 assert.doesNotThrow(()=>validateNotebook(original));
 const tooLarge={...original,cells:[...original.cells,markdown('x','extra-byte')]};
 assert.throws(()=>validateNotebook(tooLarge),hasCode('source-limit'));
 const withEmptyCell={...original,cells:[...original.cells,markdown('','empty-cell')]};
 assert.throws(()=>updateNotebookCell(withEmptyCell,4,{source:'x'}),hasCode('source-limit'));
 assert.equal(notebookCellSource(withEmptyCell.cells[4]),'');
});

test('outputs and attachments share one 64 MiB budget rather than separate or obsolete 24 MiB budgets',{timeout:30000},()=>{
 const output={output_type:'stream',name:'stdout',text:'o'.repeat(MiB)};
 const emptyAttachment={'synthetic.png':{'image/png':''}};
 // Account for the persisted JSON wrapper bytes, not only the payload strings.
 const attachmentLength=64*MiB-bytes(JSON.stringify([output]))-bytes(JSON.stringify(emptyAttachment));
 const attachment='A'.repeat(attachmentLength),first=code('print("synthetic")');
 first.outputs=[output];
 const second={...markdown('![synthetic](attachment:synthetic.png)','attachment-cell'),attachments:{'synthetic.png':{'image/png':attachment}}};
 const original=book([first,second]),stats=notebookStats(original);
 assert.equal(stats.outputBytes+stats.attachmentBytes,64*MiB);
 assert(stats.attachmentBytes>24*MiB);
 assert.doesNotThrow(()=>validateNotebook(original));
 const tooLarge={...original,cells:[first,{...second,attachments:{'synthetic.png':{'image/png':attachment+'A'}}}]};
 assert.throws(()=>validateNotebook(tooLarge),hasCode('output-size-limit'));
 assert.equal(notebookStats(original).outputBytes+notebookStats(original).attachmentBytes,64*MiB);
});

test('runtime reads source arrays above the former 2 MiB limit without changing their content',()=>{
 const prefix='# synthetic runtime source\n',remaining=8*MiB-bytes(prefix);
 const source=[prefix,'汉'.repeat(Math.floor(remaining/3)),'x'.repeat(remaining%3)];
 const selected=readCells(wire([code(source)]),[0]);
 assert.equal(selected.length,1);
 assert.equal(selected[0].index,0);
 assert.equal(selected[0].source,source.join(''));
 assert.equal(bytes(selected[0].source),8*MiB);
 assert(selected[0].source.length<8*MiB,'Runtime must count UTF-8 bytes, not JavaScript characters.');
 assert.throws(()=>readCells(wire([code([...source,'x'])]),[0]),hasCode('TOO_LARGE'));
});

test('runtime selected-source aggregate agrees with 32 MiB and rejects its next byte',{timeout:30000},()=>{
 const source=' '.repeat(8*MiB),cells=Array.from({length:4},(_,index)=>code(source,'runtime-'+index));
 const selected=readCells(wire(cells),[0,1,2,3]);
 assert.equal(selected.reduce((sum,cell)=>sum+bytes(cell.source),0),32*MiB);
 assert.deepEqual(selected.map(cell=>cell.index),[0,1,2,3]);
 assert.throws(()=>readCells(wire([...cells,code('x','runtime-extra')]),[0,1,2,3,4]),hasCode('TOO_LARGE'));
});

test('a synthetic Notebook above the former 32 MiB file limit opens, saves, and reopens byte-correctly',{timeout:60000},async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-notebook-capacity-test-'));
 try{
  const root=path.join(temp,'vault');await fs.mkdir(root);
  const original=book([markdown('# CAPACITY_BEFORE_SENTINEL\n')]);
  original.metadata.syntheticPadding='p'.repeat(33*MiB);
  const initial=serializeNotebook(original),file=path.join(root,'capacity.ipynb');
  assert(bytes(initial)>32*MiB);
  assert(bytes(initial)<128*MiB);
  assert.doesNotThrow(()=>parseNotebook(initial));
  await fs.writeFile(file,initial);
  const vaults=new VaultService({dataDirectory:path.join(temp,'profile')}),vault=await vaults.grantVault(root);
  const request={vaultId:vault.id,path:'capacity.ipynb'},opened=await vaults.readFile(request);
  assert.equal(opened.kind,'text');
  assert.equal(opened.bytes,bytes(initial));
  assert.equal(opened.sha256,digest(Buffer.from(initial)));
  assert.equal(digest(Buffer.from(opened.text)),opened.sha256);
  const changed=opened.text.replace('CAPACITY_BEFORE_SENTINEL','CAPACITY_AFTER_SENTINEL');
  assert.notEqual(digest(Buffer.from(changed)),opened.sha256);
  const saved=await vaults.saveText({...request,text:changed,expectedSHA256:opened.sha256});
  assert.equal(saved.sha256,digest(Buffer.from(changed)));
  assert(saved.backupId,'The capacity increase must retain the normal backup path.');
  const reopened=await vaults.readFile(request);
  assert.equal(reopened.sha256,saved.sha256);
  assert.equal(reopened.bytes,bytes(changed));
  assert.equal(digest(Buffer.from(reopened.text)),saved.sha256);
  assert.equal(digest(await fs.readFile(file)),saved.sha256);
  assert.equal(notebookCellSource(parseNotebook(reopened.text).cells[0]),'# CAPACITY_AFTER_SENTINEL\n');
  await assert.rejects(()=>vaults.createTextFile({vaultId:vault.id,parentPath:'',name:'ordinary.txt',content:'x'.repeat(4*MiB+1)}),hasCode('TOO_LARGE'));
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

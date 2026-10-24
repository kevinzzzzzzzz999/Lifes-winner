'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ExternalDocumentOpen,inspectDocument,fileWithin,selectDocument,DOCUMENT_EXTENSIONS}=require('../src/main/external-document-open.cjs');
const {VaultService,digest}=require('../src/main/vault-service.cjs');
const {WindowContexts}=require('../src/main/window-contexts.cjs');
test('packaging associations cover every supported Finder document without claiming a default',()=>{
 const {fileAssociations,documentTypes}=require('../scripts/packaging/document-associations.cjs');
 assert.deepEqual(require('../package.json').build.mac.fileAssociations,fileAssociations);
 const extensions=fileAssociations.flatMap(record=>record.ext);
 assert.deepEqual(new Set(DOCUMENT_EXTENSIONS),new Set(extensions));
 assert.deepEqual(new Set(extensions),new Set(['ipynb','json','md','markdown','tex','py','js','ts','txt','html','htm','csv','tsv','pdf','png','jpg','jpeg','doc','docx','pptx','xls','xlsx','xlsm','mp4','mov','m4v']));
 assert.ok(fileAssociations.every(record=>record.rank==='Alternate'));
 assert.ok(documentTypes.every(record=>!record.LSItemContentTypes&&record.LSHandlerRank==='Alternate'));
});
test('native Open file picker is single-selection, cancellation-safe, and rejects unexpected multiple paths',async()=>{
 let options;const window={id:1},dialog={showOpenDialog:async(owner,request)=>{assert.equal(owner,window);options=request;return {canceled:false,filePaths:['/tmp/example.ipynb']};}};
 assert.equal(await selectDocument({dialog,window}),'/tmp/example.ipynb');assert.deepEqual(options.properties,['openFile']);assert.equal(options.filters[0].extensions,DOCUMENT_EXTENSIONS);
 dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});assert.equal(await selectDocument({dialog,window}),null);
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:['/tmp/A.md','/tmp/B.md']});await assert.rejects(selectDocument({dialog,window}),{code:'INVALID_REQUEST'});
});

async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-external-open-test-')),root=await fs.realpath(temp);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const vaults=new VaultService({dataDirectory:path.join(root,'profile')}),windows=new WindowContexts(),errors=[],events=[],created=[];
 let next=1;
 const createWindow=(vault=null)=>{const window={isDestroyed:()=>false,webContents:{id:next++,isDestroyed:()=>false,send:(channel,value)=>events.push({id:window.webContents.id,channel,value})}};const context=windows.add(window,vault);created.push(context);return context;};
 const reveal=context=>{windows.lastActive=context;return context;};
 const opener=new ExternalDocumentOpen({onError:error=>errors.push(error)});
 const deps={vaults,windows,createWindow,reveal};
 const write=async(relative,data='original source\r\n')=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);return file;};
 return {root,vaults,windows,opener,deps,created,events,errors,write,createWindow};
}
test('cold OS file events are retained before configuration and renderer readiness',async t=>{
 const f=await fixture(t),first=await f.write('notes/A.ipynb'),second=await f.write('notes/B.md');
 f.opener.enqueue(first);f.opener.enqueue(second);assert.equal(f.created.length,0);
 await f.opener.configure(f.deps);assert.equal(f.created.length,1);assert.equal(f.events.length,0);
 const context=f.created[0],requests=f.opener.list(context);
 assert.deepEqual(requests.map(request=>request.path),['A.ipynb','B.md']);
 assert.deepEqual(f.opener.list(context),requests,'reading must not drain a request before React processes it');
 assert.deepEqual(f.opener.acknowledge(context,requests[0].id),{acknowledged:true});
 assert.deepEqual(f.opener.list(context).map(request=>request.path),['B.md']);
});
test('warm requests prefer the focused matching vault and retain each incoming file',async t=>{
 const f=await fixture(t),first=await f.write('vault/child/A.ipynb'),second=await f.write('vault/child/B.inkspace.json','{}');
 const vault=await f.vaults.grantVault(path.join(f.root,'vault')),other=f.createWindow(vault),focused=f.createWindow(vault);f.opener.list(focused);
 await f.opener.configure(f.deps);f.opener.enqueue(first);f.opener.enqueue(second);f.opener.enqueue(first);await f.opener.idle();
 assert.equal(f.created.length,2);assert.equal(f.opener.list(other).length,0);
 assert.deepEqual(f.opener.list(focused).map(request=>request.path),['child/A.ipynb','child/B.inkspace.json','child/A.ipynb']);
 assert.equal(f.events.length,3);assert.equal(new Set(f.opener.list(focused).map(request=>request.id)).size,3);
});
test('a different directory creates a workspace without replacing the old window',async t=>{
 const f=await fixture(t),first=await f.write('old/draft.md'),next=await f.write('new/book.ipynb');
 const vault=await f.vaults.grantVault(path.dirname(first)),context=f.createWindow(vault);context.draft='UNSAVED';f.opener.list(context);
 await f.opener.configure(f.deps);f.opener.enqueue(next);await f.opener.idle();
 assert.equal(f.created.length,2);assert.equal(context.activeVault.id,vault.id);assert.equal(context.draft,'UNSAVED');
 assert.equal(await f.vaults.root(f.created[1].activeVault.id),path.dirname(next));assert.equal(f.opener.list(context).length,0);
});
test('cold launch uses a verified recent vault ancestor so board links retain their root',async t=>{
 const f=await fixture(t),file=await f.write('known/nested/board.inkspace.json','{}'),root=path.join(f.root,'known'),stat=await fs.stat(root);
 f.deps.recentVaults={load:async()=>{},entries:[{id:'recent',selectedPath:root,canonicalPath:root,dev:stat.dev,ino:stat.ino}]};
 f.opener.enqueue(file);await f.opener.configure(f.deps);
 const request=f.opener.list(f.created[0])[0];assert.equal(request.path,'nested/board.inkspace.json');assert.equal(request.vault.recentId,'recent');assert.equal(await f.vaults.root(request.vault.id),root);
});
test('changed recent identity falls back to the selected file directory',async t=>{
 const f=await fixture(t),file=await f.write('known/nested/book.ipynb'),root=path.join(f.root,'known'),stat=await fs.stat(root);
 f.deps.recentVaults={load:async()=>{},entries:[{id:'recent',selectedPath:root,canonicalPath:root,dev:stat.dev,ino:stat.ino+1}]};
 f.opener.enqueue(file);await f.opener.configure(f.deps);assert.equal(await f.vaults.root(f.created[0].activeVault.id),path.dirname(file));
});
test('invalid, missing, unsupported and linked paths return public errors without granting them',async t=>{
 const f=await fixture(t),source=await f.write('files/source.md'),unsupported=await f.write('files/no.exe');
 const link=path.join(f.root,'link.md'),hard=path.join(f.root,'hard.md');await fs.symlink(source,link);await fs.link(source,hard);
 const values=['relative.ipynb',path.join(f.root,'missing.ipynb'),unsupported,link,hard,path.dirname(source),source+'\0'];
 values.forEach(value=>f.opener.enqueue(value));await f.opener.configure(f.deps);
 assert.equal(f.vaults.vaults.size,0);assert.equal(f.errors.length,values.length);
 const requests=f.opener.list(f.created[0]);assert.equal(requests.length,values.length);
 assert.ok(requests.every(request=>request.error&&!request.path&&!request.vault));
 assert.ok(requests.every(request=>!request.error.message.includes(f.root)));
 assert.equal(fileWithin(path.join(f.root,'files'),path.join(f.root,'files-other','x.md')),null);
});
test('source bytes survive queued opens, renderer read errors, and moving a request to another window',async t=>{
 const f=await fixture(t),file=await f.write('docs/Broken.inkspace.json','{broken\r\n'),before=await fs.readFile(file);
 f.opener.enqueue(file);await f.opener.configure(f.deps);const context=f.created[0],request=f.opener.list(context)[0];
 await assert.rejects(f.vaults.readFile({vaultId:request.vault.id,path:request.path}),{code:'INVALID_BOARD'});
 const unrelated=f.createWindow();assert.equal(f.opener.acknowledge(unrelated,request.id).acknowledged,false);
 await assert.rejects(f.opener.moveToNewWindow(unrelated,request.id),{code:'INVALID_REQUEST'});
 await f.opener.moveToNewWindow(context,request.id);f.opener.acknowledge(context,request.id);
 assert.equal(f.opener.list(f.created.at(-1))[0].path,'Broken.inkspace.json');assert.equal(digest(await fs.readFile(file)),digest(before));
});
test('a renderer subscription can receive a later warm file after listing an empty mailbox',async t=>{
 const f=await fixture(t),file=await f.write('docs/book.ipynb'),startup=f.createWindow();f.opener.list(startup);
 await f.opener.configure(f.deps);f.opener.enqueue(file);await f.opener.idle();
 assert.equal(f.created.length,2,'a warm unassigned window may have an in-flight folder choice');
 const target=f.created[1];assert.equal(f.opener.list(target).length,1);f.opener.enqueue(file);await f.opener.idle();assert.equal(f.events.at(-1).id,target.id);
});

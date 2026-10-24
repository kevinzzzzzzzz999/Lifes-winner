'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {PDFDocument,PDFName,PDFString,StandardFonts}=require('pdf-lib');
const {VaultService,digest}=require('../src/main/vault-service.cjs');
const {publishOneNotePDF,DIRECTORY}=require('../src/main/onenote-publication.cjs');
const {buildOneNotePDF,VERSION}=require('../src/main/onenote-pdf.cjs');
const {resolveBoardSource}=require('../src/main/board-source-resolver.cjs');
const {publicError,AppError}=require('../src/main/errors.cjs');
const id=()=>crypto.randomUUID(),code=value=>error=>error.code===value;
async function sourcePDF(offset=0){
 const pdf=await PDFDocument.create();pdf.setCreator('Microsoft OneNote');pdf.setTitle('Independent synthetic tiles');const font=await pdf.embedFont(StandardFonts.Helvetica);
 for(let n=0;n<4;n++){
  const p=pdf.addPage([595.08,843.24]);p.node.set(PDFName.of('Resources'),pdf.context.obj({Font:{F1:font.ref}}));
  const raw=`q\n0 40 595.08 780 re W n\n/P << /MCID 0 >> BDC\n0 .2 .7 RG\n2 w\n${40+offset} ${180+n*4} m\n500 ${220+n*4} l\nS\nEMC\nQ\nBT\n/F1 10 Tf\n1 0 0 1 30 16 Tm\n(Synthetic footer ${n+1}) Tj\nET\n`;
  p.node.set(PDFName.of('Contents'),pdf.context.register(pdf.context.flateStream(Buffer.from(raw))));
 }
 return Buffer.from(await pdf.save());
}
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-onenote-publication-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'vault');await fs.mkdir(path.join(root,'course'),{recursive:true});
 const vaults=new VaultService({dataDirectory:path.join(temp,'state')}),vault=await vaults.grantVault(root),source=await sourcePDF(),sourcePath='course/source.pdf';
 await fs.writeFile(path.join(root,sourcePath),source);const opened=await vaults.createBoard({vaultId:vault.id,parentPath:'course',name:'board.inkspace.json'});
 const carded=await vaults.addBoardFileCards({vaultId:vault.id,path:opened.path,expectedSHA256:opened.sha256,sourcePaths:[sourcePath],x:100,y:100});
 const card=carded.board.items.find(item=>carded.selectedIDs.includes(item.id)),sourceRequest={vaultId:vault.id,path:sourcePath};
 const snapshot=()=>vaults.snapshot(sourceRequest,128*1024*1024);
 const request=async(operation)=>({vaultId:vault.id,path:opened.path,expectedSHA256:(await vaults.readFile({vaultId:vault.id,path:opened.path})).sha256,operation:{type:'expandDocument',id:card.id,direction:'onenote',scale:1,...operation}});
 return{temp,root,vaults,vault,source,sourcePath,opened,card,sourceRequest,snapshot,request};
}
async function files(root,rel=DIRECTORY){
 let entries;try{entries=await fs.readdir(path.join(root,rel),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return[];throw error;}
 const result=[];for(const e of entries){const child=rel+'/'+e.name;if(e.isDirectory())result.push(...await files(root,child));else result.push(child);}return result.sort();
}
async function annotatedPDF(bytes,text){
 const pdf=await PDFDocument.load(bytes),page=pdf.getPage(0);
 const annotation=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[20,20,60,60],Contents:PDFString.of(text),NM:PDFString.of(id())}));
 page.node.addAnnot(annotation);return Buffer.from(await pdf.save({useObjectStreams:false}));
}
test('actual builder publishes vector PDF/report pair, concurrent identical requests reuse verified bytes',async t=>{
 const f=await fixture(t),snapshot=await f.snapshot(),a=[],b=[];
 const [first,second]=await Promise.all([publishOneNotePDF(f.vaults,f.sourceRequest,snapshot,{columns:2},a),publishOneNotePDF(f.vaults,f.sourceRequest,snapshot,{columns:2},b)]);
 assert.equal(first.reused,false);assert.equal(second.reused,true);assert.equal(first.path,second.path);assert.equal(a.length,2);assert.equal(b.length,0);
 assert.match(first.path,/^\.inkspace-assets\/onenote\/[a-f0-9]{64}\/continuous\.pdf$/);assert.equal(first.report.pageCount,4);assert.equal(first.report.columns,2);assert.equal(first.report.rasterized,false);
 const stored=await f.vaults.snapshot({vaultId:f.vault.id,path:first.path},128*1024*1024);assert.equal(stored.sha256,first.sha256);assert.equal((await PDFDocument.load(stored.data)).getPageCount(),1);
 const report=JSON.parse(await fs.readFile(path.join(f.root,first.reportPath)));assert.equal(report.pdfSHA256,stored.sha256);assert.equal(report.report.sourceSha256,snapshot.sha256);assert.equal(report.identity.rendererVersion,VERSION);
 assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);assert.equal((await files(f.root)).length,2);
});
test('modified or partial publication is preserved and conflicts instead of overwriting or using a suffix',async t=>{
 const f=await fixture(t),r=await publishOneNotePDF(f.vaults,f.sourceRequest,await f.snapshot(),{columns:2},[]),modified=Buffer.from('external change');
 await fs.writeFile(path.join(f.root,r.path),modified);
 await assert.rejects(publishOneNotePDF(f.vaults,f.sourceRequest,await f.snapshot(),{columns:2},[]),code('CONFLICT'));
 assert.deepEqual(await fs.readFile(path.join(f.root,r.path)),modified);assert.equal((await files(f.root)).length,2);
 await fs.unlink(path.join(f.root,r.reportPath));await assert.rejects(publishOneNotePDF(f.vaults,f.sourceRequest,await f.snapshot(),{columns:2},[]),code('CONFLICT'));
 assert.deepEqual(await fs.readFile(path.join(f.root,r.path)),modified);assert.equal((await files(f.root)).length,1);
});
test('report-backup failure rolls back only the new PDF and leaves original and board unchanged',async t=>{
 const f=await fixture(t),before=(await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,backup=f.vaults.backup.bind(f.vaults);
 f.vaults.backup=async(rel,...args)=>{if(rel.endsWith('/report.json'))throw Object.assign(Error('Synthetic report backup failure'),{code:'BACKUP_FAILED'});return backup(rel,...args);};
 await assert.rejects(f.vaults.mutateBoard(await f.request()),code('BACKUP_FAILED'));
 assert.deepEqual(await files(f.root),[]);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,before);assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);
});
test('source changed during conversion is never overwritten and prevents publication',async t=>{
 const f=await fixture(t),snapshot=await f.snapshot(),changed=await sourcePDF(2);
 const implementation={VERSION,buildOneNotePDF:async(data,options)=>{const result=await buildOneNotePDF(data,options);await fs.writeFile(path.join(f.root,f.sourcePath),changed);return result;}};
 await assert.rejects(publishOneNotePDF(f.vaults,f.sourceRequest,snapshot,{columns:2},[],implementation),code('CONFLICT'));
 assert.deepEqual(await files(f.root),[]);assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),changed);
});
test('unsafe paths, invalid column ranges and linked asset directories fail closed',async t=>{
 const f=await fixture(t),snapshot=await f.snapshot();
 for(const columns of [0,9,1.5,NaN])await assert.rejects(publishOneNotePDF(f.vaults,f.sourceRequest,snapshot,{columns},[]),code('INVALID_REQUEST'));
 await assert.rejects(publishOneNotePDF(f.vaults,{...f.sourceRequest,path:'../outside.pdf'},snapshot,{columns:2},[]),code('PATH_DENIED'));
 const outside=path.join(f.temp,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.root,'.inkspace-assets'));
 await assert.rejects(publishOneNotePDF(f.vaults,f.sourceRequest,snapshot,{columns:2},[]),code('PATH_DENIED'));assert.deepEqual(await fs.readdir(outside),[]);
});
test('unsupported ordinary PDF exposes the specific error without publishing files or changing the board/source',async t=>{
 const f=await fixture(t),pdf=await PDFDocument.create();pdf.setCreator('Independent ordinary PDF');pdf.addPage([600,800]);
 const ordinary=Buffer.from(await pdf.save());await fs.writeFile(path.join(f.root,f.sourcePath),ordinary);
 const before=await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path});
 await assert.rejects(f.vaults.mutateBoard(await f.request()),error=>{
  assert.equal(error.code,'ONENOTE_LAYOUT_UNSUPPORTED');const shown=publicError(error);assert.equal(shown.code,'ONENOTE_LAYOUT_UNSUPPORTED');assert.match(shown.message,/ordinary PDF/);return true;
 });
 assert.deepEqual(await files(f.root),[]);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,before.sha256);assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),ordinary);
});
test('whiteboard expansion keeps ordinary pages/native/web ink; generated source resolves, saves/reopens and Undo/Redo retain assets',async t=>{
 const f=await fixture(t),normal=await f.vaults.mutateBoard(await f.request({direction:'vertical'}));
 const b=structuredClone(normal.board);b.drawing='unchanged opaque native archive';b.webInk={version:1,strokes:[{points:[[110,120,2],[130,140,3]],color:'#123456',opacity:1}]};
 await fs.writeFile(path.join(f.root,f.opened.path),JSON.stringify(b));
 f.vaults.nativeInkBridge={apply:async()=>{throw Error('Adding a new reading revision must not transform existing ink');}};
 const r=await f.vaults.mutateBoard(await f.request({x:20,y:30})),page=r.board.items.at(-1);
 assert.equal(r.board.items.length,b.items.length+1);assert.deepEqual(r.board.items.slice(0,-1),b.items);assert.equal(r.board.drawing,b.drawing);assert.deepEqual(r.board.webInk,b.webInk);
 assert.equal(page.width,1440);assert.equal(page.x,20);assert.equal(page.y,30);assert.equal(page.originalSourcePath,f.sourcePath);assert.equal(page.originalSourceSHA256,digest(f.source));assert.equal(page.page,1);
 const source=await resolveBoardSource(f.vaults,{vaultId:f.vault.id,boardPath:f.opened.path,expectedBoardSHA256:r.sha256,sourcePath:page.sourcePath});assert.equal(source.path,page.sourcePath);
 const asset=await f.vaults.getAssetUrl({vaultId:f.vault.id,path:page.sourcePath}),response=await f.vaults.asset(asset.url);assert.equal(digest(response.body),asset.sha256);
 const reopened=await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path});assert.deepEqual(reopened.board.items.at(-1),page);
 const again=await f.vaults.mutateBoard(await f.request({x:900,y:900,scale:2}));assert.equal(again.unchanged,true);assert.equal(again.sha256,r.sha256);assert.deepEqual(again.board.items.at(-1),page);
 const undone=await f.vaults.undoBoard({vaultId:f.vault.id,path:f.opened.path,expectedSHA256:r.sha256});assert.deepEqual(undone.board.items,b.items);assert.equal(undone.board.drawing,b.drawing);assert.deepEqual(undone.board.webInk,b.webInk);
 const redone=await f.vaults.redoBoard({vaultId:f.vault.id,path:f.opened.path,expectedSHA256:undone.sha256});assert.deepEqual(redone.board.items,r.board.items);assert.equal(digest(await fs.readFile(path.join(f.root,page.sourcePath))),asset.sha256);
});
test('different source hash or column option appends an independent reading revision without moving existing pages',async t=>{
 const f=await fixture(t),first=await f.vaults.mutateBoard(await f.request()),oldPage=first.board.items.at(-1),oldBytes=await fs.readFile(path.join(f.root,oldPage.sourcePath));
 const columns=await f.vaults.mutateBoard(await f.request({columns:1}));assert.deepEqual(columns.board.items.slice(0,-1),first.board.items);assert.notEqual(columns.board.items.at(-1).sourcePath,oldPage.sourcePath);assert.equal(columns.board.items.at(-1).width,720);
 await fs.writeFile(path.join(f.root,f.sourcePath),await sourcePDF(3));const changed=await f.vaults.mutateBoard(await f.request());
 assert.deepEqual(changed.board.items.slice(0,-1),columns.board.items);assert.notEqual(changed.board.items.at(-1).sourcePath,oldPage.sourcePath);assert(changed.board.items.at(-1).y>=Math.max(...columns.board.items.filter(i=>i.sourceCardID===f.card.id).map(i=>i.y+i.height)));
 assert.deepEqual(await fs.readFile(path.join(f.root,oldPage.sourcePath)),oldBytes);
});
test('referenced continuous page with real PDF annotation updates is selected intact without regenerating or moving it',async t=>{
 const f=await fixture(t),first=await f.vaults.mutateBoard(await f.request()),page=first.board.items.at(-1),original=await fs.readFile(path.join(f.root,page.sourcePath)),reportPath=path.posix.dirname(page.sourcePath)+'/report.json',report=await fs.readFile(path.join(f.root,reportPath));
 const annotated=await annotatedPDF(original,'Independent synthetic annotation');assert.notEqual(digest(annotated),digest(original));
 await fs.writeFile(path.join(f.root,page.sourcePath),annotated);
 const again=await f.vaults.mutateBoard(await f.request({x:900,y:900,scale:2}));
 assert.equal(again.unchanged,true);assert.equal(again.sha256,first.sha256);assert.deepEqual(again.selectedIDs,[page.id]);assert.deepEqual(again.board.items,first.board.items);assert.deepEqual(again.board.items.at(-1),page);
 assert.deepEqual(await fs.readFile(path.join(f.root,page.sourcePath)),annotated);assert.deepEqual(await fs.readFile(path.join(f.root,reportPath)),report);assert.equal((await files(f.root)).length,2);
 const parsed=await PDFDocument.load(await fs.readFile(path.join(f.root,page.sourcePath)));assert.equal(parsed.getPage(0).node.Annots().size(),1);
 const resolved=await resolveBoardSource(f.vaults,{vaultId:f.vault.id,boardPath:f.opened.path,expectedBoardSHA256:first.sha256,sourcePath:page.sourcePath});assert.equal(resolved.path,page.sourcePath);
 const asset=await f.vaults.getAssetUrl({vaultId:f.vault.id,path:page.sourcePath});assert.equal(asset.sha256,digest(annotated));
 // The exception is selection of an already referenced page; unreferenced
 // publication reuse still requires the original verified pair.
 await assert.rejects(publishOneNotePDF(f.vaults,f.sourceRequest,await f.snapshot(),{columns:2},[]),code('CONFLICT'));
 assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);
});
test('selecting an existing continuous page rejects concurrent PDF or board edits and preserves the newer bytes',async t=>{
 for(const changed of ['pdf','board']){
  const f=await fixture(t),first=await f.vaults.mutateBoard(await f.request()),page=first.board.items.at(-1),pdf=await fs.readFile(path.join(f.root,page.sourcePath)),reportPath=path.posix.dirname(page.sourcePath)+'/report.json',report=await fs.readFile(path.join(f.root,reportPath));
  const newer=changed==='pdf'?await annotatedPDF(pdf,'Concurrent independent annotation'):Buffer.from(JSON.stringify({...first.board,title:'Concurrent independent board title',revision:first.board.revision+1}));
  const originalSnapshot=f.vaults.snapshot.bind(f.vaults),request=await f.request();let edited=false;
  f.vaults.snapshot=async(input,maximum)=>{const snapshot=await originalSnapshot(input,maximum);if(!edited&&input.path===page.sourcePath){edited=true;await fs.writeFile(path.join(f.root,changed==='pdf'?page.sourcePath:f.opened.path),newer);}return snapshot;};
  await assert.rejects(f.vaults.mutateBoard(request),code('CONFLICT'));assert.equal(edited,true);
  assert.deepEqual(await fs.readFile(path.join(f.root,changed==='pdf'?page.sourcePath:f.opened.path)),newer);assert.deepEqual(await fs.readFile(path.join(f.root,reportPath)),report);assert.equal((await files(f.root)).length,2);
  if(changed==='pdf')assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,first.sha256);else assert.deepEqual(await fs.readFile(path.join(f.root,page.sourcePath)),pdf);
  assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);
 }
});
test('board-space or final commit failure leaves board unchanged and rolls back both newly created artifacts',async t=>{
 for(const kind of ['space','commit']){
  const f=await fixture(t),before=(await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256;
  if(kind==='commit')f.vaults.commitSnapshot=async()=>{throw Object.assign(Error('Synthetic board conflict'),{code:'CONFLICT'});};
  await assert.rejects(f.vaults.mutateBoard(await f.request(kind==='space'?{x:8000000-1}:{})),code(kind==='space'?'BOARD_SPACE_INSUFFICIENT':'CONFLICT'));
  assert.deepEqual(await files(f.root),[]);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,before);assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);
 }
});
test('reused artifacts survive later board conflict; changed report is caught by final SHA checks and preserved',async t=>{
 const f=await fixture(t),stored=await publishOneNotePDF(f.vaults,f.sourceRequest,await f.snapshot(),{columns:2},[]),originalPDF=await fs.readFile(path.join(f.root,stored.path)),commit=f.vaults.commitSnapshot.bind(f.vaults),before=(await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256;
 const edited=Buffer.from('{"external":"report changed"}');f.vaults.commitSnapshot=async(...args)=>{await fs.writeFile(path.join(f.root,stored.reportPath),edited);return commit(...args);};
 await assert.rejects(f.vaults.mutateBoard(await f.request()),code('CONFLICT'));
 assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,before);assert.deepEqual(await fs.readFile(path.join(f.root,stored.path)),originalPDF);assert.deepEqual(await fs.readFile(path.join(f.root,stored.reportPath)),edited);
});
test('OneNote mode refuses Excel and bad placement values before creating assets',async t=>{
 const f=await fixture(t);for(const patch of [{x:NaN},{y:-1},{scale:0},{columns:9}])await assert.rejects(f.vaults.mutateBoard(await f.request(patch)),code('INVALID_REQUEST'));
 const current=await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path});current.board.items.find(item=>item.id===f.card.id).sourcePath='course/source.xlsx';await fs.writeFile(path.join(f.root,f.opened.path),JSON.stringify(current.board));
 await assert.rejects(f.vaults.mutateBoard(await f.request()),code('PDF_REQUIRED'));assert.deepEqual(await files(f.root),[]);
});
test('generated-source allowance is exact, referenced-only, symlink-safe and never uses a board-relative hidden fallback',async t=>{
 const f=await fixture(t),published=await publishOneNotePDF(f.vaults,f.sourceRequest,await f.snapshot(),{columns:2},[]),request=await f.request(),lookup=sourcePath=>resolveBoardSource(f.vaults,{vaultId:f.vault.id,boardPath:f.opened.path,expectedBoardSHA256:request.expectedSHA256,sourcePath});
 await assert.rejects(lookup(published.path),code('PATH_DENIED'));
 for(const p of ['.inkspace-assets/onenote/'+('a'.repeat(64))+'/report.json','.hidden/source.pdf','.inkspace-assets/other/'+('a'.repeat(64))+'/continuous.pdf','.inkspace-assets/onenote/'+('A'.repeat(64))+'/continuous.pdf'])await assert.rejects(lookup(p),code('PATH_DENIED'));
 const result=await f.vaults.mutateBoard(await f.request()),derived=result.board.items.at(-1).sourcePath;
 const invoke=()=>resolveBoardSource(f.vaults,{vaultId:f.vault.id,boardPath:f.opened.path,expectedBoardSHA256:result.sha256,sourcePath:derived});
 const original=await fs.readFile(path.join(f.root,derived));await fs.unlink(path.join(f.root,derived));await fs.mkdir(path.dirname(path.join(f.root,'course',derived)),{recursive:true});await fs.writeFile(path.join(f.root,'course',derived),original);
 await assert.rejects(invoke(),code('NOT_FOUND'));
 const outside=path.join(f.temp,'outside.pdf');await fs.writeFile(outside,original);await fs.symlink(outside,path.join(f.root,derived));await assert.rejects(invoke(),code('PATH_DENIED'));
});
test('publication retries a transient source snapshot conflict without changing its required source bytes',async t=>{
 const f=await fixture(t),source=await f.snapshot(),snapshot=f.vaults.snapshot.bind(f.vaults);let failed=false,sourceReads=0;
 f.vaults.snapshot=async(request,maximum)=>{if(request.path===f.sourcePath){sourceReads++;if(!failed){failed=true;throw new AppError('CONFLICT');}}return snapshot(request,maximum);};
 const published=await publishOneNotePDF(f.vaults,f.sourceRequest,source,{columns:2},[]);
 assert.equal(failed,true);assert(sourceReads>=2);assert.equal((await files(f.root)).length,2);assert.equal((await PDFDocument.load(await fs.readFile(path.join(f.root,published.path)))).getPageCount(),1);assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);
});
test('OneNote commit retries one metadata snapshot conflict per derived file and still saves through the real board CAS',async t=>{
 const f=await fixture(t),snapshot=f.vaults.snapshot.bind(f.vaults),commit=f.vaults.commitSnapshot.bind(f.vaults),reads=new Map();let committing=false,boardReads=0;
 f.vaults.commitSnapshot=async(...args)=>{committing=true;try{return await commit(...args);}finally{committing=false;}};
 f.vaults.snapshot=async(request,maximum)=>{if(committing){if(request.path===f.opened.path)boardReads++;if(request.path.endsWith('/continuous.pdf')||request.path.endsWith('/report.json')){const n=(reads.get(request.path)||0)+1;reads.set(request.path,n);if(n===1)throw new AppError('CONFLICT');}}return snapshot(request,maximum);};
 const result=await f.vaults.mutateBoard(await f.request());assert.equal(result.board.items.filter(item=>item.kind==='pdfPage').length,1);assert.deepEqual([...reads.values()],[2,2]);assert.equal(boardReads,1);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,result.sha256);
});
test('OneNote commit rejects three persistent source read conflicts, rolls back only its new files and keeps the board unchanged',async t=>{
 const f=await fixture(t),request=await f.request(),snapshot=f.vaults.snapshot.bind(f.vaults),commit=f.vaults.commitSnapshot.bind(f.vaults);let committing=false,reads=0;
 f.vaults.commitSnapshot=async(...args)=>{committing=true;try{return await commit(...args);}finally{committing=false;}};
 f.vaults.snapshot=async(input,maximum)=>{if(committing&&input.path.endsWith('/continuous.pdf')){reads++;throw new AppError('CONFLICT');}return snapshot(input,maximum);};
 await assert.rejects(f.vaults.mutateBoard(request),code('CONFLICT'));assert.equal(reads,3);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,request.expectedSHA256);assert.deepEqual(await files(f.root),[]);assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);
});
test('a transient read error followed by changed PDF bytes is rejected immediately and the external edit is preserved',async t=>{
 const f=await fixture(t),request=await f.request(),snapshot=f.vaults.snapshot.bind(f.vaults),commit=f.vaults.commitSnapshot.bind(f.vaults);let committing=false,reads=0,editedPath,edited;
 f.vaults.commitSnapshot=async(...args)=>{committing=true;try{return await commit(...args);}finally{committing=false;}};
 f.vaults.snapshot=async(input,maximum)=>{if(committing&&input.path.endsWith('/continuous.pdf')){reads++;if(reads===1){editedPath=input.path;edited=await annotatedPDF(await fs.readFile(path.join(f.root,input.path)),'Concurrent annotation during retry');await fs.writeFile(path.join(f.root,input.path),edited);throw new AppError('CONFLICT');}}return snapshot(input,maximum);};
 await assert.rejects(f.vaults.mutateBoard(request),code('CONFLICT'));assert.equal(reads,2);assert.deepEqual(await fs.readFile(path.join(f.root,editedPath)),edited);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,request.expectedSHA256);assert.deepEqual(await files(f.root),[editedPath]);assert.deepEqual(await fs.readFile(path.join(f.root,f.sourcePath)),f.source);
});
test('OneNote source retries never retry or weaken the final board writer snapshot',async t=>{
 const f=await fixture(t),request=await f.request(),snapshot=f.vaults.snapshot.bind(f.vaults),commit=f.vaults.commitSnapshot.bind(f.vaults);let committing=false,reads=0;
 f.vaults.commitSnapshot=async(...args)=>{committing=true;try{return await commit(...args);}finally{committing=false;}};
 f.vaults.snapshot=async(input,maximum)=>{if(committing&&input.path===f.opened.path){reads++;throw new AppError('CONFLICT');}return snapshot(input,maximum);};
 await assert.rejects(f.vaults.mutateBoard(request),code('CONFLICT'));assert.equal(reads,1);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.opened.path})).sha256,request.expectedSHA256);assert.deepEqual(await files(f.root),[]);
});
test('selecting an already referenced page retries its transient read but does not regenerate or mutate the board',async t=>{
 const f=await fixture(t),first=await f.vaults.mutateBoard(await f.request()),page=first.board.items.at(-1),pdf=await fs.readFile(path.join(f.root,page.sourcePath)),snapshot=f.vaults.snapshot.bind(f.vaults);let reads=0;
 f.vaults.snapshot=async(input,maximum)=>{if(input.path===page.sourcePath){reads++;if(reads===1)throw new AppError('CONFLICT');}return snapshot(input,maximum);};
 const result=await f.vaults.mutateBoard(await f.request());assert.equal(reads,3);assert.equal(result.unchanged,true);assert.equal(result.sha256,first.sha256);assert.deepEqual(result.board.items,first.board.items);assert.deepEqual(await fs.readFile(path.join(f.root,page.sourcePath)),pdf);
});

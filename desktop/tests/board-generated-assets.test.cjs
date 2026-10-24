'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {VaultService,digest}=require('../src/main/vault-service.cjs');
const {boardGeneratedAssetDirectory,ensureBoardGeneratedAssets}=require('../src/main/board-generated-assets.cjs');
const {pasteBoardContent}=require('../src/main/board-paste.cjs');
const {createPDFVisualExcerpt}=require('../src/main/pdf-visual-excerpt.cjs');
const {importSelectedImage}=require('../src/main/image-import.cjs');
const {grantFileURLs}=require('../src/main/clipboard-files.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
// These tests exercise real publication/board/history paths. The native decoder
// boundary returns a fixed validated PNG; image-decoding quality is out of scope.
const nativeImage={createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>png})};
const image={dataURL:'data:image/png;base64,'+png.toString('base64')};
async function fixture(t,boardPath='course/week/board.inkspace.json'){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'inkspace-generated-assets-test-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'vault');await fs.mkdir(path.dirname(path.join(root,boardPath)),{recursive:true});
 const vaults=new VaultService({dataDirectory:path.join(temp,'profile')}),vault=await vaults.grantVault(root),parent=path.posix.dirname(boardPath)==='.'?'':path.posix.dirname(boardPath);
 const opened=await vaults.createBoard({vaultId:vault.id,parentPath:parent,name:path.posix.basename(boardPath)});
 const request={vaultId:vault.id,path:boardPath,expectedSHA256:opened.sha256};
 const paste=(content={images:[image]})=>pasteBoardContent(vaults,{...request,content,x:100,y:100},{nativeImage});
 const source=Buffer.from('%PDF-1.4\n% independent synthetic source\n%%EOF\n');await fs.writeFile(path.join(root,'source.pdf'),source);
 const excerptRequest={...request,boardID:opened.board.id,itemID:crypto.randomUUID(),title:'Synthetic excerpt',sourceReference:{schemaVersion:1,path:'source.pdf',sourceSHA256:digest(source),page:1,rect:{x:0,y:0,width:.5,height:.5},quote:''},dataURL:image.dataURL,x:100,y:100};
 return{temp,root,vaults,vault,parent,opened,request,paste,excerptRequest};
}
test('generated directory is board-adjacent for root and nested boards; rejects traversal and private paths',()=>{
 assert.equal(boardGeneratedAssetDirectory('a.inkspace.json'),'白板资源');
 assert.equal(boardGeneratedAssetDirectory('course/week/a.inkspace.json'),'course/week/白板资源');
 for(const name of ['../a.inkspace.json','/a.inkspace.json','.hidden/a.inkspace.json','a.pdf'])assert.throws(()=>boardGeneratedAssetDirectory(name));
});
test('clipboard pixels publish in dedicated resources and survive native board Undo/Redo',async t=>{
 const f=await fixture(t),result=await f.paste(),node=result.board.items.find(n=>result.selectedIDs.includes(n.id));
 assert.match(node.sourcePath,/^course\/week\/白板资源\/Clipboard-[a-f0-9-]+\.png$/);
 assert.deepEqual(await fs.readFile(path.join(f.root,node.sourcePath)),png);
 assert.equal((await fs.readdir(path.join(f.root,f.parent))).filter(n=>n.endsWith('.png')).length,0);
 const reopened=await f.vaults.readFile(f.request);assert.equal(reopened.board.items.find(n=>n.id===node.id).sourcePath,node.sourcePath);
 const undone=await f.vaults.undoBoard({...f.request,expectedSHA256:reopened.sha256});assert(!undone.board.items.some(n=>n.id===node.id));
 const redone=await f.vaults.redoBoard({...f.request,expectedSHA256:undone.sha256});assert.equal(redone.board.items.find(n=>n.id===node.id).sourcePath,node.sourcePath);
 assert.deepEqual(await fs.readFile(path.join(f.root,node.sourcePath)),png);
});
test('root-level boards use the same dedicated folder',async t=>{
 const f=await fixture(t,'root.inkspace.json'),r=await f.paste();assert.match(r.board.items.find(n=>r.selectedIDs.includes(n.id)).sourcePath,/^白板资源\//);
});
test('ordinary text-only paste creates no asset folder',async t=>{
 const f=await fixture(t);await f.paste({text:{text:'synthetic text'}});await assert.rejects(fs.stat(path.join(f.root,f.parent,'白板资源')),{code:'ENOENT'});
});
test('ordinary selected image import keeps its requested folder',async t=>{
 const f=await fixture(t),source=path.join(f.temp,'ordinary.png');await fs.writeFile(source,png);
 const r=await importSelectedImage(f.vaults,{vaultId:f.vault.id,parentPath:f.parent},source);
 assert.equal(path.posix.dirname(r.path),f.parent);assert(!r.path.includes('白板资源'));assert.deepEqual(await fs.readFile(path.join(f.root,r.path)),png);
});
test('external clipboard file import retains its original source-card folder behavior',async t=>{
 const f=await fixture(t),source=path.join(f.temp,'ordinary.png');await fs.writeFile(source,png);
 const files=grantFileURLs(pathToFileURL(source).href),r=await f.paste({files}),node=r.board.items.find(n=>r.selectedIDs.includes(n.id));
 assert.equal(path.posix.dirname(node.sourcePath),f.parent);assert(!node.sourcePath.includes('白板资源'));
});
test('PDF visual excerpt publishes in resources, saves/reopens, and fixed-ID retry reuses it',async t=>{
 const f=await fixture(t),r=await createPDFVisualExcerpt(f.vaults,f.excerptRequest,{nativeImage}),node=r.board.items.find(n=>n.id===f.excerptRequest.itemID);
 assert.equal(node.sourcePath,f.parent+'/白板资源/Excerpt-'+f.excerptRequest.itemID+'.png');
 const retry=await createPDFVisualExcerpt(f.vaults,f.excerptRequest,{nativeImage});assert.equal(retry.reused,true);assert.equal(retry.sha256,r.sha256);
 assert.deepEqual(await fs.readFile(path.join(f.root,'source.pdf')),Buffer.from('%PDF-1.4\n% independent synthetic source\n%%EOF\n'));
 assert.equal((await fs.readdir(path.join(f.root,f.parent,'白板资源'))).length,1);
});
test('matching old-version excerpt orphan is reused in place without moving it',async t=>{
 const f=await fixture(t),legacy=f.parent+'/Excerpt-'+f.excerptRequest.itemID+'.png';await fs.writeFile(path.join(f.root,legacy),png);
 const r=await createPDFVisualExcerpt(f.vaults,f.excerptRequest,{nativeImage}),node=r.board.items.find(n=>n.id===f.excerptRequest.itemID);assert.equal(node.sourcePath,legacy);
 const retry=await createPDFVisualExcerpt(f.vaults,f.excerptRequest,{nativeImage});assert.equal(retry.reused,true);
 await assert.rejects(fs.stat(path.join(f.root,f.parent,'白板资源')),{code:'ENOENT'});
});
test('different old-version orphan content is preserved and blocks fixed-ID retry',async t=>{
 const f=await fixture(t),legacy=f.parent+'/Excerpt-'+f.excerptRequest.itemID+'.png',other=Buffer.from('existing different bytes');await fs.writeFile(path.join(f.root,legacy),other);
 await assert.rejects(createPDFVisualExcerpt(f.vaults,f.excerptRequest,{nativeImage}),{code:'CONFLICT'});assert.deepEqual(await fs.readFile(path.join(f.root,legacy)),other);
 assert.equal((await f.vaults.readFile(f.request)).sha256,f.opened.sha256);
});
test('symlink or ordinary file at reserved resource path is never followed or overwritten',async t=>{
 for(const kind of ['symlink','file']){
  const f=await fixture(t),folder=path.join(f.root,f.parent,'白板资源'),outside=path.join(f.temp,'outside');await fs.mkdir(outside);
  if(kind==='symlink')await fs.symlink(outside,folder);else await fs.writeFile(folder,'existing document');
  await assert.rejects(f.paste());assert.deepEqual(await fs.readdir(outside),[]);
  if(kind==='file')assert.equal(await fs.readFile(folder,'utf8'),'existing document');
  assert.equal((await f.vaults.readFile(f.request)).sha256,f.opened.sha256);
 }
});
test('resource directory identity is revalidated across replacement',async t=>{
 const f=await fixture(t),held=await ensureBoardGeneratedAssets(f.vaults,f.vault.id,f.request.path),folder=path.join(f.root,held.path);await fs.rename(folder,folder+'-old');await fs.mkdir(folder);
 await assert.rejects(held.revalidate(),{code:'CONFLICT'});
});
test('board commit failure rolls back only the new clipboard asset and preserves the board',async t=>{
 const f=await fixture(t);f.vaults.commitSnapshot=async()=>{throw Object.assign(Error('synthetic conflict'),{code:'CONFLICT'});};
 await assert.rejects(f.paste(),{code:'CONFLICT'});assert.deepEqual(await fs.readdir(path.join(f.root,f.parent,'白板资源')),[]);assert.equal((await f.vaults.readFile(f.request)).sha256,f.opened.sha256);
});

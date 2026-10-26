'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {VaultService,digest}=require('../src/main/vault-service.cjs'),{newBoard}=require('../src/main/board-elements.cjs'),{BoardVersions}=require('../src/main/board-versions.cjs'),{PNGOrganizationService}=require('../src/main/png-organization-service.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lifes-winner137-history-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const root=path.join(temp,'vault');await fs.mkdir(path.join(root,'week'),{recursive:true});
 const vaults=new VaultService({dataDirectory:path.join(temp,'profile')}),vault=await vaults.grantVault(root),board=newBoard('Legacy PNG',crypto.randomUUID()),file='week/legacy.inkspace.json',image='week/笔记图 Legacy.png';
 board.items=[{id:crypto.randomUUID(),kind:'document',title:'Original PNG',sourcePath:image,x:100,y:100,width:200,height:100}];await fs.writeFile(path.join(root,image),png);await fs.writeFile(path.join(root,file),JSON.stringify(board));
 const oldSHA=digest(await fs.readFile(path.join(root,file))),changed=await vaults.mutateBoard({vaultId:vault.id,path:file,expectedSHA256:oldSHA,operation:{type:'patchItems',items:[{id:board.items[0].id,title:'Changed title'}]}}),versions=new BoardVersions(vaults),service=new PNGOrganizationService(vaults,{decodePNG:(bytes,info)=>bytes.equals(png)&&info.width===1&&info.height===1,flagsGetter:async()=>0});
 return{temp,root,vaults,vault,board,file,image,oldSHA,changed,versions,service};
}
async function organize(f){const preview=await f.service.preview(137,{vaultId:f.vault.id,path:f.file,requestId:crypto.randomUUID()});assert.equal(preview.canCommit,true,JSON.stringify(preview.blockers));assert.equal(preview.moves.length,1);const result=await f.service.commit(137,{token:preview.token}),current=await f.vaults.readFile({vaultId:f.vault.id,path:f.file});return{preview,result,current,to:preview.moves[0].to};}
test('restoring an old version follows the verified PNG receipt only in the new copy and retains immutable history bytes',async t=>{
 const f=await fixture(t),object=path.join(f.vaults.boardHistory.root,'objects',f.oldSHA+'.bin'),before=await fs.readFile(object),r=await organize(f);
 const restored=await f.versions.restoreCopy({vaultId:f.vault.id,path:f.file,expectedSHA256:r.current.sha256,versionSHA256:f.oldSHA,name:'Restored.inkspace.json'});
 assert.equal(restored.board.items[0].sourcePath,r.to);assert.equal(restored.board.items[0].title,'Original PNG');assert.deepEqual(await fs.readFile(path.join(f.root,r.to)),png);assert.deepEqual(await fs.readFile(object),before);assert.equal(digest(before),f.oldSHA);assert.equal((await f.vaults.readFile({vaultId:f.vault.id,path:f.file})).sha256,r.current.sha256);
});
test('a changed organized PNG cannot be used to publish a historical copy',async t=>{
 const f=await fixture(t),r=await organize(f);await fs.writeFile(path.join(f.root,r.to),Buffer.from('newer image contents retained'));
 await assert.rejects(()=>f.versions.restoreCopy({vaultId:f.vault.id,path:f.file,expectedSHA256:r.current.sha256,versionSHA256:f.oldSHA,name:'Unsafe.inkspace.json'}),e=>e.code==='PNG_ORGANIZE_OLD_VERSION');
 assert.equal(await fs.readFile(path.join(f.root,r.to),'utf8'),'newer image contents retained');await assert.rejects(fs.stat(path.join(f.root,'week/Unsafe.inkspace.json')),{code:'ENOENT'});
});
test('an unrelated historical board remains restorable if another organized image later changes',async t=>{
 const f=await fixture(t),other=newBoard('Unrelated',crypto.randomUUID());other.items=[{id:crypto.randomUUID(),kind:'text',title:'Unrelated text',text:'Keep this text',x:1,y:1,width:100,height:50}];const otherPath='week/other.inkspace.json';await fs.writeFile(path.join(f.root,otherPath),JSON.stringify(other));const old=digest(await fs.readFile(path.join(f.root,otherPath))),changed=await f.vaults.mutateBoard({vaultId:f.vault.id,path:otherPath,expectedSHA256:old,operation:{type:'patchItems',items:[{id:other.items[0].id,title:'New unrelated title'}]}}),r=await organize(f);await fs.writeFile(path.join(f.root,r.to),'changed unrelated image');
 const copy=await f.versions.restoreCopy({vaultId:f.vault.id,path:otherPath,expectedSHA256:changed.sha256,versionSHA256:old,name:'Other copy.inkspace.json'});assert.equal(copy.board.items[0].text,'Keep this text');assert.equal(copy.board.items[0].title,'Unrelated text');
});

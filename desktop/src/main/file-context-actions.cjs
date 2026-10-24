'use strict';
// Metadata-only OS actions. A renderer supplies a vault token and relative path;
// absolute paths and arbitrary clipboard payloads are never accepted over IPC.
const fs=require('node:fs/promises'),path=require('node:path');
const {relativePath}=require('./vault-path.cjs'),{fail}=require('./errors.cjs');
async function contextTarget(vaults,request){
 if(typeof request.vaultId!=='string')fail('INVALID_REQUEST');
 const rel=relativePath(request.path);if(rel.split('/').some(part=>part.startsWith('.')))fail('PATH_DENIED');
 const parent=path.posix.dirname(rel)==='.'?'':path.posix.dirname(rel);
 const resolved=await vaults.resolve(request.vaultId,parent,{directory:true});
 const before=await fs.lstat(path.join(resolved.full,path.posix.basename(rel)));
 if(before.isSymbolicLink()||(!before.isDirectory()&&(!before.isFile()||before.nlink!==1)))fail('PATH_DENIED');
 const current=await vaults.resolve(request.vaultId,rel,{directory:before.isDirectory()});
 if(current.stat.dev!==before.dev||current.stat.ino!==before.ino)fail('CONFLICT');
 return{...current,path:rel,directory:before.isDirectory()};
}
async function revealInFinder(vaults,request,{shell}){
 const target=await contextTarget(vaults,request);shell.showItemInFolder(target.full);return{revealed:true};
}
async function copyFileReference(vaults,request,{clipboard}){
 if(!['path','link'].includes(request.kind))fail('INVALID_REQUEST');
 const target=await contextTarget(vaults,request);
 if(request.kind==='link'&&target.directory)fail('UNSUPPORTED');
 let text=target.path;
 if(request.kind==='link'){const url=new URL('inkspace://open');url.searchParams.set('file',target.path);text=url.href;}
 clipboard.writeText(text);return{copied:true};
}
module.exports={contextTarget,revealInFinder,copyFileReference};

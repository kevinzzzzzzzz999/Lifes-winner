'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {relativePath}=require('./vault-path.cjs'),{fail}=require('./errors.cjs');
const BOARD_ASSET_FOLDER='白板资源';

// Only program-created clipboard pixels and PDF visual excerpts use this path.
// Ordinary image imports, source documents and existing references are untouched.
function boardGeneratedAssetDirectory(boardPath){
 relativePath(boardPath);
 if(!boardPath.toLowerCase().endsWith('.inkspace.json')||boardPath.split('/').some(part=>part.startsWith('.')))fail('PATH_DENIED');
 const parent=path.posix.dirname(boardPath);
 return parent==='.'?BOARD_ASSET_FOLDER:parent+'/'+BOARD_ASSET_FOLDER;
}
async function ensureBoardGeneratedAssets(vaults,vaultId,boardPath){
 const relative=boardGeneratedAssetDirectory(boardPath),parent=path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative);
 const before=await vaults.resolve(vaultId,parent,{directory:true});
 const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
 const checkParent=async()=>{const current=await vaults.resolve(vaultId,parent,{directory:true});if(!same(before.stat,current.stat))fail('CONFLICT');};
 await checkParent();
 try{await fs.mkdir(path.join(before.full,BOARD_ASSET_FOLDER),{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 await checkParent();
 // resolve retains all normal vault/symlink checks; a substituted regular file
 // or linked folder is rejected rather than selecting another directory name.
 const directory=await vaults.resolve(vaultId,relative,{directory:true});
 const revalidate=async()=>{await checkParent();const current=await vaults.resolve(vaultId,relative,{directory:true});if(!same(directory.stat,current.stat))fail('CONFLICT');return current;};
 await revalidate();return{path:relative,revalidate};
}
module.exports={BOARD_ASSET_FOLDER,boardGeneratedAssetDirectory,ensureBoardGeneratedAssets};

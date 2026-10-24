import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Run only when the product owner has frozen production sources and the latest
// renderer build. Verification rejects subsequent changes or missing package files.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const files={};
async function add(relative){const data=await fs.readFile(path.join(root,relative));files[relative]={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};}
for(const top of ['src','dist/renderer','runtime/latex','runtime/notebook']){
 const queue=[top];
 while(queue.length){const directory=queue.pop();for(const entry of await fs.readdir(path.join(root,directory),{withFileTypes:true})){
  const relative=path.posix.join(directory,entry.name);
  if(entry.isDirectory())queue.push(relative);else if(entry.isFile()&&entry.name!=='.DS_Store')await add(relative);
 }}
}
for(const relative of ['package.json','package-lock.json','electron-builder.cjs','runtime/PROVENANCE.json'])await add(relative);
const manifest={createdAt:new Date().toISOString(),version,scope:'Frozen desktop production and built renderer inputs; no user vault.',files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))};
await fs.mkdir(path.join(root,'build/evidence'),{recursive:true});
await fs.writeFile(path.join(root,'build/evidence/packaging-inputs.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({version,inputFiles:Object.keys(files).length}));

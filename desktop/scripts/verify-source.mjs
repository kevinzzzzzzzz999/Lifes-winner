import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'release-baseline/build142.json'),'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const failures=[];
for(const[relative,expected]of Object.entries(manifest.baselineSourceFiles)){
 const file=path.join(root,relative);
 if(!fs.existsSync(file)||sha(file)!==expected)failures.push(relative);
}
for(const[relative,expected]of Object.entries(manifest.rendererFiles)){
 const file=path.join(root,'dist/renderer',relative);
 if(!fs.existsSync(file)||sha(file)!==expected)failures.push('dist/renderer/'+relative);
}
if(failures.length){console.error('Source or built renderer differs from frozen build142:',failures.join('\n'));process.exitCode=1;}
else console.log(`build142 verified: ${Object.keys(manifest.baselineSourceFiles).length} source inputs and ${manifest.rendererFileCount} original renderer resources match. New release tooling and prepared PDF.js resources are documented separately.`);

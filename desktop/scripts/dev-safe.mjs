import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn(process.execPath,[path.join(root,'node_modules/electron/cli.js'),path.join(root,'scripts/dev-safe-bootstrap.cjs')],{cwd:root,env:{...process.env,INKSPACE_DISABLE_NOTIFICATIONS:'1'},stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});

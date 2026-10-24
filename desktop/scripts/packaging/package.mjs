import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.argv[2];
if (!['mac', 'win'].includes(target)) throw new Error('Expected mac or win target');
for (const relative of ['src/main/main.cjs', 'src/preload/preload.cjs', 'dist/renderer/index.html', 'runtime/PROVENANCE.json', 'LICENSES/npm-dependencies.json']) {
  if (!fs.statSync(path.join(root, relative)).isFile()) throw new Error('Missing packaged input: ' + relative);
}
if(target==='mac'&&!fs.existsSync(path.join(root,'runtime/native-ink/darwin-arm64/InkSpaceInkHelper.app/Contents/MacOS/InkSpaceInkHelper')))throw new Error('Build the native handwriting helper before packaging Mac');
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
env.PATH = [path.dirname(process.execPath), path.join(root, 'scripts/packaging/.tools/bin'), env.PATH ?? ''].join(path.delimiter);
for (const key of Object.keys(env)) if (/^(CSC_|WIN_CSC_)/.test(key) && key !== 'CSC_IDENTITY_AUTO_DISCOVERY') delete env[key];
const flags = target === 'mac' ? ['--mac', 'dmg', '--arm64'] : ['--win', 'nsis', '--x64'];
const logDirectory = path.join(root, 'build/evidence');
fs.mkdirSync(logDirectory, { recursive: true });
const log = fs.createWriteStream(path.join(logDirectory, `package-${target}.log`));
const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--config', 'electron-builder.cjs', ...flags, '--publish', 'never'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
child.on('error', error => { log.end(); console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { log.end(); process.exitCode = code ?? 1; });

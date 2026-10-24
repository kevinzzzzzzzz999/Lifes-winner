import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js');
const { NtExecutable, NtExecutableResource } = require('pe-library');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'release');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frozen = JSON.parse(await fs.readFile(path.join(root, 'build/evidence/packaging-inputs.json'), 'utf8'));
if (frozen.version !== expectedVersion) throw new Error('Frozen manifest has a different version');
for (const [relative, metadata] of Object.entries(frozen.files)) {
  if (sha(await fs.readFile(path.join(root, relative))) !== metadata.sha256) throw new Error('Input changed after freeze: ' + relative);
}
const expectedPackaged = Object.keys(frozen.files).filter(x => /^(src\/(main|preload)\/|dist\/renderer\/)/.test(x) && !x.endsWith('.map') && !x.endsWith('/.DS_Store'));
const results = { frozenInputFilesChecked: Object.keys(frozen.files).length, schemaVersion: 1, version: expectedVersion, macOSRuntimeTested: false, windowsRuntimeTested: false, windowsInstallerExecuted: false, storeSigned: false, notarized: false, artifacts: [], packages: [] };
for (const target of [
  { platform: 'darwin-arm64', resources: path.join(output, 'mac-arm64/人生赢家.app/Contents/Resources'), executable: 'bin/python3' },
  { platform: 'win32-x64', resources: path.join(output, 'win-unpacked/resources'), executable: 'python.exe' }
]) {
  const archive = path.join(target.resources, 'app.asar');
  const files = asar.listPackage(archive);
  for (const relative of expectedPackaged) if (!files.includes('/' + relative)) throw new Error('Frozen input missing from package: ' + relative);
  for (const required of ['/src/main/main.cjs', '/src/preload/preload.cjs', '/dist/renderer/index.html']) {
    if (!files.includes(required)) throw new Error('Missing ASAR file: ' + required);
  }
  let comparedFiles = 0;
  for (const file of files.filter(x => /^\/(src\/(main|preload)\/|dist\/renderer\/)/.test(x))) {
    if (asar.statFile(archive, file.substring(1)).files) continue;
    const relative = file.substring(1);
    let input;
    try { input = await fs.readFile(path.join(root, relative)); } catch { continue; }
    if (sha(asar.extractFile(archive, relative)) !== sha(input)) throw new Error('Packaged input differs: ' + relative);
    comparedFiles++;
  }
  if (files.some(x => x.endsWith('.node'))) throw new Error('Unexpected application native Node addon');
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (pkg.version !== expectedVersion || pkg.main !== 'src/main/main.cjs') throw new Error('Wrong packaged app metadata');
  const runtimeDirectory = path.join(target.resources, 'runtime/python', target.platform);
  const python = path.join(runtimeDirectory, target.executable);
  const nativeBytes = await fs.readFile(python);
  const reference = await fs.readFile(path.join(root, 'runtime/python', target.platform, target.executable));
  if (sha(nativeBytes) !== sha(reference)) throw new Error('Packaged Python differs from verified runtime');
  const dirs = await fs.readdir(path.join(target.resources, 'runtime/python'));
  if (dirs.length !== 1 || dirs[0] !== target.platform) throw new Error('Wrong platform Python included');
  if (target.platform === 'darwin-arm64') {
    const check = JSON.parse(execFileSync(python, ['-I', '-S', '-B', '-c', 'import sys,json,sqlite3,ssl,decimal; print(json.dumps({"version":sys.version.split()[0],"sum":sum(range(101)),"decimal":str(decimal.Decimal("0.1")+decimal.Decimal("0.2")),"sqlite":sqlite3.sqlite_version,"ssl":bool(ssl.OPENSSL_VERSION)}))'], { encoding: 'utf8', timeout: 15000 }));
    if (check.version !== '3.14.7' || check.sum !== 5050 || check.decimal !== '0.3' || !check.ssl) throw new Error('Bundled macOS Python failed');
    results.macOSRuntimeTested = true;
  } else {
    if (nativeBytes.toString('ascii', 0, 2) !== 'MZ' || nativeBytes.readUInt16LE(nativeBytes.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error('Windows Python is not x64 PE');
    await fs.stat(path.join(runtimeDirectory, 'python314.zip'));
    await fs.stat(path.join(runtimeDirectory, 'python314.dll'));
    const mainBytes = await fs.readFile(path.join(output, 'win-unpacked/人生赢家.exe'));
    if (mainBytes.readUInt16LE(mainBytes.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error('Windows application is not x64');
    const resources = NtExecutableResource.from(NtExecutable.from(mainBytes));
    if (!resources.entries.some(x => x.type === 14) || !resources.entries.some(x => x.type === 16 && Buffer.from(x.bin).includes(Buffer.from('人生赢家', 'utf16le')))) throw new Error('Windows icon/product name resources missing');
  }
  const latexInputs=Object.keys(frozen.files).filter(relative=>relative==='runtime/latex/PROVENANCE.json'||relative.startsWith('runtime/latex/basic-cache/')||relative.startsWith('runtime/latex/'+target.platform+'/'));
  if(!latexInputs.some(relative=>/\/tectonic(?:\.exe)?$/.test(relative)))throw new Error('LaTeX runtime missing from frozen inputs');
  for(const relative of latexInputs)if(sha(await fs.readFile(path.join(target.resources,relative)))!==frozen.files[relative].sha256)throw new Error('Packaged LaTeX input differs: '+relative);
  const otherPlatform=target.platform==='darwin-arm64'?'win32-x64':'darwin-arm64';
  try{await fs.stat(path.join(target.resources,'runtime/latex',otherPlatform));throw new Error('Wrong-platform LaTeX runtime was packaged');}catch(e){if(e.code!=='ENOENT')throw e;}
  results[target.platform==='darwin-arm64'?'macLaTeXRuntimeFilesVerified':'windowsLaTeXRuntimeFilesVerified']=latexInputs.length;
  await fs.stat(path.join(target.resources, 'LICENSES/npm-dependencies.json'));
  results.packages.push({ platform: target.platform, appASARSHA256: sha(await fs.readFile(archive)), pythonExecutableSHA256: sha(nativeBytes), pythonVersion: '3.14.7', onlyMatchingPlatformRuntimeIncluded: true, entryAndRendererPresent: true, nativeNodeAddons: 0, sourceAndRendererFilesCompared: comparedFiles, allFrozenPackagedInputsPresent: true, comparedFilesByteIdentical: true });
}
for (const filename of (await fs.readdir(output)).filter(x => /\.(dmg|exe)$/.test(x))) {
  const full = path.join(output, filename);
  const bytes = await fs.readFile(full);
  if (filename.endsWith('.exe')) execFileSync(await getPath7za(), ['t', full], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  else execFileSync('/usr/bin/hdiutil', ['verify', full], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  results.artifacts.push({ filename, bytes: bytes.length, sha256: sha(bytes), containerIntegrityPassed: true });
}
if (results.artifacts.length !== 2) throw new Error('Expected one DMG and one NSIS installer');
await fs.mkdir(path.join(root, 'build/evidence'), { recursive: true });
await fs.writeFile(path.join(root, 'build/evidence/artifacts.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));

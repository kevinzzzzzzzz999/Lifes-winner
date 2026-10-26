import fs from 'node:fs/promises';
import path from 'node:path';
import { desktop, work, output, sha256, run, writeJSON, buildDependency, exists } from './common.mjs';

const target = process.argv[2];
if (target && !['mac', 'win'].includes(target)) throw Error('Usage: node scripts/release/verify.mjs [mac|win]');
const targets = target ? [target] : ['mac', 'win'];
const results = [];
for (const value of targets) {
  const receiptFile = path.join(work, `last-package-${value}.json`);
  if (!await exists(receiptFile)) { if (target) throw Error('No completed package for ' + value); continue; }
  const packaged = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  const inputs = JSON.parse(await fs.readFile(path.join(work, 'app-inputs.json'), 'utf8'));
  const archive = path.join(output, packaged.filename);
  if (sha256(await fs.readFile(archive)) !== packaged.sha256) throw Error('Packaged container hash changed');
  const resources = value === 'mac' ? path.join(packaged.candidate, 'Contents/Resources') : path.join(output, 'win-unpacked/resources');
  const application = path.join(resources, 'app.asar');
  const asar = buildDependency('@electron/asar');
  if (sha256(await fs.readFile(application)) !== packaged.appASARSHA256 || inputs.sha256 !== packaged.appASARSHA256) throw Error('Application archive differs from frozen inputs; verify immediately after each build.');
  let compared = 0;
  for (const [relative, item] of Object.entries(inputs.files)) {
    const bytes = asar.extractFile(application, relative);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw Error('Application file differs: ' + relative); compared++;
  }
  const result = { target: value, filename: packaged.filename, sha256: packaged.sha256, bytes: packaged.bytes, appASARSHA256: packaged.appASARSHA256, applicationFilesCompared: compared, runtimeExecuted: false, functionalAcceptancePassed: false };
  result.runtimeSourceFilesCompared = 0;
  const notebookSources = path.join(desktop, 'runtime-src/notebook');
  if (await exists(notebookSources)) for (const entry of await fs.readdir(notebookSources, { withFileTypes: true })) {
    if (!entry.isFile() || !(entry.name === 'kernel.py' || /^requirements.*\.lock$/.test(entry.name) || ['PROVENANCE.json', 'FILES.json'].includes(entry.name))) continue;
    const original = await fs.readFile(path.join(notebookSources, entry.name));
    const bundled = await fs.readFile(path.join(resources, 'runtime/notebook', entry.name));
    if (sha256(original) !== sha256(bundled)) throw Error('Runtime source differs: ' + entry.name);
    result.runtimeSourceFilesCompared++;
  }
  if (value === 'mac') {
    if (process.platform !== 'darwin') throw Error('Verify macOS signatures on a Mac');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', packaged.candidate]);
    const { execFileSync } = await import('node:child_process');
    const actual = JSON.parse(execFileSync('/usr/bin/plutil', ['-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', path.join(packaged.candidate, 'Contents/Info.plist')], { encoding: 'utf8' }));
    if (actual['Resources/app.asar']?.hash !== sha256(Buffer.from(asar.getRawHeader(application).headerString))) throw Error('macOS ASAR integrity metadata mismatch');
    const roundTrip = path.join(work, 'verification-mac-roundtrip');
    await fs.rm(roundTrip, { recursive: true, force: true }); await fs.mkdir(roundTrip, { recursive: true });
    await run('/usr/bin/ditto', ['-x', '-k', archive, roundTrip]);
    const extractedApp = path.join(roundTrip, '人生赢家.app');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp]);
    if (sha256(await fs.readFile(path.join(extractedApp, 'Contents/Resources/app.asar'))) !== packaged.appASARSHA256) throw Error('ZIP round-trip changed application code');
    result.strictSignatureVerified = true; result.archiveRoundTripVerified = true; result.notarized = false;
  } else {
    const { execFileSync } = await import('node:child_process');
    process.env.ELECTRON_BUILDER_CACHE = path.join(work, 'tool-cache');
    process.env.ELECTRON_BUILDER_7ZIP_PATH = JSON.parse(await fs.readFile(path.join(work, 'prepared-win.json'), 'utf8')).sevenZipExecutable;
    const { getPath7za } = buildDependency('app-builder-lib/out/toolsets/7zip.js');
    const test = execFileSync(await getPath7za(), ['t', archive], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (!test.includes('Everything is Ok')) throw Error('Installer container test failed');
    const peFiles = [path.join(output, 'win-unpacked/人生赢家.exe'), path.join(resources, 'runtime/python/win32-x64/python.exe'), path.join(resources, 'runtime/latex/win32-x64/tectonic.exe')];
    for (const file of peFiles) {
      const data = await fs.readFile(file); if (data.toString('ascii', 0, 2) !== 'MZ' || data.readUInt16LE(data.readUInt32LE(0x3c) + 4) !== 0x8664) throw Error('Not a Windows x64 PE executable: ' + path.basename(file));
    }
    const latex = JSON.parse(await fs.readFile(path.join(resources, 'runtime/latex/PROVENANCE.json'), 'utf8'));
    for (const file of latex.basicCache.files) { const data = await fs.readFile(path.join(resources, 'runtime/latex/basic-cache', file.path)); if (data.length !== file.bytes || sha256(data) !== file.sha256) throw Error('TeX cache changed: ' + file.path); }
    result.containerIntegrityPassed = true; result.windowsExecutablesX64 = true; result.checkedTeXCacheFiles = latex.basicCache.files.length; result.installerExecuted = false; result.signed = false;
  }
  await writeJSON(path.join(output, `verification-${value}.json`), result);
  await fs.writeFile(path.join(output, `${packaged.filename}.sha256`), packaged.sha256 + '  ' + packaged.filename + '\n');
  results.push(result);
}
if (!results.length) throw Error('No completed artifacts. Run npm run pack:mac or npm run pack:win first.');
console.log(JSON.stringify(results, null, 2));

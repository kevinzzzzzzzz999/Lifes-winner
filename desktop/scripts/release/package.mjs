import fs from 'node:fs/promises';
import path from 'node:path';
import { desktop, work, output, baseline, options, run, sha256, writeJSON, require, buildDependency, exists } from './common.mjs';
import { prepare } from './prepare.mjs';
import { buildASAR } from './build-asar.mjs';
import { collectLicenses } from './licenses.mjs';
import { overlayRuntimeSources, overlayNative } from './overlays.mjs';

const opts = options();
if (!opts.skipBuild) await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
const prepared = await prepare(opts);
const inputs = await buildASAR();
const licenses = await collectLicenses();
await fs.mkdir(output, { recursive: true });
if (opts.target === 'mac') {
  const parent = path.join(work, 'mac-candidate');
  const candidate = path.join(parent, '人生赢家.app');
  await fs.mkdir(parent, { recursive: true });
  await fs.rm(candidate, { recursive: true, force: true });
  await run('/usr/bin/ditto', [prepared.baselineApp, candidate]);
  const resources = path.join(candidate, 'Contents/Resources');
  await fs.cp(licenses, path.join(resources, 'LICENSES'), { recursive: true });
  const runtimeSourceOverrides = await overlayRuntimeSources(resources);
  const nativeHelpersRebuilt = await overlayNative(resources);
  await fs.copyFile(inputs.archive, path.join(resources, 'app.asar'));
  const plist = path.join(candidate, 'Contents/Info.plist');
  const integrityHash = sha256(Buffer.from(buildDependency('@electron/asar').getRawHeader(inputs.archive).headerString));
  const patch = { version: inputs.version, integrityHash };
  // plutil uses the literal slash as part of the dictionary key here. Python's
  // plistlib avoids key-path escaping ambiguity and preserves the other metadata.
  await run('/usr/bin/python3', ['-c', 'import json,plistlib,sys;p=sys.argv[1];v=json.loads(sys.argv[2]);d=plistlib.load(open(p,"rb"));d["CFBundleShortVersionString"]=v["version"];d.setdefault("ElectronAsarIntegrity",{})["Resources/app.asar"]={"algorithm":"SHA256","hash":v["integrityHash"]};plistlib.dump(d,open(p,"wb"))', plist, JSON.stringify(patch)]);
  require(path.join(desktop, 'scripts/packaging/app-branding.cjs')).assertFrameworkHelperLookup(candidate);
  const identity = process.env.INKSPACE_MAC_SIGN_IDENTITY || '-';
  // Only the candidate's outer signature changes. All baseline nested helper
  // signatures, entitlements and framework binaries remain intact.
  await run('/usr/bin/codesign', ['--force', '--sign', identity, '--preserve-metadata=entitlements,flags', '--timestamp=none', candidate]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]);
  const filename = `Lifes-Winner-${inputs.version}-mac-arm64-rebuilt.zip`;
  const archive = path.join(output, filename);
  await fs.rm(archive, { force: true });
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', candidate, archive]);
  await writeJSON(path.join(work, 'last-package-mac.json'), { target: 'mac', filename, candidate, appASARSHA256: inputs.sha256, bytes: (await fs.stat(archive)).size, sha256: sha256(await fs.readFile(archive)), baselineSHA256: baseline.sha256, runtimeSourceOverrides, nativeHelpersRebuilt, signer: identity === '-' ? 'ad hoc' : 'explicitly configured identity', notarized: false, launched: false });
  console.log('Created ' + path.relative(desktop, archive));
} else {
  await fs.cp(licenses, path.join(prepared.resources, 'LICENSES'), { recursive: true });
  const metadata = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'));
  const appDir = path.join(work, 'windows-app'); await fs.mkdir(appDir, { recursive: true });
  await writeJSON(path.join(appDir, 'package.json'), { name: metadata.name, productName: metadata.productName, version: metadata.version, description: metadata.description, author: metadata.author, license: metadata.license, main: metadata.main });
  await fs.copyFile(path.join(desktop, 'scripts/release/WINDOWS-NOTES.txt'), path.join(prepared.resources, 'WINDOWS-NOTES.txt'));
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_CACHE: path.join(work, 'tool-cache'), ELECTRON_BUILDER_NSIS_DIR: prepared.nsisDirectory, ELECTRON_BUILDER_NSIS_RESOURCES_DIR: prepared.nsisDirectory, ELECTRON_BUILDER_7ZIP_PATH: prepared.sevenZipExecutable };
  env.PATH = [path.dirname(process.execPath), env.PATH || ''].join(path.delimiter);
  for (const key of Object.keys(env)) if (/^(CSC_|WIN_CSC_)/.test(key) && key !== 'CSC_IDENTITY_AUTO_DISCOVERY') delete env[key];
  await run(process.execPath, [require.resolve('electron-builder/cli.js'), '--projectDir', appDir, '--config', path.join(desktop, 'electron-builder.cjs'), '--win', 'nsis', '--x64', '--publish', 'never'], { env });
  const filename = `Lifes-Winner-${inputs.version}-Windows-x64-Setup.exe`;
  const archive = path.join(output, filename);
  if (!await exists(archive)) throw Error('Expected installer missing');
  await writeJSON(path.join(work, 'last-package-win.json'), { target: 'win', filename, appASARSHA256: inputs.sha256, bytes: (await fs.stat(archive)).size, sha256: sha256(await fs.readFile(archive)), signed: false, windowsInstallerExecuted: false, windowsFunctionalAcceptancePassed: false });
  console.log('Created ' + path.relative(desktop, archive));
}

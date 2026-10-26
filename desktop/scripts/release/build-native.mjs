import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { desktop, work, options, run, sha256, writeJSON } from './common.mjs';
import { prepare } from './prepare.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Native Apple helpers require an Apple Silicon Mac with Xcode.');
const args = process.argv.slice(2); const requested = args.indexOf('--only');
let selected;
if (requested >= 0) { selected = (args[requested + 1] || '').split(','); args.splice(requested, 2); }
const opts = options(args[0] === 'mac' ? args : ['mac', ...args]);
const prepared = await prepare(opts);
const definitions = [
  { name: 'ink', version: '5', minimum: '13.0', bundle: 'runtime/native-ink/darwin-arm64/InkSpaceInkHelper.app', executable: 'InkSpaceInkHelper', sources: ['src/native/NativeInkCore.swift', 'src/native/InkSpaceInkHelper.swift'] },
  { name: 'ocr', version: '5', minimum: '13.0', output: 'runtime/nativeOCR/darwin-arm64/InkSpaceOCR', sources: ['src/native/ocr/LocalOCR.swift', 'src/native/ocr/LocalOCRCLI.swift'] },
  { name: 'pdf-info', version: '5', minimum: '13.0', output: 'runtime/relink-pdf-info/inkspace-relink-pdf-info', sources: ['src/native/RelinkPDFInfo.swift'] },
  { name: 'dictation', version: '5', minimum: '26.0', bundle: 'runtime/dictation/darwin-arm64/InkSpaceDictation.app', executable: 'InkSpaceDictation', sources: ['src/native/dictation/DictationTranscript.swift', 'src/native/dictation/InkSpaceDictation.swift'] },
  { name: 'recorder', version: '5', minimum: '13.0', bundle: 'runtime/recognition-recorder/darwin-arm64/RecognitionRecorder.app', executable: 'RecognitionRecorder', sources: ['src/native/recording/RecognitionRecorder.swift'] },
  { name: 'mail', version: '6', minimum: '14.0', library: true, bundle: 'helpers/WorkMailHelper.app', executable: 'WorkMailHelper', sources: ['scripts/work-mail-helper/main.swift', 'scripts/work-mail-helper/WorkMailCore.swift', 'scripts/work-mail-helper/WorkNotifications.swift'] }
];
if (selected?.some(name => !definitions.some(item => item.name === name))) throw Error('Unknown --only helper; use ink,ocr,pdf-info,dictation,recorder,mail');
const root = path.join(work, 'native-overrides');
await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
const identity = process.env.INKSPACE_MAC_SIGN_IDENTITY || '-';
const sourceHashes = {}, helpers = [];
for (const item of definitions.filter(item => !selected || selected.includes(item.name))) {
  let executable, entitlements;
  if (item.bundle) {
    const bundle = path.join(root, item.bundle); await fs.mkdir(path.dirname(bundle), { recursive: true });
    await run('/usr/bin/ditto', [path.join(prepared.baselineApp, 'Contents/Resources', item.bundle), bundle]);
    const inherited = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundle], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (inherited.includes(Buffer.from('<plist'))) {
      entitlements = path.join(work, 'native-entitlements', item.name + '.plist');
      await fs.mkdir(path.dirname(entitlements), { recursive: true }); await fs.writeFile(entitlements, inherited);
    }
    if (['dictation', 'recorder'].includes(item.name)) {
      entitlements ||= path.join(work, 'native-entitlements', item.name + '.plist');
      await fs.mkdir(path.dirname(entitlements), { recursive: true });
      // These are the explicit entitlements in the helpers' source build recipes.
      await run('/usr/bin/python3', ['-c', 'import pathlib,plistlib,sys;p=pathlib.Path(sys.argv[1]);d=plistlib.loads(p.read_bytes()) if p.exists() else {};d["com.apple.security.device.audio-input"]=True;p.write_bytes(plistlib.dumps(d))', entitlements]);
    }
    executable = path.join(bundle, 'Contents/MacOS', item.executable);
  } else { executable = path.join(root, item.output); await fs.mkdir(path.dirname(executable), { recursive: true }); }
  const sourcePaths = item.sources.map(relative => path.join(desktop, relative));
  for (const relative of item.sources) sourceHashes[relative] = sha256(await fs.readFile(path.join(desktop, relative)));
  const flags = ['--sdk', 'macosx', 'swiftc', '-swift-version', item.version, '-O', '-target', 'arm64-apple-macos' + item.minimum, '-sdk', sdk, '-module-cache-path', path.join(work, 'swift-module-cache')];
  if (item.library) flags.push('-parse-as-library');
  await run('xcrun', [...flags, ...sourcePaths, '-o', executable]);
  const signed = item.bundle ? path.join(root, item.bundle) : executable;
  const sign = ['--force', '--sign', identity, '--timestamp=none'];
  if (entitlements) sign.push('--entitlements', entitlements);
  await run('/usr/bin/codesign', [...sign, signed]);
  await run('/usr/bin/codesign', ['--verify', '--strict', signed]);
  helpers.push({ name: item.name, output: item.bundle || item.output, minimumMacOS: item.minimum, executableSHA256: sha256(await fs.readFile(executable)) });
}
await writeJSON(path.join(root, 'receipt.json'), { createdUTC: new Date().toISOString(), helpers, sources: sourceHashes, run: false, installed: false, microphoneOpened: false, signer: identity === '-' ? 'ad hoc' : 'explicit identity' });
console.log(JSON.stringify({ rebuiltHelpers: helpers.map(item => item.name), overlayUsedByNextMacPackage: true, helperExecuted: false }, null, 2));

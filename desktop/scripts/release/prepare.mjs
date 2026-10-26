import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktop, work, baseline, windowsComponents, hostArchiveTool, checkedArchive, options, sha256, run, writeJSON, exists, safeExtractZip } from './common.mjs';
import { overlayRuntimeSources, overlayNative } from './overlays.mjs';

const prefix = '人生赢家.app/Contents/Resources/';
export async function prepare(opts) {
  const baseArchive = await checkedArchive(baseline, opts, opts.baselineFile);
  const macRoot = path.join(work, 'baseline-mac');
  const baselineApp = path.join(macRoot, '人生赢家.app');
  if (opts.target === 'mac') {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('The complete Mac baseline workflow requires an Apple Silicon Mac.');
    // ditto preserves framework links, executable modes and macOS resource metadata.
    if (!await exists(baselineApp)) { await fs.mkdir(macRoot, { recursive: true }); await run('/usr/bin/ditto', ['-x', '-k', baseArchive, macRoot]); }
    const resources = path.join(baselineApp, 'Contents/Resources');
    if (sha256(await fs.readFile(path.join(resources, 'app.asar'))) !== baseline.appASARSHA256) throw Error('Extracted baseline application differs from build142');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baselineApp]);
    if (opts.development) {
      const development = path.join(work, 'development-resources');
      await fs.mkdir(development, { recursive: true });
      await fs.cp(path.join(resources, 'runtime'), path.join(development, 'runtime'), { recursive: true });
      await fs.cp(path.join(resources, 'helpers'), path.join(development, 'helpers'), { recursive: true });
      await overlayRuntimeSources(development); await overlayNative(development);
      for (const [source, destination] of [[path.join(development, 'runtime'), path.join(desktop, 'runtime')], [path.join(development, 'helpers/WorkMailHelper.app'), path.join(desktop, 'build/WorkMailHelper.app')]]) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (!await exists(destination)) await fs.symlink(source, destination, 'dir');
        else if (await fs.realpath(destination) !== await fs.realpath(source)) throw Error('Existing development resource retained; remove/relocate it deliberately before linking: ' + destination);
      }
    }
    const value = { target: 'mac', baselineArchiveSHA256: baseline.sha256, baselineApp, nativeHelpers: 'Reused unchanged from the pinned release; not rebuilt by this script', notarized: false };
    await writeJSON(path.join(work, 'prepared-mac.json'), value); return value;
  }

  const resources = path.join(work, 'windows-resources');
  const extracted = path.join(work, 'baseline-resources');
  await safeExtractZip(baseArchive, extracted, file => file.startsWith(prefix + 'LICENSES/') || file === prefix + 'runtime/latex/PROVENANCE.json' || file.startsWith(prefix + 'runtime/latex/basic-cache/'));
  await fs.mkdir(resources, { recursive: true });
  await fs.cp(path.join(extracted, prefix, 'LICENSES'), path.join(resources, 'LICENSES'), { recursive: true });
  await fs.cp(path.join(extracted, prefix, 'runtime/latex'), path.join(resources, 'runtime/latex'), { recursive: true });
  const latex = JSON.parse(await fs.readFile(path.join(resources, 'runtime/latex/PROVENANCE.json'), 'utf8'));
  for (const file of latex.basicCache.files) {
    const data = await fs.readFile(path.join(resources, 'runtime/latex/basic-cache', file.path));
    if (data.length !== file.bytes || sha256(data) !== file.sha256) throw Error('Baseline TeX cache differs: ' + file.path);
  }
  const archives = new Map();
  for (const entry of windowsComponents) archives.set(entry.name, await checkedArchive(entry, opts));
  await safeExtractZip(archives.get('Python'), path.join(resources, 'runtime/python/win32-x64'));
  await safeExtractZip(archives.get('Tectonic'), path.join(resources, 'runtime/latex/win32-x64'));
  if (sha256(await fs.readFile(path.join(resources, 'runtime/latex/win32-x64/tectonic.exe'))) !== '99ffcfdbf1ebf8bdda9e791942e3d06aedb12463fddc33f07de6f5211c8bf08d') throw Error('Tectonic executable differs');
  const electronLicenses = path.join(work, 'windows-electron-licenses');
  await safeExtractZip(archives.get('Electron'), electronLicenses, file => ['LICENSE', 'LICENSES.chromium.html'].includes(file));
  await fs.copyFile(path.join(electronLicenses, 'LICENSE'), path.join(resources, 'LICENSES/Electron-LICENSE.txt'));
  await fs.copyFile(path.join(electronLicenses, 'LICENSES.chromium.html'), path.join(resources, 'LICENSES/Electron-Chromium-LICENSES.html'));
  await writeJSON(path.join(resources, 'LICENSES/Electron-PROVENANCE.json'), windowsComponents[0]);
  const nsis = path.join(work, 'tools/nsis');
  await fs.mkdir(nsis, { recursive: true });
  // The archive is pinned to electron-builder's official SHA-256. System bsdtar
  // on macOS and Windows 10/11 can extract this bundle without executing it.
  await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', archives.get('NSIS'), '-C', nsis]);
  const archiveTool = hostArchiveTool(); const archiveToolFile = await checkedArchive(archiveTool, opts);
  const sevenZip = path.join(work, 'tools/7zip'); await fs.mkdir(sevenZip, { recursive: true });
  await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', archiveToolFile, '--strip-components=1', '-C', sevenZip]);
  const sevenZipExecutable = path.join(sevenZip, 'bin', process.platform === 'win32' ? '7za.exe' : '7za');
  if (process.platform !== 'win32') await fs.chmod(sevenZipExecutable, 0o755);
  const value = { target: 'win', resources, electronArchive: archives.get('Electron'), nsisDirectory: path.join(nsis, 'nsis-bundle'), sevenZipExecutable, components: [...windowsComponents, archiveTool],
    baselineArchiveSHA256: baseline.sha256, checkedTeXCacheFiles: latex.basicCache.files.length, windowsRuntimeExecuted: false, windowsInstallerExecuted: false,
    nativeHelpers: 'Mac-only helpers are intentionally absent; see WINDOWS-NOTES.txt' };
  await writeJSON(path.join(resources, 'runtime/PROVENANCE.json'), { target: value.target, components: windowsComponents.filter(item => item.name !== 'NSIS'), baselineArchiveSHA256: value.baselineArchiveSHA256, checkedTeXCacheFiles: value.checkedTeXCacheFiles, windowsRuntimeExecuted: false, windowsInstallerExecuted: false, nativeHelpers: value.nativeHelpers });
  await overlayRuntimeSources(resources);
  await writeJSON(path.join(work, 'prepared-win.json'), value);
  if (opts.development) {
    const destination = path.join(desktop, 'runtime');
    if (await exists(destination)) throw Error('Existing development runtime retained: ' + destination);
    await fs.cp(path.join(resources, 'runtime'), destination, { recursive: true, errorOnExist: true, force: false });
  }
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const value = await prepare(options()); console.log(JSON.stringify(value, null, 2));
}

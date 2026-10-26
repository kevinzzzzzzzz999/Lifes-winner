import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

export const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const work = path.join(desktop, '.release-work');
export const output = path.join(desktop, 'release');
export const require = createRequire(path.join(desktop, 'package.json'));
export function buildDependency(name) {
  try { return require(name); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const builder = createRequire(require.resolve('electron-builder/package.json'));
    return createRequire(builder.resolve('app-builder-lib/package.json'))(name);
  }
}
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const baseline = Object.freeze({
  filename: 'Lifes-Winner-0.8.5-build142-mac-arm64.zip', bytes: 246715105,
  sha256: '8e5f5e6ee03da72556e8fc78dfb6364b16e530b35acf3973ee3f36e93f7d620d',
  url: 'https://github.com/kevinzzzzzzzz999/Lifes-winner/releases/download/v0.8.5-build142-desktop-preview/Lifes-Winner-0.8.5-build142-mac-arm64.zip',
  appASARSHA256: '9493744de3f13e3eb97169fa81c0d0e6e3927055fd1bd92b4ebd784122b611d8'
});
export const windowsComponents = Object.freeze([
  { name: 'Electron', version: '44.3.0', filename: 'electron-v44.3.0-win32-x64.zip', bytes: 158149320,
    sha256: '26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d',
    url: 'https://github.com/electron/electron/releases/download/v44.3.0/electron-v44.3.0-win32-x64.zip',
    checksumSource: 'https://github.com/electron/electron/releases/download/v44.3.0/SHASUMS256.txt' },
  { name: 'Python', version: '3.14.7', filename: 'python-3.14.7-embed-amd64.zip', bytes: 12673227,
    sha256: 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15',
    url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip',
    checksumSource: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip.sigstore' },
  { name: 'Tectonic', version: '0.17.0', filename: 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip', bytes: 21060223,
    sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f',
    url: 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
    checksumSource: 'https://api.github.com/repos/tectonic-typesetting/tectonic/releases/tags/tectonic%400.17.0' },
  { name: 'NSIS', version: '3.12', filename: 'nsis-bundle-3.12.tar.gz', bytes: 4337619,
    sha256: '56997fdefe25e7928a1a68b4583d08b240b66cf660234053b20131a74cc082f4',
    url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis%401.2.1/nsis-bundle-3.12.tar.gz',
    checksumSource: 'electron-builder 26.15.3 app-builder-lib/out/toolsets/windows.js nsisChecksums[1.2.1]' }
]);
export function hostArchiveTool() {
  const key = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64') : process.platform === 'win32' && process.arch === 'x64' ? 'win-x64' : null;
  const hashes = { 'darwin-arm64': '496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1', 'darwin-x86_64': '496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1', 'win-x64': 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3' };
  if (!key) throw Error('Windows packaging is configured for macOS hosts and Windows x64 hosts.');
  const filename = `7zip-${key}.tar.gz`;
  return { name: '7zip build tool', filename, sha256: hashes[key], maxBytes: 32 * 1024 * 1024, url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/7zip%401.0.0/' + filename, checksumSource: 'electron-builder 26.15.3 app-builder-lib/out/toolsets/7zip.js' };
}

export function options(argv = process.argv.slice(2)) {
  const result = { target: argv[0], downloads: path.join(work, 'downloads'), offline: false, development: false, skipBuild: false };
  if (!['mac', 'win'].includes(result.target)) throw Error('Expected target mac or win. See scripts/release/README.md.');
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--baseline-file') result.baselineFile = path.resolve(argv[++i] || '');
    else if (argv[i] === '--downloads-dir') result.downloads = path.resolve(argv[++i] || '');
    else if (argv[i] === '--offline') result.offline = true;
    else if (argv[i] === '--development') result.development = true;
    else if (argv[i] === '--skip-build') result.skipBuild = true;
    else throw Error('Unknown option: ' + argv[i]);
  }
  return result;
}
export async function exists(file) { try { await fs.stat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function checkedArchive(entry, opts, explicitFile) {
  const filename = explicitFile || path.join(opts.downloads, entry.filename);
  let data;
  try { data = await fs.readFile(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!data) {
    if (explicitFile || opts.offline) throw Error('Missing archive: ' + filename);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(240000), headers: { 'User-Agent': 'Lifes-Winner-source-build' } });
    if (!response.ok || !response.body) throw Error(`HTTP ${response.status}: ${entry.url}`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > (entry.bytes || entry.maxBytes)) throw Error('Archive exceeds pinned size: ' + entry.filename); chunks.push(chunk);
    }
    data = Buffer.concat(chunks);
    if ((entry.bytes && data.length !== entry.bytes) || sha256(data) !== entry.sha256) throw Error('Archive size/SHA-256 mismatch: ' + entry.filename);
    const temporary = filename + '.part-' + crypto.randomUUID();
    await fs.writeFile(temporary, data, { flag: 'wx' });
    try { await fs.link(temporary, filename); } finally { await fs.unlink(temporary); }
  }
  if ((entry.bytes && data.length !== entry.bytes) || sha256(data) !== entry.sha256) throw Error('Archive size/SHA-256 mismatch: ' + filename);
  return filename;
}
export async function run(command, args, settings = {}) {
  return new Promise((resolve, reject) => {
    // .cmd entrypoints require Windows command-file resolution. cross-spawn is
    // already an electron-builder dependency and handles that quoting correctly.
    const start = process.platform === 'win32' && /\.cmd$/i.test(command) ? buildDependency('cross-spawn') : spawn;
    const child = start(command, args, { cwd: desktop, stdio: 'inherit', shell: false, ...settings });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error(command + ' exited ' + code)));
  });
}
export async function writeJSON(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
export async function safeExtractZip(archive, destination, select = () => true) {
  const zip = await buildDependency('unzipper').Open.file(archive);
  for (const entry of zip.files) {
    const relative = entry.path.replace(/\\/g, '/');
    if (relative.startsWith('/') || relative.split('/').includes('..') || /^[a-zA-Z]:/.test(relative)) throw Error('Unsafe ZIP path');
    if (!select(relative) || entry.type === 'Directory') continue;
    // Windows preparation only selects regular resources, never the Mac framework symlinks.
    if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw Error('Unexpected selected ZIP symlink: ' + relative);
    const file = path.join(destination, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await entry.buffer());
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Developer-only setup. Never finds or invokes a system TeX installation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = path.join(root, 'runtime/latex');
const downloadDirectory = path.join(root, 'scripts/packaging/.downloads');
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(await fs.readFile(path.join(runtime, 'PROVENANCE.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !['--all', '--mac', '--win'].includes(args[0]))) {
  throw new Error('Usage: node scripts/packaging/prepare-latex.mjs [--all|--mac|--win]');
}
const platforms = args[0] === '--mac' ? ['darwin-arm64'] : args[0] === '--win' ? ['win32-x64'] : ['darwin-arm64', 'win32-x64'];

function safeParts(relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f]/.test(relative) || relative.startsWith('/')) throw new Error('Invalid provenance path');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid provenance path');
  return parts;
}
async function checkedRead(base, relative) {
  let current = base;
  const parts = safeParts(relative);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe file type: ' + relative);
  }
  return fs.readFile(current);
}
function verify(bytes, size, sha, name) {
  if (!Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/.test(sha) || bytes.length !== size || digest(bytes) !== sha) throw new Error('Size or SHA-256 mismatch: ' + name);
}
async function verifySeed() {
  const base = path.join(runtime, 'basic-cache');
  const stat = await fs.lstat(base);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid offline cache directory');
  const files = provenance.basicCache?.files;
  if (!Array.isArray(files) || files.length !== provenance.basicCache.fileCount || files.length > 10000) throw new Error('Invalid offline cache manifest');
  const seen = new Set(); let total = 0;
  for (const file of files) {
    if (seen.has(file.path)) throw new Error('Duplicate cache entry');
    seen.add(file.path);
    const data = await checkedRead(base, file.path);
    verify(data, file.bytes, file.sha256, file.path); total += data.length;
  }
  if (total !== provenance.basicCache.totalBytes) throw new Error('Offline cache total size mismatch');
  console.log(JSON.stringify({ cache: 'verified', files: files.length, bytes: total }));
}
async function publishNew(destination, bytes, mode = 0o600) {
  const parent = path.dirname(destination); await fs.mkdir(parent, { recursive: true });
  if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('Refusing symbolic-link destination');
  const temp = path.join(parent, '.latex-download-' + randomUUID());
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx', mode });
    // Link publishes complete bytes and never replaces a pre-existing file.
    await fs.link(temp, destination);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
async function archiveFor(entry) {
  const url = new URL(entry.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/tectonic-typesetting/tectonic/releases/download/')) throw new Error('Unsupported runtime source');
  const name = decodeURIComponent(url.pathname.split('/').at(-1)); safeParts(name);
  const destination = path.join(downloadDirectory, name);
  try {
    const cached = await checkedRead(downloadDirectory, name);
    verify(cached, entry.archiveBytes, entry.archiveSHA256, name); return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Number.isSafeInteger(entry.archiveBytes) || entry.archiveBytes < 1 || entry.archiveBytes > 128 * 1024 * 1024) throw new Error('Invalid archive size');
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error('Tectonic archive HTTP ' + response.status);
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > entry.archiveBytes) throw new Error('Tectonic archive exceeds expected size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks); verify(bytes, entry.archiveBytes, entry.archiveSHA256, name);
  await publishNew(destination, bytes); return destination;
}
await verifySeed();
for (const platform of platforms) {
  const entry = provenance.entries.find(item => item.platform === platform);
  const member = platform === 'darwin-arm64' ? 'tectonic' : 'tectonic.exe';
  if (!entry || entry.executable !== `${platform}/${member}`) throw new Error('Missing or unexpected platform manifest: ' + platform);
  try {
    const present = await checkedRead(runtime, entry.executable);
    verify(present, entry.executableBytes, entry.executableSHA256, entry.executable);
    console.log(JSON.stringify({ platform, status: 'already verified; unchanged', sha256: entry.executableSHA256 }));
    continue;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const archive = await archiveFor(entry);
  // macOS and Windows 10/11 ship bsdtar, which reads both these .tar.gz and .zip
  // archives. List first, then stream exactly one known member; never extract a
  // directory tree or let archive paths choose the publication destination.
  const tar = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
  const listing = await run(tar, ['-tf', archive], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
  const members = listing.stdout.trim().split(/\r?\n/);
  if (members.length !== 1 || members[0] !== member) throw new Error('Unexpected Tectonic archive members: ' + platform);
  const result = await run(tar, ['-xOf', archive, member], { encoding: 'buffer', timeout: 30000, maxBuffer: entry.executableBytes + 1024, windowsHide: true, shell: false });
  verify(result.stdout, entry.executableBytes, entry.executableSHA256, entry.executable);
  const destination = path.join(runtime, ...safeParts(entry.executable));
  await publishNew(destination, result.stdout, 0o755);
  console.log(JSON.stringify({ platform, status: 'downloaded and verified', sha256: entry.executableSHA256 }));
}

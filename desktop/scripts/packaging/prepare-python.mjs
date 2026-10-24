import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = path.join(root, 'runtime');
const cache = path.join(root, 'scripts/packaging/.downloads');
const entries = [
  {
    platform: 'darwin-arm64', version: '3.14.7', release: '20260901',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.14.7%2B20260901-aarch64-apple-darwin-install_only_stripped.tar.gz',
    sha256: '4632cb1a6edad9e73d3c81b6d2e69131637d995173e3e85005df14102b0592ba',
    checksumSource: 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20260901',
    archive: 'cpython-3.14.7-20260901-darwin-arm64.tar.gz', executable: 'bin/python3',
    provider: 'Astral python-build-standalone official release', license: 'Python-2.0 and bundled dependency licenses'
  },
  {
    platform: 'win32-x64', version: '3.14.7',
    url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip',
    sha256: Buffer.from('0pfl/wGZZoF62FAkZRdhOfLT2ED6TthLE77TmaarHxU=', 'base64').toString('hex'),
    checksumSource: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip.sigstore',
    archive: 'python-3.14.7-embed-amd64.zip', executable: 'python.exe',
    provider: 'Python Software Foundation official Windows embeddable distribution', license: 'Python-2.0 and bundled dependency licenses'
  }
];
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(runtime, { recursive: true });
for (const entry of entries) {
  const archive = path.join(cache, entry.archive);
  let bytes;
  try { bytes = await fs.readFile(archive); } catch { /* Download only an absent archive. */ }
  if (!bytes) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Python archive HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) throw new Error(`Python checksum mismatch: ${entry.platform}`);
  await fs.writeFile(archive, bytes);
  const destination = path.join(runtime, 'python', entry.platform);
  await fs.mkdir(destination, { recursive: true });
  if (entry.archive.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
  } else if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', archive, '-C', destination]);
  } else {
    execFileSync('unzip', ['-q', '-o', archive, '-d', destination]);
  }
  await fs.stat(path.join(destination, entry.executable));
  entry.downloadBytes = bytes.length;
  entry.archiveSHA256Verified = true;
  console.log(JSON.stringify({ platform: entry.platform, bytes: bytes.length, sha256: digest }));
}
await fs.writeFile(path.join(runtime, 'PROVENANCE.json'), JSON.stringify({
  schemaVersion: 1,
  purpose: 'Offline base Python runtime, invoked only by the user. No system Python fallback.',
  archiveVerification: 'SHA-256 matched official release metadata over HTTPS; Sigstore signature verification was not performed.',
  entries
}, null, 2) + '\n');

// The install-only runtime omits the upstream build's dependency license folder.
// Fetch the matching full archive only to retain that folder and build metadata.
const licenseArchive = {
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.14.7%2B20260901-aarch64-apple-darwin-pgo%2Blto-full.tar.zst',
  sha256: '185fa676e14b648bd736ce7f20f9b11e201131b3216ec5a39d4ecd8ab8a71112',
  file: path.join(cache, 'python-full-licenses.tar.zst')
};
let licenseBytes;
try { licenseBytes = await fs.readFile(licenseArchive.file); } catch { /* Download an absent archive. */ }
if (!licenseBytes) {
  const response = await fetch(licenseArchive.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Python licenses HTTP ${response.status}`);
  licenseBytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(licenseBytes).digest('hex') !== licenseArchive.sha256) throw new Error('Python license archive checksum mismatch');
await fs.writeFile(licenseArchive.file, licenseBytes);
const licenseDirectory = path.join(root, 'LICENSES/Python-dependencies');
await fs.mkdir(licenseDirectory, { recursive: true });
execFileSync('tar', ['-xf', licenseArchive.file, '--strip-components=2', '-C', licenseDirectory, 'python/licenses']);
const upstreamMetadata = execFileSync('tar', ['-xOf', licenseArchive.file, 'python/PYTHON.json'], { maxBuffer: 8 * 1024 * 1024 });
await fs.writeFile(path.join(licenseDirectory, 'UPSTREAM-PYTHON.json'), upstreamMetadata);
await fs.writeFile(path.join(licenseDirectory, 'PROVENANCE.json'), JSON.stringify({
  url: licenseArchive.url, sha256: licenseArchive.sha256,
  scope: 'Unmodified license files and metadata from the exact upstream runtime release; no build objects are distributed.'
}, null, 2) + '\n');

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'LICENSES');
await fs.mkdir(path.join(output, 'npm'), { recursive: true });
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const packages = [];
for (const [relative, metadata] of Object.entries(lock.packages)) {
  if (!relative.startsWith('node_modules/')) continue;
  const directory = path.join(root, relative);
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); } catch { continue; }
  const key = `${pkg.name}@${pkg.version}`;
  const id = key.replace(/[^a-zA-Z0-9._@-]/g, '_');
  const copied = [];
  const candidates = await fs.readdir(directory, { withFileTypes: true });
  for (const candidate of candidates) {
    if (!candidate.isFile() || !/^(licen[sc]e|copying|notice|copyright)(\.|$|-)/i.test(candidate.name)) continue;
    const bytes = await fs.readFile(path.join(directory, candidate.name));
    const target = `npm/${id}/${candidate.name}`;
    await fs.mkdir(path.dirname(path.join(output, target)), { recursive: true });
    await fs.writeFile(path.join(output, target), bytes);
    copied.push({ file: target, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  packages.push({
    name: pkg.name, version: pkg.version, license: pkg.license ?? metadata.license ?? 'SEE PACKAGE',
    buildOnly: metadata.dev === true, url: metadata.resolved, integrity: metadata.integrity,
    licenseFiles: copied
  });
}
for (const [from, name] of [
  ['node_modules/electron/dist/LICENSE', 'Electron-LICENSE.txt'],
  ['node_modules/electron/dist/LICENSES.chromium.html', 'Electron-Chromium-LICENSES.html'],
  ['runtime/python/darwin-arm64/lib/python3.14/LICENSE.txt', 'Python-macOS-LICENSE.txt'],
  ['runtime/python/win32-x64/LICENSE.txt', 'Python-Windows-LICENSE.txt']
]) { try { await fs.copyFile(path.join(root, from), path.join(output, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
await fs.writeFile(path.join(output, 'npm-dependencies.json'), JSON.stringify({
  schemaVersion: 1, lockfileVersion: lock.lockfileVersion,
  packageLockSHA256: createHash('sha256').update(await fs.readFile(path.join(root, 'package-lock.json'))).digest('hex'),
  scope: 'Installed npm dependencies, including build tools. Renderer libraries are bundled; mammoth is a main-process dependency. Package-lock fixes the registry archive integrity for every dependency.',
  packages
}, null, 2) + '\n');
console.log(JSON.stringify({ recordedPackages: packages.length, copiedLicenseFiles: packages.reduce((n, p) => n + p.licenseFiles.length, 0) }));

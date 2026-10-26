import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktop, work, writeJSON, exists, sha256 } from './common.mjs';

// Include installed build and renderer dependencies as a conservative superset.
// Existing baseline licenses for native runtimes and vendored SheetJS remain.
export async function collectLicenses() {
  const lock = JSON.parse(await fs.readFile(path.join(desktop, 'package-lock.json'), 'utf8'));
  const root = path.join(work, 'generated-licenses');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(path.join(root, 'npm'), { recursive: true });
  const packages = [];
  for (const [relative, locked] of Object.entries(lock.packages || {})) {
    if (!relative || !relative.includes('node_modules/')) continue;
    const directory = path.join(desktop, relative);
    if (!await exists(path.join(directory, 'package.json'))) continue; // omitted platform-specific optional package
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    const notices = [];
    const label = `${metadata.name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${metadata.version}`;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) continue;
      const bytes = await fs.readFile(path.join(directory, entry.name));
      const output = path.join(root, 'npm', label, entry.name); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, bytes);
      notices.push({ file: `npm/${label}/${entry.name}`, sha256: sha256(bytes) });
    }
    packages.push({ name: metadata.name, version: metadata.version, license: metadata.license || null, source: locked.resolved || null, integrity: locked.integrity || null, notices });
  }
  await writeJSON(path.join(root, 'npm-dependencies.json'), { schemaVersion: 1, lockfileVersion: lock.lockfileVersion, scope: 'Installed npm dependencies, including renderer and build tools. Baseline native/runtime notices remain separate.', packages });
  console.log(JSON.stringify({ licensePackages: packages.length, destination: '.release-work/generated-licenses' }));
  return root;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await collectLicenses();

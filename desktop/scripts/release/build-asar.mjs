import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktop, work, require, buildDependency, sha256, writeJSON, exists } from './common.mjs';

export async function buildASAR() {
  if (!await exists(path.join(desktop, 'dist/renderer/index.html'))) throw Error('Missing production renderer. Run npm run build first.');
  const destination = path.join(work, 'app-input');
  await fs.rm(destination, { recursive: true, force: true }); await fs.mkdir(destination, { recursive: true });
  const paths = ['package.json', 'src/main', 'src/preload', 'src/native', 'src/vendor/excel', 'dist/renderer'];
  for (const relative of paths) {
    const source = path.join(desktop, relative);
    if (!await exists(source)) throw Error('Required application input missing: ' + relative);
    await fs.cp(source, path.join(destination, relative), { recursive: true, filter: file => !['.DS_Store', '.git'].includes(path.basename(file)) });
  }
  const metadata = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'));
  const modulesRoot = await fs.realpath(path.join(desktop, 'node_modules'));
  const copied = new Set(), packages = [];
  async function copyDependency(name, parent, optional = false) {
    let file;
    try { file = require.resolve(name + '/package.json', { paths: [parent] }); }
    catch (error) {
      try {
        let dir = path.dirname(require.resolve(name, { paths: [parent] }));
        while (dir !== path.dirname(dir)) {
          const candidate = path.join(dir, 'package.json');
          try { if (JSON.parse(await fs.readFile(candidate, 'utf8')).name === name) { file = candidate; break; } } catch {}
          dir = path.dirname(dir);
        }
      } catch { if (optional) return; throw error; }
    }
    if (!file) { if (optional) return; throw Error('Cannot resolve production dependency: ' + name); }
    const source = await fs.realpath(path.dirname(file));
    if (copied.has(source)) return; copied.add(source);
    const relative = path.relative(modulesRoot, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Production dependency is outside this npm installation. Run npm ci in the checkout: ' + name);
    await fs.cp(source, path.join(destination, 'node_modules', relative), { recursive: true, filter: file => !['.DS_Store', '.git'].includes(path.basename(file)) });
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    packages.push({ name: pkg.name, version: pkg.version, path: 'node_modules/' + relative.split(path.sep).join('/') });
    for (const dependency of Object.keys(pkg.dependencies || {})) await copyDependency(dependency, source);
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) await copyDependency(dependency, source, true);
  }
  for (const dependency of Object.keys(metadata.dependencies || {})) await copyDependency(dependency, desktop);
  const files = {};
  async function inventory(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Unexpected application-input symbolic link: ' + file);
      if (entry.isDirectory()) await inventory(file);
      else if (entry.isFile()) { const data = await fs.readFile(file); files[path.relative(destination, file).split(path.sep).join('/')] = { bytes: data.length, sha256: sha256(data) }; }
    }
  }
  await inventory(destination);
  if (Object.keys(files).some(file => file.endsWith('.node'))) throw Error('Native Node add-ons need platform-specific rebuilding; this release script accepts the current pure-JavaScript dependencies.');
  const archive = path.join(work, 'app.asar');
  await buildDependency('@electron/asar').createPackage(destination, archive);
  const receipt = { createdUTC: new Date().toISOString(), version: metadata.version, archive, sha256: sha256(await fs.readFile(archive)), productionPackages: packages, files };
  await writeJSON(path.join(work, 'app-inputs.json'), receipt);
  console.log(JSON.stringify({ archive: 'app.asar', version: metadata.version, sha256: receipt.sha256, inputFiles: Object.keys(files).length, productionPackages: packages.length }));
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildASAR();

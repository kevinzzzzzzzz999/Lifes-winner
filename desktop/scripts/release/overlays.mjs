import fs from 'node:fs/promises';
import path from 'node:path';
import { desktop, work, exists, sha256 } from './common.mjs';

export async function overlayRuntimeSources(resources) {
  const source = path.join(desktop, 'runtime-src/notebook');
  if (!await exists(source)) return [];
  const copied = [];
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !(entry.name === 'kernel.py' || /^requirements.*\.lock$/.test(entry.name) || ['PROVENANCE.json', 'FILES.json'].includes(entry.name))) continue;
    const target = path.join(resources, 'runtime/notebook', entry.name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(source, entry.name), target); copied.push(entry.name);
  }
  return copied;
}
export async function overlayNative(resources) {
  const root = path.join(work, 'native-overrides');
  const file = path.join(root, 'receipt.json');
  if (!await exists(file)) return [];
  const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const [relative, expected] of Object.entries(receipt.sources)) {
    if (sha256(await fs.readFile(path.join(desktop, relative))) !== expected) throw Error('A native helper source changed after compilation. Run build:native again: ' + relative);
  }
  for (const name of ['runtime', 'helpers']) if (await exists(path.join(root, name))) await fs.cp(path.join(root, name), path.join(resources, name), { recursive: true });
  return receipt.helpers;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules/pdfjs-dist');
const destination = path.join(root, 'public/pdfjs');
await fs.mkdir(destination, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await fs.cp(path.join(source, name), path.join(destination, name), { recursive: true });
}
await fs.copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
console.log('Prepared PDF.js resources and upstream license from the locked dependency.');

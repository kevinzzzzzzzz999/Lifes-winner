'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFS = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const XLSX = require('../src/vendor/excel/xlsx.full.min.js');
const JSZip = require('jszip');
const { VaultService, digest } = require('../src/main/vault-service.cjs');
const { notebookDataInfo, NOTEBOOK_DATA_LIMITS } = require('../src/main/notebook-data.cjs');

const MiB = 1024 * 1024;
const hasCode = code => error => error?.code === code;
const names = ['统计 & Sales', 'Hidden', 'VeryHidden'];
const expected = { sheets: names.map((name, index) => ({ name, hidden: index > 0 })) };
function workbook(format = 'xlsx', count = 3) {
  const value = XLSX.utils.book_new();
  for (let index = 0; index < count; index++) XLSX.utils.book_append_sheet(value,
    XLSX.utils.aoa_to_sheet([['sentinel', index], ['=not executed', 7]]), count === 3 ? names[index] : 'S' + index);
  value.Workbook = { Sheets: Array.from({ length: count }, (_, index) => ({ Hidden: index === 0 ? 0 : index === 1 ? 1 : 2 })) };
  return Buffer.from(XLSX.write(value, { type: 'buffer', bookType: format }));
}
const inspect = (data, extension = 'xlsx') => notebookDataInfo({ snapshot: async () => ({ data }) }, { vaultId: 'synthetic-vault', path: 'data.' + extension });
async function editZIP(data, edit, compression = 'DEFLATE') {
  const zip = await JSZip.loadAsync(data);
  await edit(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression });
}
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inkspace-excel-metadata-'));
  try {
    const root = path.join(directory, 'vault');
    await fs.mkdir(root);
    const vaults = new VaultService({ dataDirectory: path.join(directory, 'profile') });
    const vault = await vaults.grantVault(root);
    return await run({ directory, root, vaults, vaultId: vault.id });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('xlsx, xlsm and OLE xls report ordered visible, hidden and very-hidden sheets', async () => {
  for (const format of ['xlsx', 'xlsm', 'xls']) assert.deepEqual(await inspect(workbook(format), format), expected);
});

test('real vault authority reads a nested Unicode uppercase filename without writes or backup side effects', async () => {
  await fixture(async ({ directory, root, vaults, vaultId }) => {
    await fs.mkdir(path.join(root, 'course'));
    const file = path.join(root, 'course', '统计.XLSX');
    await fs.writeFile(file, workbook());
    const before = await fs.stat(file), hash = digest(await fs.readFile(file));
    assert.deepEqual(await notebookDataInfo(vaults, { vaultId, path: 'course/统计.XLSX' }), expected);
    const after = await fs.stat(file);
    assert.equal(digest(await fs.readFile(file)), hash);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
    await assert.rejects(fs.stat(path.join(directory, 'profile')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(root, 'course')), ['统计.XLSX']);
  });
});

test('invalid requests, unsupported files and traversal fail before touching a vault snapshot', async () => {
  let snapshots = 0;
  const vaults = { snapshot: async () => { snapshots++; throw Error('must not read'); } };
  for (const value of [null, [], {}, { vaultId: '', path: 'a.xlsx' }, { vaultId: 'v', path: 'a.xlsx', extra: true }]) {
    await assert.rejects(() => notebookDataInfo(vaults, value), hasCode('INVALID_REQUEST'));
  }
  for (const value of ['../outside.xlsx', '/outside.xlsx', 'a/../outside.xlsx', 'a\\outside.xlsx', 'a\0.xlsx', 'a//b.xlsx']) {
    await assert.rejects(() => notebookDataInfo(vaults, { vaultId: 'v', path: value }), hasCode('PATH_DENIED'));
  }
  await assert.rejects(() => notebookDataInfo(vaults, { vaultId: 'v', path: 'data.csv' }), hasCode('UNSUPPORTED'));
  assert.equal(snapshots, 0);
});

test('real vault denies unknown grants, symlink escapes and hard-linked workbooks', async () => {
  await fixture(async ({ directory, root, vaults, vaultId }) => {
    const outside = path.join(directory, 'outside.xlsx');
    const original = workbook();
    await fs.writeFile(outside, original);
    await fs.symlink(outside, path.join(root, 'linked.xlsx'));
    await fs.link(outside, path.join(root, 'hard.xlsx'));
    await assert.rejects(() => notebookDataInfo(vaults, { vaultId: 'not-granted', path: 'linked.xlsx' }), hasCode('NO_VAULT'));
    for (const file of ['linked.xlsx', 'hard.xlsx']) await assert.rejects(() => notebookDataInfo(vaults, { vaultId, path: file }), hasCode('PATH_DENIED'));
    assert.deepEqual(await fs.readFile(outside), original);
  });
});

test('snapshot size contract is 32 MiB and an over-limit sparse file is refused before reading', async () => {
  assert.equal(NOTEBOOK_DATA_LIMITS.sourceBytes, 32 * MiB);
  assert.equal(NOTEBOOK_DATA_LIMITS.sheets, 128);
  assert.equal(NOTEBOOK_DATA_LIMITS.concurrent, 2);
  let maximum;
  await notebookDataInfo({ snapshot: async (_request, limit) => { maximum = limit; return { data: workbook() }; } }, { vaultId: 'v', path: 'a.xlsx' });
  assert.equal(maximum, 32 * MiB);
  await fixture(async ({ root, vaults, vaultId }) => {
    const file = path.join(root, 'oversized.xlsx');
    await fs.writeFile(file, '');
    await fs.truncate(file, 32 * MiB + 1);
    await assert.rejects(() => notebookDataInfo(vaults, { vaultId, path: 'oversized.xlsx' }), hasCode('TOO_LARGE'));
    assert.equal((await fs.stat(file)).size, 32 * MiB + 1);
  });
});

test('metadata remains readable above the old 16 MiB preview limit without parsing images or worksheet cells', async () => {
  const data = await editZIP(workbook(), zip => {
    zip.file('xl/media/unused.bin', Buffer.alloc(17 * MiB, 0x61));
    zip.file('xl/worksheets/sheet1.xml', 'deliberately not worksheet XML');
    zip.file('xl/vbaProject.bin', Buffer.from('non-executable test macro payload'));
  }, 'STORE');
  assert(data.length > 16 * MiB && data.length < 32 * MiB);
  assert.deepEqual(await inspect(data), expected);
});

test('128 worksheet metadata entries are accepted and 129 are rejected rather than silently truncated', async () => {
  const result = await inspect(workbook('xlsx', 128));
  assert.equal(result.sheets.length, 128);
  assert.deepEqual(result.sheets.at(-1), { name: 'S127', hidden: true });
  await assert.rejects(() => inspect(workbook('xlsx', 129)), hasCode('TOO_LARGE'));
});

test('mismatched file magic, corrupt ZIP/OLE, duplicate ZIP names and ZIP traversal are rejected', async () => {
  for (const [data, extension] of [
    [Buffer.from('not a workbook'), 'xlsx'], [Buffer.from('PK\x03\x04'), 'xlsm'],
    [workbook(), 'xls'], [workbook('xls'), 'xlsx'], [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'xls'],
  ]) await assert.rejects(() => inspect(data, extension), hasCode('EXCEL_UNREADABLE'));
  const traversal = await editZIP(workbook(), zip => zip.file('../escape.txt', 'denied'));
  await assert.rejects(() => inspect(traversal), hasCode('EXCEL_UNREADABLE'));
  const duplicate = Buffer.from(workbook());
  // Alter a central-directory filename to duplicate an existing same-length entry.
  const central = [];
  for (let pos = 0; pos + 46 < duplicate.length; pos++) if (duplicate.readUInt32LE(pos) === 0x02014b50) central.push(pos);
  const pair = central.flatMap((a, index) => central.slice(index + 1).filter(b => duplicate.readUInt16LE(a + 28) === duplicate.readUInt16LE(b + 28)).map(b => [a, b]))[0];
  assert(pair, 'Fixture needs two central-directory names of equal length');
  const [a, b] = pair, length = duplicate.readUInt16LE(a + 28);
  duplicate.copy(duplicate, b + 46, a + 46, a + 46 + length);
  await assert.rejects(() => inspect(duplicate), hasCode('EXCEL_UNREADABLE'));
});

test('invalid hidden-state metadata, DTD declarations and over-budget workbook XML are refused', async () => {
  const state = await editZIP(workbook(), async zip => zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace('state="hidden"', 'state="invalid"')));
  await assert.rejects(() => inspect(state), hasCode('EXCEL_UNREADABLE'));
  const dtd = await editZIP(workbook(), async zip => zip.file('xl/workbook.xml', '<!DOCTYPE workbook [<!ENTITY external SYSTEM "file:///not-read">]>' + (await zip.file('xl/workbook.xml').async('string')).replace(/<\?xml[^?]*\?>/, '')));
  await assert.rejects(() => inspect(dtd), hasCode('EXCEL_UNREADABLE'));
  const large = await editZIP(workbook(), async zip => zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace('</workbook>', '<!--' + 'x'.repeat(NOTEBOOK_DATA_LIMITS.workbookXMLBytes) + '--></workbook>')));
  await assert.rejects(() => inspect(large), hasCode('TOO_LARGE'));
});

test('packaged Office XML parser refuses malformed, foreign-namespace, unresolved-entity and excessively deep metadata', async () => {
  for (const edit of [
    xml => xml.replace('</sheets>', '</wrong>'),
    xml => xml.replace('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'https://invalid.example/workbook'),
    xml => xml.replace('</workbook>', '<extra>&unresolved;</extra></workbook>'),
    xml => xml.replace('</workbook>', '<sheets/></workbook>'),
  ]) {
    const data = await editZIP(workbook(), async zip => zip.file('xl/workbook.xml', edit(await zip.file('xl/workbook.xml').async('string'))));
    await assert.rejects(() => inspect(data), hasCode('EXCEL_UNREADABLE'));
  }
  const deep = await editZIP(workbook(), async zip => zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace('</workbook>', '<extra>'.repeat(64) + '</extra>'.repeat(64) + '</workbook>')));
  await assert.rejects(() => inspect(deep), hasCode('TOO_LARGE'));
});

test('concurrency is reserved before snapshots and a refused third request performs no read', async () => {
  const releases = [];
  const vaults = { snapshot: () => new Promise(resolve => releases.push(() => resolve({ data: workbook() }))) };
  const first = notebookDataInfo(vaults, { vaultId: 'v', path: 'one.xlsx' });
  const second = notebookDataInfo(vaults, { vaultId: 'v', path: 'two.xlsx' });
  await assert.rejects(() => notebookDataInfo(vaults, { vaultId: 'v', path: 'three.xlsx' }), hasCode('BUSY'));
  assert.equal(releases.length, 2);
  releases.forEach(release => release());
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.deepEqual(await inspect(workbook()), expected, 'Slots must be released after both workers terminate');
});

function isolatedHelper(Worker, timerOverrides = {}) {
  const filename = require.resolve('../src/main/notebook-data.cjs');
  const module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(syncFS.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    Buffer, Uint8Array, setTimeout, clearTimeout, ...timerOverrides,
    require: name => name === 'node:worker_threads' ? { Worker } : localRequire(name),
  }, { filename });
  return module.exports;
}

test('worker deadline terminates the parser, uses heap limits and never returns partial sheet metadata', async () => {
  let options, timeout, terminated = 0;
  class HangingWorker extends EventEmitter {
    constructor(_filename, value) { super(); options = value; }
    terminate() { terminated++; return Promise.resolve(1); }
  }
  const helper = isolatedHelper(HangingWorker, {
    setTimeout: (callback, delay) => { timeout = delay; return setImmediate(callback); },
    clearTimeout: clearImmediate,
  });
  await assert.rejects(() => helper.notebookDataInfo({ snapshot: async () => ({ data: workbook() }) }, { vaultId: 'v', path: 'a.xlsx' }), hasCode('EXCEL_TIMEOUT'));
  assert.equal(timeout, 15000);
  assert.equal(terminated, 1);
  assert.equal(options.resourceLimits.maxOldGenerationSizeMb, 256);
  assert.equal(options.resourceLimits.stackSizeMb, 4);
  assert.equal(options.workerData.data.byteLength, workbook().length);
  assert.equal(options.transferList[0], options.workerData.data);
});

test('worker startup failure, crash, OOM, and malformed output release their slot and fail safely', async () => {
  for (const mode of ['constructor', 'exit', 'oom', 'bad-message']) {
    let attempts = 0;
    class FailingWorker extends EventEmitter {
      constructor() {
        super(); attempts++;
        if (mode === 'constructor') throw Error('synthetic startup failure');
        queueMicrotask(() => {
          if (mode === 'exit') this.emit('exit', 1);
          if (mode === 'oom') this.emit('error', Object.assign(Error('synthetic OOM'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
          if (mode === 'bad-message') this.emit('message', { ok: true, sheets: [{ name: 'Sheet', hidden: 'false' }] });
        });
      }
      terminate() { return Promise.resolve(1); }
    }
    const helper = isolatedHelper(FailingWorker);
    const read = () => helper.notebookDataInfo({ snapshot: async () => ({ data: workbook() }) }, { vaultId: 'v', path: 'a.xlsx' });
    for (let index = 0; index < 3; index++) await assert.rejects(read, hasCode(mode === 'oom' ? 'TOO_LARGE' : 'EXCEL_UNREADABLE'));
    assert.equal(attempts, 3, 'Failed parses must not leak concurrency slots');
  }
});

'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { AppError, fail } = require('./errors.cjs');
const { relativePath } = require('./vault-path.cjs');

const NOTEBOOK_DATA_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  workbookXMLBytes: 2 * 1024 * 1024,
  sheets: 128,
  concurrent: 2,
  timeoutMs: 15000,
});
let active = 0;

function validSheets(sheets) {
  return Array.isArray(sheets) && sheets.length > 0 && sheets.length <= NOTEBOOK_DATA_LIMITS.sheets &&
    sheets.every(sheet => sheet && typeof sheet.name === 'string' && sheet.name.length > 0 &&
      sheet.name.length <= 255 && !sheet.name.includes('\0') && typeof sheet.hidden === 'boolean') &&
    new Set(sheets.map(sheet => sheet.name)).size === sheets.length;
}

function readMetadata(data, extension) {
  return new Promise((resolve, reject) => {
    let worker, timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Await termination before releasing the shared concurrency slot. A timed
      // out parser must not continue alongside a newly accepted workbook.
      Promise.resolve().then(() => worker?.terminate()).catch(() => {}).then(() => error ? reject(error) : resolve(result));
    };
    try {
      // Transfer a dedicated buffer; never expose unrelated pooled Buffer bytes.
      const bytes = Uint8Array.from(data).buffer;
      worker = new Worker(path.join(__dirname, 'notebook-data-worker.cjs'), {
        workerData: { data: bytes, extension },
        transferList: [bytes],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
      worker.once('message', value => {
        if (value?.ok && validSheets(value.sheets)) {
          finish(null, { sheets: value.sheets.map(({ name, hidden }) => ({ name, hidden })) });
        } else {
          finish(new AppError(value?.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'EXCEL_UNREADABLE'));
        }
      });
      worker.once('error', error => finish(new AppError(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'TOO_LARGE' : 'EXCEL_UNREADABLE')));
      worker.once('exit', () => finish(new AppError('EXCEL_UNREADABLE')));
      timer = setTimeout(() => finish(new AppError('EXCEL_TIMEOUT')), NOTEBOOK_DATA_LIMITS.timeoutMs);
    } catch {
      finish(new AppError('EXCEL_UNREADABLE'));
    }
  });
}

async function notebookDataInfo(vaults, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !['vaultId', 'path'].includes(key)) ||
      typeof request.vaultId !== 'string' || !request.vaultId || request.vaultId.length > 128) fail('INVALID_REQUEST');
  const relative = relativePath(request.path);
  const extension = path.posix.extname(relative).slice(1).toLowerCase();
  if (!['xlsx', 'xlsm', 'xls'].includes(extension)) fail('UNSUPPORTED');
  if (active >= NOTEBOOK_DATA_LIMITS.concurrent) fail('BUSY');
  // Reserve before snapshotting, so simultaneous callers cannot first allocate
  // an unbounded number of 32 MiB workbook buffers on the main thread.
  active++;
  try {
    const snapshot = await vaults.snapshot({ vaultId: request.vaultId, path: relative }, NOTEBOOK_DATA_LIMITS.sourceBytes);
    if (!Buffer.isBuffer(snapshot.data) || !snapshot.data.length) fail('EXCEL_UNREADABLE');
    if (snapshot.data.length > NOTEBOOK_DATA_LIMITS.sourceBytes) fail('TOO_LARGE');
    return await readMetadata(snapshot.data, extension);
  } finally {
    active--;
  }
}

module.exports = { notebookDataInfo, NOTEBOOK_DATA_LIMITS };

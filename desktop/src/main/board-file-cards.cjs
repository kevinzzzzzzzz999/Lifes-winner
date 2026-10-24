'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { fail } = require('./errors.cjs');
const { validateBoard } = require('./board-validation.cjs');
const { relativePath } = require('./vault-path.cjs');
const MAX_BOARD = 64 * 1024 * 1024;

// One placement is one revision and one guarded commit, even across folders.
async function addBoardFileCards(vaults, request) {
  const { kindOf } = require('./vault-service.cjs');
  const allowed = value => { relativePath(value); if (value.split('/').some(p => p.toLowerCase() === '.inkspace-reviews')) fail('PATH_DENIED'); };
  allowed(request.path);
  if (kindOf(request.path) !== 'board' || !/^[a-f0-9]{64}$/.test(request.expectedSHA256 || '') || !Array.isArray(request.sourcePaths) || !request.sourcePaths.length || request.sourcePaths.length > 100 || !Number.isFinite(request.x) || !Number.isFinite(request.y)) fail('INVALID_REQUEST');
  const paths = [...new Set(request.sourcePaths)];
  for (const source of paths) { allowed(source); if (!['text', 'media', 'docx', 'pptx', 'spreadsheet', 'video'].includes(kindOf(source))) fail('INVALID_REQUEST'); }
  return vaults.locked(request.vaultId + ':' + request.path, async () => {
    const snap = await vaults.snapshot(request, MAX_BOARD);
    if (snap.sha256 !== request.expectedSHA256) fail('CONFLICT');
    let board;
    try { board = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snap.data), (_key, v) => { if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) fail('INVALID_BOARD'); return v; }); } catch { fail('INVALID_BOARD'); }
    validateBoard(board);
    const width = 360, height = 180, gap = 24;
    if (request.x < 0 || request.y < 0 || request.x + width > board.canvasWidth || request.y + paths.length * (height + gap) - gap > board.canvasHeight) fail('BOARD_SPACE_INSUFFICIENT');
    if (!Number.isSafeInteger(board.revision + 1)) fail('INVALID_BOARD');
    for (const source of paths) await vaults.resolve(request.vaultId, source);
    const items = paths.map((sourcePath, i) => ({ id: crypto.randomUUID(), kind: 'document', x: request.x, y: request.y + i * (height + gap), width, height, title: path.posix.basename(sourcePath), sourcePath }));
    const next = { ...board, items: [...board.items, ...items], revision: board.revision + 1, writerID: await vaults.writerID(), updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    validateBoard(next);
    const result = await vaults.commitSnapshot(request, snap, Buffer.from(JSON.stringify(next, null, 2)), MAX_BOARD, async () => { for (const source of paths) await vaults.resolve(request.vaultId, source); });
    return { path: request.path, name: path.posix.basename(request.path), kind: 'board', board: next, selectedIDs: items.map(item => item.id), ...result };
  });
}
module.exports = { addBoardFileCards };

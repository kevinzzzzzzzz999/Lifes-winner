'use strict';
// Relinking changes board references only. Candidate and old source files are never written.
const path = require('node:path');
const { fail } = require('./errors.cjs');
const { relativePath } = require('./vault-path.cjs');
const { validateBoard } = require('./board-validation.cjs');
const SHA = /^[a-f0-9]{64}$/;
const MAX_BOARD = 64 * 1024 * 1024, PREVIEW_LIMIT = 128 * 1024 * 1024;
const streaming = require('./board-relink-stream.cjs');
function publicPath(value) {
  relativePath(value);
  if (value.split('/').some(part => part.startsWith('.'))) fail('PATH_DENIED');
  return value;
}
function extension(value) { return path.posix.extname(value).toLowerCase().replace(/^\.jpeg$/, '.jpg'); }
function selection(board, request) {
  if (!['sourcePath', 'originalSourcePath'].includes(request.field) || typeof request.id !== 'string') fail('INVALID_REQUEST');
  const item = board.items.find(item => item.id.toLowerCase() === request.id.toLowerCase());
  if (!item || typeof item[request.field] !== 'string') fail('INVALID_REQUEST');
  const oldPath = publicPath(item[request.field]);
  // An expanded document's own pages are an explicit part of the confirmation.
  const affected = board.items.filter(other => other.id === item.id || item.kind === 'document' && other.sourceCardID?.toLowerCase() === item.id.toLowerCase() && other[request.field] === oldPath);
  return { item, oldPath, affected };
}
async function assertMissing(vaults, vaultId, oldPath) {
  publicPath(oldPath);
  try { await vaults.resolve(vaultId, oldPath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('RELINK_SOURCE_AVAILABLE');
}
function expectedDigests(board, field, oldPath, affected) {
  const values = field === 'originalSourcePath' ? affected.map(item => item.originalSourceSHA256) : [
    ...(board.pdfAnnotationSources || []).filter(source => source.sourcePath === oldPath).map(source => source.sha256),
    ...affected.filter(item => item.sourceReference?.path === oldPath).map(item => item.sourceReference.sourceSHA256)
  ];
  return [...new Set(values.filter(value => typeof value === 'string').map(value => value.toLowerCase()).filter(value => SHA.test(value) && value !== '0'.repeat(64)))];
}
async function inspect(vaults, request, board) {
  const target = selection(board, request), candidatePath = publicPath(request.candidatePath);
  const { kindOf } = require('./vault-service.cjs'), kind = kindOf(target.oldPath);
  if (!['text','media','docx','pptx','spreadsheet','video'].includes(kind) || kindOf(candidatePath) !== kind || candidatePath === request.path || candidatePath === target.oldPath || extension(candidatePath) !== extension(target.oldPath)) fail('RELINK_TYPE_MISMATCH');
  await assertMissing(vaults, request.vaultId, target.oldPath);
  const job = streaming.current(vaults, request.vaultId, request.requestId);
  const candidate = await streaming.snapshot(vaults, { vaultId: request.vaultId, path: candidatePath }, job);
  const expected = expectedDigests(board, request.field, target.oldPath, target.affected);
  if (expected.some(sha => sha !== candidate.sha256)) fail('RELINK_CONTENT_MISMATCH');
  let pageCount;
  if (extension(candidatePath) === '.pdf') {
    pageCount = (await streaming.pdfInfo(candidate, job)).pageCount;
    if (!pageCount || request.field === 'sourcePath' && target.affected.some(item => item.page != null && item.page > pageCount)) fail('RELINK_PAGE_MISSING');
  }
  const root = await vaults.root(request.vaultId);
  return { target, candidate, preview: {
    id: target.item.id, field: request.field, oldPath: target.oldPath, candidatePath,
    oldFullPath: path.join(root, target.oldPath), candidateFullPath: path.join(root, candidatePath),
    candidateSHA256: candidate.sha256, bytes: candidate.bytes, pageCount,
    fingerprintMatched: expected.length > 0, affectedCount: target.affected.length,
    page: request.field === 'sourcePath' ? target.item.page || 1 : 1,
    previewUnavailable: candidate.bytes > PREVIEW_LIMIT,
    ...(candidate.bytes <= PREVIEW_LIMIT && /\.(pdf|png|jpe?g)$/i.test(candidatePath) ? { previewURL: vaults.assetToken({ vaultId: request.vaultId, path: candidatePath }, candidate.sha256) } : {})
  } };
}
async function prepare(vaults, request) {
  publicPath(request.path);
  if (!request.path.toLowerCase().endsWith('.inkspace.json') || !SHA.test(request.expectedSHA256 || '')) fail('INVALID_REQUEST');
  const snap = await vaults.snapshot(request, MAX_BOARD);
  if (snap.sha256 !== request.expectedSHA256) fail('CONFLICT');
  let board; try { board = JSON.parse(snap.data.toString('utf8')); } catch { fail('INVALID_BOARD'); }
  validateBoard(board);
  return streaming.withJob(vaults,request.vaultId,request.requestId,async()=> (await inspect(vaults, request, board)).preview);
}
async function apply(vaults, request, board, next) {
  const op = request.operation;
  if (Object.keys(op).some(key => !['type', 'id', 'field', 'oldPath', 'candidatePath', 'candidateSHA256', 'confirmed', 'requestId'].includes(key)) || op.confirmed !== true || !SHA.test(op.candidateSHA256 || '')) fail('INVALID_REQUEST');
  const { target, candidate } = await inspect(vaults, { ...request, ...op }, board);
  if (target.oldPath !== op.oldPath || candidate.sha256 !== op.candidateSHA256) fail('CONFLICT');
  const ids = new Set(target.affected.map(item => item.id));
  next.items = board.items.map(item => {
    if (!ids.has(item.id)) return item;
    const changed = { ...item, [op.field]: op.candidatePath };
    if (op.field === 'sourcePath' && item.sourceReference?.path === op.oldPath) changed.sourceReference = { ...item.sourceReference, path: op.candidatePath };
    return changed;
  });
  // Retain old declarations for other cards and never mark an unverified PDF as written back.
  if (op.field === 'sourcePath' && extension(op.candidatePath) === '.pdf') {
    const source = (board.pdfAnnotationSources || []).find(source => source.sourcePath === op.oldPath && source.sha256 === candidate.sha256);
    if (source) {
      const pages = source.pages.filter(page => target.affected.some(item => item.kind === 'pdfPage' && item.page === page));
      const existing = (board.pdfAnnotationSources || []).find(value => value.sourcePath === op.candidatePath);
      if (existing && existing.sha256 !== candidate.sha256) fail('CONFLICT');
      const affectedPages = new Set(target.affected.filter(item => item.kind === 'pdfPage').map(item => item.page));
      const destinationPages = new Set(board.items.filter(item => !ids.has(item.id) && item.kind === 'pdfPage' && item.sourcePath === op.candidatePath).map(item => item.page));
      // An empty declaration still means this board's PDF annotations must be
      // hidden while its complete web ink is drawn. Keep that contract on relink;
      // a shared page is complete only when both known placement groups agree.
      const retained = (existing?.pages || []).filter(page => !affectedPages.has(page));
      const incoming = pages.filter(page => !existing || !destinationPages.has(page) || existing.pages.includes(page));
      const declaration = { ...source, sourcePath: op.candidatePath, pages: [...new Set([...retained, ...incoming])].sort((a,b) => a-b) };
      next.pdfAnnotationSources = [...(board.pdfAnnotationSources || []).filter(value => value.sourcePath !== op.candidatePath), declaration];
    }
  }
  validateBoard(next);
  return { board: next, selectedIDs: [target.item.id], sourceChecks: [], warnings: [], revalidate: async()=>{await candidate.revalidate();await assertMissing(vaults,request.vaultId,op.oldPath);streaming.abort(streaming.current(vaults,request.vaultId,op.requestId));}, beforeCommit:()=>{const job=streaming.current(vaults,request.vaultId,op.requestId);streaming.abort(job);job.cancellable=false;job.phase='saving';} };
}
module.exports = { prepare, apply, assertMissing };

/** Local nbformat 4 model. Unknown JSON fields are retained, never executed here.
 * Limits are UTF-8 bytes: 128 MiB file, 32 MiB sources, 8 MiB per cell,
 * 64 MiB outputs + attachments; at most 1,000 cells / 10,000 outputs,
 * 250,000 JSON values and 100 nesting levels.
 * https://nbformat.readthedocs.io/en/latest/format_description.html
 */
export const NOTEBOOK_LIMITS = Object.freeze({
  fileBytes: 128 * 1024 * 1024, sourceBytes: 32 * 1024 * 1024,
  cellSourceBytes: 8 * 1024 * 1024, outputBytes: 64 * 1024 * 1024,
  cells: 1000, outputs: 10000, cellOutputs: 1000, jsonDepth: 100, jsonNodes: 250000,
});

export type NotebookCellType = 'code' | 'markdown' | 'raw';
export type NotebookMultiline = string | string[];
export type NotebookOutput = Record<string, unknown> & { output_type: string };
export type NotebookCell = Record<string, unknown> & {
  cell_type: string; source: NotebookMultiline; metadata: Record<string, unknown>;
  id?: string; outputs?: NotebookOutput[]; execution_count?: number | null;
};
export type NotebookDocument = Record<string, unknown> & {
  nbformat: 4; nbformat_minor: number; metadata: Record<string, unknown>; cells: NotebookCell[];
};
export type NotebookStats = {
  cells: number; codeCells: number; markdownCells: number; rawCells: number;
  unknownCells: number; sourceBytes: number; outputBytes: number;
  attachmentBytes: number; outputCount: number;
};
export type NotebookWarning = { code: 'cell-id-repair' | 'unknown-cell' | 'unknown-output'; message: string; cellIndex: number };

export class NotebookFormatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'NotebookFormatError'; this.code = code; }
}

const utf8 = new TextEncoder();
const bytes = (value: string) => utf8.encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const multiline = (value: unknown): value is NotebookMultiline => typeof value === 'string' || Array.isArray(value) && value.every(part => typeof part === 'string');
const count = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const knownTypes = new Set(['code', 'markdown', 'raw']);
const knownOutputs = new Set(['stream', 'display_data', 'execute_result', 'error']);
function fail(code: string, message: string): never { throw new NotebookFormatError(code, message); }
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));

/** Iterative check also rejects cycles/non-JSON programmatic edits before save. */
function checkJSON(value: unknown): void {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (item.exit) { ancestors.delete(item.value as object); continue; }
    if (++nodes > NOTEBOOK_LIMITS.jsonNodes) fail('json-complexity', 'Notebook 的数据项过多，请先清理输出或拆分。');
    if (item.depth > NOTEBOOK_LIMITS.jsonDepth) fail('json-depth', 'Notebook 的嵌套层数过多，未修改原文件。');
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue;
    if (typeof item.value !== 'object') fail('invalid-json-value', 'Notebook 含有不能保存为 JSON 的内容。');
    const object = item.value as object;
    if (ancestors.has(object)) fail('cyclic-json', 'Notebook 含有循环引用，未保存。');
    const proto = Object.getPrototypeOf(object);
    if (!Array.isArray(object) && proto !== Object.prototype && proto !== null) fail('invalid-json-value', 'Notebook 含有不能保存为 JSON 的对象。');
    if (Array.isArray(object) && object.length > NOTEBOOK_LIMITS.jsonNodes - nodes) fail('json-complexity', 'Notebook 的数据项过多，请先清理输出或拆分。');
    ancestors.add(object); stack.push({ value: object, depth: item.depth, exit: true });
    const children = Object.values(object);
    if (children.length + nodes + stack.length > NOTEBOOK_LIMITS.jsonNodes) fail('json-complexity', 'Notebook 的数据项过多，请先清理输出或拆分。');
    for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
  }
}

export function notebookCellSource(cell: NotebookCell): string { return typeof cell.source === 'string' ? cell.source : cell.source.join(''); }
export function notebookMultilineText(value: unknown): string { return multiline(value) ? typeof value === 'string' ? value : value.join('') : ''; }
/** Index disambiguates malformed duplicate IDs without altering a file on open. */
export function notebookCellKey(cell: NotebookCell, index: number): string { return `${index}:${validId(cell.id) ? cell.id : 'cell'}`; }

function validateOutput(output: unknown, cellIndex: number): asserts output is NotebookOutput {
  const where = `第 ${cellIndex + 1} 个单元格的输出`;
  if (!record(output) || typeof output.output_type !== 'string' || !output.output_type) fail('invalid-output', `${where}格式不正确。`);
  if (output.metadata !== undefined && !record(output.metadata)) fail('invalid-output', `${where}的 metadata 必须是对象。`);
  switch (output.output_type) {
    case 'stream':
      if (typeof output.name !== 'string' || !multiline(output.text)) fail('invalid-output', `${where}缺少有效的文本。`);
      break;
    case 'display_data': case 'execute_result':
      if (!record(output.data)) fail('invalid-output', `${where}的 data 必须是对象。`);
      if (output.output_type === 'execute_result' && (output.execution_count === null || !count(output.execution_count))) fail('invalid-output', `${where}的执行次数不正确。`);
      break;
    case 'error':
      if (typeof output.ename !== 'string' || typeof output.evalue !== 'string' || !Array.isArray(output.traceback) || !output.traceback.every(line => typeof line === 'string')) fail('invalid-output', `${where}的错误信息不完整。`);
      break;
    // Future output types survive unchanged; the viewer must not run their content.
  }
}

export function notebookStats(notebook: NotebookDocument): NotebookStats {
  const stats: NotebookStats = { cells: notebook.cells.length, codeCells: 0, markdownCells: 0, rawCells: 0, unknownCells: 0, sourceBytes: 0, outputBytes: 0, attachmentBytes: 0, outputCount: 0 };
  for (const cell of notebook.cells) {
    if (cell.cell_type === 'code') stats.codeCells++;
    else if (cell.cell_type === 'markdown') stats.markdownCells++;
    else if (cell.cell_type === 'raw') stats.rawCells++;
    else stats.unknownCells++;
    stats.sourceBytes += bytes(notebookCellSource(cell));
    if (Array.isArray(cell.outputs)) { stats.outputCount += cell.outputs.length; stats.outputBytes += jsonBytes(cell.outputs); }
    if (cell.attachments !== undefined) stats.attachmentBytes += jsonBytes(cell.attachments);
  }
  return stats;
}

/** Validates structure while permitting future 4.x fields, cell types and outputs. */
export function validateNotebook(value: unknown): asserts value is NotebookDocument {
  if (!record(value)) fail('invalid-notebook', '这个文件不是有效的 Jupyter Notebook。');
  if (value.nbformat !== 4) fail('unsupported-version', `目前支持 nbformat 4；这个文件的版本为 ${String(value.nbformat)}。未修改原文件，请先在 Jupyter 中转换为版本 4。`);
  if (typeof value.nbformat_minor !== 'number' || !Number.isSafeInteger(value.nbformat_minor) || value.nbformat_minor < 0) fail('invalid-version', 'Notebook 的 nbformat_minor 必须是非负整数。');
  if (!record(value.metadata) || !Array.isArray(value.cells)) fail('invalid-notebook', 'Notebook 必须包含 metadata 对象和 cells 列表。');
  if (value.cells.length > NOTEBOOK_LIMITS.cells) fail('cell-limit', '这个 Notebook 超过 1,000 个单元格，请先在 Jupyter 中拆分后打开。');
  checkJSON(value);
  value.cells.forEach((cell: unknown, index: number) => {
    if (!record(cell) || typeof cell.cell_type !== 'string' || !cell.cell_type || !record(cell.metadata) || !multiline(cell.source)) fail('invalid-cell', `第 ${index + 1} 个单元格缺少有效的类型、metadata 或 source。`);
    if (bytes(typeof cell.source === 'string' ? cell.source : (cell.source as string[]).join('')) > NOTEBOOK_LIMITS.cellSourceBytes) fail('cell-source-limit', `第 ${index + 1} 个单元格超过 8 MiB，请先拆分。`);
    if (cell.attachments !== undefined && !record(cell.attachments)) fail('invalid-attachments', `第 ${index + 1} 个单元格的 attachments 必须是对象。`);
    if (cell.cell_type === 'code' && (!Array.isArray(cell.outputs) || !count(cell.execution_count))) fail('invalid-code-cell', `第 ${index + 1} 个代码单元格缺少 outputs 或有效的 execution_count。`);
    if (cell.outputs !== undefined) {
      if (!Array.isArray(cell.outputs)) fail('invalid-output', `第 ${index + 1} 个单元格的 outputs 必须是列表。`);
      if (cell.outputs.length > NOTEBOOK_LIMITS.cellOutputs) fail('output-count-limit', `第 ${index + 1} 个单元格超过 1,000 条输出，请先在 Jupyter 中清理输出。`);
      cell.outputs.forEach(output => validateOutput(output, index));
    }
  });
  const stats = notebookStats(value as NotebookDocument);
  if (stats.sourceBytes > NOTEBOOK_LIMITS.sourceBytes) fail('source-limit', 'Notebook 的代码和文字超过 32 MiB，请先拆分。');
  if (stats.outputBytes + stats.attachmentBytes > NOTEBOOK_LIMITS.outputBytes) fail('output-size-limit', 'Notebook 的输出和附件超过 64 MiB，请先在 Jupyter 中清理或拆分。');
  if (stats.outputCount > NOTEBOOK_LIMITS.outputs) fail('output-count-limit', 'Notebook 超过 10,000 条输出，请先在 Jupyter 中清理输出。');
  if (jsonBytes(value) > NOTEBOOK_LIMITS.fileBytes) fail('file-limit', 'Notebook 超过 128 MiB，请先在 Jupyter 中清理输出或拆分。');
}

export function parseNotebook(text: string): NotebookDocument {
  if (bytes(text) > NOTEBOOK_LIMITS.fileBytes) fail('file-limit', 'Notebook 超过 128 MiB，请先在 Jupyter 中清理输出或拆分。');
  let value: unknown;
  try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { fail('invalid-json', 'Notebook 的 JSON 格式不完整或不正确，未修改原文件。'); }
  validateNotebook(value);
  return value;
}

export function notebookWarnings(notebook: NotebookDocument): NotebookWarning[] {
  const result: NotebookWarning[] = [], used = new Set<string>();
  notebook.cells.forEach((cell, cellIndex) => {
    if (notebook.nbformat_minor >= 5 && (!validId(cell.id) || used.has(cell.id))) result.push({ code: 'cell-id-repair', cellIndex, message: `第 ${cellIndex + 1} 个单元格的 ID 缺失、无效或重复；保存时将生成唯一 ID。` });
    if (validId(cell.id)) used.add(cell.id);
    if (!knownTypes.has(cell.cell_type)) result.push({ code: 'unknown-cell', cellIndex, message: `第 ${cellIndex + 1} 个单元格的类型 ${cell.cell_type} 暂不支持编辑或运行；保存时保留。` });
    if (cell.outputs?.some(output => !knownOutputs.has(output.output_type))) result.push({ code: 'unknown-output', cellIndex, message: `第 ${cellIndex + 1} 个单元格含有暂不支持显示的输出；保存时保留。` });
  });
  return result;
}

function freshId(used: Set<string>, index: number): string {
  const base = `inkspace-cell-${index + 1}`; let id = base, suffix = 1;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id); return id;
}

/** Preserve the first occurrence of every valid ID, even one appearing later. */
export function prepareNotebookForSave(notebook: NotebookDocument): NotebookDocument {
  validateNotebook(notebook);
  if (notebook.nbformat_minor < 5) return notebook;
  const reserved = new Set(notebook.cells.map(cell => cell.id).filter(validId)), seen = new Set<string>();
  let changed = false;
  const cells = notebook.cells.map((cell, index) => {
    if (validId(cell.id) && !seen.has(cell.id)) { seen.add(cell.id); return cell; }
    changed = true;
    return { ...cell, id: freshId(reserved, index) };
  });
  return changed ? { ...notebook, cells } : notebook;
}

export function serializeNotebook(notebook: NotebookDocument): string {
  const text = JSON.stringify(prepareNotebookForSave(notebook), null, 1) + '\n';
  if (bytes(text) > NOTEBOOK_LIMITS.fileBytes) fail('file-limit', '保存后的 Notebook 超过 128 MiB，请先清理输出或拆分。');
  return text;
}

function makeCell(type: NotebookCellType, id: string, source = ''): NotebookCell {
  return type === 'code' ? { cell_type: type, id, metadata: {}, source, outputs: [], execution_count: null } : { cell_type: type, id, metadata: {}, source };
}
export function createNotebook(): NotebookDocument {
  return { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, cells: [makeCell('markdown', 'inkspace-cell-1', '# Notebook\n'), makeCell('code', 'inkspace-cell-2')] };
}
function at(notebook: NotebookDocument, index: number): NotebookCell {
  if (!Number.isInteger(index) || index < 0 || index >= notebook.cells.length) fail('cell-not-found', '这个单元格已不存在，请重新选择。');
  return notebook.cells[index];
}
function replace(notebook: NotebookDocument, index: number, cell: NotebookCell): NotebookDocument {
  const cells = [...notebook.cells]; cells[index] = cell; return { ...notebook, cells };
}

export function updateNotebookCell(notebook: NotebookDocument, index: number, patch: { source?: string; cell_type?: NotebookCellType }): NotebookDocument {
  const old = at(notebook, index);
  if (!knownTypes.has(old.cell_type)) fail('unsupported-cell', '这个扩展单元格暂不支持编辑；它的内容会保留。');
  if (patch.source !== undefined && typeof patch.source !== 'string') fail('invalid-source', '单元格内容必须是文本。');
  if (patch.cell_type !== undefined && !knownTypes.has(patch.cell_type)) fail('unsupported-cell', '请选择代码、Markdown 或原始文本单元格。');
  const type = patch.cell_type ?? old.cell_type, source = patch.source ?? notebookCellSource(old);
  if (type === old.cell_type && source === notebookCellSource(old)) return notebook;
  const size = bytes(source);
  if (size > NOTEBOOK_LIMITS.cellSourceBytes) fail('cell-source-limit', '一个单元格最多 8 MiB，请拆分后输入。');
  if (notebook.cells.reduce((sum, cell, i) => sum + (i === index ? size : bytes(notebookCellSource(cell))), 0) > NOTEBOOK_LIMITS.sourceBytes) fail('source-limit', 'Notebook 的代码和文字最多 32 MiB，请先拆分。');
  const next: NotebookCell = { ...old, cell_type: type, source };
  // Editing code does not invalidate the visible record of its previous run.
  // Only an explicit clear, an actual run, or conversion to code resets outputs.
  if (type === 'code' && old.cell_type !== 'code') { next.outputs = []; next.execution_count = null; }
  else if (type !== 'code' && old.cell_type === 'code') { delete next.outputs; delete next.execution_count; }
  return replace(notebook, index, next);
}

export function addNotebookCell(notebook: NotebookDocument, type: NotebookCellType = 'code', afterIndex = notebook.cells.length - 1): NotebookDocument {
  if (!knownTypes.has(type)) fail('unsupported-cell', '请选择代码、Markdown 或原始文本单元格。');
  if (notebook.cells.length >= NOTEBOOK_LIMITS.cells) fail('cell-limit', '每个 Notebook 最多 1,000 个单元格。');
  if (!Number.isInteger(afterIndex) || afterIndex < -1 || afterIndex >= notebook.cells.length) fail('cell-not-found', '无法在这个位置添加单元格。');
  const cells = [...notebook.cells], id = freshId(new Set(cells.map(cell => cell.id).filter(validId)), cells.length);
  cells.splice(afterIndex + 1, 0, makeCell(type, id)); return { ...notebook, cells };
}
export function removeNotebookCell(notebook: NotebookDocument, index: number): NotebookDocument {
  at(notebook, index); return { ...notebook, cells: notebook.cells.filter((_, i) => i !== index) };
}
export function moveNotebookCell(notebook: NotebookDocument, from: number, to: number): NotebookDocument {
  at(notebook, from); at(notebook, to); if (from === to) return notebook;
  const cells = [...notebook.cells], [cell] = cells.splice(from, 1); cells.splice(to, 0, cell); return { ...notebook, cells };
}
export function clearNotebookOutputs(notebook: NotebookDocument, index?: number): NotebookDocument {
  if (index !== undefined) at(notebook, index);
  let changed = false;
  const cells = notebook.cells.map((cell, i) => {
    if (cell.cell_type !== 'code' || index !== undefined && i !== index || !cell.outputs?.length && cell.execution_count === null) return cell;
    changed = true; return { ...cell, outputs: [], execution_count: null };
  });
  return changed ? { ...notebook, cells } : notebook;
}
export function setNotebookCellOutputs(notebook: NotebookDocument, index: number, outputs: NotebookOutput[], executionCount: number | null): NotebookDocument {
  const cell = at(notebook, index);
  if (cell.cell_type !== 'code') fail('unsupported-cell', '只能为代码单元格写入运行结果。');
  if (!count(executionCount)) fail('invalid-execution-count', '运行结果的执行次数不正确。');
  const next = replace(notebook, index, { ...cell, outputs, execution_count: executionCount });
  validateNotebook(next); return next;
}

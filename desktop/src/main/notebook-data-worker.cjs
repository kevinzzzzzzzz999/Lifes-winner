'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { NOTEBOOK_DATA_LIMITS: LIMITS } = require('./notebook-data.cjs');
const unreadable = () => { throw Object.assign(Error('Workbook metadata is unavailable'), { code: 'EXCEL_UNREADABLE' }); };
const capacity = () => { throw Object.assign(Error('Workbook metadata exceeds its budget'), { code: 'TOO_LARGE' }); };
const MAIN_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);

async function xlsxVisibility(data) {
  const zip = await require('jszip').loadAsync(data);
  const entry = zip.file('xl/workbook.xml');
  if (!entry) unreadable();
  if (entry._data?.uncompressedSize > LIMITS.workbookXMLBytes) capacity();
  const xml = await entry.async('nodebuffer');
  if (xml.length > LIMITS.workbookXMLBytes) capacity();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(xml); } catch { unreadable(); }
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) unreadable();
  // Use the same XML parser already shipped for Office previews. Source-only
  // dependencies are not necessarily present in the installed ASAR.
  const { DOMParser } = require('@xmldom/xmldom');
  const document = new DOMParser({ errorHandler: { warning: unreadable, error: unreadable, fatalError: unreadable } }).parseFromString(text, 'application/xml');
  const root = document.documentElement;
  if (!root || document.doctype || root.localName !== 'workbook' || !MAIN_NAMESPACES.has(root.namespaceURI)) unreadable();
  const pending = [[root, 1]];
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (depth > 64 || ++count > 80000) capacity();
    for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) pending.push([child, depth + 1]);
  }
  const attribute = (node, name) => Array.from(node.attributes).find(value => value.localName === name && !value.namespaceURI)?.value;
  const states = [];
  let foundSheets = false;
  for (let group = root.firstChild; group; group = group.nextSibling) {
    if (group.nodeType !== 1 || group.localName !== 'sheets' || group.namespaceURI !== root.namespaceURI) continue;
    if (foundSheets) unreadable();
    foundSheets = true;
    for (let sheet = group.firstChild; sheet; sheet = sheet.nextSibling) {
      if (sheet.nodeType !== 1 || sheet.localName !== 'sheet' || sheet.namespaceURI !== root.namespaceURI) continue;
      if (states.length >= LIMITS.sheets) capacity();
      if (!attribute(sheet, 'name')) unreadable();
      const state = attribute(sheet, 'state');
      if (state !== undefined && !['visible', 'hidden', 'veryHidden'].includes(state)) unreadable();
      states.push(state === 'hidden' || state === 'veryHidden');
    }
  }
  return states;
}

function xlsVisibility(data, XLSX) {
  const cfb = XLSX.CFB.read(data, { type: 'buffer' });
  if (!Array.isArray(cfb.FullPaths) || !Array.isArray(cfb.FileIndex) || !cfb.FullPaths[0]) unreadable();
  const root = cfb.FullPaths[0].replace(/\/?$/, '/');
  const candidates = cfb.FullPaths.map((name, index) => ({ name, index })).filter(({ name }) =>
    name.toLowerCase() === (root + 'Workbook').toLowerCase() || name.toLowerCase() === (root + 'Book').toLowerCase());
  if (candidates.length !== 1) unreadable();
  const raw = cfb.FileIndex[candidates[0].index]?.content;
  if (!raw) unreadable();
  const stream = Buffer.from(raw);
  if (stream.length > LIMITS.sourceBytes) capacity();
  const states = [];
  let position = 0, first = true, complete = false;
  // Read BIFF workbook-global BoundSheet records only. Stop at its EOF; never
  // traverse worksheet cell, drawing, image or macro substreams.
  while (position + 4 <= stream.length) {
    const type = stream.readUInt16LE(position), length = stream.readUInt16LE(position + 2);
    const start = position + 4;
    if (start + length > stream.length) unreadable();
    if (first) {
      if (![0x0809, 0x0409, 0x0209, 0x0009].includes(type) || length < 4 || stream.readUInt16LE(start + 2) !== 0x0005) unreadable();
      first = false;
    }
    if (type === 0x002f) unreadable(); // encrypted FilePass
    if (type === 0x0085) {
      if (states.length >= LIMITS.sheets) capacity();
      if (length < 7 || stream[start + 4] > 2) unreadable();
      states.push(stream[start + 4] !== 0);
    }
    position = start + length;
    if (type === 0x000a) { complete = true; break; }
  }
  if (!complete) unreadable();
  return states;
}

(async () => {
  try {
    const data = Buffer.from(workerData.data), extension = workerData.extension;
    if (!data.length) unreadable();
    if (data.length > LIMITS.sourceBytes) capacity();
    if (!['xlsx', 'xlsm', 'xls'].includes(extension)) unreadable();
    if (extension === 'xls') {
      if (!data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) unreadable();
    } else {
      // Decompression/structure validation also occurs within the bounded worker.
      require('./excel-zip-budget.cjs').validateExcelZIP(data);
    }
    const XLSX = require('../vendor/excel/xlsx.full.min.js');
    const workbook = XLSX.read(data, { type: 'buffer', bookSheets: true, bookVBA: false, bookDeps: false });
    const names = workbook.SheetNames;
    if (!Array.isArray(names) || !names.length) unreadable();
    if (names.length > LIMITS.sheets) capacity();
    if (names.some(name => typeof name !== 'string' || !name.length || name.length > 255 || name.includes('\0')) || new Set(names).size !== names.length) unreadable();
    const hidden = extension === 'xls' ? xlsVisibility(data, XLSX) : await xlsxVisibility(data);
    if (hidden.length !== names.length) unreadable();
    parentPort.postMessage({ ok: true, sheets: names.map((name, index) => ({ name, hidden: hidden[index] })) });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error?.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'EXCEL_UNREADABLE' });
  }
})();

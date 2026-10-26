'use strict';
// The schema-1 reader shares the companion's bounded geometry and ink rules.
// Validation never reconstructs the object: every unknown field is retained.
const {fail}=require('./errors.cjs');
const MAX_ENTRIES=100000,MAX_STROKES=50000,MAX_POINTS=1000000,MAX_STROKE_POINTS=50000;
const HEX_COLOR=/^#[0-9a-f]{6}$/i;
const KINDS=new Set(['text','formula','document','pdfPage','inkGroup']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isSafeVaultPath(value){try{require('./vault-path.cjs').boardRelativePath(value);return true;}catch{return false;}}
function isPDFSourcePath(value){return isSafeVaultPath(value)&&value.toLowerCase().endsWith('.pdf');}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function identifier(value) { return typeof value === "string" && UUID.test(value); }
function ensure(condition) { if (!condition) fail('INVALID_BOARD'); }

function validateBoard(board) {
  ensure(object(board));
  ensure(board.schemaVersion === 1);
  ensure(identifier(board.id) && identifier(board.writerID));
  ensure(typeof board.title === "string" && board.title.length <= 10000);
  ensure(Number.isInteger(board.revision) && board.revision >= 0);
  for (const key of ["createdAt", "updatedAt"]) {
    ensure(typeof board[key] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(board[key]) && Number.isFinite(Date.parse(board[key])));
  }
  ensure((board.canvasWidth === 1000000 || board.canvasWidth === 8000000) && board.canvasHeight === board.canvasWidth);
  ensure(object(board.viewport) && finite(board.viewport.x) && finite(board.viewport.y) && finite(board.viewport.zoom) && board.viewport.zoom > 0);
  for (const key of ["items", "edges", "pins"]) ensure(Array.isArray(board[key]) && board[key].length <= MAX_ENTRIES);
  for (const key of ["drawing", "previewPNG"]) ensure(board[key] == null || typeof board[key] === "string");
  const ids = new Set();
  for (const item of board.items) {
    ensure(object(item) && identifier(item.id) && KINDS.has(item.kind));
    ensure(item.sourceCardID == null || identifier(item.sourceCardID));
    if(item.childBoards!=null){ensure(Array.isArray(item.childBoards)&&item.childBoards.length<=100);const seenChild=new Set();for(const child of item.childBoards){require('./board-child-links.cjs').validateLink(child,board.canvasWidth);ensure(!seenChild.has(child.id.toLowerCase()));seenChild.add(child.id.toLowerCase());}}
    if(item.style != null) require('./board-elements.cjs').validateItemStyle(item.style);
    ensure(item.textFormat == null || (typeof item.textFormat === 'string' && item.textFormat.length <= 64 && item.textFormat.isWellFormed() && !item.textFormat.includes('\0')));
    ensure(item.richTextHTML == null || (typeof item.richTextHTML === 'string' && item.richTextHTML.length <= 300000 && item.richTextHTML.isWellFormed() && !item.richTextHTML.includes('\0')));
    const id = item.id.toLowerCase();
    ensure(!ids.has(id));
    ids.add(id);
    ensure(typeof item.title === "string" && item.title.length <= 10000 && (item.text == null || (typeof item.text === "string" && item.text.length <= 100000)) && (item.url == null || typeof item.url === "string") && (item.inkData == null || typeof item.inkData === "string"));
    ensure([item.x, item.y, item.width, item.height].every(finite) && item.x >= 0 && item.y >= 0 && item.width > 0 && item.height > 0 && item.x + item.width <= board.canvasWidth && item.y + item.height <= board.canvasHeight);
    ensure(item.sourcePath == null || isSafeVaultPath(item.sourcePath));
    ensure(item.originalSourcePath == null || isSafeVaultPath(item.originalSourcePath));
    ensure(item.originalSourceSHA256 == null || (typeof item.originalSourceSHA256 === "string" && /^[a-f0-9]{64}$/i.test(item.originalSourceSHA256) && item.originalSourcePath != null));
    // sourcePath keeps its original meaning: the actual PDF for rendering and annotations.
    ensure(item.originalSourcePath == null || item.kind !== "pdfPage" || isPDFSourcePath(item.sourcePath));
    ensure(item.page == null || (Number.isInteger(item.page) && item.page >= 1));
    ensure(item.kind !== "pdfPage" || Number.isInteger(item.page));
  }
  for (const edge of board.edges) {
    ensure(object(edge)&& (edge.relation==null||(typeof edge.relation==='string'&&edge.relation.length<=120&&!edge.relation.includes('\0'))));
    if(object(edge) && edge.style != null) require('./board-elements.cjs').validateEdgeStyle(edge.style);
    ensure(object(edge) && identifier(edge.id) && identifier(edge.from) && identifier(edge.to) && edge.from.toLowerCase() !== edge.to.toLowerCase() && ids.has(edge.from.toLowerCase()) && ids.has(edge.to.toLowerCase()));
  }
  for (const pin of board.pins) {
    ensure(object(pin) && identifier(pin.id) && typeof pin.title === "string" && [pin.x, pin.y, pin.zoom].every(finite) && pin.x >= 0 && pin.y >= 0 && pin.x <= board.canvasWidth && pin.y <= board.canvasHeight && pin.zoom > 0);
  }
  if (board.printFrames != null) {
    ensure(Array.isArray(board.printFrames) && board.printFrames.length <= 2000);
    const frameIDs = new Set();
    for (const frame of board.printFrames) {
      ensure(object(frame) && identifier(frame.id));
      const id = frame.id.toLowerCase();
      ensure(!frameIDs.has(id)); frameIDs.add(id);
      ensure([frame.x, frame.y, frame.width, frame.height].every(finite) && frame.x >= 0 && frame.y >= 0 && frame.width > 0 && frame.height > 0 && frame.x + frame.width <= board.canvasWidth && frame.y + frame.height <= board.canvasHeight);
      ensure(["portrait", "landscape"].includes(frame.orientation) && Math.abs(frame.width / frame.height - (frame.orientation === "portrait" ? 540 / 720 : 720 / 540)) <= 0.000001);
      if (frame.normalizedClip != null) {
        // CoreGraphics encodes CGRect as [[x,y],[width,height]].
        const clip = frame.normalizedClip;
        ensure(Array.isArray(clip) && clip.length === 2 && clip.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(finite)));
        ensure(clip[0][0] >= 0 && clip[0][1] >= 0 && clip[1][0] > 0 && clip[1][1] > 0 && clip[0][0] + clip[1][0] <= 1.0000001 && clip[0][1] + clip[1][1] <= 1.0000001);
      }
    }
  }
  if (board.lastInkLocation != null) {
    const r=board.lastInkLocation;ensure(object(r)&&[r.x,r.y,r.width,r.height].every(finite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=board.canvasWidth&&r.y+r.height<=board.canvasHeight);
  }
  if (board.webInk != null) validateWebInk(board.webInk);
  if(board.pdfMergedOwnerIDs!=null){ensure(Array.isArray(board.pdfMergedOwnerIDs)&&board.pdfMergedOwnerIDs.length<=128&&board.pdfMergedOwnerIDs.every(id=>typeof id==='string'&&UUID.test(id))&&new Set(board.pdfMergedOwnerIDs.map(id=>id.toLowerCase())).size===board.pdfMergedOwnerIDs.length);}
  if (board.pdfAnnotationSources != null) {
    ensure(Array.isArray(board.pdfAnnotationSources) && board.pdfAnnotationSources.length <= 2000);
    for (const source of board.pdfAnnotationSources) {
      ensure(object(source) && isSafeVaultPath(source.sourcePath) && typeof source.sha256 === "string" && /^[a-f0-9]{64}$/i.test(source.sha256) && Array.isArray(source.pages) && source.pages.length <= MAX_ENTRIES && source.pages.every(page => Number.isInteger(page) && page >= 1));
    }
  }
  return board;
}

function validateWebInk(ink) {
  ensure(object(ink) && ink.version === 1 && Array.isArray(ink.strokes) && ink.strokes.length <= MAX_STROKES);
  let count = 0, clipCount = 0;
  for (const stroke of ink.strokes) {
    ensure(object(stroke) && typeof stroke.color === "string" && HEX_COLOR.test(stroke.color) && finite(stroke.opacity) && stroke.opacity >= 0 && stroke.opacity <= 1);
    ensure(Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length <= MAX_STROKE_POINTS);
    count += stroke.points.length;
    ensure(count <= MAX_POINTS);
    for (const point of stroke.points) ensure(Array.isArray(point) && point.length === 3 && point.every(finite) && Math.abs(point[0]) <= 8000000 && Math.abs(point[1]) <= 8000000 && point[2] > 0 && point[2] <= 10000);
    if (Object.hasOwn(stroke,'clipPath')) {
      const commands=stroke.clipPath;ensure(Array.isArray(commands)&&commands.length<=10000);
      clipCount+=commands.length;ensure(clipCount<=100000);
      for(let index=0;index<commands.length;index++) {
        const command=commands[index];ensure(Array.isArray(command));
        const size=[3,3,5,7,1][command[0]];
        ensure(Number.isInteger(command[0])&&size!==undefined&&command.length===size&&(index!==0||command[0]===0));
        for(let i=1;i<command.length;i++)ensure(finite(command[i])&&Math.abs(command[i])<=8000000);
      }
    }
  }
  return ink;
}


module.exports={validateBoard,validateWebInk};

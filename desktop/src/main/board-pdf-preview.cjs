'use strict';
const {PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString} = require('pdf-lib');
const {fail} = require('./errors.cjs');

function pdfText(value) {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
}
function ownedAnnotation(dict, boardID) {
  const name = pdfText(dict.lookup(PDFName.of('NM')));
  const contents = pdfText(dict.lookup(PDFName.of('Contents')));
  const prefix = 'InkSpace 手写\n[InkSpace annotation: ';
  const identifier = name.startsWith('InkSpace.v1.') ? name :
    contents.startsWith(prefix) && contents.endsWith(']') ? contents.slice(prefix.length, -1) : '';
  return identifier.toLowerCase().startsWith(`inkspace.v1.${boardID.toLowerCase()}.`);
}

// Only the rendering response is rebuilt. The original vault PDF is never
// changed, and annotations owned by another board/app remain on every page.
async function boardPDFPreview(data, boardID) {
  const owners=Array.isArray(boardID)?boardID:[boardID];
  if (!owners.length || owners.length>129 || owners.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) fail('INVALID_REQUEST');
  const document = await PDFDocument.load(data, {updateMetadata:false});
  let removed = false;
  for (const page of document.getPages()) {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (!(annotations instanceof PDFArray)) continue;
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const annotation = document.context.lookup(annotations.get(i));
      if (annotation instanceof PDFDict && owners.some(id=>ownedAnnotation(annotation, id))) { annotations.remove(i); removed = true; }
    }
  }
  return removed ? Buffer.from(await document.save({useObjectStreams:false, addDefaultPage:false, updateFieldAppearances:false})) : data;
}
module.exports = {boardPDFPreview};

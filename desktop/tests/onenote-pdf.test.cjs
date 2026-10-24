'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PDFDocument,PDFName,PDFString}=require('pdf-lib');
const {buildOneNotePDF,register,parseTile,VERSION}=require('../src/main/onenote-pdf.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function ink(x,y,id){const points=Array.from({length:180},(_,n)=>`${(x+n*.015).toFixed(3)} ${(y+Math.sin(n*.2)).toFixed(3)} ${n?'l':'m'}`).join('\n');return `/P <</MCID ${id}>> BDC\n0.8 0 0 rg\n${points}\nh\nf\nEMC\n`;}
async function fixture({producer='Microsoft OneNote',annot=false,rotate=false,crop=false,pages=4}={}){
 const doc=await PDFDocument.create();doc.setCreator(producer);doc.setProducer(producer);
 for(let n=0;n<pages;n++){
  const p=doc.addPage([595.08,843.24]);let content='q\n0 80 595.51 680 re\nW* n\n';
  if(n===0)content+=ink(20,100,0)+ink(40,110,1);
  if(n===2)content+=ink(20,700,0)+ink(40,710,1)+ink(40,200,2);
  if(n===3)content+=ink(25,200,0);
  content+='Q\nBT\n/F1 3 Tf\n1 0 0 1 60 15.288 Tm\n(Quick Notes Page) Tj\nET\n';
  p.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(content)));
  p.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica'})}}));
  if(annot&&n===0)p.node.set(PDFName.of('Annots'),doc.context.obj([{Type:'Annot',Subtype:'Link',Rect:[0,0,10,10],A:{S:'URI',URI:PDFString.of('https://example.com')}}]));
  if(rotate)p.node.set(PDFName.of('Rotate'),doc.context.obj(90));if(crop)p.setCropBox(10,10,500,700);
 }
 return Buffer.from(await doc.save());
}
test('two-column rows preserve blank slots and repeated ink, without changing input',async()=>{
 const data=await fixture(),before=hash(data),r=await buildOneNotePDF(data,{columns:2}),out=await PDFDocument.load(r.data);
 assert.equal(hash(data),before);assert.equal(out.getPageCount(),1);assert.equal(r.report.version,VERSION);assert.equal(r.report.pageCount,4);assert.equal(r.report.rowCount,2);
 assert.equal(r.report.pageMappings[1].emptyBody,true);assert.equal(r.report.pageMappings[3].row,2);assert.equal(r.report.pageMappings[3].column,2);assert.ok(r.report.pageMappings[3].xOffset>590);
 assert.equal(r.report.verticalSeams[0].method,'matched-handwriting');assert.ok(Math.abs(r.report.verticalSeams[0].step-600)<.001);assert.equal(r.report.removedFooterTextBlocks,4);assert.equal(r.report.rasterized,false);
 const streams=out.getPages()[0].node.Resources().lookup(PDFName.of('XObject'));assert.equal(streams.entries().length,4);
 for(const [,ref] of streams.entries()){const form=out.context.lookup(ref);assert.equal(form.dict.get(PDFName.of('Subtype')).toString(),'/Form');const raw=require('pdf-lib').decodePDFRawStream(form).decode();assert.ok(!Buffer.from(raw).toString().includes('Quick Notes'));}
});
test('incomplete final row keeps its original column mapping',async()=>{const r=await buildOneNotePDF(await fixture({pages:3}),{columns:2});assert.equal(r.report.pageMappings.length,3);assert.deepEqual(r.report.pageMappings.map(x=>[x.row,x.column]),[[1,1],[1,2],[2,1]]);});
test('ordinary PDFs, rotated/custom-cropped pages and annotations are refused, not flattened',async()=>{
 for(const options of [{producer:'Other producer'},{annot:true},{rotate:true},{crop:true}])await assert.rejects(buildOneNotePDF(await fixture(options),{columns:2}),e=>e.code==='ONENOTE_LAYOUT_UNSUPPORTED');
});
test('invalid column counts are refused',async()=>{const data=await fixture();for(const columns of [0,9,1.5])await assert.rejects(buildOneNotePDF(data,{columns}),e=>e.code==='INVALID_REQUEST');});
test('path matching requires whole-shape agreement and the orthogonal coordinate',()=>{
 const raw=(x,y)=>`q\n0 80 595.51 680 re\nW* n\n${ink(x,y,0)}Q\nBT\n1 0 0 1 60 15.288 Tm\n(footer) Tj\nET\n`;
 const a=parseTile(raw(20,100),595.08,843.24,0),b=parseTile(raw(20,700),595.08,843.24,1),wrong=parseTile(raw(21,700),595.08,843.24,1);
 assert.ok(Math.abs(register(a,b,'y').offset-600)<.001);assert.equal(register(a,wrong,'y'),null);
 b.paths[0].coords[b.paths[0].coords.length-1]+=.5;assert.equal(register(a,b,'y'),null);
});

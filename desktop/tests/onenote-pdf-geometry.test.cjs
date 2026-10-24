'use strict';
// Geometry safety regressions: success must preserve known visible source
// paint, or reject the unsupported export so ordinary PDF import can keep it.
const test=require('node:test');
const assert=require('node:assert/strict');
const {PDFDocument,PDFName,PDFString}=require('pdf-lib');
const {buildOneNotePDF}=require('../src/main/onenote-pdf.cjs');

function ink(x,y,id,{tagged=true}={}){
 const path=Array.from({length:180},(_,n)=>`${(x+n*.015).toFixed(3)} ${(y+Math.sin(n*.2)).toFixed(3)} ${n?'l':'m'}`).join('\n');
 const body=`0.8 0 0 rg\n${path}\nh\nf\n`;
 return tagged?`/P <</MCID ${id}>> BDC\n${body}EMC\n`:body;
}
function text(x,y,value){return `BT\n/F1 12 Tf\n1 0 0 1 ${x} ${y} Tm\n(${value}) Tj\nET\n`;}
async function fixture(bodies,{withImage=false}={}){
 const doc=await PDFDocument.create();doc.setCreator('Microsoft OneNote');doc.setProducer('Microsoft OneNote');
 const image=withImage?doc.context.register(doc.context.flateStream(Buffer.from([0,40,200,0,40,200,0,40,200,0,40,200]),{Type:'XObject',Subtype:'Image',Width:2,Height:2,BitsPerComponent:8,ColorSpace:'DeviceRGB'})):null;
 for(const body of bodies){
  const p=doc.addPage([595.08,843.24]);
  const raw=`q\n0 80 595.51 680 re\nW* n\n${body}Q\nBT\n/F1 3 Tf\n1 0 0 1 60 15.288 Tm\n(Quick Notes Page) Tj\nET\n`;
  p.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(raw)));
  p.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica'})},...(image?{XObject:{Image1:image}}:{})}));
 }
 return Buffer.from(await doc.save());
}
function inside(a,b){return a[0]>=b[0]-1e-6&&a[1]>=b[1]-1e-6&&a[2]<=b[2]+1e-6&&a[3]<=b[3]+1e-6;}
async function assertPreservedOrRefused(bytes,columns,sourcePage,visibleBox){
 let result;
 try{result=await buildOneNotePDF(bytes,{columns});}
 catch(error){assert.equal(error.code,'ONENOTE_LAYOUT_UNSUPPORTED','Unsupported source geometry must be rejected explicitly, not dropped or flattened');return;}
 const doc=await PDFDocument.load(result.data),page=doc.getPages()[0];
 const forms=page.node.Resources().lookup(PDFName.of('XObject')).entries().map(([,ref])=>doc.context.lookup(ref)).filter(obj=>obj.dict?.get(PDFName.of('Subtype'))?.toString()==='/Form');
 const form=forms[sourcePage-1];assert.ok(form,'Every source tile must retain its source form');
 const bbox=form.dict.lookup(PDFName.of('BBox')).asArray().map(n=>n.asNumber());
 assert.ok(inside(visibleBox,bbox),`Known source-visible content ${visibleBox} was silently excluded by output Form bbox ${bbox}; refuse this export or preserve the content`);
 const map=result.report.pageMappings.find(m=>m.page===sourcePage);assert.ok(map);
 const world=[visibleBox[0]+map.xOffset,visibleBox[1]+map.yOffset,visibleBox[2]+map.xOffset,visibleBox[3]+map.yOffset];
 assert.ok(inside(world,[0,0,page.getWidth(),page.getHeight()]),`Known source-visible content maps outside the output page: ${world}; refuse this export or preserve the content`);
}

test('OneNote right-column typed content must survive width trimming or be explicitly refused',async()=>{
 const data=await fixture([ink(20,500,0),ink(20,500,0)+text(460,300,'TYPED RIGHT')]);
 await assertPreservedOrRefused(data,2,2,[460,300,540,313]);
});

test('OneNote final-row typed content below the last recognized ink must survive or be refused',async()=>{
 const data=await fixture([ink(40,500,0),ink(20,600,0)+text(30,100,'TYPED LAST ROW')]);
 await assertPreservedOrRefused(data,1,2,[30,100,135,113]);
});

test('OneNote visible unmarked drawing cannot be silently omitted from crop geometry',async()=>{
 const data=await fixture([ink(20,500,0),ink(20,500,0)+ink(490,250,1,{tagged:false})]);
 await assertPreservedOrRefused(data,2,2,[490,248.99,492.685,251.01]);
});

test('OneNote independent drawing transforms must be honored or explicitly refused',async()=>{
 const data=await fixture([ink(40,500,0),`q\n1 0 0 1 0 -400 cm\n${ink(20,600,0)}Q\n`]);
 await assertPreservedOrRefused(data,1,2,[20,198.99,22.685,201.01]);
});

test('OneNote unique typed content in a measured overlap band cannot be discarded with repeated ink',async()=>{
 const data=await fixture([
  ink(20,200,0)+ink(40,220,1)+text(30,100,'UNIQUE TYPED NOTE'),
  ink(20,700,0)+ink(40,720,1)+ink(80,300,2)
 ]);
 await assertPreservedOrRefused(data,1,1,[30,100,150,113]);
});

test('OneNote unique visible ink in a measured overlap band cannot be discarded with other repeated ink',async()=>{
 const data=await fixture([
  ink(20,200,0)+ink(40,220,1)+ink(70,100,2),
  ink(20,700,0)+ink(40,720,1)+ink(80,300,2)
 ]);
 await assertPreservedOrRefused(data,1,1,[70,98.99,72.685,101.01]);
});

test('legitimate complete duplicate ink remains supported with a conservative owner proof',async()=>{
 const data=await fixture([ink(20,200,0)+ink(40,220,1),ink(20,700,0)+ink(40,720,1)+ink(80,300,2)]);
 const result=await buildOneNotePDF(data,{columns:1});
 assert.equal(result.report.inkConservation.verifiedPaths,5);
 assert.equal(result.report.inkConservation.pathsRequiringCorrespondingOwner,2);
 assert.equal(result.report.inkConservation.unprovedVisibleInk,0);
});

test('rectangle coverage must reject an interior gap rather than accepting a bounding union',()=>{
 const {coveredByRectangles}=require('../src/main/onenote-geometry-guard.cjs');
 assert.equal(coveredByRectangles([0,0,10,10],[[0,0,4,10],[6,0,10,10]]),false);
 assert.equal(coveredByRectangles([0,0,10,10],[[0,0,5,10],[5,0,10,10]]),true);
 assert.equal(coveredByRectangles([0,0,10,10],[[0,0,10,4],[0,6,10,10],[0,4,4,6],[6,4,10,6]]),false);
});

test('fill changes after path construction cannot masquerade as an identical repeated paint',async()=>{
 const changed=ink(20,200,0).replace('\nh\nf\n','\nh\n0 .7 0 rg\nf\n');
 const data=await fixture([changed+ink(40,220,1),ink(20,700,0)+ink(40,720,1)+ink(80,300,2)]);
 await assert.rejects(buildOneNotePDF(data,{columns:1}),e=>e.code==='ONENOTE_LAYOUT_UNSUPPORTED');
});

function imageAt(y){return `/P <</MCID 8>> BDC\nq\n20 0 0 20 60 ${y} cm\n/Image1 Do\nQ\nEMC\n`;}

test('a unique visible image in a measured overlap band must be refused rather than cropped',async()=>{
 const data=await fixture([ink(20,200,0)+ink(40,220,1)+imageAt(90),ink(20,700,0)+ink(40,720,1)+ink(80,300,2)],{withImage:true});
 await assert.rejects(buildOneNotePDF(data,{columns:1}),e=>e.code==='ONENOTE_LAYOUT_UNSUPPORTED'&&/unique visible image/.test(e.message));
});

test('an exact source-image counterpart can preserve a cropped image without rasterizing it',async()=>{
 const data=await fixture([ink(20,200,0)+ink(40,220,1)+imageAt(90),ink(20,700,0)+ink(40,720,1)+ink(80,300,2)+imageAt(590)],{withImage:true});
 const result=await buildOneNotePDF(data,{columns:1});
 assert.equal(result.report.imageConservation.verifiedImages,2);assert.equal(result.report.imageConservation.imagesRequiringCorrespondingOwner,1);assert.equal(result.report.imageConservation.approximateImagePairs,0);assert.equal(result.report.rasterized,false);
});

test('a tagged rectangle-only paint is refused rather than disappearing from parsed geometry',async()=>{
 const rect='/P <</MCID 8>> BDC\n0 .6 0 rg\n70 100 20 20 re f\nEMC\n';
 const data=await fixture([ink(20,200,0)+ink(40,220,1)+rect,ink(20,700,0)+ink(40,720,1)+ink(80,300,2)]);
 await assert.rejects(buildOneNotePDF(data,{columns:1}),e=>e.code==='ONENOTE_LAYOUT_UNSUPPORTED');
});

test('a stroke whose full inherited clip is cropped is refused without guessing cap bounds',async()=>{
 const stroke='/P <</MCID 8>> BDC\n30 w\n70 100 m\n90 110 l\nS\nEMC\n';
 const data=await fixture([ink(20,200,0)+ink(40,220,1)+stroke,ink(20,700,0)+ink(40,720,1)+ink(80,300,2)]);
 await assert.rejects(buildOneNotePDF(data,{columns:1}),e=>e.code==='ONENOTE_LAYOUT_UNSUPPORTED');
});

test('a one-pixel unique image mark cannot disappear through low global resampling RMS',async()=>{
 for(const value of [0,160]){
  const doc=await PDFDocument.create();doc.setCreator('Microsoft OneNote');doc.setProducer('Microsoft OneNote');
  for(let i=0;i<2;i++){
   const width=64,height=i?129:128,pixels=Buffer.alloc(width*height*3,255);
   if(!i){const k=(108*width+32)*3;pixels.fill(value,k,k+3);}
   const ref=doc.context.register(doc.context.flateStream(pixels,{Type:'XObject',Subtype:'Image',Width:width,Height:height,BitsPerComponent:8,ColorSpace:'DeviceRGB'}));
   const body=(i?ink(20,700,0)+ink(40,720,1)+ink(80,300,2):ink(20,200,0)+ink(40,220,1))+`/P <</MCID 8>> BDC\nq\n64 0 0 128 20 ${i?620:120} cm\n/Image1 Do\nQ\nEMC\n`;
   const page=doc.addPage([595.08,843.24]);
   page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(`q\n0 80 595.51 680 re\nW* n\n${body}Q\nBT\n/F1 3 Tf\n1 0 0 1 60 15.288 Tm\n(Quick Notes Page) Tj\nET\n`)));
   page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica'})},XObject:{Image1:ref}}));
  }
  await assert.rejects(buildOneNotePDF(Buffer.from(await doc.save()),{columns:1}),e=>e.code==='ONENOTE_LAYOUT_UNSUPPORTED'&&/unique visible image/.test(e.message),`A unique gray level ${value} pixel needs a local counterpart; a small global RMS is insufficient`);
 }
});

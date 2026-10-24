'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PDF_READER_MIN_ZOOM,PDF_READER_MAX_ZOOM,clampPDFReaderZoom,pdfReaderWheelZoom,pdfReaderZoomAnchor}=require('../src/renderer/pdf-reader-zoom.ts');

test('reader scales accept 800%,1600%,3200% and retain the 30% lower limit',()=>{
 assert.equal(PDF_READER_MIN_ZOOM,.3);assert.equal(PDF_READER_MAX_ZOOM,32);
 for(const value of [.3,1,3,8,16,32])assert.equal(clampPDFReaderZoom(value),value);
 assert.equal(clampPDFReaderZoom(-1),.3);assert.equal(clampPDFReaderZoom(100),32);
});

test('invalid restored scales and fallbacks always become a finite bounded scale',()=>{
 for(const value of [NaN,Infinity,-Infinity]){
  assert.equal(clampPDFReaderZoom(value),1);
  assert.equal(clampPDFReaderZoom(value,8),8);
  assert.equal(clampPDFReaderZoom(value,Infinity),1);
  assert.equal(clampPDFReaderZoom(value,100),32);
 }
 assert.equal(clampPDFReaderZoom(16,NaN),16);
});

test('wheel keeps the existing exponential response and reversible gestures below limits',()=>{
 assert.ok(Math.abs(pdfReaderWheelZoom(1,50)-0.9048374180359595)<1e-12);
 assert.ok(Math.abs(pdfReaderWheelZoom(1,-50)-1.1051709180756477)<1e-12);
 for(const start of [1,3,8,16]){
  const enlarged=pdfReaderWheelZoom(start,-100);
  assert.ok(enlarged>start);
  assert.ok(Math.abs(pdfReaderWheelZoom(enlarged,100)-start)<1e-10);
 }
 assert.ok(pdfReaderWheelZoom(3,-100)>3,'a pinch can continue beyond the old 300% ceiling');
});

test('zoom anchor chooses the nearest page in two dimensions and retains its document point',()=>{
 const left={page:'1',rect:{left:-1000,top:10,width:800,height:600}};
 const right={page:'2',rect:{left:100,top:10,width:800,height:600}};
 const anchor=pdfReaderZoomAnchor([left,right],{x:300,y:310});
 assert.deepEqual(anchor,{page:'2',x:.25,y:.375,clientX:300,clientY:310});
 // At the next scale, a scroll adjustment of this difference returns the
 // same page-relative point to its old client coordinate.
 const nextRect={left:30,top:-50,width:1600,height:1200};
 const correction={x:nextRect.left+anchor.x*nextRect.width-anchor.clientX,y:nextRect.top+anchor.y*nextRect.width-anchor.clientY};
 assert.deepEqual(correction,{x:130,y:240});
 assert.equal(nextRect.left+anchor.x*nextRect.width-correction.x,300);
 assert.equal(nextRect.top+anchor.y*nextRect.width-correction.y,310);
});

test('late-page focal point stays in source-width units despite a fixed footer at 1600% and 3200%',()=>{
 const point={x:720,y:570.5};
 const anchor=pdfReaderZoomAnchor([{page:'10',rect:{left:220,top:69.5,width:1000,height:744}}],point);
 assert.deepEqual(anchor,{page:'10',x:.5,y:.501,clientX:720,clientY:570.5});
 for(const scale of [16,32]){
  const width=1000*scale,contentHeight=720*scale,footer=24;
  const top=point.y-anchor.y*width;
  assert.equal(top+anchor.y*width,point.y);
  const again=pdfReaderZoomAnchor([{page:'10',rect:{left:point.x-anchor.x*width,top,width,height:contentHeight+footer}}],point);
  assert.equal(again.x,anchor.x);assert.equal(again.y,anchor.y);
 }
 assert.equal(point.y-anchor.y*16000,-7445.5);
});

test('zoom anchor handles inter-page margins and refuses invalid geometry',()=>{
 const pages=[{page:'1',rect:{left:10,top:10,width:200,height:200}},{page:'2',rect:{left:10,top:250,width:200,height:200}}];
 const anchor=pdfReaderZoomAnchor(pages,{x:110,y:240});
 assert.equal(anchor.page,'2');assert.equal(anchor.x,.5);assert.equal(anchor.y,-.05);
 assert.equal(pdfReaderZoomAnchor(pages,{x:NaN,y:20}),null);
 assert.equal(pdfReaderZoomAnchor([{page:'x',rect:{left:0,top:0,width:0,height:200}},{page:'',rect:{left:0,top:0,width:20,height:20}}],{x:10,y:10}),null);
});

test('large or invalid wheel input cannot exceed bounds or corrupt the reader state',()=>{
 assert.equal(pdfReaderWheelZoom(32,-1000),32);
 assert.equal(pdfReaderWheelZoom(.3,1000),.3);
 assert.equal(pdfReaderWheelZoom(8,-1000),pdfReaderWheelZoom(8,-300));
 assert.equal(pdfReaderWheelZoom(8,1000),pdfReaderWheelZoom(8,300));
 for(const delta of [NaN,Infinity,-Infinity])assert.equal(pdfReaderWheelZoom(16,delta),16);
 assert.equal(pdfReaderWheelZoom(NaN,0),1);
 let scale=1;
 for(let i=0;i<100;i++)scale=pdfReaderWheelZoom(scale,-120);
 assert.equal(scale,32);
 for(let i=0;i<100;i++)scale=pdfReaderWheelZoom(scale,120);
 assert.equal(scale,.3);
});

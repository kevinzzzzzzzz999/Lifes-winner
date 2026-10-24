'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {capturePDFSelection}=require('../src/renderer/pdf-selection-capture.ts');
const bounds=(left=0,top=0,width=320,height=320)=>({left,top,width,height});
const layer=(id,width,height,b,ready=true)=>({id,width,height,dataset:{pdfReady:String(ready)},getBoundingClientRect:()=>b});
function output(size=()=>100){
 const calls=[],sizes=[];const out={width:0,height:0,getContext:()=>({fillRect(){},drawImage(...args){calls.push(args);}}),toDataURL(){sizes.push([this.width,this.height]);return 'data:image/png;base64,'+'a'.repeat(size(sizes.length));}};
 return{out,calls,sizes,create:()=>out};
}

test('a high-zoom selection uses ready detail pixels and puts existing ink last',()=>{
 const base=layer('overview',20,20,bounds()),detail=layer('detail',640,640,bounds()),ink=layer('ink',320,320,bounds()),probe=output();
 const capture=capturePDFSelection(base,{x:100,y:120,width:80,height:60},bounds(),[detail],[ink],probe.create);
 assert.deepEqual([capture.width,capture.height],[160,120]);
 assert.deepEqual(probe.calls.map(call=>call[0].id),['overview','detail','ink']);
 assert.deepEqual(probe.calls[1].slice(1),[200,240,160,120,0,0,160,120]);
 assert.equal(probe.out.width,0);assert.equal(probe.out.height,0);
 assert.equal(base.width,20);assert.equal(detail.width,640);
});

test('partial detail intersects only its own region while overview fills the remainder',()=>{
 const base=layer('overview',100,100,bounds(-200,-400,1000,1000));
 const detail=layer('detail',400,300,bounds(100,50,200,150)),probe=output();
 const capture=capturePDFSelection(base,{x:250,y:400,width:200,height:200},base.getBoundingClientRect(),[detail],[],probe.create);
 assert.deepEqual([capture.width,capture.height],[400,400]);
 // Selection is screen(50,0,200,200); tile begins screen(100,50).
 assert.deepEqual(probe.calls[1].slice(1),[0,0,300,300,100,100,300,300]);
});

test('unready, off-selection, empty and malformed details cannot increase capture size',()=>{
 const base=layer('overview',160,160,bounds()),probe=output();
 const details=[layer('loading',3200,3200,bounds(),false),layer('outside',3200,3200,bounds(800,800)),layer('empty',0,320,bounds()),layer('invalid',320,320,bounds(NaN))];
 const capture=capturePDFSelection(base,{x:20,y:20,width:80,height:60},bounds(),details,[],probe.create);
 assert.deepEqual([capture.width,capture.height],[40,30]);assert.equal(probe.calls.length,1);
});

test('both pixel budgets remain bounded when detail has extreme density',()=>{
 const base=layer('overview',100,100,bounds(0,0,10000,1000)),probe=output();
 const detail=layer('detail',100000,10000,base.getBoundingClientRect());
 const capture=capturePDFSelection(base,{x:0,y:0,width:10000,height:1000},base.getBoundingClientRect(),[detail],[],probe.create);
 assert.ok(capture.width<=4096&&capture.height<=4096&&capture.width*capture.height<=4_000_000);
 assert.equal(capture.width,4096);
 const square=output(),squareBase=layer('overview',100,100,bounds(0,0,10000,10000));
 const squareCapture=capturePDFSelection(squareBase,{x:0,y:0,width:10000,height:10000},squareBase.getBoundingClientRect(),[layer('detail',100000,100000,squareBase.getBoundingClientRect())],[],square.create);
 assert.deepEqual([squareCapture.width,squareCapture.height],[2000,2000]);
});

test('PNG-size retry redraws all layers and releases output even when the byte budget cannot fit',()=>{
 const base=layer('overview',320,320,bounds()),detail=layer('detail',640,640,bounds()),probe=output(attempt=>attempt===1?6_000_000:100);
 const capture=capturePDFSelection(base,{x:0,y:0,width:100,height:100},bounds(),[detail],[],probe.create);
 assert.deepEqual(probe.sizes,[[200,200],[140,140]]);assert.equal(capture.width,140);assert.equal(probe.calls.length,4);assert.equal(probe.out.width,0);
 const rejected=output(()=>6_000_000);
 assert.throws(()=>capturePDFSelection(base,{x:0,y:0,width:100,height:100},bounds(),[],[],rejected.create),/CAPTURE_TOO_LARGE/);
 assert.equal(rejected.sizes.length,8);assert.equal(rejected.out.width,0);assert.equal(rejected.out.height,0);
});

test('invalid and empty selections fail before allocating or reading other canvas pixels',()=>{
 const base=layer('overview',320,320,bounds());let allocated=0;const create=()=>{allocated++;throw Error('unexpected allocation');};
 for(const rect of [{x:NaN,y:0,width:10,height:10},{x:900,y:0,width:10,height:10},{x:0,y:0,width:0,height:10},{x:0,y:0,width:-10,height:10}])assert.throws(()=>capturePDFSelection(base,rect,bounds(),[],[],create),/CAPTURE_UNAVAILABLE/);
 assert.equal(allocated,0);
});

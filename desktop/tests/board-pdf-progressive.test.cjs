'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {planBoardPDFRegions,BOARD_PDF_PIXELS,PDF_PAGE_PIXELS}=require('../src/renderer/board-pdf-resolution.ts');
const {createPDFDetailState,requestPDFDetail,finishPDFDetail,pdfDetailFrameScale,pdfDetailFrameScore,pdfDetailCoversRequest}=require('../src/renderer/board-pdf-progressive.ts');
const view={width:1232,height:525},longPage={id:'long',x:-1617,y:-16017,width:1440*3.28,height:13039*3.28};
const plan=(page=longPage,budget=BOARD_PDF_PIXELS)=>planBoardPDFRegions([page],view,1,2,budget,true).get(page.id);
const shifted=(region,x)=>{const value={...region,x};return{...value,key:JSON.stringify(value)};};
const held=state=>[state.front,state.active].filter(Boolean);

test('328% long-page overscan is stable for small pans and refreshes after crossing a quantized boundary',()=>{
 const initial=plan();for(let n=1;n<=16;n++)assert.equal(plan({...longPage,x:longPage.x+n,y:longPage.y+n}).key,initial.key);
 assert.notEqual(plan({...longPage,x:longPage.x-256,y:longPage.y-256}).key,initial.key);
 assert(initial.x<-longPage.x&&initial.y<-longPage.y);assert(initial.x+initial.width>-longPage.x+view.width);assert(initial.y+initial.height>-longPage.y+view.height);
 assert(initial.pixelWidth/initial.width>1);assert(initial.pixelWidth*initial.pixelHeight<=initial.pixelBudget);
});
test('every progressive crop covers the visible intersection and stays inside all four page edges',()=>{
 for(const x of [-longPage.width+10,-longPage.width/2,-20,0,50,view.width-10])for(const y of [-longPage.height+10,-longPage.height/2,-20,0,50,view.height-10]){
  const page={...longPage,x,y},r=plan(page);assert(r);const left=Math.max(0,x),top=Math.max(0,y),right=Math.min(view.width,x+page.width),bottom=Math.min(view.height,y+page.height);
  assert(r.x>=0&&r.y>=0&&r.x+r.width<=page.width+.0001&&r.y+r.height<=page.height+.0001);
  assert(r.x<=left-x&&r.y<=top-y&&r.x+r.width>=right-x&&r.y+r.height>=bottom-y);
  assert(r.pixelWidth*r.pixelHeight<=r.pixelBudget);assert(r.pixelBudget*2<=PDF_PAGE_PIXELS);
 }
});
test('all front and pending reservations together stay within the shared pixel budget',()=>{
 const pages=Array.from({length:12},(_,i)=>({...longPage,id:String(i),x:-800+i*20,y:-900+i*20}));
 for(const budget of [24_000_000,12_000_000,1_000_000]){
  const regions=[...planBoardPDFRegions(pages,view,1,4,budget,true).values()];assert.equal(regions.length,12);
  assert(regions.reduce((sum,r)=>sum+2*r.pixelBudget,0)<=budget);
  assert(regions.reduce((sum,r)=>sum+2*r.pixelWidth*r.pixelHeight,0)<=budget);
 }
 // Replay's single-buffer/default planner retains its original exact intersection.
 const legacy=planBoardPDFRegions([longPage],view,1,2).get('long');assert.equal(legacy.x,-longPage.x);assert.equal(legacy.width,view.width);assert.equal(legacy.pixelBudget,undefined);
});
test('sustained pan keeps one active render, promotes it, then serves only the newest queued crop',()=>{
 const first=plan();let state=createPDFDetailState(first);const active=state.active;
 for(let n=1;n<=100;n++)state=requestPDFDetail(state,shifted(first,first.x+n*4));
 assert.equal(state.active,active);assert.equal(held(state).length,1);assert.equal(state.latest.x,first.x+400);
 state=finishPDFDetail(state,active.id,true);assert.equal(state.front,active);assert.equal(state.active.region.key,state.latest.key);assert.equal(held(state).length,2);
 const second=state.active;state=requestPDFDetail(state,shifted(first,first.x+800));assert.equal(state.active,second);assert.equal(state.front,active);
 state=finishPDFDetail(state,second.id,true);assert.equal(state.front,second);assert.equal(state.active.region.x,first.x+800);assert.equal(held(state).length,2);
});
test('returning to the finished crop discards an obsolete result without starting a duplicate render',()=>{
 const first=plan();let state=finishPDFDetail(createPDFDetailState(first),1,true);const front=state.front;
 state=requestPDFDetail(state,shifted(first,first.x+400));const active=state.active;state=requestPDFDetail(state,first);state=finishPDFDetail(state,active.id,true);
 assert.equal(state.front,front);assert.equal(state.active,undefined);assert.equal(state.latest.key,first.key);
});
test('returning near a finished crop keeps its useful coverage when a distant pending crop completes',()=>{
 const first=plan();let state=finishPDFDetail(createPDFDetailState(first),1,true);const front=state.front;
 const far=shifted(first,first.x+first.width*3),near=shifted(first,first.x+128);
 state=requestPDFDetail(state,far);const distantJob=state.active;state=requestPDFDetail(state,near);
 assert(pdfDetailFrameScore(front.region,near).coverage>0);assert.equal(pdfDetailFrameScore(distantJob.region,near).coverage,0);
 state=finishPDFDetail(state,distantJob.id,true);assert.equal(state.front,front);assert.equal(state.active.region.key,near.key);assert.equal(held(state).length,2);
});
test('coverage comparisons use the latest zoom and prefer sharper pixels only when coverage is equal',()=>{
 const r={x:100,y:100,width:100,height:100,pageWidth:1000,pageHeight:1000,pixelWidth:200,pixelHeight:200,pixelBudget:1_000_000,key:'original'};
 let state=finishPDFDetail(createPDFDetailState(r),1,true);const original=state.front;
 const zoomed={...r,x:200,y:200,width:200,height:200,pageWidth:2000,pageHeight:2000,pixelWidth:400,pixelHeight:400,key:'zoomed'};
 state=requestPDFDetail(state,zoomed);const sharper=state.active;state=requestPDFDetail(state,{...zoomed,key:'latest-same-geometry'});
 assert.equal(pdfDetailFrameScore(original.region,state.latest).coverage,1);assert.equal(pdfDetailFrameScore(sharper.region,state.latest).coverage,1);
 state=finishPDFDetail(state,sharper.id,true);assert.equal(state.front,sharper);assert.equal(state.active,undefined);
 const partial={...zoomed,x:zoomed.x+100,pixelWidth:800,pixelHeight:800,key:'sharper-but-partial'};
 state=requestPDFDetail(state,partial);const partialJob=state.active;assert.equal(partialJob.region.key,partial.key);state=requestPDFDetail(state,zoomed);state=finishPDFDetail(state,partialJob.id,true);assert.equal(state.front,sharper);assert.equal(state.active,undefined);
});
test('an already adequate sharper crop satisfies a different lower-density request without a rerender loop',()=>{
 const first=plan();let state=finishPDFDetail(createPDFDetailState(first),1,true);const front=state.front;
 const inset={...first,x:first.x+20,y:first.y+20,width:first.width-40,height:first.height-40,pixelWidth:Math.floor(first.pixelWidth/2),pixelHeight:Math.floor(first.pixelHeight/2),key:'lower-density-inset'};
 state=requestPDFDetail(state,inset);assert.equal(state.front,front);assert.equal(state.active,undefined);
 for(let n=0;n<10;n++)state=requestPDFDetail(state,inset);assert.equal(state.active,undefined);assert.equal(state.nextID,2);
});
test('without a front a completed stale crop is retained only when it intersects the current request',()=>{
 const first=plan();let state=createPDFDetailState(first);const initial=state.active;
 const far=shifted(first,first.x+first.width*3);state=requestPDFDetail(state,far);state=finishPDFDetail(state,initial.id,true);
 assert.equal(state.front,undefined);assert.equal(state.active.region.key,far.key);
 const latest=shifted(far,far.x+128),job=state.active;state=requestPDFDetail(state,latest);state=finishPDFDetail(state,job.id,true);
 assert.equal(state.front,job);assert.equal(state.active.region.key,latest.key);assert(pdfDetailFrameScore(state.front.region,latest).coverage>0);
});
test('retained crops scale in page coordinates and never claim a newly uncovered area is ready',()=>{
 const original=plan(),twice={...original,x:original.x*2,y:original.y*2,width:original.width*2,height:original.height*2,pageWidth:original.pageWidth*2,pageHeight:original.pageHeight*2};
 assert.deepEqual(pdfDetailFrameScale(original,twice),{x:2,y:2});assert.equal(pdfDetailCoversRequest(original,twice),true);
 assert.equal(pdfDetailCoversRequest(original,{...twice,x:twice.x+200}),false);assert.equal(pdfDetailCoversRequest(undefined,twice),false);
});
test('budget shrink retires oversized crops and ignores their later completion',()=>{
 const first=plan();let state=finishPDFDetail(createPDFDetailState(first),1,true);state=requestPDFDetail(state,shifted(first,first.x+400));const obsoleteID=state.active.id;
 const smaller={...plan(longPage,1_000_000),key:'smaller-budget'};state=requestPDFDetail(state,smaller);
 assert.equal(state.front,undefined);assert.notEqual(state.active.id,obsoleteID);assert(held(state).every(f=>f.region.pixelWidth*f.region.pixelHeight<=smaller.pixelBudget));
 assert.equal(finishPDFDetail(state,obsoleteID,true),state);
});
test('a failed crop is not retried forever but a newer demand can make progress',()=>{
 const first=plan();let state=finishPDFDetail(createPDFDetailState(first),1,false);assert.equal(state.front,undefined);assert.equal(state.active,undefined);assert.equal(state.failedKey,first.key);
 state=requestPDFDetail(state,first);assert.equal(state.active,undefined);state=requestPDFDetail(state,shifted(first,first.x+300));assert(state.active);assert.equal(state.failedKey,undefined);
 state=finishPDFDetail(state,state.active.id,true);assert(state.front);assert.equal(state.active,undefined);
});

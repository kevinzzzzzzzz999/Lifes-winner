'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {clampMergePosition,defaultMergePosition,mergePlacementCamera,mergePreviewPlan,validMergeBounds,MERGE_WORLD_LIMIT}=require('../src/renderer/board-merge-placement.ts');
test('whole-source placement supports arbitrary offsets and clamps only to the complete world, never the current canvas',()=>{
 const source={x:500,y:900,width:12000,height:8000},point={x:41000,y:65000};
 assert.deepEqual(clampMergePosition(point,source),point);assert.deepEqual(source,{x:500,y:900,width:12000,height:8000});
 assert.deepEqual(clampMergePosition({x:-100,y:-5},source),{x:0,y:0});
 const last=clampMergePosition({x:MERGE_WORLD_LIMIT,y:MERGE_WORLD_LIMIT},source);assert.equal(last.x+source.width,MERGE_WORLD_LIMIT);assert.equal(last.y+source.height,MERGE_WORLD_LIMIT);
});
test('empty targets and a populated target receive valid initial preview positions without changing the source origin',()=>{
 const s={x:-20,y:440,width:900,height:600},t={x:200,y:80,width:1000,height:300};
 assert.deepEqual(defaultMergePosition(s,null),{x:120,y:120});assert.deepEqual(defaultMergePosition(s,t),{x:200,y:500});
 const camera=mergePlacementCamera(s,defaultMergePosition(s,t),t);
 for(const r of [t,{x:200,y:500,width:s.width,height:s.height}]){assert(Math.abs(r.x-camera.x)*camera.zoom<=400);assert(Math.abs(r.y-camera.y)*camera.zoom<=230);assert(Math.abs(r.x+r.width-camera.x)*camera.zoom<=400);assert(Math.abs(r.y+r.height-camera.y)*camera.zoom<=230);}
});
test('invalid or oversized source ranges fail before placement; finite maximum-size ranges remain usable',()=>{
 const valid={x:0,y:0,width:10,height:10};for(const bad of [{...valid,width:0},{...valid,height:-1},{...valid,x:NaN},{...valid,width:Infinity},{...valid,width:MERGE_WORLD_LIMIT+1}]){assert.equal(validMergeBounds(bad),false);assert.throws(()=>clampMergePosition({x:0,y:0},bad));}
 assert.throws(()=>clampMergePosition({x:NaN,y:0},valid));assert.deepEqual(clampMergePosition({x:30,y:30},{x:-100,y:20,width:MERGE_WORLD_LIMIT,height:MERGE_WORLD_LIMIT}),{x:0,y:0});
});
test('large-source ghost preview allocates at most 1400² pixels and limits sampled points without altering data',()=>{
 const points=2_403_000,bounds={x:450,y:700,width:1_000_000,height:700_000},plan=mergePreviewPlan(bounds,points);
 assert(plan.width<=1400&&plan.height<=1400);assert(plan.width*plan.height<=1400*1400);assert(Math.ceil(points/plan.stride)<=180_000);assert.deepEqual(bounds,{x:450,y:700,width:1_000_000,height:700_000});
 const tiny=mergePreviewPlan({x:0,y:0,width:1,height:1},1);assert.deepEqual(tiny,{width:1,height:1,scale:1,stride:1});
});

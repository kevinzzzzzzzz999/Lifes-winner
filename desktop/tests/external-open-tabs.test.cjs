'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {retainExternalTab}=require('../src/renderer/external-open-tabs.ts');
test('Finder activation preserves the exact existing dirty tab and its original source',()=>{
 const draft={vaultId:'vault',file:{path:'A.ipynb',sha256:'original',text:'original source'},draft:'unsaved local changes',dirty:true};
 const tabs=[draft],loaded={vaultId:'vault',file:{path:'A.ipynb',sha256:'external',text:'changed elsewhere'},draft:'changed elsewhere',dirty:false};
 assert.equal(retainExternalTab(tabs,loaded),tabs);assert.equal(tabs[0],draft);assert.equal(tabs[0].draft,'unsaved local changes');assert.equal(tabs[0].file.sha256,'original');
});
test('multiple warm files are appended without losing any earlier tab or reloading duplicates',()=>{
 const a={vaultId:'vault',file:{path:'A.md'},dirty:true},b={vaultId:'vault',file:{path:'B.md'},dirty:false},c={vaultId:'vault',file:{path:'C.md'},dirty:false};
 const next=retainExternalTab(retainExternalTab([a],b),c);assert.deepEqual(next,[a,b,c]);assert.equal(retainExternalTab(next,{...b,dirty:true}),next);assert.equal(next[0],a);
});

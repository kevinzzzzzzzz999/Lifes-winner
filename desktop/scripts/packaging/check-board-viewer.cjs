'use strict';
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/renderer/BoardViewer.tsx'),'utf8');
let calls=[];let version=1;let rejectNext=false;
const context={exports:{},require:()=>({}),window:{desktop:{getAssetUrl:async request=>{calls.push(request);if(rejectNext){rejectNext=false;throw Error('synthetic failure');}await Promise.resolve();return {ok:true,value:{url:'synthetic:'+version,sha256:String(version)}};}}}};
(async()=>{
 const {transformWithOxc}=await import('vite');
 // Execute the actual production helpers, with only type syntax removed by the
 // same transform used for the application. React and browser layout are outside
 // this narrowly scoped cache/annotation regression check.
 const first=source.indexOf('function createAssetCache('),last=source.indexOf('function BoardPDF(');
 assert.ok(first>=0&&last>first);
 const {code}=await transformWithOxc(source.slice(first,last),'board-helper-check.ts');
 vm.createContext(context);vm.runInContext(code+'\nglobalThis.helpers={createAssetCache,matchesPDFWriteback};',context);
 const {createAssetCache,matchesPDFWriteback}=context.helpers;
 const checks=[];const cache=createAssetCache('vault-A');
 const values=await Promise.all(Array.from({length:12},()=>cache.load('Course.pdf')));
 assert.equal(calls.length,1);assert.ok(values.every(x=>x===values[0]));checks.push('12 simultaneous pages share one source snapshot request');
 assert.equal(matchesPDFWriteback({sourcePath:'Course.pdf',sha256:'1',pages:[1]},1,'1'),true);
 assert.equal(matchesPDFWriteback({sourcePath:'Course.pdf',sha256:'1',pages:[1]},2,'1'),false);checks.push('same source digest does not clip an unwritten page');
 assert.equal(matchesPDFWriteback({sourcePath:'Course.pdf',sha256:'1',pages:[1]},1,'2'),false);assert.equal(matchesPDFWriteback(undefined,1,'1'),false);checks.push('changed or missing digest declaration keeps web ink');
 version=2;cache.clear();assert.equal((await cache.load('Course.pdf')).sha256,'2');checks.push('reload clears old fingerprints');
 const other=createAssetCache('vault-B');await other.load('Course.pdf');assert.equal(calls.at(-1).vaultId,'vault-B');checks.push('same relative path in another vault uses independent authority');
 const bounded=createAssetCache('vault-A');for(let n=0;n<65;n++)await bounded.load('PDF-'+n+'.pdf');const count=calls.length;await bounded.load('PDF-0.pdf');assert.equal(calls.length,count+1);checks.push('metadata LRU retains at most 64 source entries');
 rejectNext=true;await assert.rejects(()=>bounded.load('failed.pdf'));await bounded.load('failed.pdf');checks.push('failed lookup can retry');
 const report={passed:true,checks,scope:'Actual production asset cache and annotation match helper; no browser or device execution.'};fs.mkdirSync(path.resolve(__dirname,'../../build/evidence'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../../build/evidence/board-viewer-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});

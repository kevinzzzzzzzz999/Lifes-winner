const test=require('node:test');
const assert=require('node:assert/strict');
const read=()=>import('../src/renderer/board-source-navigation.ts');
const fixture=()=>({schemaVersion:1,path:'Course/Reading.pdf',sourceSHA256:'a'.repeat(64),page:3,rect:{x:.1,y:.2,width:.3,height:.4},quote:'A source quotation',extendBlockID:'12345678-1234-1234-1234-123456789abc'});

test('reads a saved source anchor as an independent safe snapshot',async()=>{
 const {boardPDFSourceReference}=await read(),original=fixture();Object.freeze(original.rect);Object.freeze(original);
 const parsed=boardPDFSourceReference(original);assert.deepEqual(parsed,original);assert.notEqual(parsed,original);assert.notEqual(parsed.rect,original.rect);
 parsed.path='Canonical/Reading.pdf';parsed.rect.x=.15;assert.equal(original.path,'Course/Reading.pdf');assert.equal(original.rect.x,.1);
});
test('rejects paths that escape the granted root or refer to a non-PDF asset',async()=>{
 const {boardPDFSourceReference}=await read();
 for(const path of ['/Reading.pdf','../Reading.pdf','Course/../Reading.pdf','Course//Reading.pdf','C:\\Reading.pdf','file:Reading.pdf','Reading.png','Reading.pdf\0'])assert.equal(boardPDFSourceReference({...fixture(),path}),undefined,path);
});
test('rejects invalid source identity, page, geometry and unknown schemas',async()=>{
 const {boardPDFSourceReference}=await read();
 for(const invalid of [null,[],{...fixture(),schemaVersion:2},{...fixture(),page:1.5},{...fixture(),page:0},{...fixture(),sourceSHA256:'wrong'},{...fixture(),rect:{x:.9,y:0,width:.3,height:.2}},{...fixture(),rect:{x:0,y:0,width:0,height:.2}},{...fixture(),rect:{x:NaN,y:0,width:.3,height:.2}}])assert.equal(boardPDFSourceReference(invalid),undefined);
});
test('keeps usable PDF anchors while dropping malformed optional metadata',async()=>{
 const {boardPDFSourceReference}=await read(),parsed=boardPDFSourceReference({...fixture(),quote:null,extendBlockID:'not-a-block-id',extra:{untrusted:true}});
 assert.equal(parsed.quote,'');assert.equal(parsed.extendBlockID,undefined);assert.equal(parsed.extra,undefined);assert.equal(parsed.page,3);
});

'use strict';
const {fail}=require('./errors.cjs');
const MAX_MODEL_CHARACTERS=300000;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const xml=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function validateModel(value){
 let characters=0,blocks=0;
 const keys=(v,allowed)=>{if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail('INVALID_DOCUMENT');};
 const text=(v,max)=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(v)||!v.isWellFormed())fail('INVALID_DOCUMENT');characters+=v.length;if(characters>MAX_MODEL_CHARACTERS)fail('TOO_LARGE');return v;};
 const readBlocks=arr=>{if(!Array.isArray(arr)||arr.length>5000)fail('INVALID_DOCUMENT');return arr.map(b=>{keys(b,['kind','text']);if(!['paragraph','heading','bullet'].includes(b.kind))fail('INVALID_DOCUMENT');if(++blocks>5000)fail('TOO_LARGE');return {kind:b.kind,text:text(b.text,100000)};});};
 keys(value,['version','format','title','blocks','slides']);
 if(value.version!==1||!['docx','pptx','pdf'].includes(value.format))fail('INVALID_DOCUMENT');
 const model={version:1,format:value.format,title:text(value.title,1000),blocks:readBlocks(value.blocks)};
 if(value.format==='pptx'){
  if(!Array.isArray(value.slides)||value.slides.length<1||value.slides.length>200||model.blocks.length)fail('INVALID_DOCUMENT');
  model.slides=value.slides.map(s=>{keys(s,['title','blocks']);const slide={title:text(s.title,200),blocks:readBlocks(s.blocks)};if(slide.blocks.length>100||slide.blocks.reduce((n,b)=>n+b.text.length,0)>12000)fail('TOO_LARGE');return slide;});
 }else if(value.slides!=null)fail('INVALID_DOCUMENT');
 return model;
}
function blocksHTML(blocks){return blocks.map(b=>b.kind==='heading'?`<h2>${xml(b.text)}</h2>`:b.kind==='bullet'?`<ul><li>${xml(b.text)}</li></ul>`:`<p>${xml(b.text)||'&#160;'}</p>`).join('');}
function modelHTML(model){return model.format==='pptx'?model.slides.map((s,i)=>`<section><h1>${xml(s.title)}</h1>${blocksHTML(s.blocks)}<p>Slide ${i+1}</p></section>`).join(''):`<h1>${xml(model.title)}</h1>${blocksHTML(model.blocks)}`;}
function modelText(model){return model.format==='pptx'?model.slides.map(s=>[s.title,...s.blocks.map(b=>b.text)].join('\n')).join('\n\n'):[model.title,...model.blocks.map(b=>b.text)].join('\n');}
module.exports={validateModel,xml,blocksHTML,modelHTML,modelText,MAX_MODEL_CHARACTERS};

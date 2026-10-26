'use strict';
const crypto=require('node:crypto');
const {imageInfo}=require('./image-import.cjs');
const {fail}=require('./errors.cjs');
const LIMITS=Object.freeze({items:200,bytes:100*1024*1024,mediaBytes:12*1024*1024,indexBytes:4*1024*1024,text:4000,seconds:60,pendingBytes:24*1024*1024,dimension:8192,pixels:24000000,lifetimeMs:10*60*1000});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('LEARNING_INVALID');return value;}
function text(value){if(typeof value!=='string'||!value.trim()||value.length>LIMITS.text||value.includes('\0')||Buffer.from(value,'utf8').toString('utf8')!==value)fail('LEARNING_LABEL');return value;}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)||(!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19)))fail('LEARNING_INVALID');return value;}
function emptyLibrary(){return{version:1,kind:'personal-recognition-samples',samples:[]};}
function parseLibrary(value){
 exact(value,['version','kind','samples']);if(value.version!==1||value.kind!=='personal-recognition-samples'||!Array.isArray(value.samples)||value.samples.length>LIMITS.items)fail('LEARNING_INVALID');
 let total=0;const ids=new Set(),digests=new Set();const samples=value.samples.map(sample=>{
  exact(sample,['id','kind','locale','source','mediaFileName','sha256','byteCount','durationSeconds','confirmedText','enabled','createdAt','updatedAt']);
  if(!UUID.test(sample.id||'')||!['handwriting','speech'].includes(sample.kind)||!['zh-CN','en-US'].includes(sample.locale)||!SHA.test(sample.sha256||'')||!Number.isSafeInteger(sample.byteCount)||sample.byteCount<1||sample.byteCount>LIMITS.mediaBytes||typeof sample.enabled!=='boolean')fail('LEARNING_INVALID');
  const id=sample.id.toLowerCase(),extension=sample.kind==='speech'?'wav':null;
  if(ids.has(id)||digests.has(sample.sha256))fail('LEARNING_DUPLICATE');ids.add(id);digests.add(sample.sha256);
  if(typeof sample.mediaFileName!=='string'||!(sample.kind==='speech'?sample.mediaFileName===id+'.wav':[id+'.png',id+'.jpg'].includes(sample.mediaFileName)))fail('LEARNING_INVALID');
  if(sample.kind==='speech'){if(!['microphone','imported-audio'].includes(sample.source)||typeof sample.durationSeconds!=='number'||!Number.isFinite(sample.durationSeconds)||sample.durationSeconds<=0||sample.durationSeconds>LIMITS.seconds)fail('LEARNING_INVALID');}
  else if(!['pencil-draft','imported-image'].includes(sample.source)||sample.durationSeconds!==undefined)fail('LEARNING_INVALID');
  total+=sample.byteCount;if(total>LIMITS.bytes)fail('LEARNING_LIMIT');
  text(sample.confirmedText);date(sample.createdAt);date(sample.updatedAt);return{...sample};
 });
 return{version:1,kind:'personal-recognition-samples',samples};
}
function inspectWAV(bytes){
 if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)fail('LEARNING_MEDIA');
 let at=12,format=null,dataSize=null,chunks=0;
 while(at<bytes.length){if(++chunks>128||at+8>bytes.length)fail('LEARNING_MEDIA');const tag=bytes.toString('ascii',at,at+4),size=bytes.readUInt32LE(at+4),start=at+8,end=start+size;if(end>bytes.length)fail('LEARNING_MEDIA');
  if(tag==='fmt '){if(format||![16,18].includes(size))fail('LEARNING_MEDIA');const code=bytes.readUInt16LE(start),channels=bytes.readUInt16LE(start+2),rate=bytes.readUInt32LE(start+4),byteRate=bytes.readUInt32LE(start+8),align=bytes.readUInt16LE(start+12),bits=bytes.readUInt16LE(start+14);if(code!==1||channels<1||channels>2||rate<8000||rate>96000||![8,16,24,32].includes(bits)||align!==channels*bits/8||byteRate!==rate*align||(size===18&&bytes.readUInt16LE(start+16)!==0))fail('LEARNING_MEDIA');format={channels,sampleRate:rate,bitsPerSample:bits,blockAlign:align};}
  if(tag==='data'){if(dataSize!==null||size===0)fail('LEARNING_MEDIA');dataSize=size;}
  at=end+(size%2);if(at>bytes.length)fail('LEARNING_MEDIA');
 }
 if(!format||dataSize===null||dataSize%format.blockAlign!==0)fail('LEARNING_MEDIA');const durationSeconds=dataSize/format.blockAlign/format.sampleRate;if(durationSeconds<=0||durationSeconds>LIMITS.seconds)fail('LEARNING_DURATION');return{...format,durationSeconds,extension:'wav',mime:'audio/wav'};
}
function inspectMedia(bytes,kind,{decodeImage}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>LIMITS.mediaBytes)fail('LEARNING_LIMIT');let info;
 if(kind==='speech')info=inspectWAV(bytes);
 else if(kind==='handwriting'){
  try{info=imageInfo(bytes);}catch{fail('LEARNING_MEDIA');}
  if(info.width>LIMITS.dimension||info.height>LIMITS.dimension||info.width*info.height>LIMITS.pixels)fail('LEARNING_LIMIT');
  if(info.extension==='png'&&(bytes.length<45||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND'))fail('LEARNING_MEDIA');
  if(info.extension==='jpg'&&(bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217))fail('LEARNING_MEDIA');
  if(typeof decodeImage!=='function'||decodeImage(bytes,info)!==true)fail('LEARNING_MEDIA');info={...info,mime:info.extension==='png'?'image/png':'image/jpeg'};
 }else fail('LEARNING_INVALID');
 return{kind,byteCount:bytes.length,sha256:hash(bytes),...info};
}
module.exports={LIMITS,UUID,SHA,hash,exact,text,emptyLibrary,parseLibrary,inspectWAV,inspectMedia};

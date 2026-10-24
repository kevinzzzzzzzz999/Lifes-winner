'use strict';
// Bounded reader for the standard ZIP / WinZip AE-1 and AE-2 envelope.
// Authentication is checked before decompression; no archive paths are written.
const crypto=require('node:crypto'),zlib=require('node:zlib');
const {fail}=require('./errors.cjs');
const FORMAT_PARAMETER=require('./boardnotes-format.cjs');
const LIMITS=Object.freeze({compressed:1536*1024*1024,entry:64*1024*1024,total:3*1024*1024*1024,entries:10000,name:1024});
function invalid(){fail('BOARDNOTES_INVALID');}
function safeName(s){if(typeof s!=='string'||!s||Buffer.byteLength(s)>LIMITS.name||s.includes('\0')||s.includes('\\')||s.startsWith('/')||s.includes(':')||s.split('/').some(x=>!x||x==='.'||x==='..')||s.split('/').length>16)invalid();return s;}
const crcTable=Uint32Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
function crc32(data){let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function extras(data){const result=new Map();for(let p=0;p<data.length;){if(p+4>data.length)invalid();const id=data.readUInt16LE(p),n=data.readUInt16LE(p+2);p+=4;if(n>data.length-p||result.has(id))invalid();result.set(id,data.subarray(p,p+n));p+=n;}return result;}
function integer64(b,p){if(p+8>b.length)invalid();const n=b.readBigUInt64LE(p);if(n>BigInt(Number.MAX_SAFE_INTEGER))invalid();return Number(n);}
function parseArchive(data){
 if(!Buffer.isBuffer(data)||data.length<22)invalid();if(data.length>LIMITS.compressed)fail('TOO_LARGE');
 let end=-1;for(let p=data.length-22;p>=Math.max(0,data.length-65557);p--)if(data.readUInt32LE(p)===0x06054b50&&p+22+data.readUInt16LE(p+20)===data.length){end=p;break;}
 if(end<0||data.readUInt16LE(end+4)!==0||data.readUInt16LE(end+6)!==0||data.readUInt16LE(end+8)!==data.readUInt16LE(end+10))invalid();
 const count=data.readUInt16LE(end+10),centralSize=data.readUInt32LE(end+12),central=data.readUInt32LE(end+16);
 if(count===0xffff||centralSize===0xffffffff||central===0xffffffff)fail('BOARDNOTES_UNSUPPORTED');
 if(!count||count>LIMITS.entries)fail('TOO_LARGE');if(central+centralSize!==end||central<4)invalid();
 const entries=[],seen=new Set(),ranges=[];let p=central,total=0;
 for(let i=0;i<count;i++){
  if(p+46>end||data.readUInt32LE(p)!==0x02014b50)invalid();const flags=data.readUInt16LE(p+8),method=data.readUInt16LE(p+10),crc=data.readUInt32LE(p+16),nl=data.readUInt16LE(p+28),el=data.readUInt16LE(p+30),cl=data.readUInt16LE(p+32),disk=data.readUInt16LE(p+34),attrs=data.readUInt32LE(p+38);
  if(!nl||nl>LIMITS.name||p+46+nl+el+cl>end||disk!==0||(flags&~0x80f))invalid();
  let expanded=data.readUInt32LE(p+24),compressed=data.readUInt32LE(p+20),offset=data.readUInt32LE(p+42);
  const ex=extras(data.subarray(p+46+nl,p+46+nl+el)),zip64=ex.get(1);let z=0;
  if(expanded===0xffffffff){if(!zip64)invalid();expanded=integer64(zip64,z);z+=8;}
  if(compressed===0xffffffff){if(!zip64)invalid();compressed=integer64(zip64,z);z+=8;}
  if(offset===0xffffffff){if(!zip64)invalid();offset=integer64(zip64,z);z+=8;}
  if(expanded>LIMITS.entry||total+expanded>LIMITS.total)fail('TOO_LARGE');total+=expanded;
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(p+46,p+46+nl));}catch{invalid();}
  const directory=name.endsWith('/');if(directory)name=name.slice(0,-1);safeName(name);
  const folded=name.normalize('NFC').toLowerCase();if(seen.has(folded))invalid();seen.add(folded);
  const type=(attrs>>>16)&0xf000;if(type&&type!==0x8000&&type!==0x4000)invalid();if(directory&&expanded!==0)invalid();
  if(offset+30>central||data.readUInt32LE(offset)!==0x04034b50||data.readUInt16LE(offset+6)!==flags||data.readUInt16LE(offset+8)!==method)invalid();
  const ln=data.readUInt16LE(offset+26),le=data.readUInt16LE(offset+28),start=offset+30+ln+le;
  if(ln!==nl||start>central||compressed>central-start||!data.subarray(offset+30,offset+30+ln).equals(data.subarray(p+46,p+46+nl)))invalid();
  const local=extras(data.subarray(offset+30+ln,start));const aes=ex.get(0x9901),localAES=local.get(0x9901);
  if(Boolean(aes)!==Boolean(localAES)||aes&&!aes.equals(localAES))invalid();
  if(!(flags&8)){
   if(data.readUInt32LE(offset+14)!==crc)invalid();const lc=data.readUInt32LE(offset+18),lu=data.readUInt32LE(offset+22);if(lc!==0xffffffff&&lc!==compressed||lu!==0xffffffff&&lu!==expanded)invalid();
  }
  let version,strength,actual=method;
  if(method===99){if(!(flags&1)||!aes||aes.length!==7)invalid();version=aes.readUInt16LE(0);strength=aes[4];actual=aes.readUInt16LE(5);if(![1,2].includes(version)||aes.toString('ascii',2,4)!=='AE'||![1,2,3].includes(strength)||version===2&&crc!==0)invalid();}
  else if(flags&1||aes)fail('BOARDNOTES_UNSUPPORTED');
  if(![0,8].includes(actual))fail('BOARDNOTES_UNSUPPORTED');
  let rangeEnd=start+compressed;
  if(flags&8){let d=rangeEnd;if(d+12>central)invalid();if(data.readUInt32LE(d)===0x08074b50)d+=4;if(d+12>central||data.readUInt32LE(d)!==crc)invalid();
   if(data.readUInt32LE(d+4)===compressed&&data.readUInt32LE(d+8)===expanded)d+=12;
   else if(d+20<=central&&integer64(data,d+4)===compressed&&integer64(data,d+12)===expanded)d+=20;else invalid();rangeEnd=d;
  }
  ranges.push([offset,rangeEnd]);entries.push({name,directory,expanded,compressed,start,actual,crc,version,strength});p+=46+nl+el+cl;
 }
 if(p!==end)invalid();ranges.sort((a,b)=>a[0]-b[0]);if(ranges[0][0]!==0)invalid();for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])invalid();
 return entries;
}
function decodeEntry(input,e,{parameter=FORMAT_PARAMETER}={}){let packed=input;
  if(e.version){const keyBytes=[0,16,24,32][e.strength],saltBytes=keyBytes/2;if(packed.length<saltBytes+12)invalid();
   const derived=crypto.pbkdf2Sync(parameter,packed.subarray(0,saltBytes),1000,keyBytes*2+2,'sha1');
   if(!crypto.timingSafeEqual(derived.subarray(keyBytes*2),packed.subarray(saltBytes,saltBytes+2)))invalid();
   const ciphertext=packed.subarray(saltBytes+2,-10),auth=crypto.createHmac('sha1',derived.subarray(keyBytes,keyBytes*2)).update(ciphertext).digest().subarray(0,10);
   if(!crypto.timingSafeEqual(auth,packed.subarray(-10)))invalid();
   const blocks=Buffer.alloc(Math.ceil(ciphertext.length/16)*16);for(let i=0;i<blocks.length;i+=16)blocks.writeBigUInt64LE(BigInt(i/16+1),i);
   const cipher=crypto.createCipheriv('aes-'+keyBytes*8+'-ecb',derived.subarray(0,keyBytes),null);cipher.setAutoPadding(false);const stream=Buffer.concat([cipher.update(blocks),cipher.final()]);packed=Buffer.alloc(ciphertext.length);for(let i=0;i<packed.length;i++)packed[i]=ciphertext[i]^stream[i];derived.fill(0);stream.fill(0);
  }
  let output;try{output=e.actual===0?Buffer.from(packed):zlib.inflateRawSync(packed,{maxOutputLength:Math.min(LIMITS.entry,e.expanded)+1,info:true});if(e.actual===8){if(output.engine.bytesWritten!==packed.length)invalid();output=output.buffer;}}catch(error){if(error.code==='TOO_LARGE')throw error;invalid();}
  if(output.length!==e.expanded||e.version!==2&&crc32(output)!==e.crc)invalid();
 return output;
}
function decodeEntries(data,{parameter=FORMAT_PARAMETER,signal}={}){
 // Compatibility helper for small fixtures. Production uses the disk reader.
 if(data.length>128*1024*1024)fail('BOARDNOTES_CONTENT_LIMIT');
 const entries=parseArchive(data),result=new Map();let kept=0;
 for(const e of entries){if(signal?.aborted)fail('CANCELLED');kept+=e.expanded;if(kept>256*1024*1024)fail('BOARDNOTES_CONTENT_LIMIT');const output=decodeEntry(data.subarray(e.start,e.start+e.compressed),e,{parameter});if(!e.directory)result.set(e.name,output);}
 return result;
}
module.exports={decodeEntries,decodeEntry,parseArchive,crc32,LIMITS,safeName};

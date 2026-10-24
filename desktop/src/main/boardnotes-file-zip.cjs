'use strict';
// ZIP directory and members are read by offset; the archive is never buffered.
const fs=require('node:fs/promises'),crypto=require('node:crypto'),path=require('node:path');
const {constants}=require('node:fs'),{fail}=require('./errors.cjs');
const {decodeEntry,safeName,LIMITS}=require('./boardnotes-zip.cjs');
function invalid(){fail('BOARDNOTES_INVALID');}
function extras(data){const result=new Map();for(let p=0;p<data.length;){if(p+4>data.length)invalid();const id=data.readUInt16LE(p),n=data.readUInt16LE(p+2);p+=4;if(n>data.length-p||result.has(id))invalid();result.set(id,data.subarray(p,p+n));p+=n;}return result;}
function integer64(b,p){if(p+8>b.length)invalid();const n=b.readBigUInt64LE(p);if(n>BigInt(Number.MAX_SAFE_INTEGER))invalid();return Number(n);}
async function openArchive(file,{signal}={}){
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let closed=false;
 const check=()=>{if(signal?.aborted)fail('CANCELLED');};
 try{const initial=await h.stat(),size=initial.size;if(!initial.isFile()||size<22)invalid();if(size>LIMITS.compressed)fail('TOO_LARGE');
 const read=async(position,length)=>{check();if(!Number.isSafeInteger(position)||!Number.isSafeInteger(length)||position<0||length<0||position+length>size)invalid();const data=Buffer.alloc(length);let count=0;while(count<length){const {bytesRead}=await h.read(data,count,length-count,position+count);if(!bytesRead)invalid();count+=bytesRead;}return data;};
 const tailStart=Math.max(0,size-65557),tail=await read(tailStart,size-tailStart);let ep=-1;for(let p=tail.length-22;p>=0;p--)if(tail.readUInt32LE(p)===0x06054b50&&p+22+tail.readUInt16LE(p+20)===tail.length){ep=p;break;}
 if(ep<0||tail.readUInt16LE(ep+4)!==0||tail.readUInt16LE(ep+6)!==0||tail.readUInt16LE(ep+8)!==tail.readUInt16LE(ep+10))invalid();
 const count=tail.readUInt16LE(ep+10),centralSize=tail.readUInt32LE(ep+12),central=tail.readUInt32LE(ep+16),end=tailStart+ep;
 if(count===0xffff||centralSize===0xffffffff||central===0xffffffff)fail('BOARDNOTES_UNSUPPORTED');if(!count||count>LIMITS.entries||centralSize>16*1024*1024)fail('TOO_LARGE');if(central+centralSize!==end||central<4)invalid();
 const data=await read(central,centralSize),entries=[],seen=new Set(),ranges=[];let p=0,total=0;
 for(let i=0;i<count;i++){
  check();if(p+46>data.length||data.readUInt32LE(p)!==0x02014b50)invalid();const flags=data.readUInt16LE(p+8),method=data.readUInt16LE(p+10),crc=data.readUInt32LE(p+16),nl=data.readUInt16LE(p+28),el=data.readUInt16LE(p+30),cl=data.readUInt16LE(p+32),disk=data.readUInt16LE(p+34),attrs=data.readUInt32LE(p+38);
  if(!nl||nl>LIMITS.name||p+46+nl+el+cl>data.length||disk!==0||(flags&~0x80f))invalid();
  let expanded=data.readUInt32LE(p+24),compressed=data.readUInt32LE(p+20),offset=data.readUInt32LE(p+42);
  const ex=extras(data.subarray(p+46+nl,p+46+nl+el)),zip64=ex.get(1);let z=0;
  if(expanded===0xffffffff){if(!zip64)invalid();expanded=integer64(zip64,z);z+=8;}if(compressed===0xffffffff){if(!zip64)invalid();compressed=integer64(zip64,z);z+=8;}if(offset===0xffffffff){if(!zip64)invalid();offset=integer64(zip64,z);z+=8;}
  // Deflate framing can be slightly larger than the decoded member, but must not
  // hide a whole-archive allocation in one member.
  if(expanded>LIMITS.entry||compressed>LIMITS.entry+1024*1024||total+expanded>LIMITS.total)fail('BOARDNOTES_CONTENT_LIMIT');total+=expanded;
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(p+46,p+46+nl));}catch{invalid();}const directory=name.endsWith('/');if(directory)name=name.slice(0,-1);safeName(name);const folded=name.normalize('NFC').toLowerCase();if(seen.has(folded))invalid();seen.add(folded);
  const type=(attrs>>>16)&0xf000;if(type&&type!==0x8000&&type!==0x4000)invalid();if(directory&&expanded!==0)invalid();
  if(offset+30>central)invalid();const localHeader=await read(offset,30);if(localHeader.readUInt32LE(0)!==0x04034b50||localHeader.readUInt16LE(6)!==flags||localHeader.readUInt16LE(8)!==method)invalid();
  const ln=localHeader.readUInt16LE(26),le=localHeader.readUInt16LE(28),start=offset+30+ln+le;if(ln!==nl||start>central||compressed>central-start)invalid();const localVariable=await read(offset+30,ln+le);if(!localVariable.subarray(0,ln).equals(data.subarray(p+46,p+46+nl)))invalid();
  const local=extras(localVariable.subarray(ln)),aes=ex.get(0x9901),localAES=local.get(0x9901);if(Boolean(aes)!==Boolean(localAES)||aes&&!aes.equals(localAES))invalid();
  if(!(flags&8)){if(localHeader.readUInt32LE(14)!==crc)invalid();const lc=localHeader.readUInt32LE(18),lu=localHeader.readUInt32LE(22);if(lc!==0xffffffff&&lc!==compressed||lu!==0xffffffff&&lu!==expanded)invalid();}
  let version,strength,actual=method;if(method===99){if(!(flags&1)||!aes||aes.length!==7)invalid();version=aes.readUInt16LE(0);strength=aes[4];actual=aes.readUInt16LE(5);if(![1,2].includes(version)||aes.toString('ascii',2,4)!=='AE'||![1,2,3].includes(strength)||version===2&&crc!==0)invalid();}else if(flags&1||aes)fail('BOARDNOTES_UNSUPPORTED');if(![0,8].includes(actual))fail('BOARDNOTES_UNSUPPORTED');
  let rangeEnd=start+compressed;if(flags&8){if(rangeEnd+12>central)invalid();const descriptor=await read(rangeEnd,Math.min(24,central-rangeEnd));let d=descriptor.readUInt32LE(0)===0x08074b50?4:0;if(d+12>descriptor.length||descriptor.readUInt32LE(d)!==crc)invalid();if(descriptor.readUInt32LE(d+4)===compressed&&descriptor.readUInt32LE(d+8)===expanded)d+=12;else if(d+20<=descriptor.length&&integer64(descriptor,d+4)===compressed&&integer64(descriptor,d+12)===expanded)d+=20;else invalid();rangeEnd+=d;}
  ranges.push([offset,rangeEnd]);entries.push({name,directory,expanded,compressed,start,actual,crc,version,strength});p+=46+nl+el+cl;
 }
 if(p!==data.length)invalid();ranges.sort((a,b)=>a[0]-b[0]);if(ranges[0][0]!==0)invalid();for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])invalid();
 const unchanged=async()=>{const now=await h.stat();if(now.dev!==initial.dev||now.ino!==initial.ino||now.size!==initial.size||now.mtimeMs!==initial.mtimeMs||now.ctimeMs!==initial.ctimeMs)fail('CONFLICT');};
 return{entries,total,bytes:size,readEntry:async(e,options={})=>{if(!entries.includes(e))invalid();check();const packed=await read(e.start,e.compressed),output=decodeEntry(packed,e,options);await unchanged();return output;},close:async()=>{if(!closed){closed=true;await h.close();}}};
 }catch(e){await h.close();closed=true;throw e;}
}
async function extractSelected(file,directory,names,{signal,onProgress,resourceTypes={}}={}){
 const selected=new Set(names),archive=await openArchive(file,{signal}),files=[];let completed=0;
 try{const available=new Set(archive.entries.filter(e=>!e.directory).map(e=>e.name));for(const name of selected)if(!available.has(name))invalid();
  for(const entry of archive.entries){const data=await archive.readEntry(entry);if(selected.has(entry.name)&&!entry.directory){let info;const type=resourceTypes[entry.name];if(type==='pdf')await require('./note-exchange.cjs').validateContent(data,'.pdf');else if(type==='image')info=require('./image-import.cjs').imageInfo(data);const filename=String(files.length)+'.bin',target=path.join(directory,filename),h=await fs.open(target,'wx',0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}files.push({name:entry.name,filename,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),...(info?{info}:{})});}completed++;onProgress?.({completed,total:archive.entries.length});}
  return files;
 }finally{await archive.close();}
}
module.exports={openArchive,extractSelected};

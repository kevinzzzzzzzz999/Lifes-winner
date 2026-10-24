'use strict';
const zlib=require('node:zlib');
function validateExcelZIP(data){
 const fail=()=>{throw Error('EXCEL_CAPACITY_OR_STRUCTURE');},u16=p=>data.readUInt16LE(p),u32=p=>data.readUInt32LE(p);
 if(data.length<22||u32(0)!==0x04034b50)fail();let end=-1;
 for(let p=data.length-22;p>=Math.max(0,data.length-65557);p--)if(u32(p)===0x06054b50&&p+22+u16(p+20)===data.length){end=p;break;}
 if(end<0||u16(end+4)!==0||u16(end+6)!==0||u16(end+8)!==u16(end+10))fail();
 const count=u16(end+10),size=u32(end+12),start=u32(end+16);if(!count||count>10000||!start||size>end||start>end-size)fail();
 let p=start,total=0;const names=new Set();
 for(let n=0;n<count;n++){
  if(p+46>start+size||u32(p)!==0x02014b50)fail();
  const compressed=u32(p+20),expanded=u32(p+24),name=u16(p+28),extra=u16(p+30),comment=u16(p+32),offset=u32(p+42);
  if((u16(p+8)&1)||![0,8].includes(u16(p+10))||expanded>32*1024*1024||expanded>64*1024*1024-total||offset+30>start||u32(offset)!==0x04034b50||compressed>start-offset-30||!name||name>1024||p+46+name+extra+comment>start+size)fail();
  const filename=data.subarray(p+46,p+46+name).toString('utf8');if(names.has(filename)||filename.includes('\0')||filename.startsWith('/')||filename.includes('\\')||filename.split('/').includes('..'))fail();names.add(filename);
  const localName=u16(offset+26),localExtra=u16(offset+28);if(offset+30+localName+localExtra+compressed>start||localName!==name||!data.subarray(offset+30,offset+30+localName).equals(data.subarray(p+46,p+46+name)))fail();
  const bytes=data.subarray(offset+30+localName+localExtra,offset+30+localName+localExtra+compressed);let plain;try{plain=u16(p+10)===0?bytes:zlib.inflateRawSync(bytes,{maxOutputLength:32*1024*1024});}catch{fail();}if(plain.length!==expanded)fail();
  total+=expanded;p+=46+name+extra+comment;
 }
 if(p!==start+size||!names.has('[Content_Types].xml')||!names.has('xl/workbook.xml'))fail();
}
module.exports={validateExcelZIP};

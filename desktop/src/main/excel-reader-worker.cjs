'use strict';
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{try {
 const data=Buffer.from(workerData.data),extension=workerData.extension;
 if(!['xls','xlsx','xlsm'].includes(extension)||!data.length||data.length>16*1024*1024)throw Error('CAPACITY');
 if(extension==='xls'){if(!data.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))throw Error('STRUCTURE');}
 else require('./excel-zip-budget.cjs').validateExcelZIP(data);
 global.XLSX=require('../vendor/excel/xlsx.full.min.js');
 const read=require('../vendor/excel/reader.js');
 const raw=read(data.toString('base64'),extension),model=JSON.parse(raw);
 if(extension!=='xls'){const zip=await require('jszip').loadAsync(data,{checkCRC32:true});await require('./office-embedded-images.cjs').addXlsxPictures(zip,model);}
 const result=JSON.stringify(model);
 if(Buffer.byteLength(result)>32*1024*1024)throw Error('CAPACITY');
 parentPort.postMessage({ok:true,model:JSON.parse(result)});
}catch(error){parentPort.postMessage({ok:false,capacity:/CAPACITY|too large|Invalid string length/i.test(String(error))});}})().catch(()=>parentPort.postMessage({ok:false,capacity:false}));

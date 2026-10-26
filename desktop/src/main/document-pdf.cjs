'use strict';
const crypto=require('node:crypto'),zlib=require('node:zlib');
const {PDFDocument,PDFName,PDFString,PDFDict,PDFArray,PDFRawStream}=require('pdf-lib');
const {validateModel,modelHTML,xml}=require('./editable-document-model.cjs');const {fail}=require('./errors.cjs');
const ATTACHMENT='InkSpace-editable-source.json',STAMP='InkSpaceSourceSHA256',ZERO='0'.repeat(64),MAX_EDITABLE_PDF=32*1024*1024,MAX_SOURCE=2*1024*1024;
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
// This is an integrity binding, not a signature or proof of authorship. Any byte
// changed by another editor invalidates rewriting, including new PDF annotations.
function stampLocation(data){const text=data.toString('latin1'),matches=[...text.matchAll(/\/InkSpaceSourceSHA256 \(([a-f0-9]{64})\)/g)];if(matches.length!==1)return null;const m=matches[0];return {offset:m.index+m[0].indexOf('(')+1,value:m[1]};}
function maskedHash(data,slot){return crypto.createHash('sha256').update(data.subarray(0,slot.offset)).update(ZERO).update(data.subarray(slot.offset+64)).digest('hex');}
async function createEditablePDF(document,printPDF){const model=validateModel(document);if(model.format!=='pdf'||typeof printPDF!=='function')fail('EXPORT_FAILED');const raw=Buffer.from(await printPDF(model));if(raw.length>MAX_EDITABLE_PDF||!raw.subarray(0,5).equals(Buffer.from('%PDF-')))fail('EXPORT_FAILED');
 const pdf=await PDFDocument.load(raw,{updateMetadata:false});if(pdf.isEncrypted||pdf.getPageCount()<1||pdf.getPageCount()>250)fail('TOO_LARGE');pdf.setCreator("Life's Winner");const source=Buffer.from(JSON.stringify({schemaVersion:1,application:'InkSpace',document:model}));if(source.length>MAX_SOURCE)fail('TOO_LARGE');await pdf.attach(source,ATTACHMENT,{mimeType:'application/json',description:'Editable source for documents created in Life\'s Winner',afRelationship:'Source'});pdf.catalog.set(PDFName.of(STAMP),PDFString.of(ZERO));const data=Buffer.from(await pdf.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false}));if(data.length>MAX_EDITABLE_PDF)fail('TOO_LARGE');const slot=stampLocation(data);if(!slot||slot.value!==ZERO)fail('EXPORT_FAILED');data.write(maskedHash(data,slot),slot.offset,64,'ascii');return data;
}
async function readPDFModel(data){
 // Ordinary large PDFs return immediately without a PDF object parse.
 if(data.indexOf(Buffer.from('/'+STAMP))<0||data.length>MAX_EDITABLE_PDF)return null;
 const slot=stampLocation(data);if(!slot||maskedHash(data,slot)!==slot.value)return null;
 try{const pdf=await PDFDocument.load(data,{updateMetadata:false,throwOnInvalidObject:true});if(pdf.isEncrypted||pdf.getPageCount()<1||pdf.getPageCount()>250)return null;if(pdf.catalog.lookup(PDFName.of(STAMP),PDFString).decodeText()!==slot.value)return null;
  const names=pdf.catalog.lookup(PDFName.of('Names'),PDFDict).lookup(PDFName.of('EmbeddedFiles'),PDFDict).lookup(PDFName.of('Names'),PDFArray);if(names.size()!==2||names.lookup(0).decodeText()!==ATTACHMENT)return null;
  const spec=names.lookup(1,PDFDict),stream=spec.lookup(PDFName.of('EF'),PDFDict).lookup(PDFName.of('F'),PDFRawStream);if(stream.dict.lookup(PDFName.of('Filter'),PDFName).toString()!=='/FlateDecode'||stream.contents.length>MAX_SOURCE)return null;
  const plain=zlib.inflateSync(stream.contents,{maxOutputLength:MAX_SOURCE});const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));if(envelope.schemaVersion!==1||envelope.application!=='InkSpace')return null;const model=validateModel(envelope.document);return model.format==='pdf'?model:null;
 }catch{return null;}
}
let printing=false;
async function printDocumentPDF(model,{pageSections=false,maximumBytes=MAX_EDITABLE_PDF,timeoutMs=30000}={}){
 if(printing)fail('BUSY');printing=true;let win,timer;
 try{const {BrowserWindow,session}=require('electron');const isolated=session.fromPartition('inkspace-document-print-'+crypto.randomUUID());isolated.setPermissionRequestHandler((_w,_p,callback)=>callback(false));isolated.setPermissionCheckHandler(()=>false);isolated.webRequest.onBeforeRequest((request,callback)=>callback({cancel:!request.url.startsWith('data:text/html;')}));
  win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:850,height:1100,webPreferences:{session:isolated,contextIsolation:true,sandbox:true,nodeIntegration:false,javascript:false,webSecurity:true,images:false,webviewTag:false,backgroundThrottling:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.on('will-attach-webview',event=>event.preventDefault());
  const html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'"><title>'+xml(model.title)+'</title><style>@page{size:Letter;margin:.75in}body{font:12pt Arial,sans-serif;line-height:1.5;color:#181818;background:white}h2{'+(pageSections?'break-before:page;':'')+'}h1{font-size:23pt}h2{font-size:17pt;break-after:avoid}p,li,h1,h2{white-space:pre-wrap;overflow-wrap:anywhere}p{margin:0 0 10pt}ul{margin:0 0 10pt;padding-left:20pt}</style></head><body>'+modelHTML(model)+'</body></html>';
  const job=(async()=>{await win.loadURL('data:text/html;charset=utf-8;base64,'+Buffer.from(html).toString('base64'));return Buffer.from(await win.webContents.printToPDF({printBackground:true,pageSize:'Letter',preferCSSPageSize:true,generateTaggedPDF:true}));})();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{if(win&&!win.isDestroyed())win.destroy();reject(Object.assign(new Error('PDF render exceeded its time limit'),{code:'EXPORT_FAILED'}));},timeoutMs);});const data=await Promise.race([job,deadline]);if(data.length>maximumBytes)fail('TOO_LARGE');return data;
 }finally{clearTimeout(timer);if(win&&!win.isDestroyed())win.destroy();printing=false;}
}
module.exports={createEditablePDF,readPDFModel,printDocumentPDF,ATTACHMENT,STAMP,MAX_EDITABLE_PDF};

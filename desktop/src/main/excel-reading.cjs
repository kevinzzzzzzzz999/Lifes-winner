'use strict';
const {Worker}=require('node:worker_threads'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const MAX_SOURCE=16*1024*1024,MAX_PDF=128*1024*1024,VERSION='excel-desktop-cell-reading-images-2';
let active=0,printing=false;
function readExcel(data,extension){
 if(!Buffer.isBuffer(data)||!data.length||data.length>MAX_SOURCE)fail('TOO_LARGE');
 if(active>=2)fail('BUSY');active++;
 return new Promise((resolve,reject)=>{
  let settled=false,timer;const worker=new Worker(path.join(__dirname,'excel-reader-worker.cjs'),{workerData:{data,extension},resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32,stackSizeMb:4}});
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);active--;void worker.terminate();error?reject(error):resolve(value);};
  worker.once('message',value=>value?.ok?finish(null,value.model):finish(Object.assign(Error(),{code:value?.capacity?'TOO_LARGE':'EXCEL_UNREADABLE'})));
  worker.once('error',()=>finish(Object.assign(Error(),{code:'EXCEL_UNREADABLE'})));
  worker.once('exit',()=>{if(!settled)finish(Object.assign(Error(),{code:'EXCEL_UNREADABLE'}));});
  timer=setTimeout(()=>finish(Object.assign(Error(),{code:'EXCEL_TIMEOUT'})),90000);
 });
}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function column(n){let s='';for(n++;n>0;){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
function warnings(model){const value=['Cell reading layout: visible worksheets and row/column bands; original print areas and merged-cell layout are not used.'];if(model.formulas)value.push('Formulas show saved results only. No recalculation, macros or external-link execution.');if(model.missingFormulaResults)value.push('Cells marked [=] have no saved result and display the original formula instead.');if(model.imageSummary){if(model.imageSummary.count)value.push('Embedded PNG/JPEG pictures are shown after their worksheet with cell-anchor labels; original placement, crops, rotations and effects are not reproduced.');value.push(...require('./office-embedded-images.cjs').imageWarnings(model.imageSummary));}else if(model.omittedVisuals)value.push('Charts, images and floating objects are not included; open the original Excel file to see them.');if(model.skippedSheets)value.push('Hidden worksheets and standalone chart sheets are not included.');return value;}
function modelHTML(model){
 if(!model||!Array.isArray(model.sheets)||!model.sheets.length||model.sheets.length>128)fail('EXCEL_UNREADABLE');
 const pieces=[],notes=warnings(model);let chars=0,span=0;
 const push=s=>{chars+=s.length;if(chars>16*1024*1024)fail('TOO_LARGE');pieces.push(s);};
 push('<aside class="office-reading-notices">'+notes.map(x=>'<p>'+escape(x)+'</p>').join('')+'</aside>');
 for(const sheet of model.sheets){
  const hiddenRows=new Set(sheet.hiddenRows),hiddenColumns=new Set(sheet.hiddenColumns),rows=[],cols=[];
  if(!Number.isInteger(sheet.minRow)||!Number.isInteger(sheet.lastRow)||sheet.minRow<0||sheet.lastRow-sheet.minRow>100000||sheet.lastRow>1048575||!Number.isInteger(sheet.minCol)||!Number.isInteger(sheet.lastCol)||sheet.minCol<0||sheet.lastCol-sheet.minCol>511||sheet.lastCol>16383)fail('TOO_LARGE');
  for(let r=sheet.minRow;r<=sheet.lastRow;r++)if(!hiddenRows.has(r))rows.push(r);
  for(let c=sheet.minCol;c<=sheet.lastCol;c++)if(!hiddenColumns.has(c))cols.push(c);
  span+=rows.length*cols.length;if(span>500000)fail('TOO_LARGE');
  const cells=new Map(sheet.cells.map(c=>[c.row*16384+c.column,c.text]));
  for(let offset=0;offset<cols.length;offset+=6){const band=cols.slice(offset,offset+6);
   push('<section class="excel-band"><h2>'+escape(sheet.name)+'</h2><p>'+column(band[0])+'–'+column(band.at(-1))+'</p><table><thead><tr><th>#</th>'+band.map(c=>'<th>'+column(c)+'</th>').join('')+'</tr></thead><tbody>');
   for(const r of rows)push('<tr><th>'+String(r+1)+'</th>'+band.map(c=>'<td>'+escape(cells.get(r*16384+c)||'')+'</td>').join('')+'</tr>');
   push('</tbody></table></section>');
  }
  push(require('./office-embedded-images.cjs').pictureHTML(sheet.images,'Embedded pictures · '+sheet.name));
 }
 return pieces.join('');
}
async function printExcelPDF(model){
 if(printing)fail('BUSY');printing=true;let win,timer;
 try{const {BrowserWindow,session,nativeImage}=require('electron');for(const sheet of model.sheets||[])for(const image of sheet.images||[]){const decoded=nativeImage.createFromDataURL(image.src);if(decoded.isEmpty()||decoded.getSize().width!==image.width||decoded.getSize().height!==image.height)fail('EXCEL_UNREADABLE');}const isolated=session.fromPartition('inkspace-excel-print-'+crypto.randomUUID());isolated.setPermissionRequestHandler((_w,_p,done)=>done(false));isolated.setPermissionCheckHandler(()=>false);isolated.webRequest.onBeforeRequest((req,done)=>done({cancel:!req.url.startsWith('data:text/html;')&&!/^data:image\/(png|jpeg);base64,/.test(req.url)}));
  win=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1123,height:794,webPreferences:{session:isolated,sandbox:true,nodeIntegration:false,contextIsolation:true,javascript:false,images:true,webviewTag:false,backgroundThrottling:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('will-attach-webview',e=>e.preventDefault());
  const html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>@page{size:A4 landscape;margin:24pt}body{font:10pt Arial,sans-serif;color:#111;background:#fff;margin:0}aside{font-size:9pt}h2{margin:0 0 6pt;font-size:16pt}p{margin:0 0 6pt}.excel-band{break-before:page}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:.35pt solid #bbb;padding:5pt;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eee}th:first-child{width:28pt}thead{display:table-header-group}tr{break-inside:avoid}.office-embedded-pictures{break-before:page}figure{margin:12pt 0;break-inside:avoid}figcaption{font-size:9pt;margin-bottom:6pt}img{display:block;max-width:100%;height:auto;max-height:420pt;object-fit:contain;object-position:left}</style></head><body>'+modelHTML(model)+'</body></html>';
  const job=(async()=>{await win.loadURL('data:text/html;charset=utf-8;base64,'+Buffer.from(html).toString('base64'));return Buffer.from(await win.webContents.printToPDF({printBackground:true,preferCSSPageSize:true,generateTaggedPDF:true}));})();
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{if(win&&!win.isDestroyed())win.destroy();reject(Object.assign(Error(),{code:'EXCEL_TIMEOUT'}));},90000);});
  const data=await Promise.race([job,timeout]);if(data.length>MAX_PDF)fail('TOO_LARGE');const pdf=await require('pdf-lib').PDFDocument.load(data,{updateMetadata:false});if(pdf.isEncrypted||!pdf.getPageCount()||pdf.getPageCount()>2000)fail('TOO_LARGE');return data;
 }finally{clearTimeout(timer);if(win&&!win.isDestroyed())win.destroy();printing=false;}
}
module.exports={readExcel,modelHTML,warnings,printExcelPDF,MAX_SOURCE,MAX_PDF,VERSION};

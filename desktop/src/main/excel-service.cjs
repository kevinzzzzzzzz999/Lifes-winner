'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {PDFDocument}=require('pdf-lib'),{readExcel,modelHTML,warnings,printExcelPDF,MAX_SOURCE,MAX_PDF,VERSION}=require('./excel-reading.cjs');
const {fail}=require('./errors.cjs');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
class ExcelService {
 constructor(vaults,{printPDF=printExcelPDF}={}){this.vaults=vaults;this.printPDF=printPDF;this.cache=new Map();this.pending=new Map();this.cacheBytes=0;}
 async model(snapshot,extension){const key=extension+':'+snapshot.sha256;if(this.cache.has(key))return this.cache.get(key).value;if(this.pending.has(key))return this.pending.get(key);const job=readExcel(snapshot.data,extension).then(value=>{const bytes=Buffer.byteLength(JSON.stringify(value));while(this.cache.size&&(this.cache.size>=4||this.cacheBytes+bytes>32*1024*1024)){const [key,old]=this.cache.entries().next().value;this.cache.delete(key);this.cacheBytes-=old.bytes;}if(bytes<=32*1024*1024){this.cache.set(key,{value,bytes});this.cacheBytes+=bytes;}return value;}).finally(()=>this.pending.delete(key));this.pending.set(key,job);return job;}
 async preview(snapshot,extension){const model=await this.model(snapshot,extension);return {html:modelHTML(model),text:model.sheets.map(s=>s.name+'\n'+s.cells.map(c=>c.text).join('\n')).join('\n\n'),warnings:warnings(model)};}
 async prepare(request,snapshot){const extension=path.posix.extname(request.path).slice(1).toLowerCase();const model=await this.model(snapshot,extension),raw=Buffer.from(await this.printPDF(model));if(raw.length>MAX_PDF)fail('TOO_LARGE');const pdf=await PDFDocument.load(raw,{updateMetadata:false});if(pdf.isEncrypted||pdf.getPageCount()<1||pdf.getPageCount()>2000)fail('TOO_LARGE');const identity={source:request.path,sha256:snapshot.sha256,renderer:VERSION,dependencies:{}},identityJSON=JSON.stringify(identity),marker='InkSpace rendered document v1\n'+identityJSON;pdf.setCreator("Life's Winner");pdf.setSubject(marker);const data=Buffer.from(await pdf.save({useObjectStreams:false}));if(data.length>MAX_PDF)fail('TOO_LARGE');return {data,sha256:digest(data),sourceSHA256:snapshot.sha256,sourcePath:request.path,pageCount:pdf.getPageCount(),marker,key:digest(Buffer.from(identityJSON)).slice(0,12),warnings:warnings(model)};}
 async publish(request,prepared,publications){
  const vaults=this.vaults,parent=path.posix.dirname(request.path)==='.'?'':path.posix.dirname(request.path);let stem=path.posix.basename(request.path);while(Buffer.byteLength(stem)>120)stem=stem.slice(0,-1);
  for(let index=1;index<=32;index++){const name=stem+' · 批注-'+prepared.key+(index===1?'':'-'+index)+'.pdf',rel=parent?parent+'/'+name:name;
   const found=await vaults.locked(request.vaultId+':'+rel,async()=>{
    const source=await vaults.snapshot(request,MAX_SOURCE);if(source.sha256!==prepared.sourceSHA256)fail('CONFLICT');
    try{const existing=await vaults.snapshot({vaultId:request.vaultId,path:rel},MAX_PDF);const pdf=await PDFDocument.load(existing.data,{updateMetadata:false});return pdf.getSubject()===prepared.marker&&pdf.getPageCount()===prepared.pageCount?rel:null;}catch(error){if(error.code!=='ENOENT') {if(['PATH_DENIED','TOO_LARGE'].includes(error.code))throw error;try{await vaults.resolve(request.vaultId,rel);return null;}catch(e){if(e.code!=='ENOENT')throw e;}}}
    const {full}=await vaults.resolve(request.vaultId,parent,{directory:true}),target=path.join(full,name),temp=path.join(full,'.inkspace-save-'+crypto.randomUUID()+'.tmp');
    await vaults.backup(rel,null,prepared.data);
    try{await require('./vault-service.cjs').durableWrite(temp,prepared.data);await vaults.resolve(request.vaultId,parent,{directory:true});const latest=await vaults.snapshot(request,MAX_SOURCE);if(latest.sha256!==prepared.sourceSHA256)fail('CONFLICT');await fs.link(temp,target);publications.push({path:rel,sha256:prepared.sha256});return rel;}finally{await fs.unlink(temp).catch(()=>{});}
   });if(found)return found;
  }fail('EXISTS');
 }
 async rollback(vaultId,publications){for(const file of publications)try{await this.vaults.locked(vaultId+':'+file.path,async()=>{const snapshot=await this.vaults.snapshot({vaultId,path:file.path},MAX_PDF);if(snapshot.sha256===file.sha256)await fs.unlink(snapshot.full);});}catch{/* A changed/unavailable derived PDF is retained, never guessed or overwritten. */}}
}
module.exports={ExcelService};

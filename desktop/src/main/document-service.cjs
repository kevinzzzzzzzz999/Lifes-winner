'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {relativePath,digest,durableWrite}=require('./vault-service.cjs');
const {validateModel,modelHTML,modelText}=require('./editable-document-model.cjs');
const {createOffice,readOfficeModel,previewPptx}=require('./editable-office.cjs');
const {fail}=require('./errors.cjs');
const MAX_OFFICE=16*1024*1024,MAX_PDF=128*1024*1024;
function formatFor(file){relativePath(file);if(file.split('/').some(part=>part.toLowerCase()==='.inkspace-reviews'))fail('PATH_DENIED');const ext=path.extname(file).toLowerCase().slice(1);if(!['docx','pptx','pdf'].includes(ext))fail('UNSUPPORTED');return ext;}
class DocumentService{
 constructor(vaults,{printPDF}={}){this.vaults=vaults;this.printPDF=printPDF;}
 async model(data,format){return format==='pdf'?require('./document-pdf.cjs').readPDFModel(data):readOfficeModel(data,format);}
 async generate(document){const model=validateModel(document);const data=model.format==='pdf'?await require('./document-pdf.cjs').createEditablePDF(model,this.printPDF):await createOffice(model);if(data.length>(model.format==='pdf'?MAX_PDF:MAX_OFFICE))fail('TOO_LARGE');const decoded=await this.model(data,model.format);if(JSON.stringify(decoded)!==JSON.stringify(model))fail('EXPORT_FAILED');return {data,model};}
 async response(request,snapshot,model){const format=formatFor(request.path);const opened={path:request.path,name:path.posix.basename(request.path),kind:format==='pdf'?'media':format,sha256:snapshot.sha256,bytes:snapshot.data.length};
  if(format==='pdf')opened.assetUrl=this.vaults.assetToken(request,snapshot.sha256);
  else if(model){opened.html=modelHTML(model);opened.text=modelText(model);}
  else if(format==='docx')Object.assign(opened,await require('./docx-preview.cjs').previewDocx(snapshot.data));else Object.assign(opened,await previewPptx(snapshot.data));
  return {editable:!!model,...(model?{document:model}:{reason:'external_or_modified'}),opened,warnings:model?['Basic document layout; not a full Microsoft Office editor.']:['This file is read-only here because its editable source is missing or the file was changed by another application.']};
 }
 async readEditableDocument(request){const format=formatFor(request.path);const snapshot=await this.vaults.snapshotForRead(request,format==='pdf'?MAX_PDF:MAX_OFFICE);const model=await this.model(snapshot.data,format);return this.response(request,snapshot,model);}
 async createDocument(request){const parent=relativePath(request.parentPath,true),name=relativePath(request.name);if(name.includes('/'))fail('INVALID_REQUEST');const rel=parent?parent+'/'+name:name,format=formatFor(rel),model=validateModel(request.document);if(format!==model.format)fail('INVALID_DOCUMENT');
  return this.vaults.locked(request.vaultId+':'+rel,async()=>{const {full}=await this.vaults.resolve(request.vaultId,parent,{directory:true}),target=path.join(full,name);try{await fs.lstat(target);fail('EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}const generated=await this.generate(model);const backupId=await this.vaults.backup(rel,null,generated.data);const temp=path.join(full,'.inkspace-save-'+crypto.randomUUID()+'.tmp');try{await durableWrite(temp,generated.data);await this.vaults.resolve(request.vaultId,parent,{directory:true});await fs.link(temp,target);await fs.unlink(temp);const fileRequest={vaultId:request.vaultId,path:rel};return {...await this.response(fileRequest,{data:generated.data,sha256:digest(generated.data)},generated.model),editable:true,backupId};}finally{await fs.unlink(temp).catch(()=>{});}});
 }
 async saveDocument(request){const format=formatFor(request.path),model=validateModel(request.document);if(format!==model.format)fail('INVALID_DOCUMENT');if(!/^[a-f0-9]{64}$/.test(request.expectedSHA256||''))fail('INVALID_REQUEST');const maximum=format==='pdf'?MAX_PDF:MAX_OFFICE;
  return this.vaults.locked(request.vaultId+':'+request.path,async()=>{const snapshot=await this.vaults.snapshot(request,maximum);if(snapshot.sha256!==request.expectedSHA256)fail('CONFLICT');const original=await this.model(snapshot.data,format);if(!original)fail('EXTERNAL_DOCUMENT');const generated=await this.generate(model);const result=await this.vaults.commitSnapshot(request,snapshot,generated.data,maximum);return {...await this.response({vaultId:request.vaultId,path:request.path},{data:generated.data,sha256:result.sha256},generated.model),editable:true,backupId:result.backupId};});
 }
}
module.exports={DocumentService,formatFor,MAX_OFFICE,MAX_PDF};

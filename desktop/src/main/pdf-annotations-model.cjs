'use strict';
const crypto=require('node:crypto');
const {PDFDocument,PDFName,PDFArray,PDFDict,PDFString,PDFHexString,PDFNumber}=require('pdf-lib');
const TYPES=new Set(['Text','FreeText','Highlight','Underline','StrikeOut','Squiggly']);
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const text=value=>value instanceof PDFString||value instanceof PDFHexString?value.decodeText():'';
function visibleRect(page,raw){const crop=page.getCropBox(),media=page.getMediaBox(),rotation=((page.getRotation().angle%360)+360)%360;if(![0,90,180,270].includes(rotation)||![crop,media].every(b=>['x','y','width','height'].every(k=>Number.isFinite(b[k]))&&b.width>0&&b.height>0))return;
 const x=Math.max(crop.x,media.x),y=Math.max(crop.y,media.y),right=Math.min(crop.x+crop.width,media.x+media.width),top=Math.min(crop.y+crop.height,media.y+media.height),w=right-x,h=top-y;if(w<=0||h<=0||raw.length!==4||!raw.every(Number.isFinite))return;
 const left=Math.max(x,Math.min(raw[0],raw[2])),bottom=Math.max(y,Math.min(raw[1],raw[3])),r=Math.min(right,Math.max(raw[0],raw[2])),t=Math.min(top,Math.max(raw[1],raw[3]));if(r<=left||t<=bottom)return;
 const u0=(left-x)/w,u1=(r-x)/w,v0=(bottom-y)/h,v1=(t-y)/h;
 return rotation===0?{x:u0,y:1-v1,width:u1-u0,height:v1-v0}:rotation===90?{x:v0,y:u0,width:v1-v0,height:u1-u0}:rotation===180?{x:1-u1,y:v0,width:u1-u0,height:v1-v0}:{x:1-v1,y:1-u1,width:v1-v0,height:u1-u0};}
async function parsePDFAnnotations(bytes,{path,sourceSHA256,limits={}}){const cap={pages:5000,annotations:10000,contents:20000,textBytes:2*1024*1024,...limits},entries=[],coverage={pages:0,annotations:0,unsupported:0,limited:0},warnings=new Set();let totalText=0,partial=false;const doc=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});if(doc.isEncrypted)throw Object.assign(Error('PDF_ANNOTATION_ENCRYPTED'),{code:'PDF_ANNOTATION_ENCRYPTED'});
 const pages=doc.getPages();if(pages.length>cap.pages){partial=true;coverage.limited++;warnings.add('PAGE_LIMIT');}
 outer:for(let p=0;p<Math.min(pages.length,cap.pages);p++){coverage.pages++;let annots;try{annots=pages[p].node.lookup(PDFName.of('Annots'));}catch{partial=true;warnings.add('ANNOTATIONS_UNREADABLE');continue;}if(annots===undefined)continue;if(!(annots instanceof PDFArray)){partial=true;warnings.add('ANNOTATIONS_UNREADABLE');continue;}
  for(let index=0;index<annots.size();index++){if(coverage.annotations>=cap.annotations){partial=true;coverage.limited++;warnings.add('ANNOTATION_LIMIT');break outer;}coverage.annotations++;try{const dict=doc.context.lookup(annots.get(index));if(!(dict instanceof PDFDict))throw Error();const st=dict.lookup(PDFName.of('Subtype')),subtype=st instanceof PDFName?st.decodeText():'Unknown';let contents=text(dict.lookup(PDFName.of('Contents'))),contentsSHA256=sha(contents),issue,supported=TYPES.has(subtype);if(contents.includes('\0')||contents.length>cap.contents||totalText+Buffer.byteLength(contents)>cap.textBytes){contents='';issue='CONTENTS_LIMIT';supported=false;coverage.limited++;partial=true;warnings.add('CONTENTS_LIMIT');}totalText+=Buffer.byteLength(contents);
    const rectValue=dict.lookup(PDFName.of('Rect')),raw=rectValue instanceof PDFArray&&rectValue.size()===4?Array.from({length:4},(_,i)=>{const n=doc.context.lookup(rectValue.get(i));return n instanceof PDFNumber?n.asNumber():NaN;}):[];const rect=visibleRect(pages[p],raw);if(!rect){issue=issue||'RECT_UNAVAILABLE';partial=true;warnings.add('RECT_UNAVAILABLE');}if(!supported){coverage.unsupported++;partial=true;warnings.add('UNSUPPORTED_ANNOTATIONS');}const nm=text(dict.lookup(PDFName.of('NM'))),fingerprint=sha(JSON.stringify({page:p+1,index,subtype,raw,contentsSHA256,nm})),id=sha(path+'\0'+sourceSHA256+'\0'+fingerprint);
    entries.push({id,path,sourceSHA256,page:p+1,index,subtype,contents,hasText:contents.trim().length>0,supported,...(rect?{rect}:{}),fingerprint,...(issue?{issue}:{})});
   }catch{partial=true;coverage.unsupported++;warnings.add('ANNOTATION_UNREADABLE');}
  }
 }
 return{entries,coverage,partial,warnings:[...warnings]};}
module.exports={parsePDFAnnotations,visibleRect,TYPES};

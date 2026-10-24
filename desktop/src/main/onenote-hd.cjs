'use strict';
// Vector-only recovery for low-resolution slide images inside a OneNote PDF.
// The caller supplies independently rendered, equal-size gray thumbnails. This
// module neither guesses a slide from its ordinal/name nor runs OCR. Unknown or
// ambiguous images stay unchanged. Original content streams are never rewritten.
const crypto=require('node:crypto');
const {PDFDocument,PDFName,PDFDict,PDFArray,PDFRawStream,decodePDFRawStream}=require('pdf-lib');
const VERSION='onenote-vector-slide-recovery-v1';
const METRIC='gray-mse-plus-gradient-correlation-v1';
const LIMITS=Object.freeze({maxInputBytes:128*1024*1024,maxPages:256,maxObjects:100000,maxDecodedBytes:256*1024*1024,maxThumbnailPixels:262144,maxReferenceThumbnails:256,maxMatchImages:512,maxThumbnailEvidenceBytes:32*1024*1024,maxComparisonPixels:256000000});
const THRESHOLDS=Object.freeze({maxMSE:.002,minGradientCorrelation:.90,maxScore:.004,minMargin:.008,minSeparationRatio:4,minImageWidth:128,minImageHeight:96,maxAspectError:.025});
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
function fail(message,code='ONENOTE_HD_UNSUPPORTED'){throw Object.assign(Error(message),{code});}
function bytes(data,label){if(!(data instanceof Uint8Array)||!data.length||data.length>LIMITS.maxInputBytes)fail(`${label} must be a nonempty PDF of at most 128 MiB.`,'INVALID_REQUEST');return Buffer.from(data);}
function thumb(input,w,h){if(!(input instanceof Uint8Array)||input.length!==w*h)fail('Thumbnail pixels must be equal-size 8-bit grayscale.','INVALID_REQUEST');return input;}
function gradients(a,w,h){const out=new Float64Array((h-1)*w+(w-1)*h);let n=0;for(let y=0;y<h-1;y++)for(let x=0;x<w;x++)out[n++]=(a[(y+1)*w+x]-a[y*w+x])/255;for(let y=0;y<h;y++)for(let x=0;x<w-1;x++)out[n++]=(a[y*w+x+1]-a[y*w+x])/255;return out;}
function acceptsMatch(image,ranked,thresholds=THRESHOLDS){
 const [best,second]=ranked||[];
 if(!best||!second||image.width<thresholds.minImageWidth||image.height<thresholds.minImageHeight)return false;
 const aspect=image.width/image.height;
 const numbers=[best.mse,best.gradientCorrelation,best.score,second.score,best.visualWidth,best.visualHeight];
 if(numbers.some(x=>!Number.isFinite(x))||best.mse<0||best.mse>1||best.gradientCorrelation< -1.00000001||best.gradientCorrelation>1.00000001||best.score< -1e-10||second.score<best.score||best.visualWidth<=0||best.visualHeight<=0)return false;
 const aspectError=Math.abs(aspect/(best.visualWidth/best.visualHeight)-1);
 return aspectError<=thresholds.maxAspectError&&best.mse<=thresholds.maxMSE&&best.gradientCorrelation>=thresholds.minGradientCorrelation&&best.score<=thresholds.maxScore&&second.score-best.score>=thresholds.minMargin&&second.score/Math.max(best.score,1e-12)>=thresholds.minSeparationRatio;
}
function rankThumbnailMatches(source,referenceThumbnails,{width=160,height=124,imageWidth,imageHeight}={}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<8||height<8||width*height>LIMITS.maxThumbnailPixels)fail('Invalid thumbnail dimensions.','INVALID_REQUEST');
 if(!Array.isArray(referenceThumbnails)||referenceThumbnails.length<2||referenceThumbnails.length>LIMITS.maxReferenceThumbnails)fail('Provide 2–256 reference page thumbnails.','INVALID_REQUEST');
 source=thumb(source,width,height);const sg=gradients(source,width,height);let sn=0;for(const v of sg)sn+=v*v;
 const seen=new Set(),candidates=referenceThumbnails.map(ref=>{
  if(!Number.isInteger(ref.page)||ref.page<1||seen.has(ref.page))fail('Reference thumbnail pages must be unique positive integers.','INVALID_REQUEST');seen.add(ref.page);
  const target=thumb(ref.pixels,width,height),tg=gradients(target,width,height);let mse=0,dot=0,tn=0;for(let i=0;i<source.length;i++)mse+=((source[i]-target[i])/255)**2;mse/=source.length;for(let i=0;i<sg.length;i++){dot+=sg[i]*tg[i];tn+=tg[i]*tg[i];}
  const gradientCorrelation=sn&&tn?dot/Math.sqrt(sn*tn):0;
  return {page:ref.page,mse,gradientCorrelation,score:mse+.03*(1-gradientCorrelation),visualWidth:ref.visualWidth,visualHeight:ref.visualHeight};
 }).sort((a,b)=>a.score-b.score||a.page-b.page);
 return {metric:METRIC,thumbnailWidth:width,thumbnailHeight:height,thresholds:THRESHOLDS,candidates,accepted:acceptsMatch({width:imageWidth,height:imageHeight},candidates)};
}
function decoded(stream){return Buffer.from(decodePDFRawStream(stream).decode());}
function originalStreamLedger(document){let total=0;const out=[];for(const [ref,obj] of document.context.enumerateIndirectObjects())if(obj instanceof PDFRawStream){let raw;if(obj.dict.lookup(PDFName.of('Subtype'))?.toString()==='/Image'){out.push({ref:ref.toString(),encodedSha256:sha(obj.contents),image:true});continue;}raw=decoded(obj);total+=raw.length;if(total>LIMITS.maxDecodedBytes)fail('Decoded PDF streams exceed 256 MiB.','TOO_LARGE');out.push({ref:ref.toString(),encodedSha256:sha(obj.contents),decodedSha256:sha(raw),image:false});}return out;}
function normalizedPageMatrix(page){
 const b=page.getCropBox(),rotation=((page.getRotation().angle%360)+360)%360;
 if(![0,90,180,270].includes(rotation)||![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0)fail('The reference page uses an unsupported crop/rotation.');
 const userUnit=page.node.lookup(PDFName.of('UserUnit'));if(userUnit&&userUnit.asNumber?.()!==1)fail('Reference PDF UserUnit must be one.');
 if(page.node.Annots()?.size())fail('Reference page has annotations; flatten a separate reference copy first.');
 const {x,y,width:w,height:h}=b;
 const matrices={0:[1/w,0,0,1/h,-x/w,-y/h],90:[0,-1/w,1/h,0,-y/h,1+x/w],180:[-1/w,0,0,-1/h,1+x/w,1+y/h],270:[0,1/w,-1/h,0,1+y/h,-x/w]};
 return {boundingBox:{left:x,bottom:y,right:x+w,top:y+h},matrix:matrices[rotation],rotation,visualWidth:rotation%180?h:w,visualHeight:rotation%180?w:h};
}
function collectImageSlots(document){
 const slots=[],seenResources=new Set(),seenForms=new Set();
 function resources(resource,path,depth=0){if(!resource)return;if(depth>64)fail('PDF resources nest too deeply.');if(!(resource instanceof PDFDict))fail('Invalid PDF resources.');if(seenResources.has(resource))return;seenResources.add(resource);
  const objects=resource.lookup(PDFName.of('XObject'));if(!objects)return;if(!(objects instanceof PDFDict))fail('Invalid PDF XObjects.');
  for(const [name,ref] of objects.entries()){
   const object=document.context.lookup(ref);if(!(object instanceof PDFRawStream))continue;const subtype=object.dict.lookup(PDFName.of('Subtype'))?.toString();
   if(subtype==='/Image')slots.push({objects,name,object,ref,path:path+'/'+name.toString().slice(1),encodedSha256:sha(object.contents),width:object.dict.lookup(PDFName.of('Width'))?.asNumber(),height:object.dict.lookup(PDFName.of('Height'))?.asNumber(),complex:['Mask','SMask','ImageMask','Decode'].some(k=>object.dict.has(PDFName.of(k)))});
   else if(subtype==='/Form'&&!seenForms.has(object)){seenForms.add(object);resources(object.dict.lookup(PDFName.of('Resources'))||resource,path+'/'+name.toString().slice(1),depth+1);}
  }
 }
 document.getPages().forEach((p,i)=>resources(p.node.Resources(),'page-'+(i+1)));return slots;
}
async function recoverOneNoteSlides(targetInput,referenceInput,manifest,{thumbnailEvidence}={}){
 const targetData=bytes(targetInput,'Target'),referenceData=bytes(referenceInput,'Reference');
 if(!manifest||manifest.metric!==METRIC||manifest.targetSha256!==sha(targetData)||manifest.referenceSha256!==sha(referenceData)||!Array.isArray(manifest.images)||manifest.images.length>LIMITS.maxMatchImages)fail('Slide match report is missing or belongs to different PDF bytes.','INVALID_REQUEST');
 const target=await PDFDocument.load(targetData,{updateMetadata:false,throwOnInvalidObject:true}),reference=await PDFDocument.load(referenceData,{updateMetadata:false,throwOnInvalidObject:true});
 if(target.isEncrypted||reference.isEncrypted)fail('Encrypted PDFs are not supported.');
 if(!target.getPageCount()||target.getPageCount()>LIMITS.maxPages||!reference.getPageCount()||reference.getPageCount()>LIMITS.maxPages)fail('PDF page count exceeds the recovery budget.','TOO_LARGE');
 if(target.context.enumerateIndirectObjects().length>LIMITS.maxObjects||reference.context.enumerateIndirectObjects().length>LIMITS.maxObjects)fail('PDF object count exceeds the recovery budget.','TOO_LARGE');
 const ledger=originalStreamLedger(target),slots=collectImageSlots(target),byHash=new Map();
 // A report/map alone is not an authority: recompute every ranking from the
 // trusted render adapter's pixel buffers. Bind reference pages to these PDF
 // bytes, source samples to exact encoded image SHA-256 + dimensions, and use
 // actual page crop/rotation dimensions. Never read a mapping from PDF metadata.
 if(!thumbnailEvidence||thumbnailEvidence.referenceSha256!==sha(referenceData)||!Array.isArray(thumbnailEvidence.sources)||!Array.isArray(thumbnailEvidence.references))fail('Actual rendered thumbnail pixels are required; a page map alone is not accepted.','MATCH_EVIDENCE_REQUIRED');
 const pixelCount=thumbnailEvidence.width*thumbnailEvidence.height;
 if(!Number.isInteger(pixelCount)||pixelCount<64||pixelCount>LIMITS.maxThumbnailPixels||thumbnailEvidence.sources.length>LIMITS.maxMatchImages||(thumbnailEvidence.sources.length+thumbnailEvidence.references.length)*pixelCount>LIMITS.maxThumbnailEvidenceBytes||manifest.images.length*thumbnailEvidence.references.length*pixelCount>LIMITS.maxComparisonPixels)fail('Thumbnail comparison exceeds the memory/work budget.','TOO_LARGE');
 const evidenceSources=new Map();
 for(const source of thumbnailEvidence.sources){if(evidenceSources.has(source.encodedSha256))fail('Duplicate source thumbnail identity.','INVALID_REQUEST');evidenceSources.set(source.encodedSha256,source);}
 const referenceThumbnails=thumbnailEvidence.references.map(ref=>{if(!Number.isInteger(ref.page)||ref.page<1||ref.page>reference.getPageCount())fail('Invalid evidence page.','INVALID_REQUEST');const geometry=normalizedPageMatrix(reference.getPage(ref.page-1));return {...ref,visualWidth:geometry.visualWidth,visualHeight:geometry.visualHeight};});
 if(referenceThumbnails.length!==reference.getPageCount())fail('Every reference page must be included in pixel matching.','MATCH_EVIDENCE_REQUIRED');

 for(const im of manifest.images){
  if(typeof im.encodedSha256!=='string'||!/^[a-f0-9]{64}$/.test(im.encodedSha256)||byHash.has(im.encodedSha256))fail('Duplicate or invalid image match identity.','INVALID_REQUEST');
  const ranked=im.candidates;if(!Array.isArray(ranked)||ranked.length<2||ranked.some((m,i)=>!Number.isInteger(m.page)||m.page<1||m.page>reference.getPageCount()||!Number.isFinite(m.score)||(i>0&&m.score<ranked[i-1].score)))fail('Invalid ranked page matches.','INVALID_REQUEST');
  const actualSource=evidenceSources.get(im.encodedSha256);
  if(!actualSource||actualSource.width!==im.width||actualSource.height!==im.height)fail('Source image thumbnail evidence is missing or has different dimensions.','MATCH_EVIDENCE_REQUIRED');
  const recomputed=rankThumbnailMatches(actualSource.pixels,referenceThumbnails,{width:thumbnailEvidence.width,height:thumbnailEvidence.height,imageWidth:im.width,imageHeight:im.height});
  if(ranked.length>recomputed.candidates.length||ranked.some((c,i)=>c.page!==recomputed.candidates[i].page||Math.abs(c.score-recomputed.candidates[i].score)>1e-9||Math.abs(c.mse-recomputed.candidates[i].mse)>1e-9||Math.abs(c.gradientCorrelation-recomputed.candidates[i].gradientCorrelation)>1e-9))fail('Page map disagrees with the independently rendered pixel comparison.','MATCH_EVIDENCE_MISMATCH');
  const best=recomputed.candidates[0],geometry=normalizedPageMatrix(reference.getPage(best.page-1));
  if(Math.abs(ranked[0].visualWidth-geometry.visualWidth)>.01||Math.abs(ranked[0].visualHeight-geometry.visualHeight)>.01)fail('Match dimensions disagree with the reference page.','INVALID_REQUEST');
  byHash.set(im.encodedSha256,{...im,candidates:recomputed.candidates,accepted:recomputed.accepted,geometry});
 }
 const selected=[];const retained=[];
 for(const slot of slots){const m=byHash.get(slot.encodedSha256);if(!m||slot.complex||m.width!==slot.width||m.height!==slot.height||!m.accepted){retained.push({path:slot.path,encodedSha256:slot.encodedSha256,width:slot.width,height:slot.height,reason:slot.complex?'complex-image':!m?'unmatched-image':!m.accepted?'ambiguous-or-below-confidence':'image-dimension-mismatch'});continue;}selected.push({slot,match:m});}
 if(!selected.length)fail('No slide images passed the independent thumbnail match.','NO_CONFIDENT_MATCHES');
 const pageNumbers=[...new Set(selected.map(s=>s.match.candidates[0].page))].sort((a,b)=>a-b);
 const geometry=pageNumbers.map(n=>normalizedPageMatrix(reference.getPage(n-1)));
 const embedded=await target.embedPages(pageNumbers.map(n=>reference.getPage(n-1)),geometry.map(g=>g.boundingBox),geometry.map(g=>g.matrix));
 await target.flush();const replacements=new Map();
 for(let i=0;i<pageNumbers.length;i++){
  const form=target.context.flateStream(Buffer.from('q\n1 1 1 rg\n0 0 1 1 re f\n/HDSlide Do\nQ\n','ascii'),{Type:'XObject',Subtype:'Form',FormType:1,BBox:[0,0,1,1],Matrix:[1,0,0,1,0,0],Resources:{XObject:{HDSlide:embedded[i].ref}}});
  replacements.set(pageNumbers[i],target.context.register(form));
 }
 const applied=[];
 for(const {slot,match} of selected){const page=match.candidates[0].page;slot.objects.set(slot.name,replacements.get(page));applied.push({path:slot.path,encodedSha256:slot.encodedSha256,referencePage:page,form:replacements.get(page).toString(),sourceWidth:slot.width,sourceHeight:slot.height,rotation:match.geometry.rotation,normalizationMatrix:match.geometry.matrix,score:match.candidates[0].score,runnerUpScore:match.candidates[1].score});}
 // Editing the XObject resource reference is the only change to source objects.
 // Every original stream, including ink paths, clips, cm/Do ordering and image
 // bytes, must remain exact before saving; new reference objects are additive.
 for(const original of ledger){const obj=target.context.lookup(require('pdf-lib').PDFRef.of(...original.ref.split(' ').slice(0,2).map(Number)));if(!(obj instanceof PDFRawStream)||sha(obj.contents)!==original.encodedSha256||(!original.image&&sha(decoded(obj))!==original.decodedSha256))fail('Original PDF drawing stream changed.','PRESERVATION_FAILED');}
 const output=Buffer.from(await target.save({useObjectStreams:true,addDefaultPage:false}));
 return {data:output,report:{version:VERSION,metric:METRIC,thresholds:THRESHOLDS,targetSha256:sha(targetData),referenceSha256:sha(referenceData),outputSha256:sha(output),targetPages:target.getPageCount(),referencePages:reference.getPageCount(),imageResourceSlots:slots.length,replacedResourceSlots:applied.length,uniqueMatchedImageHashes:new Set(selected.map(s=>s.slot.encodedSha256)).size,uniqueReferencePagesEmbedded:pageNumbers.length,retained,applied,originalStreamsVerified:ledger.length,originalNonImageStreamsVerified:ledger.filter(s=>!s.image).length,originalContentStreamsUnchanged:true,pixelEvidenceRecomputed:true,referencePagesCompared:referenceThumbnails.length,whiteImageBackingPreserved:true,metadataUnchanged:true,notes:['Reference pages remain vector PDF forms; the source handwriting and content-stream operators are byte-for-byte unchanged.','Only confident pixel thumbnail matches are replaced; low-confidence/unknown images remain original.','No OCR, invented formulas, rasterized page replacement, or source file write is performed.']}};
}
module.exports={VERSION,METRIC,LIMITS,THRESHOLDS,rankThumbnailMatches,acceptsMatch,normalizedPageMatrix,collectImageSlots,recoverOneNoteSlides};

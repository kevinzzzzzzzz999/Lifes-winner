'use strict';
// OOXML relationships are data only: no filesystem extraction, network, source
// HTML, SVG, macros, chart execution or external relationship dereferencing.
const path=require('node:path').posix,{DOMParser}=require('@xmldom/xmldom'),{imageInfo}=require('./image-import.cjs');
const LIMITS={xmlBytes:2*1024*1024,imageBytes:2*1024*1024,totalImageBytes:8*1024*1024,imagePixels:16*1024*1024,totalPixels:32*1024*1024,pictures:64};
const escaped=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nodes=(root,name)=>Array.from(root.getElementsByTagName('*')).filter(n=>n.localName===name);
const attr=(node,name)=>Array.from(node.attributes||[]).find(a=>a.localName===name&&/\/relationships$/.test(a.namespaceURI||''))?.value||'';
function resolvePart(part,target){
 if(!target||/[\\\x00-\x1f?#]/.test(target)||/^[a-z][a-z\d+.-]*:/i.test(target)||target.startsWith('//'))return null;
 let decoded;try{decoded=decodeURIComponent(target);}catch{return null;}
 if(/[\\\x00-\x1f?#]/.test(decoded)||/^[a-z][a-z\d+.-]*:/i.test(decoded)||decoded.startsWith('//'))return null;
 const result=path.normalize(decoded.startsWith('/')?decoded.slice(1):path.join(path.dirname(part),decoded));
 return result==='..'||result.startsWith('../')||result.startsWith('/')?null:result;
}
async function readXML(zip,name,required=true){
 const file=zip.file(name);if(!file){if(required)throw Error('OFFICE_STRUCTURE');return null;}
 if(file._data?.uncompressedSize>LIMITS.xmlBytes)throw Error('OFFICE_CAPACITY');
 const bytes=await file.async('nodebuffer');if(bytes.length>LIMITS.xmlBytes)throw Error('OFFICE_CAPACITY');
 const text=bytes.toString('utf8');if(/<!\s*(DOCTYPE|ENTITY)/i.test(text))throw Error('OFFICE_STRUCTURE');
 const reject=()=>{throw Error('OFFICE_STRUCTURE');};const xml=new DOMParser({errorHandler:{warning:reject,error:reject,fatalError:reject}}).parseFromString(text,'application/xml');
 if(!xml.documentElement||xml.getElementsByTagName('*').length>80000)throw Error('OFFICE_CAPACITY');return xml;
}
async function relationships(zip,part){
 const xml=await readXML(zip,path.join(path.dirname(part),'_rels',path.basename(part)+'.rels'),false),map=new Map();if(!xml)return map;
 for(const node of nodes(xml,'Relationship')){const id=node.getAttribute('Id');if(!id||map.has(id))throw Error('OFFICE_STRUCTURE');const external=(node.getAttribute('TargetMode')||'').toLowerCase()==='external';map.set(id,{type:node.getAttribute('Type')||'',external,path:external?null:resolvePart(part,node.getAttribute('Target'))});}return map;
}
async function optionalPictures(read,state,fallback){try{return await read();}catch(error){if(/CAPACITY/.test(String(error)))throw error;state.skipped++;return fallback;}}
const relationship=(map,id,kind)=>{const value=map.get(id);return value&&!value.external&&value.path&&value.type.endsWith('/'+kind)?value.path:null;};
function budget(){return{bytes:0,pixels:0,count:0,skipped:0,external:0,charts:0,other:0};}
async function picture(zip,pic,rels,state,anchor=''){
 const props=nodes(pic,'cNvPr')[0];if(props&&['1','true'].includes(props.getAttribute('hidden')))return null;
 const blip=nodes(pic,'blip')[0];if(!blip){state.skipped++;return null;}
 const id=attr(blip,'embed'),linked=attr(blip,'link');if(!id){if(linked)state.external++;else state.skipped++;return null;}
 const reference=rels.get(id);if(reference?.external){state.external++;return null;}
 const name=relationship(rels,id,'image'),file=name&&zip.file(name);if(!file){state.skipped++;return null;}
 if(state.count>=LIMITS.pictures||file._data?.uncompressedSize>LIMITS.imageBytes){state.skipped++;return null;}
 let bytes;try{bytes=await file.async('nodebuffer');}catch{state.skipped++;return null;}if(bytes.length>LIMITS.imageBytes||state.bytes+bytes.length>LIMITS.totalImageBytes){state.skipped++;return null;}
 let info;try{info=imageInfo(bytes);if(!completeImage(bytes,info.extension))throw Error('INCOMPLETE_IMAGE');}catch{state.skipped++;return null;}
 const pixels=info.width*info.height;if(pixels>LIMITS.imagePixels||state.pixels+pixels>LIMITS.totalPixels){state.skipped++;return null;}
 state.bytes+=bytes.length;state.pixels+=pixels;state.count++;
 return{src:'data:image/'+(info.extension==='jpg'?'jpeg':'png')+';base64,'+bytes.toString('base64'),width:info.width,height:info.height,anchor};
}
// A size header alone is not an image. Require a complete PNG chunk stream or
// JPEG scan/end marker; the renderer additionally reports actual decode failures.
function completeImage(bytes,extension){
 if(extension==='jpg')return bytes.length>4&&bytes.indexOf(Buffer.from([255,218]),2)>0&&bytes.at(-2)===255&&bytes.at(-1)===217;
 if(extension!=='png')return false;
 let at=8,sawHeader=false,sawData=false;
 while(at+12<=bytes.length){const length=bytes.readUInt32BE(at),end=at+12+length;if(end>bytes.length)return false;const type=bytes.toString('ascii',at+4,at+8);if(!sawHeader){if(type!=='IHDR'||length!==13)return false;sawHeader=true;}if(type==='IDAT'&&length>0)sawData=true;if(type==='IEND')return length===0&&sawData&&end===bytes.length;at=end;}
 return false;
}
function pictureHTML(images,label='Embedded pictures'){
 if(!images?.length)return'';
 return '<section class="office-embedded-pictures"><h3>'+escaped(label)+'</h3><p>Picture supplement: original image pixels, not the original placement, crop, rotation or effects.</p>'+images.map((image,index)=>'<figure><figcaption>Image '+(index+1)+(image.anchor?' · '+escaped(image.anchor):'')+'</figcaption><img src="'+image.src+'" width="'+image.width+'" height="'+image.height+'" alt="Embedded image '+(index+1)+'" loading="eager"/></figure>').join('')+'</section>';
}
function imageWarnings(state){const result=[];if(state.skipped)result.push('Some embedded images were omitted because their format, reference, byte size or pixel count is unsupported.');if(state.external)result.push('Linked external images were not loaded.');if(state.charts||state.other)result.push('Charts, SmartArt, drawing shapes and other floating objects are not reproduced. Open the original application for their full appearance.');return result;}
async function pptxPreview(zip){
 const part='ppt/presentation.xml',presentation=await readXML(zip,part),rels=await relationships(zip,part),ids=nodes(presentation,'sldId');if(!ids.length||ids.length>200)throw Error('OFFICE_CAPACITY');
 const state=budget(),slides=[];let characters=0;
 for(let index=0;index<ids.length;index++){
  const name=relationship(rels,attr(ids[index],'id'),'slide');if(!name)throw Error('OFFICE_STRUCTURE');const xml=await readXML(zip,name),slideRels=await optionalPictures(()=>relationships(zip,name),state,new Map()),images=[];
  const text=nodes(xml,'t').map(n=>n.textContent||'').join('\n');characters+=text.length;if(characters>300000)throw Error('OFFICE_CAPACITY');
  state.charts+=nodes(xml,'chart').length;state.other+=nodes(xml,'graphicFrame').length;
  for(const pic of nodes(xml,'pic')){const value=await picture(zip,pic,slideRels,state);if(value)images.push(value);}
  slides.push({text,images});
 }
 return{text:slides.map(s=>s.text).join('\n\n'),html:slides.map((s,index)=>'<section class="office-slide-reading"><h2>Slide '+(index+1)+'</h2><p>'+escaped(s.text).replace(/\n/g,'<br>')+'</p>'+pictureHTML(s.images)+'</section>').join(''),warnings:['Read-only slide text and slide-body PNG/JPEG picture supplements. Original slide layout, master/background artwork, crops, rotations, effects, charts and SmartArt are not reproduced.',...imageWarnings(state)],imageSummary:state};
}
function cellAnchor(pic){
 let anchor=pic.parentNode;while(anchor&&anchor.nodeType===1&&!['oneCellAnchor','twoCellAnchor','absoluteAnchor'].includes(anchor.localName))anchor=anchor.parentNode;
 if(!anchor)return '';if(anchor.localName==='absoluteAnchor')return 'Absolute position';
 const cell=kind=>{const marker=nodes(anchor,kind)[0],row=marker&&nodes(marker,'row')[0]?.textContent,col=marker&&nodes(marker,'col')[0]?.textContent;if(!/^\d+$/.test(row||'')||!/^\d+$/.test(col||''))return '';const r=Number(row),c=Number(col);if(r>1048575||c>16383)return '';let n=c+1,letters='';while(n>0){n--;letters=String.fromCharCode(65+n%26)+letters;n=Math.floor(n/26);}return letters+(r+1);};
 const from=cell('from'),to=cell('to');return from?'Anchor '+from+(to?':'+to:''):'';
}
async function addXlsxPictures(zip,model){
 const part='xl/workbook.xml',xml=await readXML(zip,part),rels=await relationships(zip,part),state=budget(),byName=new Map();
 for(const sheet of nodes(xml,'sheet')){const name=sheet.getAttribute('name');if(byName.has(name))throw Error('OFFICE_STRUCTURE');byName.set(name,sheet);}
 for(const sheet of model.sheets){
  const metadata=byName.get(sheet.name);if(!metadata)throw Error('OFFICE_STRUCTURE');const name=relationship(rels,attr(metadata,'id'),'worksheet');if(!name)throw Error('OFFICE_STRUCTURE');
  const xml=await readXML(zip,name),sheetRels=await optionalPictures(()=>relationships(zip,name),state,new Map());sheet.images=[];
  state.other+=nodes(xml,'legacyDrawing').length+nodes(xml,'oleObject').length+nodes(xml,'picture').length;
  for(const drawing of nodes(xml,'drawing')){
   const drawingName=relationship(sheetRels,attr(drawing,'id'),'drawing');if(!drawingName){state.skipped++;continue;}
   const xml=await optionalPictures(()=>readXML(zip,drawingName),state,null);if(!xml)continue;const drawingRels=await optionalPictures(()=>relationships(zip,drawingName),state,new Map());state.charts+=nodes(xml,'chart').length;state.other+=nodes(xml,'sp').length+nodes(xml,'graphicFrame').length;
   for(const pic of nodes(xml,'pic')){const image=await picture(zip,pic,drawingRels,state,cellAnchor(pic));if(image)sheet.images.push(image);}
  }
 }
 model.imageSummary=state;return model;
}
module.exports={pptxPreview,addXlsxPictures,pictureHTML,imageWarnings,resolvePart,readXML,completeImage,LIMITS};

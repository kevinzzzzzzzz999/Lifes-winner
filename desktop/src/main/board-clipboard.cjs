'use strict';
// This module never reads the clipboard on load. The IPC handler invokes it only
// in response to the explicit Paste command. No clipboard payload enters logs.
const {spawn}=require('node:child_process');
const {fail}=require('./errors.cjs');
const {imageInfo}=require('./image-import.cjs');
const {grantFileURLs,MAX_URI_BYTES}=require('./clipboard-files.cjs');
const LIMITS=Object.freeze({textChars:100000,htmlBytes:2*1024*1024,rtfBytes:2*1024*1024,imageBytes:8*1024*1024,imagePixels:16*1024*1024,imageDimension:8192,totalImageBytes:16*1024*1024,totalImagePixels:32*1024*1024,imageCount:8});
function validText(value,maxBytes){return typeof value==='string'&&!value.includes('\0')&&value.isWellFormed()&&Buffer.byteLength(value)<=maxBytes;}
function dimensions(width,height){if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>LIMITS.imageDimension||height>LIMITS.imageDimension||width*height>LIMITS.imagePixels)fail('TOO_LARGE');}
function pngFromNative(image){
 if(!image||image.isEmpty())fail('UNSUPPORTED');
 const {width,height}=image.getSize();dimensions(width,height);
 const data=image.toPNG();if(!Buffer.isBuffer(data)||!data.length||data.length>LIMITS.imageBytes)fail('TOO_LARGE');
 const info=imageInfo(data);if(info.extension!=='png')fail('UNSUPPORTED');dimensions(info.width,info.height);
 return{data,width:info.width,height:info.height};
}
function normalizeImage(dataURL,nativeImage){
 if(typeof dataURL!=='string'||dataURL.length>Math.ceil(LIMITS.imageBytes/3)*4+64)fail('TOO_LARGE');
 const prefix=/^data:image\/(png|jpeg);base64,/.exec(dataURL);if(!prefix)fail('UNSUPPORTED');
 const encoded=dataURL.slice(prefix[0].length);if(!encoded||/[^A-Za-z0-9+/=]/.test(encoded))fail('INVALID_REQUEST');
 const data=Buffer.from(encoded,'base64');if(data.toString('base64')!==encoded)fail('INVALID_REQUEST');if(!data.length||data.length>LIMITS.imageBytes)fail('TOO_LARGE');
 const info=imageInfo(data);if(info.extension!==(prefix[1]==='jpeg'?'jpg':'png'))fail('UNSUPPORTED');dimensions(info.width,info.height);
 // Decode then re-encode: malformed headers, ancillary payloads and JPEG metadata
 // never become trusted image dimensions or executable document content.
 if(!nativeImage||typeof nativeImage.createFromBuffer!=='function')fail('UNSUPPORTED');
 return pngFromNative(nativeImage.createFromBuffer(data));
}
function convertRTF(rtf,{spawnProcess=spawn,timeoutMs=1800}={}){
 if(!validText(rtf,LIMITS.rtfBytes)||!/^\s*\{\\rtf[0-9]/.test(rtf))return Promise.reject(Error('Invalid RTF'));
 return new Promise((resolve,reject)=>{
  let child,settled=false,bytes=0,chunks=[],timer;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child?.kill('SIGKILL');reject(Error('RTF conversion unavailable'));}else resolve(result);};
  try{child=spawnProcess('/usr/bin/textutil',['-stdin','-stdout','-format','rtf','-convert','html','-encoding','UTF-8','-noload','-nostore','-strip','-timeout','1'],{shell:false,stdio:['pipe','pipe','ignore'],windowsHide:true});}catch{return finish(true);}
  timer=setTimeout(()=>finish(true),timeoutMs);timer.unref?.();
  child.on('error',()=>finish(true));child.stdin.on('error',()=>finish(true));
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>LIMITS.htmlBytes)return finish(true);chunks.push(chunk);});
  child.on('close',code=>{if(settled)return;if(code!==0)return finish(true);try{const html=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(!validText(html,LIMITS.htmlBytes))return finish(true);finish(false,html);}catch{finish(true);}});
  child.stdin.end(Buffer.from(rtf));
 });
}
async function readLegacyClipboard({clipboard,convert=convertRTF,platform=process.platform}){
 // Complete native reads synchronously before awaiting the optional conversion.
 // Only native file URL representations grant local import access; web URLs are never fetched.
 const warnings=[];let text='',html='',rtf='',image,files;
 try{const formats=clipboard.availableFormats();const format=['text/uri-list','public.file-url'].find(type=>formats.includes(type));if(format&&typeof clipboard.readBuffer==='function'){files=grantFileURLs(clipboard.readBuffer(format).toString('utf8'));}}catch{files=[];warnings.push('Clipboard files could not be read. Copy the files again in Finder.');}
 try{const value=clipboard.readText();if(validText(value,LIMITS.textChars*4)&&value.length<=LIMITS.textChars)text=value;else if(value)warnings.push('Clipboard text exceeds the supported size or contains invalid text.');}catch{warnings.push('Clipboard text could not be read.');}
 try{const value=clipboard.readHTML();if(validText(value,LIMITS.htmlBytes))html=value;else if(value)warnings.push('Clipboard formatting exceeds the supported size or is invalid.');}catch{warnings.push('Clipboard formatting could not be read.');}
 if(!html&&platform==='darwin')try{const value=clipboard.readRTF();if(validText(value,LIMITS.rtfBytes))rtf=value;else if(value)warnings.push('Clipboard rich text exceeds the supported size.');}catch{}
 try{const formats=clipboard.availableFormats();if(Array.isArray(formats)&&formats.some(v=>typeof v==='string'&&/^(image\/(png|jpeg|tiff|bmp)|public\.(png|jpeg|tiff)|NSTIFFPboardType)$/i.test(v))){const value=clipboard.readImage();if(!value.isEmpty()){const png=pngFromNative(value);image={dataURL:'data:image/png;base64,'+png.data.toString('base64'),width:png.width,height:png.height};}}}catch{warnings.push('Clipboard image is too large or could not be decoded.');}
 if(!html&&rtf){try{html=await convert(rtf);if(!validText(html,LIMITS.htmlBytes))throw Error();}catch{html='';warnings.push('Rich-text formatting could not be converted; plain text remains available.');}}
 return{text,html,...(image?{image}:{}),...(files?{files}:{}),warnings};
}
async function readModernClipboard({clipboard,nativeImage,convert=convertRTF,platform=process.platform}){
 // Electron 44 exposes the asynchronous ClipboardItem API. Read the pasteboard
 // once; never mix a later readText/read() with this representation snapshot.
 const warnings=[];let items,text='',html='',rtf='',image,files;
 try{items=await clipboard.read();if(!Array.isArray(items))throw Error();}catch{return{text,html,warnings:['Clipboard contents could not be read.']};}
 // Gather actual file representations across all pasteboard items before choosing
 // an image or a single rich-text item. Finder often adds plain filenames too.
 const entries=items.slice(0,100).filter(item=>item&&Array.isArray(item.types)&&typeof item.getType==='function');
 const fileItems=entries.filter(item=>item.types.includes('text/uri-list'));
 if(fileItems.length){
  try{const values=await Promise.all(fileItems.map(async item=>{const blob=await item.getType('text/uri-list');if(!blob||!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>MAX_URI_BYTES)throw Error();return blob.text();}));const value=values.join('\r\n');const granted=grantFileURLs(value);if(granted.length)files=granted;}
  catch{files=[];warnings.push('Clipboard files could not be read. Copy the files again in Finder.');}
 }
 const supported=['text/plain','text/html',...(platform==='darwin'?['text/rtf','application/rtf']:[]),'image/png','image/jpeg'];
 const selected=entries.find(item=>item.types.includes('image/png')||item.types.includes('image/jpeg'))||entries.find(item=>item.types.some(type=>supported.includes(type)));
 if(!selected)return{text,html,...(files?{files}:{}),warnings};
 const types=selected.types;
 // Request the small, known set of representations before awaiting any of
 // them. SVG, network resources and arbitrary custom formats are never requested.
 const requests=[];
 const add=(kind,type)=>{if(type)requests.push({kind,type,promise:Promise.resolve().then(()=>selected.getType(type))});};
 add('text',types.includes('text/plain')?'text/plain':null);
 add('html',types.includes('text/html')?'text/html':null);
 if(platform==='darwin')add('rtf',types.includes('text/rtf')?'text/rtf':types.includes('application/rtf')?'application/rtf':null);
 add('image',types.includes('image/png')?'image/png':types.includes('image/jpeg')?'image/jpeg':null);
 const blobs=await Promise.allSettled(requests.map(request=>request.promise));
 for(let index=0;index<requests.length;index++){
  const {kind,type}=requests[index],result=blobs[index];
  if(kind==='rtf'&&html)continue;
  try{
   if(result.status!=='fulfilled')throw Error();
   const blob=result.value,limit=kind==='image'?LIMITS.imageBytes:kind==='text'?LIMITS.textChars*4:kind==='rtf'?LIMITS.rtfBytes:LIMITS.htmlBytes;
   // Check size before materializing Blob contents, then check the decoded
   // bytes/text again; the same limits apply to old and new runtimes.
   if(!blob||!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>limit)throw Error();
   if(kind==='image'){
    const data=Buffer.from(await blob.arrayBuffer());if(data.length!==blob.size||data.length>limit)throw Error();
    const png=normalizeImage('data:'+type+';base64,'+data.toString('base64'),nativeImage);
    image={dataURL:'data:image/png;base64,'+png.data.toString('base64'),width:png.width,height:png.height};
   }else{
    const value=await blob.text();if(!validText(value,limit)||(kind==='text'&&value.length>LIMITS.textChars))throw Error();
    if(kind==='text')text=value;else if(kind==='html')html=value;else rtf=value;
   }
  }catch{warnings.push(kind==='image'?'Clipboard image is too large or could not be decoded.':kind==='text'?'Clipboard text exceeds the supported size or could not be read.':kind==='html'?'Clipboard formatting exceeds the supported size or could not be read.':'Clipboard rich text exceeds the supported size or could not be read.');}
 }
 if(!html&&rtf){try{html=await convert(rtf);if(!validText(html,LIMITS.htmlBytes))throw Error();}catch{html='';warnings.push('Rich-text formatting could not be converted; plain text remains available.');}}
 return{text,html,...(image?{image}:{}),...(files?{files}:{}),warnings};
}
async function readBoardClipboard(options){
 // New clipboard.read() returns ClipboardItem[]; legacy Electron read(format)
 // is a different API, detected by its accompanying readHTML method.
 if(typeof options.clipboard?.read==='function'&&typeof options.clipboard.readHTML!=='function')return readModernClipboard(options);
 return readLegacyClipboard(options);
}
module.exports={LIMITS,readBoardClipboard,normalizeImage,convertRTF,pngFromNative};

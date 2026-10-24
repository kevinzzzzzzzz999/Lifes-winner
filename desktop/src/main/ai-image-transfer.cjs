'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {fail}=require('./errors.cjs');
const MAX_PNG_BYTES=24*1024*1024,MAX_PIXELS=12_000_000;
// All workspace controllers share the OS clipboard. Serialize app-owned writes
// and the final verification/paste so two captures cannot paste each other.
let clipboardQueue=Promise.resolve();
function withClipboardImage(task){const result=clipboardQueue.catch(()=>{}).then(task);clipboardQueue=result.catch(()=>{});return result;}
function pngImage(request,nativeImage){
 if(typeof request?.dataURL!=='string'||request.dataURL.length>MAX_PNG_BYTES||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(request.dataURL))fail('INVALID_REQUEST');
 const image=nativeImage.createFromDataURL(request.dataURL),size=image.getSize();
 if(image.isEmpty()||!Number.isInteger(size.width)||!Number.isInteger(size.height)||size.width<1||size.height<1||size.width*size.height>MAX_PIXELS)fail('INVALID_REQUEST');
 const bytes=image.toPNG();if(!bytes.length||bytes.length>MAX_PNG_BYTES)fail('INVALID_REQUEST');
 return{image,bytes};
}
function imageFingerprint(image){
 if(image.isEmpty())return null;const size=image.getSize(1);
 if(!Number.isInteger(size.width)||!Number.isInteger(size.height)||size.width<1||size.height<1||size.width*size.height>MAX_PIXELS)return null;
 const bitmap=image.toBitmap({scaleFactor:1});if(bitmap.length!==size.width*size.height*4)return null;
 return createHash('sha256').update(size.width+':'+size.height+':').update(bitmap).digest('hex');
}
async function writePNG(clipboard,ClipboardItem,bytes){await clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);}
async function clipboardHasPNG(clipboard,nativeImage,expected,isCurrent){
 try{
  const items=await clipboard.read();if(!isCurrent()||!Array.isArray(items)||items.length!==1||!items[0]?.types?.includes('image/png'))return false;
  const blob=await items[0].getType('image/png');if(!isCurrent()||!blob||blob.size<1||blob.size>MAX_PNG_BYTES||typeof blob.arrayBuffer!=='function')return false;
  const bytes=Buffer.from(await blob.arrayBuffer());if(!isCurrent())return false;
  // macOS may re-encode a valid PNG on the pasteboard. Compare dimensions and
  // decoded pixels, never an unrelated text flavor or the compressed PNG bytes.
  return imageFingerprint(nativeImage.createFromBuffer(bytes))===expected;
 }catch{return false;}
}
function composerScripts({origin,pageURL,nonce}){
 // Keep all candidates explicitly tied to the ChatGPT composer. Never fall
 // back to an arbitrary textarea, contenteditable, search field or chat text.
 const labels=['Ask ChatGPT','询问 ChatGPT','询问ChatGPT','向 ChatGPT 发送消息','向ChatGPT发送消息','给 ChatGPT 发送消息'];
 const selectors=labels.flatMap(label=>{const value=JSON.stringify(label);return [`textarea[placeholder=${value}]`,`textarea[aria-label=${value}]`,`[contenteditable="true"][aria-label=${value}]`,`[contenteditable="true"][data-placeholder=${value}]`];});
 const pageGate=result=>`if(location.origin!==${JSON.stringify(origin)})return ${result};const expected=new URL(${JSON.stringify(pageURL)}),current=new URL(location.href);expected.hash='';current.hash='';if(current.href!==expected.href)return ${result};`;
 const navigation="{ready:false,reason:'navigation'}",token="document[Symbol.for('inkspace.aiImagePaste')]";
 // Only booleans and the allowlisted failure stage leave the isolated page.
 // Save the actual selected node with the nonce: a same-URL React replacement
 // cannot silently redirect native paste to a different input element.
 const find=`
  const usable=el=>{
   if(!el||!el.isConnected||!(el.tagName==='TEXTAREA'||el.isContentEditable)||el.disabled||el.readOnly||el.matches?.(':disabled')||el.getAttribute('aria-disabled')==='true'||el.getAttribute('aria-readonly')==='true'||el.closest?.('[inert]')||el.closest?.('[aria-hidden="true"]')||!el.getClientRects().length)return false;
   for(let node=el;node;node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false;}
   return true;
  };
  const candidates=new Set();
  for(const host of document.querySelectorAll('#prompt-textarea')){
   if(usable(host))candidates.add(host);
   else for(const inner of host.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]'))if(usable(inner))candidates.add(inner);
  }
  for(const selector of ${JSON.stringify(selectors)})for(const candidate of document.querySelectorAll(selector))if(usable(candidate))candidates.add(candidate);
  const matches=[...candidates],el=matches.length===1?matches[0]:null;
 `;
 const valid=`const state=${token};if(!state||state.nonce!==${JSON.stringify(nonce)})return ${navigation};${find}if(!el)return {ready:false,reason:'composerMissing'};if(el!==state.element||!state.element.isConnected)return {ready:false,reason:'composerFocus'};`;
 return{
  focus:`(()=>{/* inkspace-ai-image-focus */${pageGate(navigation)}${find}if(!el)return {ready:false,reason:'composerMissing'};${token}={nonce:${JSON.stringify(nonce)},element:el};try{el.focus();return {ready:true};}catch{return {ready:false,reason:'composerFocus'};}})()`,
  verify:`(()=>{/* inkspace-ai-image-verify */${pageGate(navigation)}${valid}try{el.focus();const ready=document.activeElement===el||!!el.contains?.(document.activeElement);return ready?{ready:true}:{ready:false,reason:'composerFocus'};}catch{return {ready:false,reason:'composerFocus'};}})()`,
  attachments:`(()=>{/* inkspace-ai-image-attachments */${pageGate('[]')}const state=${token};if(!state||state.nonce!==${JSON.stringify(nonce)})return [];${find}if(!el||el!==state.element||!state.element.isConnected)return [];const form=el.closest('form')||el.parentElement?.parentElement;if(!form)return [];return [...form.querySelectorAll('[data-testid*=file-thumbnail],[data-testid*=attachment],img[src^="blob:"],img[src^="data:image/"]')].filter(el=>el.getClientRects().length).map(el=>el.getAttribute('src')||el.getAttribute('data-testid')||el.tagName);})()`
 };
}
function createPNGDragCache({temporaryDirectory,maxFiles=8}){
 let closed=false,directoryPromise=null,closePromise=null;const pending=new Set(),files=new Set();
 async function directory(){
  if(!directoryPromise)directoryPromise=(async()=>{const value=await fs.mkdtemp(path.join(temporaryDirectory(),'inkspace-ai-capture-'));try{await fs.chmod(value,0o700);return value;}catch(error){await fs.rmdir(value).catch(()=>{});throw error;}})();
  return directoryPromise;
 }
 function create(bytes,isCurrent){
  const task=(async()=>{
   if(closed||!isCurrent())fail('CANCELLED');
   if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_PNG_BYTES)fail('INVALID_REQUEST');
   const dir=await directory();if(closed||!isCurrent())fail('CANCELLED');
   const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))fail('IO_FAILED');
   const file=path.join(dir,'Capture-'+randomUUID()+'.png');let handle,created=false;
   try{
    handle=await fs.open(file,'wx',0o600);created=true;files.add(file);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    if(closed||!isCurrent())fail('CANCELLED');
    for(const old of [...files].slice(0,Math.max(0,files.size-maxFiles))){await fs.unlink(old).catch(error=>{if(error.code!=='ENOENT')throw error;});files.delete(old);}
    if(closed||!isCurrent())fail('CANCELLED');return file;
   }catch(error){if(handle)await handle.close().catch(()=>{});if(created){await fs.unlink(file).catch(()=>{});files.delete(file);}throw error;}
  })();
  pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});return task;
 }
 function close(){
  if(closePromise)return closePromise;closed=true;
  closePromise=(async()=>{await Promise.allSettled([...pending]);if(!directoryPromise)return;const dir=await directoryPromise;for(const file of files){await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});files.delete(file);}await fs.rmdir(dir).catch(error=>{if(error.code!=='ENOENT'&&error.code!=='ENOTEMPTY')throw error;});})();return closePromise;
 }
 return{create,close};
}
module.exports={MAX_PNG_BYTES,MAX_PIXELS,pngImage,imageFingerprint,writePNG,clipboardHasPNG,withClipboardImage,composerScripts,createPNGDragCache};

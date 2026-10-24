/** Internal links always name a public file relative to the currently chosen vault. */
const anchorPrefix='#inkspace-file=';
export function isInternalFilePath(value:unknown):value is string{
 if(typeof value!=='string'||!value||value.length>4096||value.startsWith('/')||/[\\\x00-\x1f\x7f-\x9f:]/.test(value))return false;
 if(value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))return false;
 try{encodeURIComponent(value);}catch{return false;}
 return true;
}
export function internalFilePathFromURL(value:string):string|null{
 if(typeof value!=='string'||value!==value.trim()||/[\x00-\x1f\x7f-\x9f]/.test(value)||!/^inkspace:\/\/open\?/i.test(value))return null;
 try{
  const url=new URL(value),entries=[...url.searchParams];
  if(url.protocol!=='inkspace:'||url.hostname.toLowerCase()!=='open'||url.username||url.password||url.port||url.pathname||url.hash||entries.length!==1||entries[0][0]!=='file')return null;
  return isInternalFilePath(entries[0][1])?entries[0][1]:null;
 }catch{return null;}
}
/** A safe local fragment survives HTML sanitization without enabling custom URI schemes. */
export function internalFileAnchor(value:string):string|null{
 const file=internalFilePathFromURL(value);return file===null?null:anchorPrefix+encodeURIComponent(file);
}
export function internalFilePathFromAnchor(value:string):string|null{
 if(typeof value!=='string'||!value.startsWith(anchorPrefix))return null;
 try{const file=decodeURIComponent(value.slice(anchorPrefix.length));return isInternalFilePath(file)?file:null;}catch{return null;}
}

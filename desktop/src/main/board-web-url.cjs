'use strict';
const {fail}=require('./errors.cjs');
// Matches the renderer/native card policy; no custom schemes, credentials, or
// ambiguous escaped control characters. It does not fetch the URL.
function webCardURL(value){
 if(typeof value!=='string'||value.length>8192||!value.isWellFormed())fail('INVALID_REQUEST');
 const text=value.trim();
 if(!/^https?:\/\//i.test(text)||/[\s\\\x00-\x1f\x7f]/u.test(text)||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(text))fail('INVALID_REQUEST');
 let url;try{url=new URL(text);}catch{fail('INVALID_REQUEST');}
 if(!url.hostname||url.username||url.password)fail('INVALID_REQUEST');
 return url.href;
}
module.exports={webCardURL};

'use strict';
// Native PencilKit bytes remain opaque here. The cross-platform renderer uses
// the retained normalized points; edits and history must keep this payload.
const MAX_BYTES=128*1024,MAX_BASE64=Math.ceil(MAX_BYTES/3)*4;
function validateNativeInk(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==3||Object.keys(v).some(k=>!['version','referenceWidth','data'].includes(k))||v.version!==1||typeof v.referenceWidth!=='number'||!Number.isFinite(v.referenceWidth)||v.referenceWidth<1||v.referenceWidth>100000||typeof v.data!=='string'||v.data.length===0||v.data.length>MAX_BASE64||v.data.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.data))throw Error('Invalid native PDF ink');
 const bytes=Buffer.from(v.data,'base64');
 if(bytes.length===0||bytes.length>MAX_BYTES||bytes.toString('base64')!==v.data)throw Error('Invalid native PDF ink');
 return{version:1,referenceWidth:v.referenceWidth,data:v.data};
}
module.exports={validateNativeInk,MAX_BYTES};

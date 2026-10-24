'use strict';
// A worksheet export is content, never a filesystem destination or executable.
const TYPES = Object.freeze({'image/png': 'png', 'text/csv': 'csv', 'application/json': 'json'});
function decodeMathExport(request) {
 if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(k=>!['name','mime','dataBase64'].includes(k))) throw Error('Invalid math export');
 if (typeof request.mime !== 'string' || !Object.hasOwn(TYPES,request.mime)) throw Error('Invalid math export MIME');
 const extension = TYPES[request.mime];
 if (!extension || typeof request.name !== 'string' || typeof request.dataBase64 !== 'string' || request.dataBase64.length > 12*1024*1024 || /[^A-Za-z0-9+/=]/.test(request.dataBase64)) throw Error('Invalid math export');
 const data=Buffer.from(request.dataBase64,'base64');
 if (data.toString('base64') !== request.dataBase64) throw Error('Invalid math export encoding');
 if (!data.length || data.length>8*1024*1024) throw Error('Math export exceeds 8 MiB');
 if (extension==='png' && !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Invalid PNG');
 if (extension==='json') JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
 if (extension==='csv') new TextDecoder('utf-8',{fatal:true}).decode(data);
 const stem=request.name.replace(/[\x00-\x1f\x7f/\\:]/g,'_').replace(/^\.+/,'').replace(/\.(png|csv|json)$/i,'').slice(0,120).trim() || 'Math worksheet';
 return {data, extension, name:stem+'.'+extension};
}
module.exports={decodeMathExport};

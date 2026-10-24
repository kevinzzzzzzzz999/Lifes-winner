'use strict';
const {fail}=require('./errors.cjs');
function trustedURL(value,devURL){try{const u=new URL(value);if(devURL){const d=new URL(devURL);return u.origin===d.origin;}return u.protocol==='inkspace-app:'&&u.hostname==='ui'&&!u.username&&!u.password&&(u.pathname==='/'||u.pathname==='/index.html');}catch{return false;}}
function validateSender(event,webContents,devURL){if(!webContents||event.sender!==webContents||event.senderFrame!==webContents.mainFrame||!trustedURL(event.senderFrame?.url,devURL))fail('PERMISSION_DENIED');}
function safeDevURL(value){if(!value)return undefined;try{const u=new URL(value);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)fail('INVALID_REQUEST');return u.href;}catch{fail('INVALID_REQUEST');}}
function externalURL(value){if(typeof value!=='string'||value.length>2048||value.trim()!==value||/[\x00-\x1f\x7f]/.test(value))fail('INVALID_REQUEST');try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||!u.hostname||u.username||u.password)fail('INVALID_REQUEST');return u.href;}catch{fail('INVALID_REQUEST');}}
module.exports={trustedURL,validateSender,safeDevURL,externalURL};

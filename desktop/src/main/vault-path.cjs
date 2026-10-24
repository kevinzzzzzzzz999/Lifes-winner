'use strict';
const {fail}=require('./errors.cjs');
// Schema references use the native app's safe relative-path syntax. A board can
// be read on Windows even when a referenced macOS filename is not representable
// there. Never trim: trailing spaces/dots are part of a real filename on macOS.
function boardRelativePath(value,allowRoot=false){
 if(typeof value!=='string'||value.length>4096||(!value&&!allowRoot)||/[\\\x00-\x1f\x7f-\x9f:]/.test(value)||value.startsWith('/'))fail('PATH_DENIED');
 if(!value)return '';
 if(value.split('/').some(p=>!p||p==='.'||p==='..'))fail('PATH_DENIED');
 return value;
}
function relativePath(value,allowRoot=false,platform=process.platform){
 boardRelativePath(value,allowRoot);
 const parts=value.split('/');
 if(parts.some(p=>(platform==='win32'&&/[. ]$/.test(p))||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('PATH_DENIED');
 return value;
}
module.exports={boardRelativePath,relativePath};

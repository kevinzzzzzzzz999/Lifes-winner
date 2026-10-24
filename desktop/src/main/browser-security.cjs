'use strict';
const {fail}=require('./errors.cjs');
const MAX_CLIP_BYTES=12*1024*1024;
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('INVALID_REQUEST');}
function string(value,max){if(typeof value!=='string'||value.length>max||value.includes('\0')||!value.isWellFormed())fail('INVALID_REQUEST');return value;}
function webURL(value){string(value,8192);let url;try{url=new URL(value);}catch{fail('INVALID_REQUEST');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('PERMISSION_DENIED');return url.href;}
function navigationURL(value){string(value,8192);value=value.trim();if(!value)return 'https://www.bing.com/';if(/^[a-z][a-z\d+.-]*:/i.test(value)&&!/^localhost:\d/i.test(value))return webURL(value);if(!/\s/.test(value)&&(/^[^/]+\.[^/]+/.test(value)||/^localhost(?::\d+)?(?:\/|$)/i.test(value)))return webURL('https://'+value);return 'https://www.bing.com/search?q='+encodeURIComponent(value);}
function normalizeClip(value){
 object(value,['format','version','kind','title','url','text','imageDataURL','capturedAt']);
 if(value.format!=='inkspace-clip'||value.version!==1||!['selection','page','link','image','screenshot'].includes(value.kind))fail('INVALID_REQUEST');
 const title=string(value.title,512),url=webURL(value.url),text=string(value.text??'',90000),capturedAt=string(value.capturedAt,64);
 if(!Number.isFinite(Date.parse(capturedAt)))fail('INVALID_REQUEST');
 let imageDataURL;if(value.imageDataURL!==undefined){imageDataURL=string(value.imageDataURL,Math.ceil(8*1024*1024/3)*4+64);if(!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(imageDataURL))fail('INVALID_REQUEST');}
 if(['image','screenshot'].includes(value.kind)&&!imageDataURL)fail('INVALID_REQUEST');
 if(['selection','page'].includes(value.kind)&&!text.trim())fail('INVALID_REQUEST');
 return {format:'inkspace-clip',version:1,kind:value.kind,title:title.trim()||'网页剪藏',url,text,capturedAt,...(imageDataURL?{imageDataURL}:{})};
}
function clipText(clip){return `${clip.title}\n来源：${clip.url}\n剪藏时间：${clip.capturedAt}${clip.text?'\n\n'+clip.text:''}`;}
function fileStem(title){return Array.from(title.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^[. ]+|[. ]+$/g,'')).slice(0,80).join('')||'网页剪藏';}
function extensionSummary(manifest){
 if(!manifest||typeof manifest!=='object'||![2,3].includes(manifest.manifest_version)||typeof manifest.name!=='string'||typeof manifest.version!=='string')fail('INVALID_REQUEST');
 const fields=['permissions','optional_permissions','host_permissions','optional_host_permissions'];
 const permissions=[];for(const field of fields){if(manifest[field]!==undefined&&!Array.isArray(manifest[field]))fail('INVALID_REQUEST');for(const entry of manifest[field]??[]){string(entry,2048);permissions.push(`${field}: ${entry}`);}}
 if(manifest.content_scripts!==undefined&&!Array.isArray(manifest.content_scripts))fail('INVALID_REQUEST');
 for(const script of manifest.content_scripts??[]){if(!script||!Array.isArray(script.matches))fail('INVALID_REQUEST');for(const match of script.matches){string(match,2048);permissions.push(`网页脚本: ${match}`);}}
 if(permissions.length>300)fail('TOO_LARGE');
 return {name:string(manifest.name,256),version:string(manifest.version,128),permissions:[...new Set(permissions)],warnings:[...(manifest.action||manifest.browser_action?['工具栏弹出窗口未集成；网页脚本仍可按兼容 API 运行。']:[]),...(manifest.background?.service_worker?['此扩展含 Manifest V3 后台服务；是否可用取决于 Electron 支持情况。']:[]),'仅支持 Electron 提供的部分扩展 API；不支持直接安装商店 .crx 文件。']};
}
module.exports={MAX_CLIP_BYTES,object,string,webURL,navigationURL,normalizeClip,clipText,fileStem,extensionSummary};

'use strict';
// Return a decision only for app-owned untrusted subframes. The main renderer's
// original network allowlist remains authoritative for every other request.
function embeddedWebRequest(details,mainContents){
 try{
  if(!mainContents||details.webContentsId!==mainContents.id||!details.frame||details.frame===mainContents.mainFrame||details.frame.top!==mainContents.mainFrame)return null;
  let remote=details.resourceType==='subFrame'&&/^https?:/i.test(details.url);
  for(let frame=details.frame;frame&&frame!==mainContents.mainFrame;frame=frame.parent){if(/^https?:/i.test(frame.url)||/^https?:/i.test(frame.origin||'')||frame.origin==='null'){remote=true;break;}}
  if(!remote)return null;
  const url=new URL(details.url);
  return !url.username&&!url.password&&['http:','https:','ws:','wss:','data:','blob:','about:'].includes(url.protocol)&&details.resourceType!=='mainFrame';
 }catch{return false;}
}
module.exports={embeddedWebRequest};

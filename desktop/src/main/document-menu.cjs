'use strict';
function installDocumentMenu({Menu,localized=(en)=>en,onOpenFile,onOpenFolder,applicationName=localized("Life's Winner",'人生赢家'),platform=process.platform}){
 const open=[
  {id:'inkspace-open-file',label:localized('Open file…','打开文件…'),accelerator:'CommandOrControl+O',click:onOpenFile},
  {id:'inkspace-open-folder-window',label:localized('Open folder in new window…','在新窗口中打开文件夹…'),accelerator:'CommandOrControl+Shift+O',click:onOpenFolder},
  {id:'inkspace-open-separator',type:'separator'}
 ];
 const previous=Menu.getApplicationMenu();
 let template;
 if(previous){
  // Rebuild only File. Menu.getApplicationMenu() cannot dynamically add items;
  // keep the other MenuItems intact, including their native default roles.
  template=[...previous.items];
  const index=template.findIndex(item=>String(item.role||'').toLowerCase()==='filemenu'||['File','文件'].includes(String(item.label||'').replace(/&/g,'')));
  if(index>=0){const file=template[index];template[index]={id:file.id||'inkspace-file-menu',label:file.label||localized('File','文件'),enabled:file.enabled,visible:file.visible,submenu:[...open,...(file.submenu?.items||(Array.isArray(file.submenu)?file.submenu:[])).filter(item=>!String(item.id||'').startsWith('inkspace-open-'))]};}
  else template.splice(platform==='darwin'?1:0,0,{label:localized('File','文件'),submenu:[...open,{role:platform==='darwin'?'close':'quit'}]});
 }else template=[...(platform==='darwin'?[{role:'appMenu'}]:[]),{label:localized('File','文件'),submenu:[...open,{role:platform==='darwin'?'close':'quit'}]},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}];
 if(platform==='darwin'){
  let appIndex=template.findIndex(item=>String(item.role||'').toLowerCase()==='appmenu');
  const firstItems=template[0]?.submenu?.items||(Array.isArray(template[0]?.submenu)?template[0].submenu:[]);
  if(appIndex<0&&firstItems.some(item=>String(item.role||'').toLowerCase()==='about'))appIndex=0;
  const original=appIndex>=0?template[appIndex]:{},items=original.submenu?.items||(Array.isArray(original.submenu)?original.submenu:null);
  const labels={about:localized('About '+applicationName,'关于'+applicationName),hide:localized('Hide '+applicationName,'隐藏'+applicationName),quit:localized('Quit '+applicationName,'退出'+applicationName)};
  const submenu=items?items.map(item=>{const label=labels[String(item.role||'').toLowerCase()];return label?{role:item.role,label,id:item.id,enabled:item.enabled,visible:item.visible,accelerator:item.accelerator,click:item.click}:item;}):[
   {role:'about',label:labels.about},{type:'separator'},
   {role:'services',label:localized('Services','服务')},{type:'separator'},
   {role:'hide',label:labels.hide},{role:'hideOthers'},{role:'unhide'},
   {type:'separator'},{role:'quit',label:labels.quit}
  ];
  const branded={role:original.role||'appMenu',label:applicationName,submenu};
  if(appIndex>=0)template[appIndex]=branded;else template.unshift(branded);
 }
 const menu=Menu.buildFromTemplate(template);Menu.setApplicationMenu(menu);return menu;
}
module.exports={installDocumentMenu};

'use strict';
function installDocumentMenu({Menu,localized=(en)=>en,onOpenFile,onOpenFolder,platform=process.platform}){
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
  if(index>=0){const file=template[index];template[index]={id:file.id||'inkspace-file-menu',label:file.label||localized('File','文件'),enabled:file.enabled,visible:file.visible,submenu:[...open,...(file.submenu?.items||[]).filter(item=>!String(item.id||'').startsWith('inkspace-open-'))]};}
  else template.splice(platform==='darwin'?1:0,0,{label:localized('File','文件'),submenu:[...open,{role:platform==='darwin'?'close':'quit'}]});
 }else template=[...(platform==='darwin'?[{role:'appMenu'}]:[]),{label:localized('File','文件'),submenu:[...open,{role:platform==='darwin'?'close':'quit'}]},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}];
 const menu=Menu.buildFromTemplate(template);Menu.setApplicationMenu(menu);return menu;
}
module.exports={installDocumentMenu};

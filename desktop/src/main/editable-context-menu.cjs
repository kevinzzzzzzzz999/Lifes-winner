'use strict';
// Native edit roles follow the focused input's selection and undo stack. The
// canvas/file-tree menus remain renderer-owned because non-editable targets
// never receive a native menu here.
function editableMenuTemplate(params,localized=(en)=>en){
 if(!params?.isEditable)return null;
 const flags=params.editFlags||{};
 const item=(role,flag,en,zh)=>({role,label:localized(en,zh),enabled:flags[flag]===true});
 return[
  item('undo','canUndo','Undo','撤销'),item('redo','canRedo','Redo','重做'),{type:'separator'},
  item('cut','canCut','Cut','剪切'),item('copy','canCopy','Copy','复制'),item('paste','canPaste','Paste','粘贴'),{type:'separator'},
  item('selectAll','canSelectAll','Select All','全选')
 ];
}
function installEditableContextMenu(window,{Menu,localized}){
 const contents=window.webContents;
 const handler=(_event,params)=>{
  const template=editableMenuTemplate(params,localized);
  if(!template||window.isDestroyed()||contents.isDestroyed())return;
  Menu.buildFromTemplate(template).popup({window});
 };
 contents.on('context-menu',handler);
 return()=>{if(!contents.isDestroyed())contents.removeListener('context-menu',handler);};
}
module.exports={editableMenuTemplate,installEditableContextMenu};

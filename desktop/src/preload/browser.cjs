'use strict';
// This bridge exists only on the trusted local controls, never on remote pages.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('browserControls',Object.freeze({
 action:request=>ipcRenderer.invoke('browser:action',request),
 onFocus:callback=>{if(typeof callback!=='function')throw TypeError('Callback required');const receive=(_event,id)=>{if(['address','findText','librarySearch'].includes(id))callback(id);};ipcRenderer.on('browser:focus',receive);return()=>ipcRenderer.removeListener('browser:focus',receive);},
 onState:callback=>{if(typeof callback!=='function')throw TypeError('Callback required');const receive=(_event,state)=>callback(state);ipcRenderer.on('browser:state',receive);return()=>ipcRenderer.removeListener('browser:state',receive);}
}));

'use strict';
// Auxiliary video window: deliberately no readFile/save/vault chooser/AI/Node API.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',Object.freeze({
 getVideoSubtitles:request=>ipcRenderer.invoke('videoWindow:getVideoSubtitles',request),
 saveVideoSubtitles:request=>ipcRenderer.invoke('videoWindow:saveVideoSubtitles',request),
 getVideoUrl:request=>ipcRenderer.invoke('videoWindow:getVideoUrl',request),
 releaseVideoUrl:request=>ipcRenderer.invoke('videoWindow:releaseVideoUrl',request)
}));
contextBridge.exposeInMainWorld('videoWindow',Object.freeze({
 info:()=>ipcRenderer.invoke('videoWindow:info'),
 setPinned:request=>ipcRenderer.invoke('videoWindow:setPinned',request)
}));

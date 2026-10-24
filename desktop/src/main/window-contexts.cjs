'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {fail,publicError}=require('./errors.cjs');
const {validateSender}=require('./security.cjs');

// A request keeps its originating window across awaits. Focus is never authority.
class WindowContexts {
 constructor({devURL,diagnostics}={}){this.devURL=devURL;this.diagnostics=diagnostics;this.windows=new Map();this.storage=new AsyncLocalStorage();this.lastActive=null;}
 add(window,initialVault=null){const context={id:window.webContents.id,window,activeVault:initialVault,grants:new Map(initialVault?[[initialVault.id,initialVault]]:[]),services:new Map(),translationRequests:new Map(),closed:false,dialogBusy:false,boardSpeechBlocker:null,pendingCalendarReminder:null};this.windows.set(context.id,context);this.lastActive=context;return context;}
 alive(context){return !!context&&!context.closed&&!context.window.isDestroyed()&&!context.window.webContents.isDestroyed();}
 current(){const context=this.storage.getStore();if(!this.alive(context))fail('CANCELLED');return context;}
 fromEvent(event){const context=this.windows.get(event.sender?.id);if(!this.alive(context))fail('PERMISSION_DENIED');validateSender(event,context.window.webContents,this.devURL);return context;}
 run(context,operation){if(!this.alive(context))fail('CANCELLED');return this.storage.run(context,operation);}
 invoke(event,value,operation){const context=this.fromEvent(event);if(value&&typeof value==='object'&&typeof value.vaultId==='string'&&!context.grants.has(value.vaultId))fail('PERMISSION_DENIED');return this.run(context,()=>operation(value,context));}
 grant(vault,context=this.current()){if(!this.alive(context))fail('CANCELLED');if(vault)context.grants.set(vault.id,vault);return vault;}
 activate(vaultId,context=this.current()){if(!this.alive(context))fail('CANCELLED');const vault=context.grants.get(vaultId);if(!vault)fail('PERMISSION_DENIED');context.activeVault=vault;return vault;}
 service(name,create,context=this.current()){if(!this.alive(context))fail('CANCELLED');if(!context.services.has(name))context.services.set(name,create(context));return context.services.get(name);}
 send(context,channel,value){if(this.alive(context))context.window.webContents.send(channel,value);}
 focused(){if(this.alive(this.lastActive))return this.lastActive;return [...this.windows.values()].find(context=>this.alive(context))||null;}
 forVault(vaultId){return [...this.windows.values()].find(context=>this.alive(context)&&context.activeVault?.id===vaultId)||null;}
 remove(context){if(context.closed)return;context.closed=true;this.windows.delete(context.id);if(this.lastActive===context)this.lastActive=null;for(const service of [...context.services.values()].reverse()){try{Promise.resolve(service.dispose?.()).catch(error=>this.diagnostics?.record('windowDispose',error));}catch(error){this.diagnostics?.record('windowDispose',error);}}context.services.clear();}
}

// Auxiliary windows keep the existing channel names, but each handler belongs
// to one exact WebContents. Removing one scope cannot unregister another.
class ScopedIPCRouter {
 constructor(ipcMain,{diagnostics}={}){this.ipcMain=ipcMain;this.diagnostics=diagnostics;this.channels=new Map();}
 scope(owns){const key=Symbol('window IPC');return {handle:(channel,handler)=>{let entries=this.channels.get(channel);if(!entries){entries=new Map();this.channels.set(channel,entries);this.ipcMain.handle(channel,async(event,value)=>{try{const match=[...entries.values()].find(entry=>entry.owns(event.sender));if(!match)fail('PERMISSION_DENIED');return await match.handler(event,value);}catch(error){return{ok:false,error:publicError(error)};}});}entries.set(key,{owns,handler});},removeHandler:channel=>{const entries=this.channels.get(channel);if(!entries)return;entries.delete(key);if(!entries.size){this.channels.delete(channel);this.ipcMain.removeHandler(channel);}}};}
}
module.exports={WindowContexts,ScopedIPCRouter};

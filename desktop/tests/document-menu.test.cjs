'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {installDocumentMenu}=require('../src/main/document-menu.cjs');
function fakeMenu(previous=null){return {getApplicationMenu:()=>previous,buildFromTemplate:items=>({items}),setApplicationMenu:menu=>{previous=menu;}};}
test('native Open commands retain the existing app, edit, view, window and File actions',()=>{
 const app={role:'appMenu'},edit={role:'editMenu'},view={role:'viewMenu'},window={role:'windowMenu'},close={role:'close'},help={role:'help'};
 const Menu=fakeMenu({items:[app,{label:'File',enabled:true,visible:true,submenu:{items:[close]}},edit,view,window,help]});
 let opened=0,folder=0;const menu=installDocumentMenu({Menu,platform:'darwin',onOpenFile:()=>opened++,onOpenFolder:()=>folder++});
 assert.equal(menu.items[0].role,app.role);assert.equal(menu.items[0].label,"Life's Winner");assert.equal(menu.items[2],edit);assert.equal(menu.items[3],view);assert.equal(menu.items[4],window);assert.equal(menu.items[5],help);
 const file=menu.items[1].submenu;assert.equal(file.at(-1),close);assert.equal(file[0].accelerator,'CommandOrControl+O');assert.equal(file[1].accelerator,'CommandOrControl+Shift+O');file[0].click();file[1].click();assert.equal(opened,1);assert.equal(folder,1);
});
test('a missing default menu receives standard native roles alongside the Open commands',()=>{
 const menu=installDocumentMenu({Menu:fakeMenu(),platform:'darwin',onOpenFile:()=>{},onOpenFolder:()=>{}});
 assert.deepEqual(menu.items.filter(item=>item.role).map(item=>item.role),['appMenu','editMenu','viewMenu','windowMenu']);assert.equal(menu.items[1].submenu.at(-1).role,'close');
});

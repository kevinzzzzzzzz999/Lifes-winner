'use strict';
const ENGLISH_BRAND="Life's Winner",CHINESE_BRAND='人生赢家';
const languageOverrides=new WeakMap(),frozenPaths=new WeakMap();
const isChinese=locale=>String(locale||'').toLowerCase().startsWith('zh');
const displayBrand=locale=>isChinese(locale)?CHINESE_BRAND:ENGLISH_BRAND;
const appLocale=app=>languageOverrides.get(app)||(typeof app.getLocale==='function'?app.getLocale():'en');
function freezeApplicationPaths(app){
 if(frozenPaths.has(app))return frozenPaths.get(app);
 // app.setName changes Electron's default profile paths. Resolve and explicitly
 // pin the existing locations first, including the persistent web-session root.
 const paths={userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),logs:app.getPath('logs')};
 for(const[key,value]of Object.entries(paths))app.setPath(key,value);
 frozenPaths.set(app,Object.freeze({...paths}));return paths;
}
function applyApplicationBrand(app,language){
 if(language!==undefined&&!['zh','en'].includes(language))throw new TypeError('Expected zh or en.');
 const paths=freezeApplicationPaths(app);if(language!==undefined)languageOverrides.set(app,language);
 const name=displayBrand(appLocale(app));app.setName(name);app.setAboutPanelOptions?.({applicationName:name,applicationVersion:app.getVersion(),copyright:name});
 for(const[key,value]of Object.entries(paths))if(app.getPath(key)!==value)throw Error('Application profile path changed while updating display name.');
 return{name,language:isChinese(appLocale(app))?'zh':'en',paths:{...paths}};
}
module.exports={ENGLISH_BRAND,CHINESE_BRAND,displayBrand,appLocale,isChinese,freezeApplicationPaths,applyApplicationBrand};

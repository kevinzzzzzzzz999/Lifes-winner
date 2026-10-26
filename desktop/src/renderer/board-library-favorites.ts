export type LibraryConfig={presetID:string;title:string;colors:{background:string;accent:string;text:string};width:number;height:number;addPin:boolean;addPrintFrame:boolean};
export type LibraryFavorite={id:string;name:string;config:LibraryConfig};
export type LibraryFavorites={version:1;favorites:LibraryFavorite[]};
export const BOARD_LIBRARY_KEY='inkspace.board-library.favorites.v1';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function validLibraryConfig(v:unknown,presetIDs:ReadonlySet<string>):v is LibraryConfig{
 if(!object(v)||Object.keys(v).some(k=>!['presetID','title','colors','width','height','addPin','addPrintFrame'].includes(k))||typeof v.presetID!=='string'||!presetIDs.has(v.presetID)||typeof v.title!=='string'||v.title.length>120||v.title.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v.title)||!object(v.colors)||Object.keys(v.colors).some(k=>!['background','accent','text'].includes(k)))return false;
 return['background','accent','text'].every(k=>typeof (v.colors as Record<string,unknown>)[k]==='string'&&/^#[0-9a-f]{6}$/i.test(String((v.colors as Record<string,unknown>)[k])))&&['width','height'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&Number(v[k])>=160&&Number(v[k])<=20000)&&typeof v.addPin==='boolean'&&typeof v.addPrintFrame==='boolean';
}
export function parseLibraryFavorites(raw:string|null,presetIDs:ReadonlySet<string>):LibraryFavorites{
 if(raw===null)return{version:1,favorites:[]};if(raw.length>256*1024)throw Error('Library favorites exceed the local limit. Original data was kept.');const v=JSON.parse(raw);if(!object(v)||v.version!==1||Object.keys(v).some(k=>!['version','favorites'].includes(k))||!Array.isArray(v.favorites)||v.favorites.length>50)throw Error('Library favorites are unavailable. Original data was kept.');const ids=new Set<string>();for(const f of v.favorites){if(!object(f)||Object.keys(f).some(k=>!['id','name','config'].includes(k))||typeof f.id!=='string'||!/^[a-f0-9-]{36}$/i.test(f.id)||ids.has(f.id.toLowerCase())||typeof f.name!=='string'||!f.name.trim()||f.name.length>60||!validLibraryConfig(f.config,presetIDs))throw Error('Invalid library favorite. Original data was kept.');ids.add(f.id.toLowerCase());}return v as LibraryFavorites;
}

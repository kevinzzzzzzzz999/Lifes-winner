'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {fail}=require('./errors.cjs');
const absolute=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0')&&path.isAbsolute(value)&&path.resolve(value)===value;
const validBirth=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
function validIdentity(v){return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['root','dev','ino','birthtimeMs'].includes(k))&&absolute(v.root)&&Number.isSafeInteger(v.dev)&&v.dev>=0&&Number.isSafeInteger(v.ino)&&v.ino>=0&&(v.birthtimeMs===undefined||validBirth(v.birthtimeMs));}
function identity(entry){return {root:entry.canonicalPath,dev:entry.dev,ino:entry.ino,...(entry.birthtimeMs!==undefined?{birthtimeMs:entry.birthtimeMs}:{})};}
function samePhysical(a,b){return a.dev===b.dev&&a.ino===b.ino&&(a.birthtimeMs===undefined||b.birthtimeMs===undefined||a.birthtimeMs===b.birthtimeMs);}
function sameLocation(a,b){return a.root===b.root&&samePhysical(a,b);}
async function inspect(selectedPath){if(typeof selectedPath!=='string'||!absolute(selectedPath))fail('INVALID_REQUEST');const root=await fs.realpath(selectedPath),st=await fs.lstat(root);if(st.isSymbolicLink()||!st.isDirectory()||!Number.isSafeInteger(st.dev)||!Number.isSafeInteger(st.ino))fail('PATH_DENIED');return {root,dev:st.dev,ino:st.ino,...(validBirth(st.birthtimeMs)?{birthtimeMs:st.birthtimeMs}:{})};}
function relocatedEntry(entry,selectedPath,candidate,now=new Date().toISOString()){
 const before=identity(entry),previous=[...(entry.previousIdentities||[])];if(!sameLocation(before,candidate)&&!previous.some(x=>sameLocation(x,before)))previous.push(before);if(previous.length>32)fail('TOO_LARGE');
 return {...entry,name:path.basename(candidate.root)||candidate.root,selectedPath:path.resolve(selectedPath),canonicalPath:candidate.root,dev:candidate.dev,ino:candidate.ino,...(candidate.birthtimeMs!==undefined?{birthtimeMs:candidate.birthtimeMs}:{}),historyRoot:entry.historyRoot||entry.canonicalPath,previousIdentities:previous,lastOpenedAt:now};
}
module.exports={absolute,validBirth,validIdentity,identity,samePhysical,sameLocation,inspect,relocatedEntry};

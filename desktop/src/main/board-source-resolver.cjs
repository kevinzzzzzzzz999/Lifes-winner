'use strict';
// Read-only compatibility for references belonging to one saved board. The
// general vault resolver and every stored path keep their original meaning.
const path=require('node:path');
const {fail}=require('./errors.cjs');
const {relativePath}=require('./vault-path.cjs');
const {validateBoard}=require('./board-validation.cjs');
const {walkFile,same}=require('./exchange-stream.cjs');
const SHA=/^[a-f0-9]{64}$/i,ZERO='0'.repeat(64);
const LIMITS=Object.freeze({sourceBytes:8*1024*1024*1024,timeoutMs:60000,boards:8,fingerprints:128,concurrentHashes:4,waitingHashes:32,candidates:64});
const stores=new WeakMap();
function state(vaults){let value=stores.get(vaults);if(!value){value={boards:new Map(),fingerprints:new Map(),hashes:0,waiters:new Set()};stores.set(vaults,value);}return value;}
const oneNoteAsset=value=>/^\.inkspace-assets\/onenote\/[a-f0-9]{64}\/continuous\.pdf$/.test(value);
function publicPath(value){relativePath(value);if(value.split('/').some(part=>part.startsWith('.'))&&!oneNoteAsset(value))fail('PATH_DENIED');return value;}
function requestFields(request){if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['vaultId','boardPath','expectedBoardSHA256','sourcePath'].includes(key))||typeof request.vaultId!=='string'||!SHA.test(request.expectedBoardSHA256||''))fail('INVALID_REQUEST');publicPath(request.boardPath);publicPath(request.sourcePath);if(!request.boardPath.toLowerCase().endsWith('.inkspace.json'))fail('INVALID_REQUEST');}
function abort(signal){if(signal?.aborted)fail('CANCELLED');}
function retain(map,key,value,limit){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value);return value;}
function references(board){
 validateBoard(board);const paths=new Map();
 const add=(value,sha)=>{if(value==null)return;publicPath(value);let expected=paths.get(value);if(!expected){expected=new Set();paths.set(value,expected);}if(sha!=null){if(typeof sha!=='string'||!SHA.test(sha))fail('INVALID_BOARD');if(sha.toLowerCase()!==ZERO)expected.add(sha.toLowerCase());}};
 for(const item of board.items){
  add(item.sourcePath);add(item.originalSourcePath,item.originalSourceSHA256);
  if(item.sourceReference!=null){require('./board-elements.cjs').validateSourceReference(item.sourceReference);add(item.sourceReference.path,item.sourceReference.sourceSHA256);}
  for(const child of item.childBoards||[])add(child.path);
 }
 for(const source of board.pdfAnnotationSources||[])add(source.sourcePath,source.sha256);
 if(board.pdfOwnedSourcePaths!=null){if(!Array.isArray(board.pdfOwnedSourcePaths)||board.pdfOwnedSourcePaths.length>100000)fail('INVALID_BOARD');for(const source of board.pdfOwnedSourcePaths)add(source);}
 return paths;
}
async function boardIndex(vaults,request){
 const held=await vaults.resolve(request.vaultId,request.boardPath),store=state(vaults),key=JSON.stringify([request.vaultId,request.boardPath,request.expectedBoardSHA256.toLowerCase()]);
 const cached=store.boards.get(key);if(cached&&cached.full===held.full&&same(cached.stat,held.stat)){retain(store.boards,key,cached,LIMITS.boards);return{...held,paths:await cached.paths};}
 // readFile reuses the existing bounded board-byte cache and validates JSON.
 const entry={full:held.full,stat:held.stat,paths:Promise.resolve().then(async()=>{const opened=await vaults.readFile({vaultId:request.vaultId,path:request.boardPath});if(opened.kind!=='board'||opened.sha256!==request.expectedBoardSHA256.toLowerCase())fail('CONFLICT');const paths=references(opened.board),latest=await vaults.resolve(request.vaultId,request.boardPath);if(latest.full!==held.full||!same(latest.stat,held.stat))fail('CONFLICT');return paths;})};
 retain(store.boards,key,entry,LIMITS.boards);void entry.paths.catch(()=>{if(store.boards.get(key)===entry)store.boards.delete(key);});return{...held,paths:await entry.paths};
}
async function slot(store,signal){
 abort(signal);
 if(store.hashes<LIMITS.concurrentHashes){store.hashes++;return;}
 if(store.waiters.size>=LIMITS.waitingHashes)fail('BUSY');
 await new Promise((resolve,reject)=>{const stop=()=>{store.waiters.delete(wake);signal?.removeEventListener('abort',stop);try{fail('CANCELLED');}catch(error){reject(error);}};const wake=()=>{if(store.hashes>=LIMITS.concurrentHashes)return;store.waiters.delete(wake);signal?.removeEventListener('abort',stop);store.hashes++;resolve();};store.waiters.add(wake);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();});
}
async function fingerprint(vaults,vaultId,rel,resolved,signal,maxBytes){
 if(resolved.stat.size>maxBytes)fail('TOO_LARGE');const store=state(vaults),key=JSON.stringify([vaultId,rel]);
 const cached=store.fingerprints.get(key);if(cached&&cached.full===resolved.full&&same(cached.stat,resolved.stat)){retain(store.fingerprints,key,cached,LIMITS.fingerprints);return cached.sha256;}
 await slot(store,signal);
 try{
  abort(signal);const already=store.fingerprints.get(key);if(already&&already.full===resolved.full&&same(already.stat,resolved.stat))return already.sha256;
  const checked=await walkFile(resolved.full,{maxBytes,expected:resolved.stat,signal}),latest=await vaults.resolve(vaultId,rel);
  if(latest.full!==resolved.full||!same(latest.stat,checked.stat))fail('CONFLICT');
  retain(store.fingerprints,key,{full:latest.full,stat:latest.stat,sha256:checked.sha256},LIMITS.fingerprints);return checked.sha256;
 }finally{store.hashes--;for(const wake of store.waiters){wake();if(store.hashes>=LIMITS.concurrentHashes)break;}}
}
async function inspect(vaults,request,paths,{signal,maxSourceBytes=LIMITS.sourceBytes}={}){
 abort(signal);const expected=paths.get(request.sourcePath);if(!expected)fail('PATH_DENIED');
 const verify=async(rel,match,resolved)=>{abort(signal);const known=expected.size>0;let sha256;if(known){sha256=await fingerprint(vaults,request.vaultId,rel,resolved,signal,Math.min(LIMITS.sourceBytes,maxSourceBytes));if(!expected.has(sha256))fail('CONFLICT');}abort(signal);const latest=await vaults.resolve(request.vaultId,rel);if(latest.full!==resolved.full||!same(latest.stat,resolved.stat))fail('CONFLICT');return{path:rel,match,fingerprintMatched:known,...(sha256?{sha256}:{})};};
 let direct;try{direct=await vaults.resolve(request.vaultId,request.sourcePath);}catch(error){if(error.code!=='ENOENT')throw error;}
 // The original namespace remains authoritative even after legitimate source
 // edits. Existing PDF provenance/version handling decides how to show them.
 if(direct){abort(signal);return{path:request.sourcePath,match:'direct',fingerprintMatched:false};}
 // Program assets have one exact vault-root namespace. A missing derivative
 // cannot fall back to a similarly named hidden folder beside another board.
 if(oneNoteAsset(request.sourcePath))fail('NOT_FOUND');
 if(expected.size>1)fail('CONFLICT');
 const root=await vaults.root(request.vaultId),prefix=path.basename(root)+'/',parent=path.posix.dirname(request.boardPath),candidates=new Map();
 const addCandidate=(candidate,match)=>{publicPath(candidate);if(candidates.has(candidate))return;if(candidates.size>=LIMITS.candidates)fail('TOO_LARGE');candidates.set(candidate,match);};
 if(request.sourcePath.startsWith(prefix)){const candidate=request.sourcePath.slice(prefix.length);if(candidate)addCandidate(candidate,'root-prefix');}
 // A board may be opened from a course, term, or study-folder root. Probe only
 // exact paths formed from its own ancestor prefixes inside the granted root;
 // never enumerate names or leave the vault. All matches still compete below.
 if(parent!=='.'){
  const parts=parent.split('/');if(parts.length>LIMITS.candidates)fail('TOO_LARGE');
  for(let depth=parts.length;depth>0;depth--)addCandidate(parts.slice(0,depth).join('/')+'/'+request.sourcePath,'board-relative');
 }
 const found=[];
 for(const [candidate,match] of candidates){abort(signal);try{found.push({path:candidate,match,resolved:await vaults.resolve(request.vaultId,candidate)});}catch(error){if(error.code!=='ENOENT')throw error;}}
 if(!found.length)fail('NOT_FOUND');if(found.length!==1)fail('CONFLICT');
 const chosen=found[0],result=await verify(chosen.path,chosen.match,chosen.resolved);
 for(const candidate of candidates.keys())if(candidate!==chosen.path){try{await vaults.resolve(request.vaultId,candidate);}catch(error){if(error.code==='ENOENT')continue;throw error;}fail('CONFLICT');}
 // A direct file appearing during the fallback probe always requires a retry.
 try{await vaults.resolve(request.vaultId,request.sourcePath);}catch(error){if(error.code==='ENOENT')return result;throw error;}
 fail('CONFLICT');
}
async function bounded(options,work){
 const controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;let timedOut=false,stop;
 const timeout=Number.isFinite(options.timeoutMs)?Math.max(1,Math.min(LIMITS.timeoutMs,options.timeoutMs)):LIMITS.timeoutMs;
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
 const interrupted=new Promise((_,reject)=>{stop=()=>{try{fail(timedOut?'FILE_SCAN_TIMEOUT':'CANCELLED');}catch(error){reject(error);}};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
 const operation=Promise.resolve().then(()=>{abort(signal);return work(signal);});void operation.catch(()=>{});
 try{return await Promise.race([operation,interrupted]);}catch(error){if(timedOut)fail('FILE_SCAN_TIMEOUT');throw error;}finally{clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
}
async function resolveBoardSource(vaults,request,options={}){
 requestFields(request);return bounded(options,async signal=>{const index=await boardIndex(vaults,request);abort(signal);const result=await inspect(vaults,request,index.paths,{...options,signal});const current=await vaults.resolve(request.vaultId,request.boardPath);if(current.full!==index.full||!same(current.stat,index.stat))fail('CONFLICT');return result;});
}
// Internal board mutations already hold their own validated snapshot and CAS.
async function resolveSourceInBoard(vaults,request,board,options={}){requestFields(request);return bounded(options,signal=>inspect(vaults,request,references(board),{...options,signal}));}
module.exports={resolveBoardSource,resolveSourceInBoard,LIMITS};

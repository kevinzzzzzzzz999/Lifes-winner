import type {OpenedFile} from '../shared/desktop-api';

/** Resolve a board reference inside the granted vault. The stored board remains
 * unchanged; callers open/edit the canonical result through the usual APIs. */
export function createBoardSourceResolver(vaultId:string,boardPath?:string,boardSHA256?:string){
 const cache=new Map<string,Promise<string>>();
 return (sourcePath:string):Promise<string>=>{
  if(!boardPath||!boardSHA256||!window.desktop.resolveBoardSource)return Promise.resolve(sourcePath);
  const held=cache.get(sourcePath);if(held)return held;
  const request=window.desktop.resolveBoardSource({vaultId,boardPath,expectedBoardSHA256:boardSHA256,sourcePath}).then(result=>{
   if(!result.ok)throw Error(result.error.message||'无法定位白板资料，请检查资料文件夹。');
   return result.value.path;
  });
  cache.set(sourcePath,request);
  if(cache.size>512)cache.delete(cache.keys().next().value!);
  void request.catch(()=>{if(cache.get(sourcePath)===request)cache.delete(sourcePath);});
  return request;
 };
}

export const boardFileSourceResolver=(vaultId:string,file:OpenedFile)=>createBoardSourceResolver(vaultId,file.path,file.sha256);

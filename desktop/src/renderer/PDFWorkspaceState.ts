// Synchronous scope registration keeps navigation/refresh guards ahead of React effects.
const scopes = new Map<string, {vaultId:string;path:string;busy:boolean}>();
export function setPDFWorkspaceBusy(id:string,vaultId:string,path:string,busy:boolean){const changed=scopes.get(id)?.busy!==busy;scopes.set(id,{vaultId,path,busy});if(changed)window.dispatchEvent(new Event('inkspace-pdf-workspace-busy'));}
export function clearPDFWorkspaceScope(id:string){const busy=scopes.get(id)?.busy;scopes.delete(id);if(busy)window.dispatchEvent(new Event('inkspace-pdf-workspace-busy'));}
export function pdfWorkspaceBusy(vaultId?:string,path?:string){return [...scopes.values()].some(s=>s.busy&&(!vaultId||s.vaultId===vaultId)&&(!path||s.path===path));}

/** Finder activates an existing tab even if a read raced a local edit. */
export function retainExternalTab<T extends {vaultId:string;file:{path:string}}>(tabs:T[],loaded:T):T[]{
 return tabs.some(tab=>tab.vaultId===loaded.vaultId&&tab.file.path===loaded.file.path)?tabs:[...tabs,loaded];
}

type SaveableTab = {vaultId:string;file:{path:string};dirty:boolean};

// A conflict in one document must not prevent unrelated drafts from saving.
// Read each draft just before its turn: an earlier save can take long enough for
// a later tab to be edited, closed, or saved by the user.
export async function autosaveTabs<T extends SaveableTab>(readTabs:()=>readonly T[],save:(tab:T)=>Promise<boolean>):Promise<void>{
 const pending=readTabs().filter(tab=>tab.dirty).map(tab=>({vaultId:tab.vaultId,path:tab.file.path}));
 let failed=false,firstError:unknown;
 for(const key of pending){
  const latest=readTabs().find(tab=>tab.vaultId===key.vaultId&&tab.file.path===key.path);
  if(!latest?.dirty)continue;
  try{await save(latest);}catch(error){if(!failed){failed=true;firstError=error;}}
 }
 // Keep the existing visible error and dirty/retry behavior after trying all tabs.
 if(failed)throw firstError;
}

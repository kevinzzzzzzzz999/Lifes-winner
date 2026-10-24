import type {OpenedFile} from '../shared/desktop-api';
type BoardTab={vaultId:string;file:OpenedFile;draft:string;dirty:boolean};
/** Only the unchanged merged snapshot is eligible for transaction-wide undo. */
export function boardMergeUndoState<T extends BoardTab>(tabs:T[],vaultId:string,result:OpenedFile):'closed'|'changed'|'ready'{
 const current=tabs.find(tab=>tab.vaultId===vaultId&&tab.file.path===result.path);
 if(!current)return 'closed';
 return current.dirty||current.file.sha256!==result.sha256||current.draft!==JSON.stringify(result.board)?'changed':'ready';
}
/** Accept disk success only while the destination editor is still the snapshot
 * inspected before the operation. A late edit or closed tab is kept intact. */
export function acceptBoardMergeResult<T extends BoardTab>(tabs:T[],vaultId:string,expected:OpenedFile,observed:{draft:string}|null,result:OpenedFile):{tabs:T[];accepted:boolean}{
 const current=tabs.find(tab=>tab.vaultId===vaultId&&tab.file.path===expected.path);
 if((!current&&observed)||(current&&(current.dirty||current.file.sha256!==expected.sha256||current.draft!==(observed?.draft??JSON.stringify(expected.board)))))return{tabs,accepted:false};
 const next={...(current||{}),vaultId,file:result,draft:JSON.stringify(result.board),dirty:false} as T;
 return{tabs:[...tabs.filter(tab=>!(tab.vaultId===vaultId&&tab.file.path===expected.path)),next],accepted:true};
}

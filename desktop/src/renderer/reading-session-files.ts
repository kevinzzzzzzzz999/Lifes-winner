import type {OpenedFile} from '../shared/desktop-api';
import type {ReadingWorkspacePane,ReadingWorkspaceSession} from './reading-session';

type ReadingFileMove={from:string;to:string};

/** Remap only a successful file-management operation's affected reading state.
 * Reloaded files are keyed by their new vault-relative paths: asset URLs retain
 * the old path internally and must never be carried across a move. */
export function remapReadingWorkspace(session:ReadingWorkspaceSession,moves:readonly ReadingFileMove[],removed:readonly string[],reloadedFiles?:ReadonlyMap<string,OpenedFile>):ReadingWorkspaceSession|undefined{
 const ordered=moves.filter(move=>move.from&&move.to&&move.from!==move.to).slice().sort((a,b)=>b.from.length-a.from.length);
 const deleted=removed.filter(Boolean),within=(value:string,parent:string)=>value===parent||value.startsWith(parent+'/');
 const isRemoved=(value:string)=>deleted.some(parent=>within(value,parent));
 const mapPath=(value:string)=>{const move=ordered.find(move=>within(value,move.from));return move?move.to+value.slice(move.from.length):value;};
 const affected=(value:string)=>isRemoved(value)||mapPath(value)!==value;
 if(isRemoved(session.primaryPath))return;
 if(!affected(session.primaryPath)&&!session.panes.some(pane=>affected(pane.file?.path||pane.video?.path||pane.copy?.path||''))&&!Object.entries(session.copies).some(([path,copy])=>affected(path)||affected(copy.path)))return session;
 const remapCopy=(copy:NonNullable<ReadingWorkspacePane['copy']>)=>{if(isRemoved(copy.path))return;const path=mapPath(copy.path);return path===copy.path?copy:{...copy,path,sourceName:path.split('/').at(-1)||copy.sourceName};};
 const panes:ReadingWorkspacePane[]=[];
 for(const pane of session.panes){
  if(pane.file){
   if(isRemoved(pane.file.path))continue;
   const path=mapPath(pane.file.path);
   if(path===pane.file.path){panes.push(pane);continue;}
   const file=reloadedFiles?.get(path);
   if(!file||file.path!==path||file.kind!==pane.file.kind)continue;
   if(file.sha256===pane.file.sha256){panes.push({...pane,file});continue;}
   const {scroll:_,view,...rest}=pane;
   if(!view){panes.push({...rest,file});continue;}
   const {scrollTop:__,scrollLeft:___,pageOffset:____,...retainedView}=view;
   panes.push({...rest,file,view:retainedView});
  }else if(pane.video){
   if(isRemoved(pane.video.path))continue;
   const path=mapPath(pane.video.path);
   panes.push(path===pane.video.path?pane:{...pane,video:{...pane.video,path,name:path.split('/').at(-1)||pane.video.name}});
  }else if(pane.copy){const copy=remapCopy(pane.copy);if(copy)panes.push(copy===pane.copy?pane:{...pane,copy});}
  else panes.push(pane);
 }
 // A failed primary reload must not promote another file into the primary role.
 if(!panes.some(pane=>pane.id===session.firstId))return;
 const copies=Object.fromEntries(Object.entries(session.copies).flatMap(([key,copy])=>{if(isRemoved(key))return[];const next=remapCopy(copy);return next?[[mapPath(key),next]]:[];}));
 return {...session,primaryPath:mapPath(session.primaryPath),panes,copies};
}

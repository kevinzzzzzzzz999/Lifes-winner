import type {OpenedFile} from '../shared/desktop-api';
import type {VideoPlaybackState} from '../shared/video-playback';
import type {PDFReaderState} from './PDFViewer';
import type {TranslationCopy} from './PDFRangeTranslation';

export type ReadingScrollState={top:number;left:number};
export type ReadingWorkspacePane={id:string;editorMode?:'read'|'edit';editorScroll?:ReadingScrollState;file?:OpenedFile;video?:{path:string;name:string;playback?:VideoPlaybackState};copy?:TranslationCopy;navigation?:{page:number;nonce:number};view?:PDFReaderState;scroll?:ReadingScrollState};
/** A tab-owned, memory-only snapshot. File/translation payloads are referenced,
 * never cloned; the owner must release this value when its tab or vault closes. */
export type ReadingWorkspaceSession={vaultId:string;primaryPath:string;firstId:string;panes:ReadingWorkspacePane[];ratio:number;copies:Record<string,TranslationCopy>;initialPage?:number};

export const readingScroll=(top:number,left:number):ReadingScrollState=>({top:Number.isFinite(top)?Math.max(0,top):0,left:Number.isFinite(left)?Math.max(0,left):0});
const stoppedCopy=(copy:TranslationCopy)=>copy.status==='running'?{...copy,status:'cancelled' as const}:copy;
export function restoreReadingWorkspace(session:ReadingWorkspaceSession|undefined,vaultId:string,primaryPath:string,file?:OpenedFile,initialPage?:number):ReadingWorkspaceSession|undefined{
 if(!session||session.vaultId!==vaultId||session.primaryPath!==primaryPath||!session.firstId||session.panes.length<1||session.panes.length>2||new Set(session.panes.map(p=>p.id)).size!==session.panes.length||!session.panes.some(p=>p.id===session.firstId))return;
 const copies=Object.fromEntries(Object.entries(session.copies).map(([path,copy])=>[path,stoppedCopy(copy)]));
 const panes=session.panes.map(p=>{
  // Navigation is a one-shot request; the stored reader view already includes it.
  const {navigation:_,...pane}=p;
  const updated=pane.file?.path===file?.path&&file?{...pane,file}:pane;
  const next=updated.copy?{...updated,copy:stoppedCopy(updated.copy)}:updated;
  if(next.id!==session.firstId||!next.view)return next;
  const changedPage=initialPage!==undefined&&initialPage!==session.initialPage;
  const changedSource=!!file&&p.file?.path===file.path&&p.file.sha256!==file.sha256;
  if(!changedPage&&!changedSource)return next;
  const {scrollTop:__,scrollLeft:___,pageOffset:____,...view}=next.view;
  return {...next,view:{...view,page:changedPage?Math.max(1,Math.floor(initialPage!)):view.page}};
 });
 return {...session,panes,copies,ratio:Number.isFinite(session.ratio)?Math.max(.25,Math.min(.75,session.ratio)):.5,initialPage};
}

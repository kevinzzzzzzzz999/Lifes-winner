import type {OpenedFile} from '../shared/desktop-api';
import type {CourseWorkspaceLayout,CourseWorkspaceReading,CourseWorkspacePane} from '../shared/course-workspaces';
import type {ReadingWorkspaceSession} from './reading-session';
export const workspaceSessionKey=(vaultId:string,path:string)=>JSON.stringify([vaultId,path]);
/** Persist only explicitly allowed view coordinates. Files, editable drafts,
 * translations, execution state, audio and authentication never enter this DTO. */
export function captureWorkspaceReading(session:ReadingWorkspaceSession|undefined):CourseWorkspaceReading|undefined{
 if(!session)return;const panes:CourseWorkspacePane[]=[];
 for(const p of session.panes){const path=p.file?.path||p.video?.path;if(!path)continue;
  const next:CourseWorkspacePane={id:p.id,kind:p.file?'file':'video',path,...(p.file?{sourceSHA256:p.file.sha256}:{})};
  if(p.editorMode)next.editorMode=p.editorMode;
  if(p.view){const v=p.view;next.view={page:v.page,count:v.count,zoom:v.zoom,mode:v.mode};for(const key of ['scrollTop','scrollLeft','pageOffset'] as const)if(Number.isFinite(v[key]))next.view[key]=v[key];}
  if(p.scroll)next.scroll={top:p.scroll.top,left:p.scroll.left};if(p.editorScroll)next.editorScroll={top:p.editorScroll.top,left:p.editorScroll.left};panes.push(next);
 }
 if(!panes.some(p=>p.path===session.primaryPath))panes.unshift({id:crypto.randomUUID(),kind:'file',path:session.primaryPath});
 const retained=panes.slice(0,2),firstId=retained.some(p=>p.id===session.firstId)?session.firstId:retained.find(p=>p.path===session.primaryPath)!.id;
 return{primaryPath:session.primaryPath,firstId,ratio:Math.max(.25,Math.min(.75,session.ratio)),panes:retained,...(session.initialPage!==undefined?{initialPage:session.initialPage}:{})};
}
export function hydrateWorkspaceReading(saved:CourseWorkspaceReading,vaultId:string,files:Map<string,OpenedFile>):ReadingWorkspaceSession{
 const panes=saved.panes.map(p=>{const file=files.get(p.path);if(!file)throw Error('Workspace file is missing: '+p.path);let view=p.view?{...p.view}:undefined,scroll=p.scroll,editorScroll=p.editorScroll;
  // Source changes invalidate absolute offsets, not the user's page/zoom choice.
  if(p.sourceSHA256&&p.sourceSHA256!==file.sha256){if(view){const{scrollTop:_,scrollLeft:__,pageOffset:___,...stable}=view;view=stable;}scroll=undefined;editorScroll=undefined;}
  return{id:p.id,...(p.kind==='video'?{video:{path:p.path,name:file.name}}:{file}),editorMode:p.editorMode,view,scroll,editorScroll};
 });return{vaultId,primaryPath:saved.primaryPath,firstId:saved.firstId,ratio:saved.ratio,panes,copies:{},initialPage:saved.initialPage};
}
export async function prepareCourseWorkspace<T extends {file:OpenedFile}>(layout:CourseWorkspaceLayout,read:(path:string)=>Promise<T>,stillCurrent:()=>boolean):Promise<{loaded:Map<string,T>}>{
 const paths=new Set<string>();for(const tab of layout.tabs){paths.add(tab.path);for(const pane of tab.reading?.panes||[])paths.add(pane.path);}
 const loaded=new Map<string,T>();
 // Bound concurrent IO; keep the old UI intact until every file is readable.
 const queue=[...paths];let cursor=0;await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(cursor<queue.length){if(!stillCurrent())throw Error('Workspace restore cancelled; current edits were kept.');const path=queue[cursor++];try{loaded.set(path,await read(path));}catch(e){throw Error(path+' · '+(e instanceof Error?e.message:String(e)));}}}));
 if(!stillCurrent())throw Error('Workspace restore cancelled; current edits were kept.');return{loaded};
}

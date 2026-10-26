import {useEffect,useRef} from 'react';
export type WorkspaceSurfacePosition={editor?:{top:number;left:number};preview?:{top:number;left:number}};
/** Ordinary editor/preview view metadata. Split readers own their separate
 * reading-session coordinates. Nothing from the document is serialized. */
export function useWorkspacePositions(vaultId:string|undefined,path:string|null,presentation:string,revision:number,generation:{current:number}){
 const positions=useRef(new Map<string,WorkspaceSurfacePosition>());
 useEffect(()=>{
  if(!vaultId||!path)return;const key=JSON.stringify([vaultId,path]),born=generation.current,root=document.querySelector<HTMLElement>('.main-content');if(!root||root.querySelector('.pdf-workspace-pane'))return;
  const nodes:{editor:HTMLElement|null;preview:HTMLElement|null}={editor:null,preview:null},saved=positions.current.get(key),pending=new Set<keyof WorkspaceSurfacePosition>();for(const kind of ['editor','preview'] as const)if(saved?.[kind])pending.add(kind);
  let restoreFrame=0;const current=()=>generation.current===born;
  const restore=()=>{if(!current())return;for(const kind of [...pending]){const n=nodes[kind],value=saved?.[kind];if(!n||!value)continue;n.scrollTop=value.top;n.scrollLeft=value.left;// Keep the target through CodeMirror's initial virtual-height measurement.
}};
  const locate=()=>{const found={editor:root.querySelector<HTMLElement>('.notebook-workspace,.document-sheet-scroll,.cm-scroller'),preview:root.querySelector<HTMLElement>('.document-preview,.data-html-preview,.data-csv-preview')};for(const kind of ['editor','preview'] as const)if(nodes[kind]!==found[kind]){nodes[kind]?.removeEventListener('scroll',publish);nodes[kind]=found[kind];nodes[kind]?.addEventListener('scroll',publish,{passive:true});if(nodes[kind]){sizes.observe(nodes[kind]!);if(nodes[kind]!.firstElementChild)sizes.observe(nodes[kind]!.firstElementChild!);}}restore();};
  const publish=()=>{if(!current())return;if(pending.size){cancelAnimationFrame(restoreFrame);restoreFrame=requestAnimationFrame(restore);}const next={...positions.current.get(key)};for(const kind of ['editor','preview'] as const){const n=nodes[kind];if(n&&!pending.has(kind))next[kind]={top:Math.max(0,n.scrollTop),left:Math.max(0,n.scrollLeft)};}positions.current.set(key,next);};
  const capture=()=>{locate();publish();},interrupt=()=>{pending.clear();publish();};
  const sizes=new ResizeObserver(restore);root.addEventListener('wheel',interrupt,{passive:true});root.addEventListener('pointerdown',interrupt);root.addEventListener('keydown',interrupt);root.addEventListener('load',restore,true);window.addEventListener('inkspace:capture-reading-session',capture);
  // CodeMirror mounts its scroller in an effect. Watch only until that surface
  // exists; do not run a mutation observer during ordinary editing.
  const needsEditor=!!root.querySelector('.text-workspace:not(.preview),.notebook-workspace,.document-sheet-scroll');
  const mounts=new MutationObserver(()=>{locate();if(needsEditor?nodes.editor:!!(nodes.editor||nodes.preview))mounts.disconnect();});
  locate();if(needsEditor?!nodes.editor:!nodes.editor&&!nodes.preview)mounts.observe(root,{childList:true,subtree:true});
  const frame=requestAnimationFrame(locate),deadline=setTimeout(()=>{pending.clear();sizes.disconnect();mounts.disconnect();publish();},2000);
  return()=>{publish();clearTimeout(deadline);cancelAnimationFrame(frame);cancelAnimationFrame(restoreFrame);sizes.disconnect();mounts.disconnect();for(const n of Object.values(nodes))n?.removeEventListener('scroll',publish);root.removeEventListener('wheel',interrupt);root.removeEventListener('pointerdown',interrupt);root.removeEventListener('keydown',interrupt);root.removeEventListener('load',restore,true);window.removeEventListener('inkspace:capture-reading-session',capture);};
 },[vaultId,path,presentation,revision]);
 return positions;
}

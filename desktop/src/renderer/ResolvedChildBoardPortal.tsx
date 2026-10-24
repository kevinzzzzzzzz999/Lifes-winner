import {useEffect,useMemo,useState,type ComponentProps} from 'react';
import ChildBoardPortal from './ChildBoardPortal';
import {childSession} from './child-board-session';
import {childCanExpand,clipChildPortal} from './child-board-model';

export type ResolvedChildBoardPortalProps=ComponentProps<typeof ChildBoardPortal>&{resolvePath:(path:string)=>Promise<string>};
type Resolution={identity:string;canonical?:string;error?:string};

/** Only the mounted view receives a canonical path. The saved parent link,
 * child identity and presentation remain untouched. */
export default function ResolvedChildBoardPortal({resolvePath,...props}:ResolvedChildBoardPortalProps){
 const{entry,vaultId,language,ancestors,presentation,left,top,scale,parentSize}=props,zh=language==='zh';
 const identity=JSON.stringify([vaultId,entry.link.path]);
 const[state,setState]=useState<Resolution|null>(null),[attempt,setAttempt]=useState(0);
 const current=state?.identity===identity?state:null;
 useEffect(()=>{
  let live=true;
  // A routine source refresh must not tear down an open child editor.
  setState(old=>old?.identity===identity?old:{identity});
  void Promise.resolve().then(()=>resolvePath(entry.link.path)).then(canonical=>{
   if(!live)return;
   setState(old=>{
    const prior=old?.identity===identity?old:undefined;
    if(prior?.canonical&&prior.canonical!==canonical){
     const held=childSession(vaultId,prior.canonical).snapshot();
     if(held.busy||held.drafts)return{...prior,error:zh?'请先完成当前子白板编辑，再重试更新来源。':'Finish the current child edit, then retry its updated source.'};
    }
    return{identity,canonical};
   });
  }).catch(()=>{if(live)setState(old=>({...((old?.identity===identity?old:undefined)||{identity}),error:zh?'暂时无法定位子白板，请重试或重新关联。':'The child board could not be located. Retry or relink its source.'}));});
  return()=>{live=false;};
 },[identity,resolvePath,attempt,zh]);
 const resolvedEntry=useMemo(()=>current?.canonical?{...entry,link:{...entry.link,path:current.canonical}}:null,[entry,current?.canonical]);
 const frame=clipChildPortal({x:left,y:top,width:presentation.width*scale,height:presentation.height*scale},parentSize,scale)?.frame;
 const recursive=!!current?.canonical&&!childCanExpand(current.canonical,ancestors);
 const message=current?.error||(recursive?(zh?'递归链接在此停止；可完整打开原文件。':'This recursive link stops here. Open the original board separately.'):(zh?'正在定位子白板…':'Locating child board…'));
 const notice=<div className="board-child-message" data-testid="board-child-resolution" data-state={current?.error?'error':recursive?'recursive':'loading'} role="status" style={frame?{position:'absolute',left:frame.x,top:frame.y,width:frame.width,height:frame.height,minHeight:0,overflow:'auto',background:'#f7f8f3',border:'1px solid #cad6cf',padding:12,zIndex:8}:{display:'none'}} onPointerDown={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}><strong>{entry.link.title}</strong><p>{message}</p>{current?.error&&<button type="button" onClick={()=>setAttempt(n=>n+1)}>{zh?'重试':'Retry'}</button>}</div>;
 if(!resolvedEntry||recursive)return notice;
 return <><ChildBoardPortal {...props} entry={resolvedEntry}/>{current?.error&&<div data-testid="board-child-resolution-warning" role="status" style={frame?{position:'absolute',left:frame.x+8,top:frame.y+Math.max(0,frame.height-65),width:Math.max(1,frame.width-16),padding:8,background:'#fff7e8',zIndex:9}:{display:'none'}} onPointerDown={event=>event.stopPropagation()}>{message} <button type="button" onClick={()=>setAttempt(n=>n+1)}>{zh?'重试':'Retry'}</button></div>}</>;
}

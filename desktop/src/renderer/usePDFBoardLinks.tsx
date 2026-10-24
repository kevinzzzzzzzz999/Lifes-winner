import {PDFToolbarMenu} from './PDFToolbarMenu';
import './pdf-board-links.css';
import {useEffect,useRef,useState} from 'react';
import type {Vault} from '../shared/desktop-api';
import type {PDFExcerpt,PDFExcerptImage} from '../shared/pdf-extend';
import type {Language} from './i18n';
import {Button,basename} from './ui';
import {parsePDFBoardLinks,pdfBoardLinksKey,pdfBoardVaultKey,remapPDFBoardLinks,updatePDFBoardLink,type PDFBoardLink,type PDFBoardRequest,type PDFBoardTarget} from './pdf-board-links';

type Options={vault:Vault|null;language:Language;save:(request:PDFBoardRequest,target:PDFBoardTarget|{path:string})=>Promise<PDFBoardTarget>;open:(target:PDFBoardTarget,sourcePath:string)=>Promise<void>};
export function usePDFBoardLinks(options:Options){
 const callbacks=useRef(options);callbacks.current=options;
 const [links,setLinks]=useState<PDFBoardLink[]>(()=>{try{return parsePDFBoardLinks(localStorage.getItem(pdfBoardLinksKey));}catch{return[];}}),linkRef=useRef(links);
 const [queue,setQueue]=useState<PDFBoardRequest[]>([]),queueRef=useRef(queue);
 const [phase,setPhase]=useState<'ready'|'choosing'|'paused'|'saving'>('ready'),phaseRef=useRef(phase),[message,setMessage]=useState(''),[storageIssue,setStorageIssue]=useState(false);
 const changePhase=(value:typeof phase)=>{phaseRef.current=value;setPhase(value);};
 const changeQueue=(value:PDFBoardRequest[])=>{queueRef.current=value;setQueue(value);};
 const persist=(next:PDFBoardLink[])=>{linkRef.current=next;setLinks(next);try{localStorage.setItem(pdfBoardLinksKey,JSON.stringify({version:1,links:next}));setStorageIssue(false);}catch{setStorageIssue(true);}};
 const find=(sourcePath:string)=>{const vault=callbacks.current.vault;return vault?linkRef.current.find(l=>l.vaultKey===pdfBoardVaultKey(vault)&&l.sourcePath===sourcePath)?.target:undefined;};
 const enqueue=(sourcePath:string,excerpt?:PDFExcerpt,textReady?:Promise<string>,imageReady?:()=>Promise<PDFExcerptImage>)=>{const v=callbacks.current.vault;if(!v)return;
  changeQueue([...queueRef.current,{id:crypto.randomUUID(),vaultId:v.id,vaultKey:pdfBoardVaultKey(v),sourcePath,...(excerpt?{excerpt}: {}),...(textReady?{textReady}: {}),...(imageReady?{imageReady}: {})}]);
 };
 const save=async(request:PDFBoardRequest,target:PDFBoardTarget|{path:string})=>{
  if(phaseRef.current==='saving')return;changePhase('saving');setMessage('');
  try{if(request.excerpt&&request.imageReady&&!request.excerpt.image)request.excerpt={...request.excerpt,image:await request.imageReady()};const ready=request.excerpt&&request.textReady?{...request,excerpt:{...request.excerpt,text:await request.textReady}}:request;const accepted=await callbacks.current.save(ready,target);persist(updatePDFBoardLink(linkRef.current,request.vaultKey,request.sourcePath,accepted));
   changeQueue(queueRef.current.filter(r=>r.id!==request.id));changePhase('ready');setMessage(callbacks.current.language==='zh'?(request.excerpt?'摘录已加入 ':'已关联 ')+basename(accepted.path)+' · 阅读位置保持不变':(request.excerpt?'Excerpt added to ':'Linked to ')+basename(accepted.path)+' · Reading position retained');
  }catch{changePhase('choosing');setMessage(callbacks.current.language==='zh'?'尚未确认加入，摘录仍保留。图片可能尚未生成，或来源／目标已变化。请稍后重试；已保存图片会复用，不重复添加。':'Addition is unconfirmed; the excerpt is retained. The target may have moved, changed or be unavailable. Choose a board or retry later.');}
 };
 useEffect(()=>{if(phase!=='ready'||!queue.length)return;const first=queue[0],target=linkRef.current.find(l=>l.vaultKey===first.vaultKey&&l.sourcePath===first.sourcePath)?.target;
  if(first.excerpt&&target)void save(first,target);else changePhase('choosing');
 },[queue,phase]);
 const choose=(path:string)=>{const request=queueRef.current[0];return request?save(request,{path}):Promise.resolve();};
 const open=async(sourcePath:string)=>{if(queueRef.current.length)return;const target=find(sourcePath);if(!target)return;changePhase('saving');
  try{await callbacks.current.open(target,sourcePath);changePhase('ready');setMessage('');}catch{changePhase('ready');enqueue(sourcePath);setMessage(callbacks.current.language==='zh'?'关联白板暂不可用，请重新选择。':'Linked board is unavailable. Choose it again.');}
 };
 const change=(path:string)=>{if(!queueRef.current.length&&phaseRef.current!=='saving')enqueue(path);};
 const resume=()=>{if(queueRef.current.length&&phaseRef.current!=='saving')changePhase('choosing');};
 const discard=()=>{if(phaseRef.current==='saving')return;changeQueue(queueRef.current.slice(1));changePhase('ready');setMessage('');};
 const clear=(path:string)=>{const v=callbacks.current.vault;if(v&&!queueRef.current.length&&phaseRef.current!=='saving'){persist(updatePDFBoardLink(linkRef.current,pdfBoardVaultKey(v),path));setMessage(callbacks.current.language==='zh'?'已取消关联。已有白板内容保留。下次摘录时重新选择。':'Link cleared. Existing board content is kept. Choose a target with the next excerpt.');}};
 return{links,request:queue[0],choosing:phase==='choosing',busy:phase==='saving',pending:!!queue.length,message,storageIssue,target:find,receive:(e:PDFExcerpt,textReady?:Promise<string>,imageReady?:()=>Promise<PDFExcerptImage>)=>enqueue(e.path,e,textReady,imageReady),choose,open,change,clear,resume,discard,pause:()=>{if(phaseRef.current!=='saving')changePhase('paused');},hasPending:()=>!!queueRef.current.length||phaseRef.current==='saving',
  remap:(v:Vault,moves:Array<{from:string;to:string}>,removed:string[])=>persist(remapPDFBoardLinks(linkRef.current,pdfBoardVaultKey(v),moves,removed))};
}
export type PDFBoardLinksController=ReturnType<typeof usePDFBoardLinks>;
export function PDFBoardLinkToolbar({c,path,language,compact=false}:{c:PDFBoardLinksController;path:string;language:Language;compact?:boolean}){
 const zh=language==='zh',target=c.target(path),ownPending=c.request?.sourcePath===path;
 const content=<div className="pdf-board-link-toolbar" data-testid="pdf-board-link-toolbar" data-source-path={path}>
  <span title={target?.path} data-testid="pdf-linked-board-name">{target?(zh?'摘录白板：':'Excerpt board: ')+basename(target.path).replace(/\.inkspace\.json$/i,''):(zh?'首次摘录时选择白板':'Choose a board with your first excerpt')}</span>
  {target&&<Button data-testid="pdf-linked-board-open" disabled={c.pending||c.busy} onClick={()=>void c.open(path)}>{zh?'右侧打开白板':'Show board on the right'}</Button>}
  <Button data-testid="pdf-linked-board-change" disabled={c.pending||c.busy} onClick={()=>c.change(path)}>{target?(zh?'更换':'Change'):(zh?'关联白板':'Link board')}</Button>
  {target&&<Button data-testid="pdf-linked-board-clear" disabled={c.pending||c.busy} onClick={()=>c.clear(path)}>{zh?'取消关联':'Clear link'}</Button>}
  {ownPending&&!c.choosing&&!c.busy&&<><Button data-testid="pdf-excerpt-resume" onClick={c.resume}>{zh?'继续添加未保存摘录':'Resume pending excerpt'}</Button><Button data-testid="pdf-excerpt-discard" onClick={c.discard}>{zh?'丢弃此未保存摘录':'Discard pending excerpt'}</Button></>}
  <small>{zh?'当前 Mac 记住关联':'Link remembered on this Mac'}</small>
  {c.busy&&<span role="status">{zh?'正在加入白板…':'Adding to board…'}</span>}
  {c.message&&<span className="pdf-board-link-message" role="status">{c.message}</span>}
  {c.storageIssue&&<span role="alert">{zh?'本机偏好未能持久保存；摘录保存不受影响。':'Local preference could not be persisted; saved excerpts are unaffected.'}</span>}
 </div>;
 return compact?<PDFToolbarMenu testId="pdf-board-link-menu" label={zh?'关联':'Board'} title={zh?'关联白板与摘录状态':'Linked board and excerpt status'} badge={c.busy?(zh?'保存中':'Saving'):c.pending?(zh?'待完成':'Pending'):target?(zh?'已关联':'Linked'):undefined}>{content}</PDFToolbarMenu>:content;
}

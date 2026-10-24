import { useCallback,useEffect,useRef,useState } from 'react';
import { MessageSquareText,RefreshCw,Trash2,X,LocateFixed,FileText,Eye,EyeOff } from 'lucide-react';
import type { ReviewRecord,ReviewListResponse } from '../shared/desktop-api';
import type { Language } from './i18n';
import { Button,basename } from './ui';
import './reviews.css';

export type ReviewRect={x:number;y:number;width:number;height:number};
export type ReviewFocus={review:ReviewRecord;nonce:number};
export function reviewRect(review:ReviewRecord,items:Array<ReviewRect&{id:string}>):ReviewRect {
 const item=review.anchor&&items.find(item=>item.id.toLowerCase()===review.anchor!.itemID.toLowerCase());
 if(!item||!review.anchor)return review.rect;
 const r=review.anchor.rect;
 return{x:item.x+r.x*item.width,y:item.y+r.y*item.height,width:r.width*item.width,height:r.height*item.height};
}

/** Responses belong to one selected file. A delayed read may never populate another tab. */
export function useReviews(vaultId:string|undefined,path:string|undefined){
 const key=JSON.stringify([vaultId,path]);
 const current=useRef(key);current.current=key;
 const epoch=useRef(0);
 const[value,setValue]=useState<{key:string;data:ReviewListResponse;error:string}|null>(null);
 const[deleting,setDeleting]=useState<string|null>(null);
 const reload=useCallback(async()=>{
  if(!vaultId||!path)return;
  const request=++epoch.current;
  try{
   const result=await window.desktop.listReviews({vaultId,path});
   if(current.current!==key||request!==epoch.current)return;
   if(!result.ok)throw Error(result.error.message);
   setValue({key,data:result.value,error:''});
  }catch(error){if(current.current===key&&request===epoch.current)setValue(old=>({key,data:old?.key===key?old.data:{reviews:[],warnings:[],truncated:false},error:error instanceof Error?error.message:String(error)}));}
 },[vaultId,path,key]);
 useEffect(()=>{void reload();const timer=setInterval(()=>void reload(),15000);const onFocus=()=>void reload();window.addEventListener('focus',onFocus);return()=>{epoch.current++;clearInterval(timer);window.removeEventListener('focus',onFocus);};},[reload]);
 const remove=async(id:string)=>{
  if(!vaultId||deleting)return;
  setDeleting(id);
  try{
   const result=await window.desktop.deleteReview({vaultId,id});
   if(!result.ok)throw Error(result.error.message);
   if(current.current===key){epoch.current++;setValue(old=>old?.key===key?{...old,data:{...old.data,reviews:old.data.reviews.filter(review=>review.id!==id)},error:''}:old);await reload();}
  }catch(error){if(current.current===key)setValue(old=>({key,data:old?.key===key?old.data:{reviews:[],warnings:[],truncated:false},error:error instanceof Error?error.message:String(error)}));}
  finally{setDeleting(null);}
 };
 const data=value?.key===key?value:null;
 return{reviews:data?.data.reviews||[],warnings:data?.data.warnings||[],truncated:data?.data.truncated||false,error:data?.error||'',loading:!!path&&!data,reload,remove,deleting};
}

export function ReviewMark({review,rect,selected,onSelect}:{review:ReviewRecord;rect:ReviewRect;selected:boolean;onSelect:()=>void}){
 return <div className={`review-mark ${selected?'selected':''}`} data-review-id={review.id} data-review-anchor={JSON.stringify(rect)} style={{left:rect.x,top:rect.y,width:Math.max(1,rect.width),height:Math.max(1,rect.height),'--review-color':review.color} as React.CSSProperties}>
  {review.points.length>0&&<svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><polyline points={review.points.map(p=>p.join(',')).join(' ')} vectorEffect="non-scaling-stroke" strokeWidth={review.strokeWidth!=null?review.strokeWidth*rect.width/review.rect.width:review.style==='highlight'?16*rect.width/review.rect.width:selected?3.5:2.5} opacity={review.style==='highlight'?.32:1}/></svg>}
  <button type="button" className="review-pin" onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onSelect();}} title={review.comment||'Review'} aria-label={review.comment||'Review'}><MessageSquareText/></button>
 </div>;
}

export default function ReviewPanel({language,reviews,warnings,truncated,error,loading,deleting,selected,visible,currentPath,currentSHA,currentBoardID,onSelect,onOpenOriginal,onDelete,onReload,onClose,onToggle}:{language:Language;reviews:ReviewRecord[];warnings:string[];truncated:boolean;error:string;loading:boolean;deleting:string|null;selected?:string;visible:boolean;currentPath:string;currentSHA:string;currentBoardID?:string;onSelect:(review:ReviewRecord)=>void;onOpenOriginal:(review:ReviewRecord)=>void;onDelete:(id:string)=>void;onReload:()=>void;onClose:()=>void;onToggle:()=>void}){
 const zh=language==='zh';const[page,setPage]=useState(0);
 useEffect(()=>setPage(0),[currentPath]);
 const pages=Math.max(1,Math.ceil(reviews.length/40));const selectedPage=Math.min(page,pages-1);
 return <aside className="review-panel" data-testid="review-panel" aria-label={zh?'待修改批注':'Review annotations'}>
  <header><MessageSquareText/><strong>{zh?'待修改批注':'Review annotations'}</strong><span className="review-count">{reviews.length}</span><span className="spacer"/><Button className="icon-button" aria-label={zh?'关闭批注列表':'Close reviews'} onClick={onClose}><X/></Button></header>
  <p className="review-explanation">{zh?'iPhone、iPad 上留下的高亮、圈画和提醒。修改原文后，删除对应批注即可。':'Highlights, marks and reminders left on iPhone or iPad. Edit the source, then delete the completed review.'}</p>
  <div className="review-actions"><Button onClick={onToggle}>{visible?<Eye/>:<EyeOff/>}{zh?(visible?'隐藏浮层':'显示浮层'):(visible?'Hide overlays':'Show overlays')}</Button><Button onClick={onReload} aria-label={zh?'刷新批注':'Refresh reviews'}><RefreshCw/></Button></div>
  <div className="review-list">
   {error&&<p className="inline-error" role="alert">{error}</p>}
   {loading?<p role="status">{zh?'正在读取批注…':'Loading reviews…'}</p>:!reviews.length&&<div className="review-empty"><MessageSquareText/><p>{zh?'这个文件没有待修改批注':'No pending reviews for this file'}</p><small>{zh?'在 iPhone 或 iPad 阅读时使用“待修改批注”。两端打开同一个共享文件夹，等待 iCloud 同步后即可看到。':'Use “Review” while reading on iPhone or iPad. Open the same shared folder on both devices and allow iCloud to sync.'}</small></div>}
   {reviews.slice(selectedPage*40,(selectedPage+1)*40).map(review=><article key={review.id} className={`review-card ${selected===review.id?'selected':''}`} data-review-card={review.id}>
    <div className="review-card-meta"><span style={{background:review.color}}/>{review.anchor?.page?`${zh?'第':'Page '}${review.anchor.page}${zh?' 页':''}`:zh?'白板位置':'Board position'}<time>{new Date(review.createdAt).toLocaleDateString(zh?'zh-CN':'en')}</time></div>
    <p>{review.comment||(zh?'查看圈画的位置':'See the marked area')}</p>
    <small title={review.anchor?.originalSourcePath||review.anchor?.sourcePath||review.boardPath}>{basename(review.anchor?.originalSourcePath||review.anchor?.sourcePath||review.boardPath)}</small>
    {currentBoardID&&currentBoardID.toLowerCase()!==review.boardID.toLowerCase()&&<p className="review-location-warning">{zh?'同名白板已替换，旧批注保留在列表中；请核对原文件。':'This board was replaced. The older review stays in this list; check its source.'}</p>}
    <div className="review-card-actions"><Button data-testid={`review-locate-${review.id}`} onClick={()=>onSelect(review)}><LocateFixed/>{zh?'定位':'Locate'}</Button>{(review.anchor?.originalSourcePath||review.anchor?.sourcePath)&&<Button title={zh?'打开原文件':'Open source'} aria-label={zh?'打开原文件':'Open source'} onClick={()=>onOpenOriginal(review)}><FileText/></Button>}<span className="spacer"/><Button data-testid={`review-delete-${review.id}`} disabled={!!deleting} onClick={()=>onDelete(review.id)} title={zh?'删除批注':'Delete review'} aria-label={zh?'删除批注':'Delete review'}><Trash2/></Button></div>
   </article>)}
  </div>
  {pages>1&&<div className="review-pages"><Button disabled={selectedPage===0} onClick={()=>setPage(selectedPage-1)}>{zh?'上一页':'Previous'}</Button><span>{selectedPage+1}/{pages}</span><Button disabled={selectedPage===pages-1} onClick={()=>setPage(selectedPage+1)}>{zh?'下一页':'Next'}</Button></div>}
  {(truncated||warnings.length>0)&&<p className="review-warning">{zh?'部分批注尚未读取，请检查同步状态后刷新。':'Some reviews could not be loaded. Check sync and refresh.'}</p>}
  <footer>{zh?'独立批注层 · 删除不改动原文':'Separate review layer · Deleting keeps the source intact'}</footer>
 </aside>;
}

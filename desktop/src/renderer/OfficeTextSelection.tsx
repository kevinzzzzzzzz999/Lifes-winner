import {useCallback,useEffect,useRef,useState,type RefObject} from 'react';
import type {Language} from './i18n';
import {beginOfficePreparation} from './office-preparation-deadline';
import {ocrCaptureScale,boundedOCRPNG,selectDOMWordAt} from './ocr-capture';
import './office-text-selection.css';

type Rect={x:number;y:number;width:number;height:number};
type Box=Rect&{text:string;rotation?:number};
type Snapshot={rect:Rect;image:string;boxes:Box[]};
function visibleRect(element:HTMLElement):Rect{
 const r=element.getBoundingClientRect(),x=Math.ceil(Math.max(0,r.left)),y=Math.ceil(Math.max(0,r.top));
 return{x,y,width:Math.max(0,Math.floor(Math.min(window.innerWidth,r.right))-x),height:Math.max(0,Math.floor(Math.min(window.innerHeight,r.bottom))-y)};
}
const sameRect=(a:Rect,b:Rect)=>a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height;
const paint=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
async function boundedPixels(dataURL:string,checkpoint:()=>void){
 const image=new Image();image.src=dataURL;await image.decode();checkpoint();
 const scale=ocrCaptureScale(image.naturalWidth,image.naturalHeight,1);
 const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(image.naturalWidth*scale));canvas.height=Math.max(1,Math.floor(image.naturalHeight*scale));
 try{canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);return boundedOCRPNG(canvas);}finally{canvas.width=0;canvas.height=0;}
}
function TextLine({box,rect}:{box:Box;rect:Rect}){
 const span=useRef<HTMLSpanElement>(null),[scale,setScale]=useState(1),width=box.width*rect.width,height=box.height*rect.height,rotation=box.rotation||0,vertical=rotation===90||rotation===270,lineWidth=vertical?height:width,lineHeight=vertical?width:height;
 useEffect(()=>{if(span.current)setScale(lineWidth/Math.max(1,span.current.scrollWidth));},[box.text,lineWidth,lineHeight]);
 return <span className="office-ocr-line" data-text-rotation={rotation} style={{left:box.x*rect.width,top:box.y*rect.height,width,height}}><span ref={span} style={{left:rotation===90||rotation===180?width:0,top:rotation===180||rotation===270?height:0,fontSize:lineHeight,lineHeight:`${lineHeight}px`,transform:`rotate(${rotation}deg) scaleX(${scale})`}}>{box.text}</span>{'\n'}</span>;
}

/** Capture only after the reader explicitly asks. The frozen pixels and their
 * selectable text share one viewport; source movement invalidates both. */
export function useOfficeTextSelection({content,language,owner,revision}:{content:RefObject<HTMLDivElement|null>;language:Language;owner:string;revision:unknown}){
 const zh=language==='zh',root=useRef<HTMLDivElement>(null),epoch=useRef(0),request=useRef<string|null>(null),running=useRef(false),bounds=useRef<Rect|null>(null),preparation=useRef<{cancel:()=>void}|null>(null);
 const nativeRoot=useRef<HTMLElement|null>(null),press=useRef<{timer:ReturnType<typeof setTimeout>;x:number;y:number;id:number}|null>(null),beforeEnable=useRef<()=>void>(()=>{});
 const [native,setNative]=useState(false);
 const cancelPress=()=>{if(press.current)clearTimeout(press.current.timer);press.current=null;};
 const [active,setActive]=useState(false),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[status,setStatus]=useState(''),[hasText,setHasText]=useState(false);
 const cancel=useCallback(()=>{cancelPress();epoch.current++;preparation.current?.cancel();preparation.current=null;running.current=false;bounds.current=null;if(request.current){void window.desktop.cancelLocalOCR({requestId:request.current}).catch(()=>{});request.current=null;}const selection=window.getSelection();if((nativeRoot.current||root.current)?.contains(selection?.anchorNode||null))selection?.removeAllRanges();content.current?.classList.remove('office-native-text-active');nativeRoot.current=null;},[content]);
 const clear=useCallback(()=>{cancel();setActive(false);setSnapshot(null);setNative(false);setStatus('');setHasText(false);},[cancel]);
 useEffect(()=>{clear();return cancel;},[owner,revision,clear,cancel]);
 useEffect(()=>{
  const element=content.current;if(!element)return;
  const sourceLoaded=(event:Event)=>{if((event.target as Element)?.closest('.document-preview')&&running.current)clear();};
  const changed=()=>{if(running.current)clear();},scrolled=()=>{if(running.current&&!nativeRoot.current)clear();},blur=()=>changed(),visibility=()=>{if(document.hidden)changed();},key=(event:KeyboardEvent)=>{if(running.current&&event.key==='Escape'){event.preventDefault();event.stopPropagation();clear();}},outside=(event:PointerEvent)=>{if(running.current&&!element.parentElement?.contains(event.target as Node))clear();};
  element.addEventListener('scroll',scrolled,true);element.addEventListener('load',sourceLoaded,true);window.addEventListener('resize',changed);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',visibility);document.addEventListener('keydown',key,true);document.addEventListener('pointerdown',outside,true);
  const preview=element.querySelector('.document-preview'),observer=new MutationObserver(changed);if(preview)observer.observe(preview,{subtree:true,childList:true,characterData:true,attributes:true});
  const selectionChanged=()=>{const s=window.getSelection();setHasText(!!s&&!s.isCollapsed&&!!(nativeRoot.current||root.current)?.contains(s.anchorNode)&&!!(nativeRoot.current||root.current)?.contains(s.focusNode)&&!!s.toString().trim());};
  document.addEventListener('selectionchange',selectionChanged);
  return()=>{element.removeEventListener('scroll',scrolled,true);element.removeEventListener('load',sourceLoaded,true);window.removeEventListener('resize',changed);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('selectionchange',selectionChanged);observer.disconnect();};
 },[content,clear]);
 useEffect(()=>{if(!active||native)return;let frame=0;const check=()=>{if(running.current&&bounds.current&&content.current&&!sameRect(bounds.current,visibleRect(content.current))){clear();return;}frame=requestAnimationFrame(check);};frame=requestAnimationFrame(check);return()=>cancelAnimationFrame(frame);},[active,native,clear,content]);
 const begin=async(beforeBegin:()=>void,forceOCR=false,point?:{x:number;y:number},target?:HTMLElement)=>{
  clear();beforeBegin();running.current=true;setActive(true);setStatus(zh?'正在选取当前画面文字…':'Selecting text in the current view…');const generation=epoch.current;
  const article=content.current?.querySelector<HTMLElement>('article');
  if(!forceOCR&&article?.textContent?.trim()){nativeRoot.current=article;content.current?.classList.add('office-native-text-active');setNative(true);setStatus(zh?'原生文字可直接拖选、复制；图片文字可长按图片识别。':'Select and copy native text directly. Long-press a picture to recognize its text.');if(point)requestAnimationFrame(()=>{if(generation===epoch.current)selectDOMWordAt(article,point);});return;}
  try{
   // Let the translation controls close before measuring. Never capture the
   // full window or substitute a thumbnail for the actual reading viewport.
   const pending=beginOfficePreparation(async phaseCheckpoint=>{
    const checkpoint=()=>{phaseCheckpoint();if(generation!==epoch.current)throw Error('CANCELLED');};
    await paint();checkpoint();await paint();checkpoint();
    const element=content.current;if(!element||document.hidden)throw Error('NOT_READY');const viewport=visibleRect(element);const image=target?.closest<HTMLImageElement>('img')||(!element.querySelector('article')?element.querySelector<HTMLImageElement>('img'):null);const r=image?.getBoundingClientRect();const x=r?Math.max(viewport.x,r.left):viewport.x,y=r?Math.max(viewport.y,r.top):viewport.y;const rect=r?{x,y,width:Math.max(0,Math.min(viewport.x+viewport.width,r.right)-x),height:Math.max(0,Math.min(viewport.y+viewport.height,r.bottom)-y)}:viewport;if(rect.width<16||rect.height<16)throw Error('NOT_READY');bounds.current=viewport;
    let pixels:string|undefined;
    if(image?.complete&&image.naturalWidth&&r?.width){const canvas=document.createElement('canvas'),scale=ocrCaptureScale(rect.width,rect.height,Math.max(1,image.naturalWidth/r.width));canvas.width=Math.max(1,Math.floor(rect.width*scale));canvas.height=Math.max(1,Math.floor(rect.height*scale));try{const c=canvas.getContext('2d')!;c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.drawImage(image,(r.left-rect.x)*scale,(r.top-rect.y)*scale,r.width*scale,r.height*scale);pixels=boundedOCRPNG(canvas);}catch{/* Protected source images fall back to a bounded native capture. */}finally{canvas.width=0;canvas.height=0;}}
    if(!pixels){const capture=await window.desktop.captureSelection({rect});checkpoint();if(!capture.ok)throw Error(capture.error.code);pixels=await boundedPixels(capture.value.dataURL,checkpoint);}
    checkpoint();if(!sameRect(viewport,visibleRect(element)))throw Error('MOVED');
    const local=element.getBoundingClientRect();return{image:pixels,display:{x:rect.x-local.x,y:rect.y-local.y,width:rect.width,height:rect.height}};
   });preparation.current=pending;
   const {image,display}=await pending.promise;if(generation!==epoch.current)return;
   if(preparation.current===pending)preparation.current=null;
   setSnapshot({rect:display,image,boxes:[]});
   const requestId=crypto.randomUUID();request.current=requestId;
   const result=await window.desktop.recognizeBoardText({requestId,imageDataURL:image});if(generation!==epoch.current)return;if(!result.ok)throw Error(result.error.code);
   if(result.value.cancelled)throw Error('CANCELLED');if(result.value.outputLimited)throw Error('OCR_OUTPUT_LIMIT');if(result.value.pages[0]?.error)throw Error('OCR_FAILED');
   const boxes=(result.value.pages[0]?.boxes||[]).filter(b=>b.text.trim()&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=1.01&&b.y+b.height<=1.01).slice(0,1200);
   if(!boxes.length)throw Error('EMPTY');setSnapshot({rect:display,image,boxes});if(point)requestAnimationFrame(()=>requestAnimationFrame(()=>{if(generation===epoch.current&&root.current)selectDOMWordAt(root.current,point);}));setStatus(zh?'拖动选择文字；本机识别，请核对原文。':'Drag to select text. Recognized locally; check the source.');
  }catch(error){if(generation!==epoch.current)return;const code=error instanceof Error?error.message:'';
   cancel();setActive(false);setSnapshot(null);setNative(false);setHasText(false);
   setStatus(code==='CANCELLED'?'':code==='OCR_FAILED'?(zh?'本机文字识别未完成，请稍后重试。':'Local text recognition failed. Try again shortly.'):code==='OCR_TIMEOUT'?(zh?'本机文字识别超时，请重试。':'Local text recognition timed out. Please try again.'):code==='OCR_OUTPUT_LIMIT'?(zh?'识别结果过多，请缩小可见范围后重试。':'The recognition result is too large. Reduce the visible area and try again.'):code==='OFFICE_PREPARATION_TIMEOUT'?(zh?'画面准备超时，请再次点击“选择画面文字”重试。':'Preparing the view timed out. Click “Select visible text” to try again.'):code==='EMPTY'?(zh?'当前画面未识别到文字，请滚动或放大后重试。':'No text found in this view. Scroll or zoom and try again.'):code==='BUSY'?(zh?'另一项本机识别尚未完成，请稍后重试。':'Another local recognition is running. Try again shortly.'):(zh?'暂时无法选择当前画面文字，请再次点击“选择画面文字”重试。':'Could not select text in this view. Click “Select visible text” to try again.'));}
  finally{if(generation===epoch.current)request.current=null;}
 };
 const selectionText=()=>{const s=window.getSelection();const container=nativeRoot.current||root.current;return s&&container?.contains(s.anchorNode)&&container?.contains(s.focusNode)?s.toString().trim():'';};
 const copy=async()=>{const text=selectionText();if(!text)return;const generation=epoch.current;try{const response=await window.desktop.copyBoardText({text});if(generation===epoch.current)setStatus(response.ok?(zh?'已复制所选文字。':'Selected text copied.'):(zh?'复制未完成，请重试。':'Copy failed. Try again.'));}catch{if(generation===epoch.current)setStatus(zh?'复制未完成，请重试。':'Copy failed. Try again.');}};
 const selectAll=()=>{const container=nativeRoot.current||root.current;if(!container||(!nativeRoot.current&&!snapshot?.boxes.length))return;const range=document.createRange();range.selectNodeContents(container);window.getSelection()?.removeAllRanges();window.getSelection()?.addRange(range);};
 const overlay=snapshot&&<div className="office-ocr-snapshot" data-testid="office-ocr-snapshot" style={{left:snapshot.rect.x,top:snapshot.rect.y,width:snapshot.rect.width,height:snapshot.rect.height}} onWheel={event=>{const preview=content.current?.querySelector('.document-preview,.readonly-image-scroll');clear();preview?.scrollBy({left:event.deltaX,top:event.deltaY});}}>
  <img src={snapshot.image} alt="" draggable={false}/><div ref={root} className="office-ocr-text" data-testid="office-ocr-text" role="region" aria-label={zh?'当前画面可选择的文字':'Selectable text in the current view'} tabIndex={0} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();clear();}else if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a'){event.preventDefault();event.stopPropagation();selectAll();}}}>{snapshot.boxes.map((box,index)=><TextLine key={index} box={box} rect={snapshot.rect}/>)}</div>
 </div>;
 const controls=(beforeBegin:()=>void)=>{beforeEnable.current=beforeBegin;return <div className="office-ocr-controls"><button className="button" data-testid="office-text-select" aria-pressed={active} title={zh?'只识别当前显示的内容；未显示的图片请用原应用打开。':'Recognizes only displayed content. Open the original app for images not shown here.'} onClick={()=>active?clear():void begin(beforeBegin)}>{active?(zh?'结束选字':'Finish selecting'):(zh?'选择画面文字':'Select visible text')}</button>{active&&<><button className="button" data-testid="office-text-copy" disabled={!hasText} onPointerDown={event=>event.preventDefault()} onClick={()=>void copy()}>{zh?'复制所选文字':'Copy selected text'}</button><button className="button" data-testid="office-text-all" disabled={!native&&!snapshot?.boxes.length} onPointerDown={event=>event.preventDefault()} onClick={selectAll}>{zh?'全选':'Select all'}</button></>}<button className="button" data-testid="office-text-ocr" onClick={()=>void begin(beforeBegin,true)}>{zh?'识别画面':'Recognize view'}</button></div>;};
 const captureDown=(event:React.PointerEvent<HTMLDivElement>)=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.altKey||(event.target as HTMLElement).closest('button,input,select,textarea,a,[contenteditable],.document-translation-selection,.office-ocr-snapshot'))return;cancelPress();const point={x:event.clientX,y:event.clientY},target=event.target as HTMLElement;press.current={...point,id:event.pointerId,timer:setTimeout(()=>{press.current=null;void begin(beforeEnable.current,!!target.closest('img'),point,target);},520)};};
 const captureMove=(event:React.PointerEvent<HTMLDivElement>)=>{const p=press.current;if(p&&Math.hypot(event.clientX-p.x,event.clientY-p.y)>6)cancelPress();};
 return{clear,captureDown,captureMove,cancelPress,overlay,controls,notice:<div className="office-ocr-status" role="status" data-testid="office-text-status">{status||(zh?'可先滚动或缩放，再选择画面文字。':'Scroll or zoom, then select text in the current view.')}</div>};
}

import {useEffect,useRef,useState,type RefObject,type PointerEvent as ReactPointerEvent} from 'react';
import {Copy,FileText,ScanText,Volume2,X} from 'lucide-react';
import type {Language} from './i18n';
import './board-text-selection.css';
import {ocrCaptureScale,boundedOCRPNG} from './ocr-capture';
import {BoardSpeech,type SpeechPart,type SpeechRect} from './BoardSpeech';
type Point={x:number;y:number};type Rect=Point&{width:number;height:number};
type Box=Rect&{text:string;rotation?:number};
type Selected={rect:Rect;point:Point;boxes:Box[];native?:HTMLElement;busy?:boolean;error?:string;status?:string};
const controlSelector='button,input,select,textarea,a,summary,video,audio,iframe,[contenteditable]:not([contenteditable="false"]),.legacy-preview,.pdf-translation-selection';
function clipped(a:Rect,b:Rect):Rect{const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);return{x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};}
const rectOf=(r:DOMRect):Rect=>({x:r.left,y:r.top,width:r.width,height:r.height});
/** Composite only the visible board's own painted sources. Toolbars, other
 * windows, nested child boards and external web frames are never captured. */
function boardPixels(stage:HTMLElement,area:Rect){
 const scale=ocrCaptureScale(area.width,area.height),out=document.createElement('canvas');
 out.width=Math.max(1,Math.floor(area.width*scale));out.height=Math.max(1,Math.floor(area.height*scale));
 try{const c=out.getContext('2d')!;c.fillStyle='#fff';c.fillRect(0,0,out.width,out.height);
  const elements=Array.from(stage.querySelectorAll<HTMLCanvasElement|HTMLImageElement>('canvas.board-skeleton,.board-item canvas[data-pdf-ready="true"],.board-item img,canvas.board-ink')).filter(el=>el.closest('.board-stage')===stage);
  for(const el of elements){if(getComputedStyle(el).visibility==='hidden')continue;const r=rectOf(el.getBoundingClientRect());if(!r.width||!r.height)continue;
   if(el instanceof HTMLImageElement){if(!el.complete||!el.naturalWidth)continue;if(getComputedStyle(el).objectFit==='contain'){const ratio=Math.min(r.width/el.naturalWidth,r.height/el.naturalHeight),w=el.naturalWidth*ratio,h=el.naturalHeight*ratio;r.x+=(r.width-w)/2;r.y+=(r.height-h)/2;r.width=w;r.height=h;}}
   else if(!el.width||!el.height)continue;
   const overlap=clipped(r,area);if(!overlap.width||!overlap.height)continue;
   c.drawImage(el,(r.x-area.x)*scale,(r.y-area.y)*scale,r.width*scale,r.height*scale);
  }
  return boundedOCRPNG(out);
 }finally{out.width=0;out.height=0;}
}
function selectAt(root:HTMLElement,point:Point){
 const doc=document as Document&{caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;caretRangeFromPoint?:(x:number,y:number)=>Range|null};
 const caret=doc.caretPositionFromPoint?.(point.x,point.y);let range=caret?document.createRange():doc.caretRangeFromPoint?.(point.x,point.y);
 if(caret&&range){range.setStart(caret.offsetNode,caret.offset);range.collapse(true);}
 if(!range||!root.contains(range.startContainer)){range=document.createRange();range.selectNodeContents(root);}
 const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
 if(range.collapsed){selection?.modify('move','backward','word');selection?.modify('extend','forward','word');}
}
function OCRLine({box,rect}:{box:Box;rect:Rect}){
 const span=useRef<HTMLSpanElement>(null),[scale,setScale]=useState(1),width=box.width*rect.width,height=box.height*rect.height,rotation=box.rotation||0,vertical=rotation===90||rotation===270,lineWidth=vertical?height:width,lineHeight=vertical?width:height;
 useEffect(()=>{if(span.current)setScale(lineWidth/Math.max(1,span.current.scrollWidth));},[box.text,lineWidth,lineHeight]);
 return <span className="board-ocr-line" data-text-rotation={rotation} style={{left:box.x*rect.width,top:box.y*rect.height,width,height}}><span ref={span} style={{left:rotation===90||rotation===180?width:0,top:rotation===180||rotation===270?height:0,fontSize:lineHeight,lineHeight:`${lineHeight}px`,transform:`rotate(${rotation}deg) scaleX(${scale})`}}>{box.text}</span>{'\n'}</span>;
}
export function useBoardTextSelection({stage,language,enabled,revision,displayScale,cancelPan,onExtract,preferredItemIDs}:{stage:RefObject<HTMLDivElement|null>;language:Language;enabled:boolean;revision:string;displayScale:number;preferredItemIDs?:()=>string[];cancelPan:()=>void;onExtract?:(text:string,point:Point)=>Promise<void>}){
 const [proofread,setProofread]=useState(false),[wordList,setWordList]=useState(()=>{try{return localStorage.getItem('inkspace.ocr.commonWords')||'';}catch{return '';}});
 const [autoRead,setAutoRead]=useState(0),readSequence=useRef(0);
 const [speakingRect,setSpeakingRect]=useState<SpeechRect|null>(null);
 const zh=language==='zh', [value,setValue]=useState<Selected|null>(null),[armed,setArmed]=useState(false),[hasText,setHasText]=useState(false);
 const selected=useRef<Selected|null>(null);selected.current=value;
 const root=useRef<HTMLDivElement>(null),request=useRef<string|null>(null),epoch=useRef(0),press=useRef<{timer:ReturnType<typeof setTimeout>;point:Point;id:number}|null>(null),extraction=useRef(false);
 const cancelPress=()=>{if(press.current)clearTimeout(press.current.timer);press.current=null;};
 const clear=()=>{cancelPress();epoch.current++;if(request.current){void window.desktop.cancelLocalOCR({requestId:request.current}).catch(()=>{});request.current=null;}selected.current?.native?.classList.remove('board-native-text-active');const selection=window.getSelection();if(selected.current?.native?.contains(selection?.anchorNode||null)||root.current?.contains(selection?.anchorNode||null))selection?.removeAllRanges();selected.current=null;setValue(null);setHasText(false);setProofread(false);};
 useEffect(()=>{clear();setArmed(false);return clear;},[revision,enabled]);
 useEffect(()=>{const listener=()=>{const s=window.getSelection(),container=selected.current?.native||root.current;setHasText(!!s&&!s.isCollapsed&&!!container?.contains(s.anchorNode)&&!!container?.contains(s.focusNode)&&!!s.toString().trim());};document.addEventListener('selectionchange',listener);return()=>document.removeEventListener('selectionchange',listener);},[]);
 useEffect(()=>{const blur=()=>cancelPress();window.addEventListener('blur',blur);return()=>{window.removeEventListener('blur',blur);cancelPress();};},[]);
 const selectForReading=(container:HTMLElement)=>{const range=document.createRange();range.selectNodeContents(container);window.getSelection()?.removeAllRanges();window.getSelection()?.addRange(range);setAutoRead(++readSequence.current);};
 const begin=async(point:Point,target:HTMLElement,read=false)=>{
  const surface=stage.current;if(!surface||!enabled)return;clear();setAutoRead(0);cancelPan();setArmed(false);const current=epoch.current,bounds=rectOf(surface.getBoundingClientRect()),item=target.closest<HTMLElement>('.board-item');
  if(item?.matches('.kind-text,.kind-formula')&&!item.querySelector('iframe')){
   item.classList.add('board-native-text-active');const rect=clipped(rectOf(item.getBoundingClientRect()),bounds);const next={rect:{x:(rect.x-bounds.x)/displayScale,y:(rect.y-bounds.y)/displayScale,width:rect.width/displayScale,height:rect.height/displayScale},point,boxes:[],native:item};selected.current=next;setValue(next);requestAnimationFrame(()=>{if(epoch.current===current){if(read)selectForReading(item);else selectAt(item,point);}});return;
  }
  const area=clipped(item?rectOf(item.getBoundingClientRect()):{x:point.x-380,y:point.y-210,width:760,height:420},bounds);
  if(area.width<8||area.height<8)return;
  const rect={x:(area.x-bounds.x)/displayScale,y:(area.y-bounds.y)/displayScale,width:area.width/displayScale,height:area.height/displayScale};
  const next:Selected={rect,point,boxes:[],busy:true};setValue(next);request.current=crypto.randomUUID();
  try{
   // A refocus may have just started a PDF/image refresh. Keep this selection busy
   // until its own source is painted, rather than recognizing a blank intermediate frame.
   const ready=()=>!item||(!item.matches('.kind-pdfPage')||!!item.querySelector('canvas[data-pdf-ready="true"]'))&&Array.from(item.querySelectorAll('img')).every(img=>img.complete&&img.naturalWidth>0);
   const deadline=performance.now()+4000;
   while(!ready()&&performance.now()<deadline&&epoch.current===current)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
   if(epoch.current!==current)return;
   if(!ready())throw Error('NOT_READY');
   const response=await window.desktop.recognizeBoardText({requestId:request.current,imageDataURL:boardPixels(surface,area),customWords:wordList.split(/[\n,，]+/).map(w=>w.trim()).filter(w=>w&&Array.from(w).length<=80).slice(0,200)});if(epoch.current!==current)return;if(!response.ok)throw Error(response.error.code);const boxes=response.value.pages[0]?.boxes||[];if(!boxes.length)throw Error('EMPTY');setValue({...next,busy:false,boxes});requestAnimationFrame(()=>requestAnimationFrame(()=>{if(epoch.current===current&&root.current){if(read)selectForReading(root.current);else selectAt(root.current,point);}}));}
  catch(error){if(epoch.current!==current)return;const code=error instanceof Error?error.message:'';setValue({...next,busy:false,error:code==='EMPTY'?(zh?'这里未识别到文字，请放大后重试。':'No text found here. Zoom in and try again.'):code==='BUSY'?(zh?'另一项本机识别尚未完成，请稍后重试。':'Another local recognition is running. Try again shortly.'):code==='OCR_UNAVAILABLE'?(zh?'本机文字识别组件暂不可用。':'Local text recognition is unavailable.'):(zh?'暂时无法选取这处文字，请放大并等待页面显示后重试。':'Could not select text here. Zoom in and wait for the page to render, then retry.')});}
  finally{if(epoch.current===current)request.current=null;}
 };
 const startReading=()=>{
  const surface=stage.current;if(!surface||!enabled||value?.busy)return;
  const existing=selected.current?.native||root.current;if(existing&&!value?.error){selectForReading(existing);return;}
  const bounds=rectOf(surface.getBoundingClientRect()),center={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2},preferred=new Set(preferredItemIDs?.()||[]);
  const choices=Array.from(surface.querySelectorAll<HTMLElement>('.board-item')).filter(item=>item.closest('.board-stage')===surface&&(item.matches('.kind-text,.kind-formula,.kind-pdfPage,.kind-inkGroup')||!!item.querySelector('img'))).map(item=>({item,rect:clipped(rectOf(item.getBoundingClientRect()),bounds)})).filter(({rect})=>rect.width>8&&rect.height>8);
  choices.sort((a,b)=>Number(preferred.has(b.item.dataset.boardItem||''))-Number(preferred.has(a.item.dataset.boardItem||''))||Math.hypot(a.rect.x+a.rect.width/2-center.x,a.rect.y+a.rect.height/2-center.y)-Math.hypot(b.rect.x+b.rect.width/2-center.x,b.rect.y+b.rect.height/2-center.y));
  const chosen=choices[0];void begin(chosen?{x:chosen.rect.x+chosen.rect.width/2,y:chosen.rect.y+chosen.rect.height/2}:center,chosen?.item||surface,true);
 };
 const captureDown=(event:ReactPointerEvent<HTMLDivElement>)=>{
  if(!enabled||event.button!==0||event.ctrlKey||event.metaKey||event.altKey)return;const target=event.target as HTMLElement,surface=stage.current;if(!surface||target.closest('.board-stage')!==surface)return;
  if(target.closest('.board-text-actions'))return;
  if(selected.current&&(selected.current.native?.contains(target)||root.current?.contains(target))){event.stopPropagation();return;}
  if(target.closest(controlSelector))return;
  if(value)clear();const point={x:event.clientX,y:event.clientY};
  if(armed){event.preventDefault();event.stopPropagation();void begin(point,target);return;}
  cancelPress();press.current={point,id:event.pointerId,timer:setTimeout(()=>{press.current=null;void begin(point,target);},520)};
 };
 const captureMove=(event:ReactPointerEvent<HTMLDivElement>)=>{const p=press.current;if(p&&Math.hypot(event.clientX-p.point.x,event.clientY-p.point.y)>6)cancelPress();};
 const selectionText=()=>{const s=window.getSelection(),container=selected.current?.native||root.current;return s&&container?.contains(s.anchorNode)&&container?.contains(s.focusNode)?s.toString().trim():'';};
 const copy=async()=>{const text=selectionText();if(!text)return;const current=epoch.current;try{const response=await window.desktop.copyBoardText({text});if(!response.ok)throw Error();if(current===epoch.current)setValue(v=>v?{...v,status:zh?'已复制':'Copied'}:v);}catch{if(current===epoch.current)setValue(v=>v?{...v,status:zh?'复制未完成，请重试':'Copy failed. Try again.'}:v);}};
 const extract=async()=>{const text=selectionText(),v=selected.current;if(!text||!v||!onExtract||extraction.current)return;extraction.current=true;const current=epoch.current;try{await onExtract(text,v.point);if(epoch.current===current)clear();}catch(error){if(epoch.current===current)setValue(v=>v?{...v,status:error instanceof Error?error.message:String(error)}:v);}finally{extraction.current=false;}};
 const speechParts=():SpeechPart[]=>{const container=selected.current?.native||root.current,s=window.getSelection();if(!container||!s||s.isCollapsed||!s.rangeCount||!container.contains(s.anchorNode)||!container.contains(s.focusNode))return[];const range=s.getRangeAt(0),bounds=stage.current!.getBoundingClientRect(),walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT),parts:SpeechPart[]=[];let node:Node|null;while((node=walker.nextNode())&&parts.length<1200){if(!range.intersectsNode(node)||!node.textContent?.trim())continue;const start=node===range.startContainer?range.startOffset:0,end=node===range.endContainer?range.endOffset:node.textContent.length;if(end<=start)continue;const part=document.createRange();part.setStart(node,start);part.setEnd(node,end);const r=part.getBoundingClientRect();const textNode=node;parts.push({text:node.textContent.slice(start,end),rect:{x:(r.left-bounds.left)/displayScale,y:(r.top-bounds.top)/displayScale,width:r.width/displayScale,height:r.height/displayScale},rectAt:(offset,length)=>{const word=document.createRange();word.setStart(textNode,Math.min(end,start+offset));word.setEnd(textNode,Math.min(end,start+offset+length));const b=word.getBoundingClientRect();return{x:(b.left-bounds.left)/displayScale,y:(b.top-bounds.top)/displayScale,width:b.width/displayScale,height:b.height/displayScale};}});}return parts;};
 const actions=value&&<div className="board-text-actions" data-testid="board-text-actions" role="toolbar" aria-label={zh?'所选文字':'Selected text'} style={{left:Math.max(8,Math.min(value.rect.x,((stage.current?.clientWidth||500)-360))),top:Math.max(6,value.rect.y-42)}} onPointerDown={event=>{event.stopPropagation();if(!(event.target as HTMLElement).closest('input,textarea,select'))event.preventDefault();}} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>e.stopPropagation()}>
  {value.busy?<span role="status">{zh?'正在选取本机文字…':'Selecting text locally…'}</span>:value.error?<span role="status">{value.error}</span>:<><button data-testid="board-text-copy" disabled={!hasText} onClick={()=>void copy()}><Copy/>{zh?'复制':'Copy'}</button>{onExtract&&<button data-testid="board-text-extract" disabled={!hasText} onClick={()=>void extract()}><FileText/>{zh?'提取为文字卡':'Extract to text card'}</button>}<button data-testid="board-text-all" onClick={()=>{const container=value.native||root.current;if(container){const range=document.createRange();range.selectNodeContents(container);window.getSelection()?.removeAllRanges();window.getSelection()?.addRange(range);}}}>{zh?'全选':'Select all'}</button><small>{value.status||(value.native?(zh?'拖动选择文字':'Drag to select text'):(zh?'本机识别，请核对原文':'Recognized locally; check the source'))}</small></>}
  <button data-testid="board-text-close" aria-label={zh?'结束选字':'Close text selection'} onClick={clear}><X/></button>
  {!value.native&&!value.busy&&!value.error&&<button data-testid="board-text-proofread" onClick={()=>setProofread(v=>!v)}>{zh?'校对 / 常用词':'Correct / vocabulary'}</button>}
  {proofread&&!value.native&&<div className="board-text-proofread" onKeyDown={event=>event.stopPropagation()}><p>{zh?'修正本次识别文字后，再选取复制、提取或朗读。原图与笔迹不改变。':'Correct recognized text, then select it to copy, extract or read. The image and ink stay unchanged.'}</p>{value.boxes.slice(0,200).map((box,index)=><input key={index} aria-label={(zh?'校对第 ':'Correct line ')+(index+1)} value={box.text} maxLength={1000} onChange={event=>{const text=event.target.value;setValue(v=>v?{...v,boxes:v.boxes.map((b,i)=>i===index?{...b,text}:b)}:v);}}/>)}<label>{zh?'常用词（每行一个，仅保存在本机；下次识别使用）':'Vocabulary (one per line, saved locally for future recognition)'}<textarea data-testid="board-text-vocabulary" value={wordList} maxLength={16000} onChange={event=>{const text=event.target.value;setWordList(text);try{localStorage.setItem('inkspace.ocr.commonWords',text);}catch{}}}/></label><small>{zh?'这是识别词表辅助，不会训练模型；手写和公式仍需核对。':'Vocabulary assists recognition; it does not train the model. Check handwriting and formulas.'}</small></div>}
  {!value.busy&&!value.error&&<BoardSpeech autoStart={autoRead} language={language} getParts={speechParts} onHighlight={setSpeakingRect}/>}
 </div>;
 const overlay=value&&!value.native&&!value.busy&&!value.error&&<div ref={root} className="board-ocr-text" data-testid="board-ocr-text" role="region" aria-label={zh?'可选取的原位文字':'Selectable text in place'} tabIndex={0} style={{left:value.rect.x,top:value.rect.y,width:value.rect.width,height:value.rect.height}} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>{e.preventDefault();e.stopPropagation();}} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();clear();}else if((e.metaKey||e.ctrlKey)&&e.key==='a'){e.preventDefault();const range=document.createRange();range.selectNodeContents(e.currentTarget);window.getSelection()?.removeAllRanges();window.getSelection()?.addRange(range);}}}>{value.boxes.map((box,index)=><OCRLine key={index} box={box} rect={value.rect}/>)}</div>;
 return{clear,captureDown,captureMove,cancelPress,active:armed||!!value,overlay:<>{speakingRect&&<div className="board-speech-highlight" data-testid="board-speech-highlight" style={{left:speakingRect.x,top:speakingRect.y,width:speakingRect.width,height:speakingRect.height}}/>}{overlay}</>,actions,control:<><button className="button" data-testid="board-text-select" disabled={!enabled} aria-pressed={armed||!!value} title={zh?'阅读或管理模式下长按文字，或点击此按钮后点选 PDF、图片、手写处':'Long-press text in Read or Arrange mode, or click this then select a PDF, image or handwriting area'} onClick={()=>{clear();setArmed(v=>!v);}}><ScanText/>{armed?(zh?'点选文字位置':'Choose text location'):(zh?'选取文字':'Select text')}</button><button className="button" data-testid="board-read-aloud" disabled={!enabled||!!value?.busy} title={zh?'朗读选中的资料，或视野中心的文字；图像、PDF和手写会先在本机识别':'Read the selected item or the item nearest the view center; recognize images, PDFs and ink locally first'} onClick={startReading}><Volume2/>{zh?'朗读':'Read aloud'}</button></>};
}

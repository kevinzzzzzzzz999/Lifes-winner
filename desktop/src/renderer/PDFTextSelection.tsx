import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Language} from './i18n';
import './pdf-text-selection.css';
export type PDFSelectableBox={text:string;x:number;y:number;width:number;height:number;rotation?:number};
function TextLine({box,width,height}:{box:PDFSelectableBox;width:number;height:number}){
 const span=useRef<HTMLSpanElement>(null),[scale,setScale]=useState(1),w=box.width*width,h=box.height*height,rotation=box.rotation||0,vertical=rotation===90||rotation===270,lineWidth=vertical?h:w,lineHeight=vertical?w:h;
 useEffect(()=>{if(span.current)setScale(lineWidth/Math.max(1,span.current.scrollWidth));},[box.text,lineWidth,lineHeight]);
 return <span className="pdf-in-place-line" data-text-rotation={rotation} style={{left:box.x*100+'%',top:box.y*100+'%',width:w,height:h}}><span ref={span} style={{left:rotation===90||rotation===180?w:0,top:rotation===180||rotation===270?h:0,fontSize:lineHeight,lineHeight:lineHeight+'px',transform:`rotate(${rotation}deg) scaleX(${scale})`}}>{box.text}</span>{'\n'}</span>;
}
export function PDFSelectableTextLayer({boxes,width,height,from=0,to=1}:{boxes:PDFSelectableBox[];width:number;height:number;from?:number;to?:number}){
 return <div className="pdf-in-place-text" data-testid="pdf-in-place-text" tabIndex={0} onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>{boxes.filter(box=>{const center=box.y+box.height/2;return center>=from&&(to===1?center<=to:center<to);}).map((box,index)=><TextLine key={index} box={box} width={width} height={height}/>)}</div>;
}
/** Owns exactly one displayed PDF page. The helper uses its bounded snapshot:
 * embedded Unicode first, local Vision only when the page has no usable text. */
export function usePDFInPlaceText({root,vaultId,path,sha256,url,page,enabled,language}:{root:RefObject<HTMLDivElement|null>;vaultId?:string;path?:string;sha256?:string;url:string;page:number;enabled:boolean;language:Language}){
 const sourceKey=JSON.stringify([vaultId,path,sha256,url,page]),epoch=useRef(0),request=useRef<string|null>(null),[recognized,setRecognized]=useState<{key:string;boxes:PDFSelectableBox[]}|null>(null),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[hasText,setHasText]=useState(false),[attempt,setAttempt]=useState(0),zh=language==='zh',boxes=enabled&&recognized?.key===sourceKey?recognized.boxes:[];
 useEffect(()=>{const generation=++epoch.current;setRecognized(null);setStatus('');setHasText(false);setBusy(false);if(!enabled||!vaultId||!path)return;
  const id=crypto.randomUUID();request.current=id;setBusy(true);setStatus(zh?'正在读取本页文字；扫描件会在本机识别…':'Reading this page; scanned content is recognized locally…');
  void window.desktop.recognizeLocalOCR({requestId:id,vaultId,path,startPage:page,endPage:page}).then(result=>{
   if(generation!==epoch.current)return;if(!result.ok)throw Error(result.error.code);if(sha256&&result.value.sourceSHA256!==sha256)throw Error('SOURCE_CHANGED');
   if(result.value.cancelled)throw Error('CANCELLED');if(result.value.outputLimited)throw Error('OCR_OUTPUT_LIMIT');const value=result.value.pages[0];if(value?.error&&value.error!=='这一页未识别到文字；请检查清晰度、方向和原文内容。')throw Error('OCR_FAILED');if(!value?.boxes?.length)throw Error(value?.text?'OCR_FAILED':'EMPTY');
   setRecognized({key:sourceKey,boxes:value.boxes});setStatus(zh?'直接拖选文字并复制；识别结果请核对原文。':'Select and copy text in place. Check recognized text against the source.');
  }).catch(error=>{if(generation!==epoch.current)return;const code=error instanceof Error?error.message:'';setStatus(code==='SOURCE_CHANGED'?(zh?'原文件已变化，请刷新此 PDF 后重新选字。':'The source changed. Refresh this PDF before selecting text.'):code==='EMPTY'?(zh?'本页暂未找到文字，可放大原文核对或重试。':'No text found on this page. Inspect the source or retry.'):code==='BUSY'?(zh?'另一处本机识别仍在进行，请稍后重试。':'Another local recognition is running. Retry shortly.'):code==='OCR_UNAVAILABLE'?(zh?'本机文字识别组件不可用，请更新应用后重试。':'The local text component is unavailable. Update the app and retry.'):(zh?'本页文字暂未读取成功，原文件未改变，请重试。':'This page could not be read. The source is unchanged; retry.'));}).finally(()=>{if(generation===epoch.current){request.current=null;setBusy(false);}});
  return()=>{epoch.current++;const selection=window.getSelection();if(root.current?.contains(selection?.anchorNode||null)&&selection?.anchorNode?.parentElement?.closest('.pdf-in-place-text'))selection.removeAllRanges();if(request.current===id){request.current=null;void window.desktop.cancelLocalOCR({requestId:id}).catch(()=>{});}};
 },[vaultId,path,sha256,url,page,enabled,attempt,zh]);
 const selectedText=()=>{const selection=window.getSelection(),anchor=selection?.anchorNode?.parentElement?.closest('.pdf-in-place-text'),focus=selection?.focusNode?.parentElement?.closest('.pdf-in-place-text');return selection&&anchor&&focus&&root.current?.contains(anchor)&&root.current?.contains(focus)?selection.toString().trim():'';};
 useEffect(()=>{const change=()=>setHasText(!!selectedText());document.addEventListener('selectionchange',change);return()=>document.removeEventListener('selectionchange',change);},[root]);
 const copy=async(all=false)=>{const text=all?boxes.map(box=>box.text).join('\n'):selectedText();if(!text)return;const generation=epoch.current;try{const result=await window.desktop.copyBoardText({text});if(generation===epoch.current)setStatus(result.ok?(zh?'已复制，可直接粘贴。':'Copied. Paste it where you need it.'):(zh?'复制未完成，请重试。':'Copy failed. Retry.'));}catch{if(generation===epoch.current)setStatus(zh?'复制未完成，请重试。':'Copy failed. Retry.');}};
 return{boxes,status,busy,hasText:enabled&&recognized?.key===sourceKey&&hasText,copy,retry:()=>setAttempt(value=>value+1)};
}

import {memo,useCallback,useEffect,useMemo,useState} from 'react';
import type {Language} from './i18n';
import {PDFPage} from './PDFViewer';
import BoxContent from './BoxContent';
import {planBoardPDFRegions,type PDFRenderRegion} from './board-pdf-resolution';
import {REPLAY_BACKGROUND_LIMITS,replayBackgroundPlan,replayPosition,type ReplayCamera,type ReplayItem,type ReplaySize} from './ink-replay-camera';
import {ReplayAssets} from './replay-assets';
const safeColor=(value:string|undefined,fallback:string)=>/^#[\da-f]{6}$/i.test(value||'')?value:fallback;
type BackgroundState='loading'|'ready'|'failed';
function ReplayAsset({item,assets,region,language,onStatus}:{item:ReplayItem;assets:ReplayAssets;region?:PDFRenderRegion;language:Language;onStatus:(id:string,state:BackgroundState)=>void}){
 const zh=language==='zh',[url,setURL]=useState(''),[state,setState]=useState<BackgroundState>('loading');
 const report=(next:BackgroundState)=>{setState(next);onStatus(item.id,next);};
 useEffect(()=>{let live=true;const controller=new AbortController();setURL('');report('loading');void assets.load(item.sourcePath||'',item.kind==='pdfPage',controller.signal).then(value=>{if(live)setURL(value);}).catch(()=>{if(live)report('failed');});return()=>{live=false;controller.abort();};},[assets,item.sourcePath,item.kind,item.id,onStatus]);
 const pdf=item.kind==='pdfPage';
 return <>{!item.boardNotesObject&&<div className="replay-asset-label">{item.title}{pdf?` · ${item.page||1}`:''}</div>}{state!=='ready'&&<small className={`replay-asset-status ${state==='failed'?'is-failed':''}`} role="status">{state==='failed'?(zh?'背景不可用，笔迹仍可回放':'Background unavailable; ink still plays'):(zh?'正在读取背景…':'Loading background…')}</small>}{url&&(pdf?region&&<PDFPage url={url} page={item.page||1} region={region} annotationMode={1} onRendered={()=>report('ready')} onFailure={()=>report('failed')}/>:<img src={url} alt={item.title||''} draggable={false} onLoad={()=>report('ready')} onError={()=>report('failed')}/> )}</>;
}
/** This layer has no mutation or open-file callbacks. Only visible materials load. */
export default memo(function ReplayBackgrounds({items,camera,size,assets,language,onSummary}:{items:ReplayItem[];camera:ReplayCamera;size:ReplaySize;assets:ReplayAssets;language:Language;onSummary:(text:string)=>void}){
 const[states,setStates]=useState<Record<string,BackgroundState>>({});
 const onStatus=useCallback((id:string,state:BackgroundState)=>setStates(previous=>previous[id]===state?previous:Object.fromEntries([...Object.entries(previous).filter(([key])=>key!==id).slice(-31),[id,state]])),[]);
 const plan=useMemo(()=>replayBackgroundPlan(items,camera,size),[items,camera,size]);
 const regions=useMemo(()=>planBoardPDFRegions(plan.pdf.map(i=>({id:i.id,...replayPosition(i,camera,size)})),size,1,window.devicePixelRatio||1,REPLAY_BACKGROUND_LIMITS.pixels),[plan,camera,size]);
 useEffect(()=>{const external=plan.details.filter(i=>i.kind==='pdfPage'||i.kind==='document'&&/\.(png|jpe?g)$/i.test(i.sourcePath||'')),failed=external.filter(i=>states[i.id]==='failed').length,ready=external.filter(i=>states[i.id]==='ready').length,pending=external.length-failed-ready;onSummary(language==='zh'?`背景：${ready} 处已显示${pending?`，${pending} 处读取中`:''}${failed?`，${failed} 处不可用（笔迹仍可回放）`:''}`:`Backgrounds: ${ready} ready${pending?`, ${pending} loading`:''}${failed?`, ${failed} unavailable (ink still plays)`:''}`);},[plan,states,language,onSummary]);
 const shown=new Set(plan.details.map(i=>i.id)),zh=language==='zh';
 return <div className="replay-backgrounds" aria-hidden="true" inert data-testid="replay-backgrounds" data-visible-count={plan.visible.length} data-detail-count={plan.details.length}>
 {plan.visible.filter(i=>!shown.has(i.id)).slice(0,2000).map(i=>{const p=replayPosition(i,camera,size);return <div key={i.id} className="replay-background-placeholder" style={{left:p.x,top:p.y,width:p.width,height:p.height}}/>;})}
 {plan.details.map(item=>{const p=replayPosition(item,camera,size),pdf=item.kind==='pdfPage',image=item.kind==='document'&&/\.(png|jpe?g)$/i.test(item.sourcePath||'');return <div key={item.id} data-replay-item={item.id} className={`replay-background-item ${pdf?'is-pdf':image?'is-image':'is-text'}${image&&item.boardNotesObject?' boardnotes-image':''}`} style={{left:p.x,top:p.y,width:p.width,height:p.height,background:safeColor(item.style?.fillColor,'#fff'),color:safeColor(item.style?.textColor,'#233c36'),borderColor:safeColor(item.style?.strokeColor,'#cbd6d2')}}>
 {pdf||image?<ReplayAsset item={item} assets={assets} region={regions.get(item.id)} language={language} onStatus={onStatus}/>:<div className="replay-text-content" style={{width:item.width,height:item.height,transform:`scale(${camera.zoom})`,fontSize:item.style?.fontSize||16}}><strong>{item.title}</strong>{item.kind==='text'||item.kind==='formula'?<BoxContent text={item.text||''} textFormat={item.textFormat} richTextHTML={item.richTextHTML} fallbackKind={item.kind}/>:<p>{item.sourcePath||item.text||''}{item.childBoards?.length?` · ${zh?'子白板内容请单独回放':'Replay child board separately'}`:''}</p>}</div>}
 </div>;})}
 </div>;
});

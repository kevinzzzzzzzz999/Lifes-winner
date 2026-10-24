import { useEffect,useLayoutEffect,useRef,useState,type MutableRefObject } from 'react';
import { X,RefreshCw,Scan,ClipboardPaste,Copy,MessageSquare,PanelRightClose } from 'lucide-react';
import { Button } from './ui';
import type { Language } from './i18n';
import type {AIWebStatus} from '../shared/desktop-api';
const aiText={title:['ChatGPT 网页','ChatGPT web'],login:['在下方网页登录你的 ChatGPT 账号。','Sign in to your ChatGPT account below.'],lasso:['矩形框选','Select rectangle'],paste:['放入 AI 输入框','Paste into AI composer'],copied:['已复制截图。若输入框未出现图片，请点击输入框后粘贴。','Screenshot copied. If no image appears, click the composer and paste.'],attempted:['已尝试放入输入框；若未出现图片，请点击输入框后手动粘贴。','Paste requested. If no image appears, click the composer and paste manually.'],confirmed:['输入框中检测到新图片附件，尚未发送。请补充问题后在网页中发送。','A new image attachment was detected in the composer. Add your question and send it on the webpage.'],hint:['拖出矩形后松开，截图会直接放入当前 AI 输入框；也可拖动下方图片附件。消息由你发送。','Release a rectangle to attach its capture to the current AI composer. You can also drag the capture as an image file. You send the message.'],loading:['正在打开网页…','Opening website…'],failed:['网页暂时无法加载。请检查网络后重试。','The website could not load. Check the network and retry.'],slow:['网页加载较慢，可稍候或刷新重试。','The website is taking longer to load. Wait or reload to retry.'],close:['折叠 AI 助手','Collapse AI assistant'],refresh:['刷新网页','Reload website']} as const;
const pasteReasonText={
 unsupported:['已复制图片；此 AI 请在网页输入框中粘贴或拖入。','Image copied. Paste or drag it into this AI composer.'],
 providerChanged:['AI 已切换，请重新框选后放入。','AI changed. Select a new capture and retry.'],
 notVisible:['请展开 AI 网页后重试。','Open the AI webpage and retry.'],
 navigation:['网页正在切换，请等对话加载完成后重试。','Wait for this conversation to finish loading, then retry.'],
 composerMissing:['未找到可用的 ChatGPT 输入框，请打开对话后重试。图片已复制。','No ChatGPT composer is ready. Open a conversation and retry. Image copied.'],
 composerFocus:['未能选中网页输入框，请先点一下输入框后重试。图片已复制。','Click the webpage composer and retry. Image copied.'],
 nativeFocus:['网页尚未取得键盘焦点，请先点一下输入框后重试。图片已复制。','Click the webpage composer to focus it, then retry. Image copied.'],
 clipboardMismatch:['剪贴板已变化，请重新点击放入图片。','Clipboard changed. Click Paste into AI composer again.'],
 pasteFailed:['系统未能粘贴图片，可拖动截图到输入框重试。','System paste failed. Drag the capture into the composer.'],
 cancelled:['操作已取消，可重新放入当前截图。','Operation cancelled. Retry the current capture.'],
} as const;
type AIVisibilityRequest={visible:boolean;bounds?:{x:number;y:number;width:number;height:number}};

/** One shared native view: serialize IPC and discard superseded layout replies. */
export function createAIVisibilityCoordinator(send:(request:AIVisibilityRequest)=>Promise<{ok:boolean;value?:{visible:boolean}}>){
 let version=0;let draining=false;
 let desired:{version:number;request:AIVisibilityRequest;resolve:(applied:boolean)=>void}|null=null;
 const drain=async()=>{
  if(draining)return;draining=true;
  try{while(desired){const next=desired;desired=null;let applied=false;
   try{const result=await send(next.request);applied=result.ok&&result.value?.visible===next.request.visible&&next.version===version;}catch{/* A later layout/focus update may retry. */}
   next.resolve(applied);
  }}finally{draining=false;}
 };
 return (request:AIVisibilityRequest)=>new Promise<boolean>(resolve=>{
  desired?.resolve(false);desired={version:++version,request,resolve};void drain();
 });
}
const setNativeVisibility=createAIVisibilityCoordinator(request=>window.desktop.aiSetVisible(request));
let activePanelOwner:symbol|null=null;

type AIWebPanelProps={language:Language;onClose:()=>void;onLasso:()=>void;capture:string|null;captureNonce?:number;blocked:boolean;lastAutoPasted:MutableRefObject<string|null>;collapsed?:boolean;resizing?:boolean;layoutRevision?:string|number};
export function AIWebPanel({language,onClose,onLasso,capture,captureNonce=0,blocked,lastAutoPasted,collapsed=false,resizing=false,layoutRevision=0}:AIWebPanelProps){
 const body=useRef<HTMLDivElement>(null);const owner=useRef(Symbol('ai-panel'));
 const alive=useRef(false);const lastLayout=useRef('');const scheduled=useRef<number|null>(null);
 const captureProvider=useRef<AIWebStatus['provider']|null>(null);
 const pasteSequence=useRef(0);const pollSequence=useRef(0);const layoutSequence=useRef(0);
 const hidden=collapsed||resizing||blocked;
 const[status,setStatus]=useState('');const[network,setNetwork]=useState<AIWebStatus>({provider:'chatgpt',label:'ChatGPT',pasteMode:'composer',visible:false,loading:true,loadError:false,url:'https://chatgpt.com'});
 const latest=useRef({hidden,capture,captureNonce,language,provider:network.provider});latest.current={hidden,capture,captureNonce,language,provider:network.provider};
 const[viewReady,setViewReady]=useState(false);
 const t=(key:keyof typeof aiText)=>aiText[key][language==='zh'?0:1];
 const sync=useRef<()=>void>(()=>{});
 sync.current=()=>{
  if(!alive.current||activePanelOwner!==owner.current)return;
  const r=body.current?.getBoundingClientRect();
  // Only show a positive on-screen host. Dragging keeps this DOM mounted while
  // hiding the native webpage, so it cannot intercept the separator's pointer.
  const x=Math.max(0,Math.floor(r?.x||0)),y=Math.max(0,Math.floor(r?.y||0));
  const width=Math.max(0,Math.floor(Math.min(r?.right||0,window.innerWidth))-x);
  const height=Math.max(0,Math.floor(Math.min(r?.bottom||0,window.innerHeight))-y);
  const visible=!latest.current.hidden&&!!r&&width>=2&&height>=2;
  const request:AIVisibilityRequest=visible?{visible:true,bounds:{x,y,width,height}}:{visible:false};
  const key=JSON.stringify(request);if(key===lastLayout.current)return;lastLayout.current=key;const sequence=++layoutSequence.current;
  setViewReady(false);
  void setNativeVisibility(request).then(applied=>{
   if(!alive.current||activePanelOwner!==owner.current||layoutSequence.current!==sequence||lastLayout.current!==key)return;
   if(applied)setViewReady(visible&&!latest.current.hidden);
   else lastLayout.current='';
  });
 };
 const schedule=useRef<()=>void>(()=>{});
 schedule.current=()=>{if(scheduled.current!==null)return;scheduled.current=requestAnimationFrame(()=>{scheduled.current=null;sync.current();});};
 useLayoutEffect(()=>{
  alive.current=true;activePanelOwner=owner.current;lastLayout.current='';
  const onLayout=()=>schedule.current();
  const observer=new ResizeObserver(onLayout);if(body.current)observer.observe(body.current);
  window.addEventListener('resize',onLayout);window.addEventListener('focus',onLayout);
  window.addEventListener('scroll',onLayout,true);sync.current();
  return()=>{
   alive.current=false;pollSequence.current++;observer.disconnect();
   window.removeEventListener('resize',onLayout);window.removeEventListener('focus',onLayout);window.removeEventListener('scroll',onLayout,true);
   if(scheduled.current!==null){cancelAnimationFrame(scheduled.current);scheduled.current=null;}
   if(activePanelOwner===owner.current){activePanelOwner=null;void setNativeVisibility({visible:false});}
  };
 },[]);
 // Parent position can change without ResizeObserver reporting a size change.
 // No cleanup hide on updates: only a real collapse, drag, modal or unmount hides.
 useLayoutEffect(()=>{pollSequence.current++;sync.current();schedule.current();},[hidden,layoutRevision]);
 useEffect(()=>{
  const off=window.desktop.onAIWebProviderChanged(info=>{const provider=info.providers.find(value=>value.id===info.provider);if(!provider||!alive.current)return;pasteSequence.current++;pollSequence.current++;setStatus('');setViewReady(false);lastLayout.current='';setNetwork(value=>({...value,provider:provider.id,label:provider.label,pasteMode:provider.pasteMode,url:provider.url,loading:false,loadError:false,download:undefined}));schedule.current();});
  const poll=()=>{
   if(latest.current.hidden)return;const sequence=++pollSequence.current;
   void window.desktop.aiStatus().then(result=>{
    if(alive.current&&!latest.current.hidden&&sequence===pollSequence.current&&result.ok)setNetwork(result.value);
   }).catch(()=>{});
   sync.current();
  };
  poll();const timer=setInterval(poll,2000);return()=>{off();pollSequence.current++;clearInterval(timer);};
 },[]);
 const paste=(dataURL:string,copyOnly=false)=>{
  if(latest.current.hidden||(!copyOnly&&!viewReady)||!alive.current)return false;
  const sequence=++pasteSequence.current,provider=latest.current.provider,nonce=latest.current.captureNonce;
  if(!copyOnly)setStatus(latest.current.language==='zh'?'正在放入图片附件…':'Attaching image…');
  void window.desktop.aiPasteImage({dataURL,provider,copyOnly}).then(result=>{
   if(!alive.current||sequence!==pasteSequence.current||latest.current.capture!==dataURL||latest.current.captureNonce!==nonce||latest.current.provider!==provider)return;
   const lang=latest.current.language==='zh'?0:1;setStatus(result.ok?(result.value.reason?pasteReasonText[result.value.reason][lang]:aiText[result.value.attachmentConfirmed?'confirmed':result.value.pasteAttempted?'attempted':'copied'][lang]):result.error.message);
  }).catch(()=>{if(alive.current&&sequence===pasteSequence.current&&latest.current.capture===dataURL&&latest.current.captureNonce===nonce&&latest.current.provider===provider)setStatus(aiText.failed[latest.current.language==='zh'?0:1]);});
  return true;
 };
 useEffect(()=>{setStatus('');lastAutoPasted.current=null;captureProvider.current=latest.current.provider;},[capture,captureNonce]);
 useEffect(()=>{
  if(!capture||hidden||!viewReady||network.loading||network.loadError||network.loadTimedOut||captureProvider.current!==network.provider)return;
  const key=String(captureNonce)+':'+capture;if(lastAutoPasted.current===key)return;
  // Record before issuing IPC so layout changes cannot attach the same selection twice.
  lastAutoPasted.current=key;if(!paste(capture))lastAutoPasted.current=null;
 },[capture,captureNonce,hidden,viewReady,network.loading,network.loadError,network.loadTimedOut,network.provider]);
 const dragImage=(dataURL:string)=>{
  if(latest.current.hidden)return;const provider=latest.current.provider,nonce=latest.current.captureNonce;
  void window.desktop.aiDragImage({provider,dataURL}).then(result=>{if(!alive.current||latest.current.capture!==dataURL||latest.current.captureNonce!==nonce)return;if(!result.ok)setStatus(result.error.message);}).catch(()=>{if(alive.current&&latest.current.captureNonce===nonce)setStatus(language==='zh'?'图片拖动未开始；可使用“放入 AI 输入框”重试。':'Image drag did not start. Use Paste into AI composer to retry.');});
 };
 const reload=()=>{
  if(latest.current.hidden||!viewReady)return;
  setNetwork(value=>({...value,loading:true,loadError:false,pageState:'loading',loadTimedOut:false}));
  void window.desktop.aiReload().then(result=>{if(alive.current&&!latest.current.hidden&&!result.ok)setStatus(result.error.message);}).catch(()=>{if(alive.current&&!latest.current.hidden)setStatus(aiText.failed[latest.current.language==='zh'?0:1]);});
 };
 return <aside id="chatgpt-sidebar" className="ai-panel" data-testid="ai-panel" data-collapsed={collapsed} data-resizing={resizing} hidden={collapsed} style={collapsed?{display:'none'}:undefined}>
  <header><MessageSquare/><strong data-testid="ai-provider-title">{network.label}{language==='zh'?' 网页':' web'}</strong><span className="spacer"/><Button data-testid="ai-reload" disabled={hidden||!viewReady} aria-label={t('refresh')} title={t('refresh')} onClick={reload}><RefreshCw/></Button><Button data-testid="ai-collapse" aria-label={t('close')} title={t('close')} onClick={onClose}><PanelRightClose/></Button></header>
  <p>{language==='zh'?'在网页内自行登录；下次打开仍使用当前 AI。':'Sign in on the webpage. The same AI opens next time.'}</p>{(network.loadError||network.loadTimedOut||network.loading)&&<p role="status" data-testid="ai-network-status">{network.pageState==='closed'||network.pageState==='crashed'?(language==='zh'?'AI 网页意外停止，请点击右上角刷新恢复当前对话。':'The AI webpage stopped unexpectedly. Reload to reopen this conversation.'):network.loadError?t('failed'):network.loadTimedOut?t('slow'):t('loading')}</p>}
  {network.download&&<p role="status" data-testid="ai-download-status" style={{overflowWrap:'anywhere'}}>{({saving:language==='zh'?'正在下载，请在系统面板选择保存位置。':'Downloading; choose a save location in the system dialog.',completed:language==='zh'?'下载已保存。':'Download saved.',cancelled:language==='zh'?'已取消下载。':'Download cancelled.',failed:language==='zh'?'下载未完成，请在网页重试。':'Download failed. Retry on the webpage.'})[network.download.state]}{' '}{network.download.filename}</p>}
  {network.audioPermission&&network.audioPermission!=='granted'&&<p role="status" data-testid="ai-audio-permission-status">{({prompting:language==='zh'?'请在系统提示中确认是否允许使用麦克风。':'Confirm microphone access in the system prompt.','system-denied':language==='zh'?'麦克风被系统禁用。请在“系统设置 → 隐私与安全性 → 麦克风”中允许“人生赢家”，然后重新启动应用。':"Microphone access is disabled. Allow Life's winner (人生赢家) in System Settings → Privacy & Security → Microphone, then restart the app.",'system-restricted':language==='zh'?'麦克风受到系统或设备管理策略限制。请检查系统的隐私设置。':'Microphone access is restricted by system or device management policy.',cancelled:language==='zh'?'本次没有允许麦克风；需要时可再次点击网页的麦克风按钮。':'Microphone access was not allowed this time. Click the website microphone again to retry.',unavailable:language==='zh'?'麦克风暂不可用，请检查系统麦克风设备后重试。':'Microphone is unavailable. Check the system input device and retry.'})[network.audioPermission]}</p>}
  <div className="ai-web-host" data-testid="ai-web-host" ref={body}/>
  <div className="ai-capture"><Button data-testid="ai-select-image" disabled={hidden} onClick={()=>{if(!latest.current.hidden)onLasso();}}><Scan/>{t('lasso')}</Button>{capture&&<><img data-testid="ai-capture-image" draggable src={capture} alt={language==='zh'?'可拖动的截图图片附件':'Draggable capture image attachment'} title={language==='zh'?'拖到 AI 输入框上传图片':'Drag into the AI composer to upload the image'} onDragStart={event=>{event.preventDefault();dragImage(capture);}}/><Button data-testid="ai-copy-image" disabled={hidden} onClick={()=>paste(capture,true)}><Copy/>{language==='zh'?'复制截图':'Copy capture'}</Button><Button data-testid="ai-paste-image" disabled={hidden||!viewReady} className="primary" onClick={()=>paste(capture)}><ClipboardPaste/>{t('paste')}</Button></>}<p role="status" data-testid="ai-paste-status">{status||t('hint')}{!status&&network.pasteMode==='manual'&&(language==='zh'?' 此服务将复制截图，请在网页输入框中手动粘贴。':' For this service, the capture is copied for you to paste manually on the webpage.')}</p></div>
 </aside>;
}
type CapturePoint={x:number;y:number};
type CaptureRectangle=CapturePoint&{width:number;height:number};
export function LassoOverlay({area,onComplete,onCancel,language='zh'}:{area:DOMRect;onComplete:(dataURL:string)=>void;onCancel:()=>void;language?:Language}){
 const zh=language==='zh',layer=useRef<HTMLDivElement>(null),alive=useRef(true),operation=useRef(0),capturing=useRef(false),selected=useRef<CaptureRectangle|null>(null);
 const [selection,setSelection]=useState<CaptureRectangle|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const drag=useRef<{start:CapturePoint;rect:CaptureRectangle|null;mode:'new'|'move'|'resize';anchor:CapturePoint}|null>(null);
 const rectangle=(a:CapturePoint,b:CapturePoint)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
 const point=(event:{clientX:number;clientY:number})=>({x:Math.max(0,Math.min(area.width,event.clientX-area.x)),y:Math.max(0,Math.min(area.height,event.clientY-area.y))});
 const select=(rect:CaptureRectangle|null)=>{selected.current=rect;setSelection(rect);};
 useEffect(()=>{alive.current=true;layer.current?.focus({preventScroll:true});return()=>{alive.current=false;operation.current++;};},[]);
 const cancel=()=>{operation.current++;onCancel();};
 const capture=async(rect=selected.current)=>{
  if(!rect||rect.width<8||rect.height<8||capturing.current)return;capturing.current=true;setBusy(true);setError('');const request=++operation.current;
  // Hide selection chrome before capturing the actual document pixels.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(!alive.current||request!==operation.current)return;
  try{const result=await window.desktop.captureSelection({rect:{x:area.x+rect.x,y:area.y+rect.y,width:rect.width,height:rect.height}});if(!alive.current||request!==operation.current)return;if(!result.ok)throw Error(result.error.message);onComplete(result.value.dataURL);}
  catch(error){if(alive.current&&request===operation.current){capturing.current=false;setBusy(false);setError(error instanceof Error?error.message:String(error));}}
 };
 const move=(current:NonNullable<typeof drag.current>,next:CapturePoint)=>{if(current.mode==='move'&&current.rect){const rect=current.rect;return {...rect,x:Math.max(0,Math.min(area.width-rect.width,rect.x+next.x-current.start.x)),y:Math.max(0,Math.min(area.height-rect.height,rect.y+next.y-current.start.y))};}return rectangle(current.anchor,next);};
 return <div ref={layer} className={`lasso-layer ${busy?'capturing':''}`} data-testid="rectangle-capture" style={{left:area.x,top:area.y,width:area.width,height:area.height}} tabIndex={0}
  onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Escape'){event.preventDefault();cancel();}else if(event.key==='Enter'){event.preventDefault();void capture();}}}
  onPointerDown={event=>{if(capturing.current||event.button!==0)return;event.preventDefault();const start=point(event);let mode:'new'|'move'|'resize'='new',anchor=start;
   if(selection){const corners=[{x:selection.x,y:selection.y},{x:selection.x+selection.width,y:selection.y},{x:selection.x,y:selection.y+selection.height},{x:selection.x+selection.width,y:selection.y+selection.height}];const corner=corners.find(value=>Math.hypot(value.x-start.x,value.y-start.y)<14);if(corner){mode='resize';anchor={x:corner.x===selection.x?selection.x+selection.width:selection.x,y:corner.y===selection.y?selection.y+selection.height:selection.y};}else if(start.x>=selection.x&&start.x<=selection.x+selection.width&&start.y>=selection.y&&start.y<=selection.y+selection.height)mode='move';}
   drag.current={start,rect:selection,mode,anchor};if(mode==='new')select(rectangle(start,start));setError('');event.currentTarget.setPointerCapture(event.pointerId);
  }}
  onPointerMove={event=>{const current=drag.current;if(current&&!capturing.current)select(move(current,point(event)));}}
  onPointerUp={event=>{const current=drag.current;drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(!current||capturing.current)return;const rect=move(current,point(event));select(rect);void capture(rect);}}
  onPointerCancel={()=>{drag.current=null;}}>
  <svg width="100%" height="100%">{selection&&<rect {...selection} fill="#087f7a18" stroke="#087f7a" strokeWidth="2" strokeDasharray="6 4"/>}</svg>
  <div style={{position:'absolute',right:12,top:10,display:'flex',gap:8,alignItems:'center',padding:8,background:'white',borderRadius:8}} onPointerDown={event=>event.stopPropagation()}>
   <span style={{fontSize:12}}>{error||(zh?'拖出矩形，松开后直接放入 AI 输入框':'Drag a rectangle; release to attach it to AI')}</span>{error&&selection&&<Button disabled={busy} onClick={()=>void capture()}>{zh?'重试截图':'Retry capture'}</Button>}<Button onClick={cancel}><X/>Esc</Button>
  </div>
 </div>;
}

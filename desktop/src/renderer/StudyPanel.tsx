import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {BookOpen,ChevronDown,ChevronRight,RefreshCw,X} from 'lucide-react';
import {Button,basename} from './ui';
import type {Language} from './i18n';
import type {StudyCard,StudyEvent,StudyProjection} from '../shared/study';
import {sourceReference} from './GraphWorkspace';
import type {PDFSourceReference} from '../shared/pdf-extend';
import {clozeParts,linkedTitles,nodeAnswer,nodeImagePath,studyNodes,studyOutline,validCloze} from './study-outline';
import './study.css';
import StudyImageAnswer from './StudyImageAnswer';
import {StudyBlocks,StudyBlocksEditor} from './StudyContentBlocks';
import StudyTransferPanel from './StudyTransferPanel';
import type {OpenedFile} from '../shared/desktop-api';

type Props={vaultId:string;path:string;board:Record<string,unknown>;language:Language;focusItem?:{id:string;nonce:number};
 onImported:(file:OpenedFile)=>void;onRecallCover?:(covered:boolean)=>void;onClose:()=>void;onPrepare:()=>Promise<void>;onStateChange:(state:{dirty:boolean;busy:boolean})=>void;
 onLocate:(id:string)=>void;onSource:(path:string,reference?:PDFSourceReference)=>Promise<void>;
 onOutlineChange:(id:string,title:string,parentID:string|null,previousParentID:string|null)=>Promise<void>};
type Draft={itemID:string;card:StudyCard};
type NodeDraft={id:string;title:string;parentID:string|null;previousParentID:string|null};
const lower=(v:string)=>v.toLowerCase();
function deviceID(){const key='inkspace.study.device-id';let id=localStorage.getItem(key);if(!id){id=crypto.randomUUID();localStorage.setItem(key,id);}return id;}
export default function StudyPanel(p:Props){
 const zh=p.language==='zh',tr=(a:string,b:string)=>zh?a:b;
 const [frontReady,setFrontReady]=useState(false),[backReady,setBackReady]=useState(false);
 const [transferOpen,setTransferOpen]=useState(false),[imageReady,setImageReady]=useState('');
 const [projection,setProjection]=useState<StudyProjection|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [tab,setTab]=useState<'outline'|'review'>('outline'),[query,setQuery]=useState(''),[collapsed,setCollapsed]=useState(new Set<string>()),[selected,setSelected]=useState('');
 const [draft,setDraft]=useState<Draft|null>(null),[nodeDraft,setNodeDraft]=useState<NodeDraft|null>(null),[pending,setPending]=useState<StudyEvent|null>(null),[discard,setDiscard]=useState(false);
 const [queue,setQueue]=useState<string[]>([]),[index,setIndex]=useState(0),[revealed,setRevealed]=useState(false),[completed,setCompleted]=useState(0),[allCards,setAllCards]=useState(false),[showContext,setShowContext]=useState(false),[clock,setClock]=useState(Date.now());
 const live=useRef(true),epoch=useRef(0),readLock=useRef(false),writeLock=useRef(false),state=useRef({draft,nodeDraft,pending});state.current={draft,nodeDraft,pending};
 const callbacks=useRef(p);callbacks.current=p;
 const dirty=!!draft||!!nodeDraft||!!pending||transferOpen;
 useEffect(()=>{p.onStateChange({dirty,busy});},[dirty,busy,p.onStateChange]);
 const nodes=useMemo(()=>studyNodes(p.board),[p.board]),outline=useMemo(()=>studyOutline(p.board),[p.board]);
 const byID=useMemo(()=>new Map(nodes.map(n=>[lower(n.id),n])),[nodes]);
 const incomplete=!!projection?.warnings.length;
 const cards=projection?.cards||[],current=cards.find(c=>lower(c.itemID)===lower(queue[index]||'')),currentNode=current?byID.get(lower(current.itemID)):undefined;
 const active=nodes.find(n=>lower(n.id)===lower(selected)),cardFor=(id:string)=>cards.find(c=>lower(c.itemID)===lower(id));
 const related=useMemo(()=>active?linkedTitles(active,nodes):[],[active,nodes]);
 const reload=useCallback(async()=>{
  if(readLock.current||writeLock.current||state.current.draft||state.current.nodeDraft||state.current.pending)return;
  readLock.current=true;const n=++epoch.current;setLoading(true);
  try{const r=await window.desktop.readStudy({vaultId:p.vaultId,path:p.path});if(!live.current||n!==epoch.current||state.current.draft||state.current.nodeDraft||state.current.pending)return;
   if(!r.ok)throw Error(r.error.code);setProjection(r.value);setError('');setClock(Date.now());
  }catch{if(live.current&&n===epoch.current)setError(zh?'复习记录暂不可读，原记录已保留。请重试。':'Study records are unavailable and have been preserved. Retry.');}
  finally{readLock.current=false;if(live.current)setLoading(false);}
 },[p.vaultId,p.path,zh]);
 useEffect(()=>{live.current=true;void reload();const timer=setInterval(()=>{setClock(Date.now());void reload();},30000),refresh=()=>void reload();window.addEventListener('focus',refresh);
  const off=window.desktop.onVaultChange?.(e=>{if(e.vaultId===p.vaultId)void reload();});return()=>{live.current=false;epoch.current++;clearInterval(timer);window.removeEventListener('focus',refresh);off?.();callbacks.current.onStateChange({dirty:false,busy:false});callbacks.current.onRecallCover?.(false);};
 },[reload,p.vaultId]);
 useEffect(()=>{if(p.focusItem&&!dirty&&!writeLock.current){setTab('outline');setSelected(p.focusItem.id);}},[p.focusItem?.nonce]);
 const markDraft=(value:Draft|null)=>{state.current.draft=value;setDraft(value);p.onStateChange({dirty:!!value||!!nodeDraft||!!pending,busy});};
 const markNode=(value:NodeDraft|null)=>{state.current.nodeDraft=value;setNodeDraft(value);p.onStateChange({dirty:!!value||!!draft||!!pending,busy});};
 const event=(itemID:string,kind:StudyEvent['kind'],extra:Partial<StudyEvent>={}):StudyEvent=>({schemaVersion:1,id:crypto.randomUUID(),deviceID:deviceID(),createdAt:new Date().toISOString(),boardID:String(p.board.id),itemID,kind,...extra});
 const publish=async(e:StudyEvent)=>{
  if(writeLock.current||incomplete||e.kind==='grade'&&(!blocksReady||!!currentImage&&imageReady!==imageKey))return;writeLock.current=true;epoch.current++;state.current.pending=e;setPending(e);setBusy(true);p.onStateChange({dirty:true,busy:true});setError('');
  try{await p.onPrepare();const r=await window.desktop.appendStudy({vaultId:p.vaultId,path:p.path,event:e});if(!r.ok)throw Error(r.error.code);if(!live.current)return;
   setProjection(r.value);setDraft(null);setNodeDraft(null);state.current={draft:null,nodeDraft:null,pending:null};setPending(null);setDiscard(false);setClock(Date.now());
   if(e.kind==='grade'){setCompleted(n=>n+1);setIndex(n=>n+1);setRevealed(false);}else if(e.kind==='delete'){setQueue(q=>q.filter(id=>lower(id)!==lower(e.itemID)));setIndex(0);setRevealed(false);}
  }catch{if(live.current)setError(tr('保存未确认，当前卡片和草稿已保留。重试不会重复记分。','Save is unconfirmed. Card and draft retained; retrying will not double-count.'));}
  finally{writeLock.current=false;if(live.current){setBusy(false);p.onStateChange({dirty:!!state.current.pending||!!state.current.draft||!!state.current.nodeDraft,busy:false});}}
 };
 const create=(id:string)=>{if(dirty||busy||!projection||incomplete)return;const node=byID.get(lower(id));if(!node)return;
  const saved=cardFor(id);markDraft({itemID:id,card:saved?structuredClone(saved.card):{mode:'qa',question:tr('回忆这个知识点。','Recall this concept.'),answer:'',answerMode:nodeImagePath(node)||nodeAnswer(node).trim()?'node':'custom'}});setError('');setDiscard(false);};
 const discardDraft=()=>{if(busy)return;setDraft(null);setNodeDraft(null);setPending(null);state.current={draft:null,nodeDraft:null,pending:null};setDiscard(false);setError('');p.onStateChange({dirty:false,busy:false});void reload();};
 const close=()=>{if(busy)return;if(dirty){setDiscard(true);return;}p.onClose();};
 const start=()=>{const selected=cards.filter(c=>!c.missingNode&&byID.has(lower(c.itemID))&&(allCards||Date.parse(c.dueAt)<=clock));setQueue(selected.map(c=>c.itemID));setIndex(0);setCompleted(0);setRevealed(false);setShowContext(false);setTab('review');};
 const goSource=async(id:string)=>{if(dirty||busy)return;const node=byID.get(lower(id));if(!node)return;const ref=sourceReference(node),path=ref?.path||String(node.originalSourcePath||node.sourcePath||'');if(!path)return;
  setShowContext(true);try{await p.onSource(path,ref);}catch{setError(tr('原文暂不可读。请等待 iCloud 下载后重试，复习位置已保留。','Source unavailable. Wait for iCloud and retry; your review position is retained.'));}};
 const updateOutline=async()=>{if(!nodeDraft||busy)return;writeLock.current=true;setBusy(true);p.onStateChange({dirty:true,busy:true});
  try{await p.onOutlineChange(nodeDraft.id,nodeDraft.title,nodeDraft.parentID,nodeDraft.previousParentID);if(live.current){state.current.nodeDraft=null;setNodeDraft(null);setError('');}}
  catch{if(live.current)setError(tr('大纲修改没有保存，草稿已保留。请检查父子关系或重试。','Outline not saved. Draft retained. Check the parent relationship or retry.'));}
  finally{writeLock.current=false;if(live.current){setBusy(false);p.onStateChange({dirty:!!state.current.nodeDraft,busy:false});}}
 };
 const filtered=outline.filter((r,i)=>{if(query.trim())return(r.node.title+' '+nodeAnswer(r.node)).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());for(let j=i-1;j>=0;j--){if(outline[j].depth<r.depth){if(collapsed.has(lower(outline[j].node.id)))return false;r=outline[j];}}return true;});
 const due=cards.filter(c=>!c.missingNode&&byID.has(lower(c.itemID))&&Date.parse(c.dueAt)<=clock).length;
 const draftNode=draft?byID.get(lower(draft.itemID)):undefined;
 const blockSource={vaultId:p.vaultId,path:p.path,boardID:String(p.board.id),language:p.language};
 const boardImages=Array.from(new Map(nodes.filter(n=>nodeImagePath(n)).map(n=>[nodeImagePath(n)!,{title:n.title,sourcePath:nodeImagePath(n)!}])).values());
 const draftBlocksValid=!!draft&&[...(draft.card.questionBlocks||[]),...(draft.card.answerBlocks||[])].every(b=>b.kind==='text'?!!b.text?.trim():!!b.sourcePath);
 const valid=!!draft&&draftBlocksValid&&(draft.card.mode==='cloze'?validCloze(draft.card.question):!!draft.card.question.trim()&&(draft.card.answerMode==='node'?!!nodeImagePath(draftNode)||!!nodeAnswer(draftNode).trim():!!draft.card.answer.trim()||!!draft.card.answerBlocks?.length)&&(draft.card.mode!=='occlusion'||!!draft.card.questionBlocks?.some(b=>b.regions?.length)));
 const frontImages=!!current?.card.questionBlocks?.some(b=>b.kind==='image'),backImages=!!current?.card.answerBlocks?.some(b=>b.kind==='image'),blocksReady=(!frontImages||frontReady)&&(!backImages||backReady);

 const currentImage=current?.card.mode==='qa'&&current.card.answerMode==='node'?nodeImagePath(currentNode):undefined, imageKey=currentImage?current?.itemID+':'+current?.eventID+':'+currentImage:'';
 const answer=current?(current.card.answerMode==='node'?nodeAnswer(currentNode):current.card.answer):'';
 useLayoutEffect(()=>{setRevealed(false);setShowContext(false);setImageReady('');setFrontReady(false);setBackReady(false);},[current?.itemID,current?.eventID,answer,currentImage]);
 useLayoutEffect(()=>{p.onRecallCover?.(tab==='review'&&!!current&&!draft&&!nodeDraft&&!revealed&&!showContext);},[tab,current?.itemID,draft,nodeDraft,revealed,showContext,p.onRecallCover]);
 useEffect(()=>{if(projection&&queue[index]&&!current)setIndex(n=>n+1);},[projection,queue,index,current]);
 const gradeLabel=(g:string)=>({again:tr('重来','Again'),hard:tr('困难','Hard'),good:tr('记住','Good'),easy:tr('熟练','Easy')}[g]||g);
 const intervalHint=(g:string)=>g==='again'?tr('10 分钟','10 min'):String(Math.min(365,g==='hard'?Math.max(1,Math.round((current?.intervalDays||0)*1.2)):g==='good'?(current?.intervalDays?Math.max(1,Math.round(current.intervalDays*2.5)):1):(current?.intervalDays?Math.max(4,Math.round(current.intervalDays*3.5)):4)))+tr(' 天',' d');
 return <aside className="study-panel" aria-label={tr('学习与复习','Study & review')} data-testid="study-panel">
  <header><div><span className="study-eyebrow">LEARN · CONNECT · RECALL</span><h2><BookOpen/>{tr('学习与复习','Study & review')}</h2></div><Button onClick={close} disabled={busy||transferOpen} aria-label={tr('关闭学习面板','Close study panel')}><X/></Button></header>
  <p className="study-board-name" title={p.path}>{basename(p.path).replace(/\.inkspace\.json$/,'')}</p>
  <nav aria-label={tr('学习视图','Study views')}><Button aria-pressed={tab==='outline'} disabled={dirty||busy} onClick={()=>setTab('outline')}>{tr('学习大纲','Outline')}</Button><Button aria-pressed={tab==='review'} disabled={dirty||busy} onClick={()=>setTab('review')}>{tr('复习','Review')} <span>{due}</span></Button><Button aria-label={tr('刷新复习','Refresh study')} disabled={dirty||busy||loading} onClick={()=>void reload()}><RefreshCw size={16}/></Button><Button data-testid="study-transfer-open" disabled={dirty||busy||!projection||incomplete} onClick={()=>setTransferOpen(true)}>{tr('导入 / 导出','Import / export')}</Button></nav>
  {(loading&&!projection)&&<p role="status">{tr('读取学习记录…','Loading study records…')}</p>}
  {error&&<div className="study-notice" role="alert">{error}{pending&&<Button disabled={busy} onClick={()=>void publish(pending)}>{tr('重试保存','Retry save')}</Button>}</div>}
  {!!projection?.warnings.length&&<p className="study-notice" role="alert">{tr('部分学习记录暂不可用，已保留。为避免遗漏，暂不保存复习；请刷新后重试。','Some study records are unavailable and preserved. Refresh and check.')}</p>}
  {discard&&<div className="study-notice" role="alert">{tr('草稿尚未保存。','Draft has not been saved.')}<Button onClick={()=>setDiscard(false)}>{tr('继续编辑','Keep editing')}</Button><Button onClick={discardDraft}>{tr('丢弃草稿','Discard draft')}</Button></div>}
  <div className="study-scroll">
  {transferOpen?<StudyTransferPanel vaultId={p.vaultId} path={p.path} boardID={String(p.board.id)} language={p.language} onPrepare={p.onPrepare} onBusy={value=>{writeLock.current=value;setBusy(value);p.onStateChange({dirty:true,busy:value});}} onImported={(file,next)=>{setProjection(next);p.onImported(file);}} onClose={()=>{setTransferOpen(false);void reload();}}/>:draft?<form className="study-editor" onSubmit={e=>{e.preventDefault();if(valid&&!pending)void publish(event(draft.itemID,'card',{card:draft.card}));}}>
   <h3>{tr('编辑复习卡','Edit study card')}</h3><p>{draftNode?.title}</p>
   <fieldset disabled={busy||!!pending||incomplete}><label>{tr('卡片类型','Card type')}<select data-testid="study-card-mode" value={draft.card.mode} onChange={e=>{const mode=e.target.value as StudyCard['mode'];markDraft({...draft,card:{...draft.card,mode,answerMode:mode!=='qa'?'custom':draft.card.answerMode,...(mode==='occlusion'&&!draft.card.answer.trim()?{answer:tr('核对已揭晓的图片区域。','Check the revealed image regions.')}:{}),...(mode==='cloze'?{questionBlocks:undefined,answerBlocks:undefined}:{})}});}}><option value="qa" disabled={!!draft.card.questionBlocks?.some(b=>b.regions?.length)}>{tr('问答','Question & answer')}</option><option value="cloze" disabled={!!draft.card.questionBlocks?.length||!!draft.card.answerBlocks?.length}>{tr('文字挖空','Cloze')}</option><option value="occlusion">{tr('图片多区域遮盖','Image region recall')}</option></select></label>
   <label>{draft.card.mode!=='cloze'?tr('问题（回忆前显示）','Question (shown before recall)'):tr('原句：用 {{ }} 包住要隐藏的词','Sentence: wrap hidden words in {{ }}')}<textarea data-testid="study-question" maxLength={4000} value={draft.card.question} onChange={e=>markDraft({...draft,card:{...draft.card,question:e.target.value}})}/></label>
   {draft.card.mode==='qa'&&<label className="study-checkbox"><input type="checkbox" checked={draft.card.answerMode==='node'} onChange={e=>markDraft({...draft,card:{...draft.card,answerMode:e.target.checked?'node':'custom',answer:e.target.checked?'':nodeAnswer(draftNode).slice(0,20000)}})}/>{tr('答案使用节点文字或图片','Answer uses the note text or image')}</label>}
   {draft.card.answerMode==='node'?<div className="study-answer-preview">{nodeImagePath(draftNode)?tr('图片卡：复习时先隐藏图片，点击揭晓后显示完整图片；创建的摘录不会随原 PDF 更新。','Image card: the image is hidden until you reveal it. Excerpt snapshots do not update with the source PDF.'):nodeAnswer(draftNode)||tr('这个节点没有文字。请改用自定义答案。','This node has no text. Use a custom answer.')}</div>:<label>{draft.card.mode==='cloze'?tr('揭晓后的补充解释（可选）','Explanation after reveal (optional)'):tr('答案','Answer')}<textarea data-testid="study-answer-input" maxLength={20000} value={draft.card.answer} onChange={e=>markDraft({...draft,card:{...draft.card,answer:e.target.value}})}/></label>}
   {draft.card.mode!=='cloze'&&<><StudyBlocksEditor label="question" blocks={draft.card.questionBlocks} source={blockSource} images={boardImages} maskable={draft.card.mode==='occlusion'} onChange={blocks=>markDraft({...draft,card:{...draft.card,questionBlocks:blocks.length?blocks:undefined}})}/><StudyBlocksEditor label="answer" blocks={draft.card.answerBlocks} source={blockSource} images={boardImages} maskable={false} onChange={blocks=>markDraft({...draft,card:{...draft.card,answerBlocks:blocks.length?blocks:undefined}})}/>{draft.card.mode==='occlusion'&&!draft.card.questionBlocks?.some(b=>b.regions?.length)&&<small>{tr('请在题面添加图片，并拖动标记至少一个遮盖区域。','Add an image to the question and drag at least one masked region.')}</small>}</>}
   {draft.card.mode==='cloze'&&!validCloze(draft.card.question)&&<small>{tr('例如：资本成本是 {{WACC}}。','Example: The cost of capital is {{WACC}}.')}</small>}
   </fieldset><div className="study-actions"><Button className="primary" type="submit" disabled={!valid||busy||!!pending}>{busy?tr('保存中…','Saving…'):tr('保存复习卡','Save card')}</Button><Button type="button" disabled={busy} onClick={()=>setDiscard(true)}>{tr('取消','Cancel')}</Button></div>
  </form>:nodeDraft?<form className="study-editor" onSubmit={e=>{e.preventDefault();void updateOutline();}}><h3>{tr('整理大纲','Edit outline')}</h3><fieldset disabled={busy}><label>{tr('节点标题','Node title')}<input maxLength={10000} value={nodeDraft.title} onChange={e=>markNode({...nodeDraft,title:e.target.value})}/></label><label>{tr('上级节点','Parent node')}<select value={nodeDraft.parentID||''} onChange={e=>markNode({...nodeDraft,parentID:e.target.value||null})}><option value="">{tr('顶层','Top level')}</option>{nodes.filter(n=>n.id!==nodeDraft.id).map(n=><option key={n.id} value={n.id}>{n.title.slice(0,90)}</option>)}</select></label></fieldset><div className="study-actions"><Button className="primary" disabled={busy||!nodeDraft.title.trim()} type="submit">{tr('保存大纲','Save outline')}</Button><Button type="button" disabled={busy} onClick={()=>setDiscard(true)}>{tr('取消','Cancel')}</Button></div></form>:
  tab==='outline'?<>
   <p className="study-help">{tr('摘录、导图和大纲共用节点。选中节点，整理层级或加入复习。','Excerpts, mind map and outline share nodes. Select one to organize or review.')}</p>
   <input className="study-search" aria-label={tr('搜索学习节点','Search study nodes')} placeholder={tr('搜索标题、关键词或正文','Search titles, keywords or notes')} value={query} onChange={e=>setQuery(e.target.value)}/>
   {!nodes.length&&<p className="study-empty">{tr('先在 PDF 框选摘录到此白板，或在导图添加节点。','Send a PDF excerpt to this board, or add a mind-map node.')}</p>}
   <div className="study-outline" role="list">{filtered.map(r=><div className={'study-row '+(lower(selected)===lower(r.node.id)?'selected':'')} role="listitem" key={r.node.id} style={{paddingLeft:Math.min(r.depth,12)*14}}>
    <button className="study-disclosure" disabled={!r.hasChildren||!!query} aria-label={collapsed.has(lower(r.node.id))?tr('展开子节点','Expand children'):tr('折叠子节点','Collapse children')} aria-expanded={r.hasChildren?!collapsed.has(lower(r.node.id)):undefined} onClick={()=>setCollapsed(old=>{const n=new Set(old),id=lower(r.node.id);n.has(id)?n.delete(id):n.add(id);return n;})}>{r.hasChildren?(collapsed.has(lower(r.node.id))?<ChevronRight size={15}/>:<ChevronDown size={15}/>):<span/>}</button>
    <button className="study-row-title" title={r.node.title} onClick={()=>setSelected(r.node.id)}>{r.node.title||tr('未命名节点','Untitled node')}</button>{cardFor(r.node.id)&&<span className="study-tag">{tr('卡片','Card')}</span>}
   </div>)}</div>
   {active&&<section className="study-node-detail"><h3>{active.title}</h3><p>{nodeImagePath(active)?tr('图片节点 · 可加入图片问答复习','Image node · available for image-answer review'):nodeAnswer(active).slice(0,1400)||tr('此节点可设置自定义问答。','Create a custom question and answer for this node.')}</p>{!!related.length&&<div className="study-title-links"><small>{tr('正文中的标题链接','Title links in this note')}</small>{related.map(node=><Button key={node.id} onClick={()=>{setSelected(node.id);p.onLocate(node.id);}}>{node.title}</Button>)}</div>}<div className="study-actions"><Button onClick={()=>p.onLocate(active.id)}>{tr('定位节点','Locate node')}</Button><Button onClick={()=>{const row=outline.find(r=>r.node.id===active.id)!;markNode({id:active.id,title:active.title,parentID:row.parentID,previousParentID:row.parentID});}}>{tr('整理层级','Edit hierarchy')}</Button>{(active.sourcePath||active.originalSourcePath||sourceReference(active))&&<Button onClick={()=>void goSource(active.id)}>{tr('返回原文','Open source')}</Button>}<Button className="primary" disabled={!projection||busy||incomplete} onClick={()=>create(active.id)}>{cardFor(active.id)?tr('编辑复习卡','Edit card'):tr('加入复习','Add to review')}</Button></div>{cardFor(active.id)&&<details><summary>{tr('卡片管理','Card management')}</summary><p>{tr('移除复习卡会保留笔记和原文。','Removing the card keeps the note and source.')}</p><Button disabled={busy||!!pending||incomplete} onClick={()=>void publish(event(active.id,'delete'))}>{tr('移除复习卡','Remove card')}</Button></details>}</section>}
  </>:<>
   <div className="study-summary"><strong>{due}</strong><span>{tr('张到期 · ',' due · ')}{cards.filter(c=>!c.missingNode).length}{tr(' 张卡片',' cards')}</span></div>
   <label className="study-checkbox"><input type="checkbox" checked={allCards} onChange={e=>setAllCards(e.target.checked)} disabled={busy||!!pending||incomplete}/>{tr('也复习尚未到期的卡片','Include cards not yet due')}</label>
   <Button className="primary" data-testid="study-start" disabled={!projection||incomplete||busy||!!pending||!cards.some(c=>!c.missingNode&&(allCards||Date.parse(c.dueAt)<=clock))} onClick={start}>{queue.length?tr('重新开始本轮','Restart session'):tr('开始复习','Start review')}</Button>
   {!!queue.length&&<p className="study-session-count">{tr('本轮已完成 ','Completed this session: ')}{completed} / {queue.length}</p>}
   {current?<article className="study-recall" data-testid="study-recall"><span className="study-eyebrow">{tr('先回忆，再揭晓','RECALL BEFORE REVEAL')}</span><div className="study-question" data-testid="study-question-display">{current.card.mode==='cloze'?clozeParts(current.card.question).map((part,i)=>part.hidden?<span key={i} className={revealed?'study-cloze-revealed':'study-cloze-hidden'}>{revealed?part.text:'•••'}</span>:part.text):current.card.question}</div>
    {!!current.card.questionBlocks?.length&&<StudyBlocks key={'question:'+current.itemID+':'+current.eventID} blocks={current.card.questionBlocks} source={blockSource} revealed={revealed} onReady={setFrontReady}/>}
    {current.missingNode||!currentNode?<p role="alert">{tr('来源节点已不存在，记录保留；此卡不计分。','Source node is missing. History retained; this card cannot be graded.')}</p>:<>
     {revealed?<><div className="study-answer" data-testid="study-answer">{currentImage?<StudyImageAnswer key={imageKey} vaultId={p.vaultId} path={p.path} boardID={String(p.board.id)} itemID={current.itemID} sourcePath={currentImage} language={p.language} onReady={ready=>setImageReady(ready?imageKey:'')}/>:answer||tr('请对照原笔记检查回忆。','Check your recall against the original note.')}{!!current.card.answerBlocks?.length&&<StudyBlocks key={'answer:'+current.itemID+':'+current.eventID} blocks={current.card.answerBlocks} source={blockSource} revealed={true} onReady={setBackReady}/>}</div><div className="study-grades">{(['again','hard','good','easy'] as const).map(g=><Button key={g} disabled={busy||!!pending||incomplete||!blocksReady||!!currentImage&&imageReady!==imageKey} data-testid={'study-grade-'+g} onClick={()=>void publish(event(current.itemID,'grade',{grade:g}))}><span>{gradeLabel(g)}</span><small>{intervalHint(g)}</small></Button>)}</div></>:<Button className="primary" data-testid="study-reveal" disabled={busy||!!pending||incomplete} onClick={()=>{setImageReady('');setRevealed(true);}}>{tr('显示答案','Show answer')}</Button>}
     <div className="study-actions">{(currentNode.sourcePath||currentNode.originalSourcePath||sourceReference(currentNode))&&<Button disabled={busy||!!pending||incomplete} onClick={()=>void goSource(current.itemID)}>{tr('查看原文','View source')}</Button>}<Button disabled={busy||!!pending||incomplete} onClick={()=>{setShowContext(true);p.onLocate(current.itemID);}}>{tr('定位笔记','Locate note')}</Button>{revealed&&<Button disabled={busy||!!pending||incomplete} onClick={()=>create(current.itemID)}>{tr('编辑卡片','Edit card')}</Button>}</div>
    </>}
    <Button disabled={busy||!!pending||incomplete} onClick={()=>{setIndex(n=>n+1);setRevealed(false);}}>{tr('跳过（不记分）','Skip (no rating)')}</Button>
   </article>:!!queue.length?<div className="study-empty"><h3>{tr('本轮完成','Session complete')}</h3><p>{tr('进度已保存。下次到期后继续复习。','Progress saved. Return when cards are due.')}</p></div>:<p className="study-help">{tr('在学习大纲中选择节点并加入复习。评级后按基础间隔安排下次复习。','Add nodes from the outline. Ratings schedule the next review using basic intervals.')}</p>}
   {!!cards.filter(c=>c.missingNode).length&&<details><summary>{tr('来源节点缺失的卡片','Cards with missing nodes')} ({cards.filter(c=>c.missingNode).length})</summary>{cards.filter(c=>c.missingNode).map(c=><div key={c.itemID} className="study-missing"><p>{c.card.question}</p><Button disabled={busy||!!pending||incomplete} onClick={()=>void publish(event(c.itemID,'delete'))}>{tr('移除复习卡','Remove card')}</Button></div>)}</details>}
  </>}
  </div><footer>{tr('本地保存 · 随资料库同步 · 原 PDF 不改写','Saved locally · syncs with your folder · original PDF unchanged')}</footer>
 </aside>;
}

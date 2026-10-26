import {useEffect,useRef,useState} from 'react';
import {Archive,ArrowDown,ArrowUp,Check,ListChecks,Pencil,Plus,RefreshCw,StickyNote,Undo2,X,Mic,Square} from 'lucide-react';
import type {QuickNoteDictationEvent,Vault} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button} from './ui';
import {CHECKLIST_LIMITS,updateTask,type ChecklistTask} from './course-checklist';
import {QUICK_NOTES_PATH,QuickNotesError,newQuickNoteDraft,parseQuickNoteDraft,quickNoteDraftKey,quickNoteIsDirty,readQuickNotes,recordQuickNote,writeQuickNotes,editQuickNote,moveQuickNote,type QuickNoteDraft,type QuickNotesSnapshot} from './quick-notes';
import {dictationDraftText,canApplyDictation,dictationContextWords,dictationErrorMessage,dictationCorrectionCandidate,currentDictationCorrection,type DictationCorrectionCandidate,type DictationDraftTarget} from './quick-note-dictation';
import PersonalVoiceProfile from './PersonalVoiceProfile';
import './quick-notes.css';

// A storage failure still preserves the input while this renderer remains open.
const memoryDrafts=new Map<string,QuickNoteDraft>();
type Props={vault:Vault;language:Language;onClose:()=>void;onSaved:()=>void;onOpenChecklist:(path:string,taskId?:string)=>void};
type Filter='pending'|'done'|'archived';
export default function QuickNotes(props:Props){return <QuickNotesSession key={props.vault.id} {...props}/>;}
function QuickNotesSession({vault,language,onClose,onSaved,onOpenChecklist}:Props){
 const zh=language==='zh',label=(cn:string,en:string)=>zh?cn:en;
 const cacheKey=quickNoteDraftKey(vault.recentId||vault.id);
 const [initial]=useState(()=>{
  const memory=memoryDrafts.get(cacheKey);if(memory)return {draft:memory,issue:false,invalid:false};
  try{return {draft:parseQuickNoteDraft(localStorage.getItem(cacheKey))||newQuickNoteDraft(),issue:false,invalid:false};}
  catch{return {draft:newQuickNoteDraft(),issue:true,invalid:true};}
 });
 const [draft,setDraft]=useState(initial.draft),[cacheIssue,setCacheIssue]=useState(initial.issue);
 const [snapshot,setSnapshot]=useState<QuickNotesSnapshot|null>(null),[loaded,setLoaded]=useState(false);
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 const [retryAsNew,setRetryAsNew]=useState(false);
 const [filter,setFilter]=useState<Filter>('pending');
 const [voicePhase,setVoicePhase]=useState<'idle'|'preparing'|'downloading'|'arming'|'listening'|'finishing'>('idle'),[voiceAvailable,setVoiceAvailable]=useState(false),[voicePreview,setVoicePreview]=useState(''),[voiceError,setVoiceError]=useState(''),[voiceWarning,setVoiceWarning]=useState<'pending'|'review'|''>('');
 const [voiceLocale,setVoiceLocale]=useState<'zh-CN'|'en-US'>(()=>{try{const saved=localStorage.getItem('inkspace.quick-notes.voice-locale.v1');return saved==='en-US'||saved==='zh-CN'?saved:zh?'zh-CN':'en-US';}catch{return zh?'zh-CN':'en-US';}}),[voiceTerms,setVoiceTerms]=useState('');
 const voiceRun=useRef<DictationDraftTarget|null>(null),voiceCallback=useRef<(event:QuickNoteDictationEvent)=>void>(()=>{});
 const voiceActive=voicePhase!=='idle';
 const [profileOpen,setProfileOpen]=useState(false),[correctionCandidate,setCorrectionCandidate]=useState<DictationCorrectionCandidate|null>(null);
 const correction=currentDictationCorrection(correctionCandidate,draft);
 const dialog=useRef<HTMLElement>(null),input=useRef<HTMLTextAreaElement>(null);
 const mounted=useRef(true),gate=useRef(false),reading=useRef(false),epoch=useRef(0),draftRef=useRef(draft),snapshotRef=useRef(snapshot),cacheIssueRef=useRef(cacheIssue);
 draftRef.current=draft;snapshotRef.current=snapshot;cacheIssueRef.current=cacheIssue;
 const cache=(next:QuickNoteDraft)=>{
  memoryDrafts.set(cacheKey,next);
  try{
   if(initial.invalid)throw Error('Existing draft cache requires recovery.');
   if(next.text||next.editingId)localStorage.setItem(cacheKey,JSON.stringify(next));else localStorage.removeItem(cacheKey);
   if(mounted.current)setCacheIssue(false);
  }catch{if(mounted.current)setCacheIssue(true);}
 };
 const changeDraft=(next:QuickNoteDraft)=>{draftRef.current=next;cache(next);if(mounted.current)setDraft(next);};
 const applyVoice=(run:DictationDraftTarget,text:string)=>{
  if(!text.trim())return;
  if(canApplyDictation(run,draftRef.current)){changeDraft({...draftRef.current,text:dictationDraftText(run.baseText,text)});if(mounted.current)setCorrectionCandidate(dictationCorrectionCandidate(run,text));}
  else {setVoicePreview(text);setVoiceError(label('草稿已变化，识别文字保留在下方，请复制到需要的位置。','Your draft changed. Recognized text is kept below; copy it where needed.'));}
 };
 const cancelVoice=(keepText=false)=>{
  const run=voiceRun.current;voiceRun.current=null;
  if(run){if(keepText)applyVoice(run,run.latestText);void window.desktop.cancelQuickNoteDictation?.({sessionId:run.sessionId}).catch(()=>{});}
  if(mounted.current){setVoicePhase('idle');setVoiceWarning(value=>keepText&&value?'review':'');if(!keepText)setVoicePreview('');}
 };
 voiceCallback.current=event=>{
  const run=voiceRun.current;if(!run||event.sessionId!==run.sessionId||event.sequence<=run.sequence)return;run.sequence=event.sequence;
  if(event.text!==undefined){run.latestText=event.text;setVoicePreview(event.text);}
  if(event.kind==='state'&&event.phase)setVoicePhase(event.phase);
  if(event.notice==='range-review')setVoiceWarning('review');else if(event.notice==='range-pending')setVoiceWarning(value=>value==='review'?value:'pending');else if(event.notice==='range-recovered')setVoiceWarning(value=>value==='review'?value:'');
  if(event.kind==='complete'||event.kind==='error'){setVoiceWarning(value=>value==='pending'?'review':value);voiceRun.current=null;applyVoice(run,event.text||run.latestText);setVoicePhase('idle');if(canApplyDictation(run,draftRef.current)||draftRef.current.text===dictationDraftText(run.baseText,event.text||run.latestText))setVoicePreview('');if(event.kind==='error')setVoiceError(dictationErrorMessage(event.code,zh));else setStatus(label('语音已加入草稿，请检查后记下。','Dictation added to your draft. Review it before saving.'));input.current?.focus();}
  if(event.kind==='authorized'){voiceRun.current=null;setVoicePhase('idle');setVoicePreview('');setStatus(label('麦克风已允许；尚未开始听写。请再次点“语音输入”，等到“可以开始说话”后再说。','Microphone permission granted; dictation has not started. Click Dictate again, then wait for Ready to speak.'));}
  if(event.kind==='cancelled'){setVoiceWarning('');voiceRun.current=null;setVoicePhase('idle');setVoicePreview('');if(voicePhase==='preparing')setStatus(label('权限准备已结束，尚未开始听写。若已允许系统麦克风，请回到此窗口再次点“语音输入”。','Permission preparation ended without starting dictation. If you allowed microphone access, return here and click Dictate again.'));}
 };
 useEffect(()=>{
  const off=window.desktop.onQuickNoteDictationEvent?.(event=>voiceCallback.current(event));let alive=true;
  void window.desktop.quickNoteDictationInfo?.().then(result=>{if(alive)setVoiceAvailable(result.ok&&result.value.available);}).catch(()=>{});
  return()=>{alive=false;mounted.current=false;off?.();cancelVoice(true);};
 },[cacheKey]);
 const startVoice=async()=>{
  if(voiceRun.current||busy||loading)return;
  const current=draftRef.current,sessionId=crypto.randomUUID();voiceRun.current={sessionId,draftId:current.id,baseText:current.text,sequence:0,latestText:''};setVoiceError('');setVoiceWarning('');setVoicePreview('');setVoicePhase('preparing');
  try{const result=await window.desktop.startQuickNoteDictation({sessionId,locale:voiceLocale,contextWords:dictationContextWords(voiceTerms)});if(voiceRun.current?.sessionId!==sessionId)return;if(result.ok&&result.value.permissionPrepared)return;if(!result.ok||!result.value.started){voiceRun.current=null;setVoicePhase('idle');setVoiceError(result.ok?(result.value.reason?dictationErrorMessage(result.value.reason,zh):label('本机听写组件尚未启动，请重试。','The local dictation component did not start. Try again.')):result.error.code==='BUSY'?label('另一扇窗口正在听写，请先结束它。','Another window is using dictation. Stop it first.'):result.error.message);}}
  catch{if(voiceRun.current?.sessionId===sessionId){voiceRun.current=null;setVoicePhase('idle');setVoiceError(label('无法启动本机听写，原草稿保留。','Could not start local dictation. Your draft is kept.'));}}
 };
 const stopVoice=async()=>{const run=voiceRun.current;if(!run)return;setVoicePhase('finishing');try{const result=await window.desktop.stopQuickNoteDictation({sessionId:run.sessionId});if(!result.ok)throw Error();}catch{if(voiceRun.current?.sessionId===run.sessionId){cancelVoice(true);setVoiceError(label('听写已结束，已识别文字保留在草稿。','Dictation ended. Recognized text is kept in your draft.'));}}};
 const closeNotes=()=>{cancelVoice(true);onClose();};
 const load=async()=>{
  if(gate.current||reading.current)return;
  const token=++epoch.current;reading.current=true;if(mounted.current)setLoading(true);
  try{const next=await readQuickNotes(window.desktop,vault.id);if(mounted.current&&token===epoch.current){setSnapshot(next);snapshotRef.current=next;setLoaded(true);setError('');}}
  catch(e){if(mounted.current&&token===epoch.current)setError(e instanceof Error?e.message:String(e));}
  finally{if(token===epoch.current){reading.current=false;if(mounted.current)setLoading(false);}}
 };
 const loadRef=useRef(load);loadRef.current=load;
 useEffect(()=>{
  mounted.current=true;void loadRef.current();input.current?.focus();
  const refresh=()=>{if(!document.hidden)void loadRef.current();};
  const before=(event:BeforeUnloadEvent)=>{if(gate.current||(cacheIssueRef.current&&quickNoteIsDirty(draftRef.current))){event.preventDefault();event.returnValue='';}};
  const off=window.desktop.onVaultChange?.(event=>{if(event.vaultId===vault.id&&(event.rescan||event.paths.includes(QUICK_NOTES_PATH)))refresh();});
  window.addEventListener('focus',refresh);window.addEventListener('beforeunload',before);
  return()=>{mounted.current=false;epoch.current++;reading.current=false;off?.();window.removeEventListener('focus',refresh);window.removeEventListener('beforeunload',before);};
 },[vault.id]);
 const save=async(action:()=>Promise<QuickNotesSnapshot>,after?:()=>void)=>{
  if(gate.current||reading.current)return;
  gate.current=true;setBusy(true);setError('');setStatus('');setRetryAsNew(false);
  try{
   const next=await action();
   if(mounted.current){snapshotRef.current=next;setSnapshot(next);setLoaded(true);setStatus(label('已保存 · 与待完成清单使用同一份内容','Saved · shared with your to-do checklist'));}
   after?.();if(mounted.current)onSaved();
  }catch(e){if(mounted.current){setError(e instanceof Error?e.message:String(e));setRetryAsNew(e instanceof QuickNotesError&&e.code==='ALREADY_RECORDED');}}
  finally{gate.current=false;if(mounted.current)setBusy(false);}
 };
 const submit=()=>{
  if(voiceRun.current)return;
  const current=draftRef.current;if(!current.text.trim()||current.text.length>CHECKLIST_LIMITS.text||!loaded)return;
  const before=snapshotRef.current;
  void save(async()=>{
   if(current.editingId){if(!before)throw Error(label('请重新读取清单，输入仍保留。','Refresh the checklist; your draft is kept.'));return writeQuickNotes(window.desktop,vault.id,editQuickNote(before.doc,current),before);}
   return (await recordQuickNote(window.desktop,vault.id,current)).snapshot;
  },()=>{
   // Never erase a newer draft, including after a close/reopen during a delayed write.
   const saved=memoryDrafts.get(cacheKey);
   if((!saved||saved.id===current.id&&saved.text===current.text)&&draftRef.current.id===current.id&&draftRef.current.text===current.text){changeDraft(newQuickNoteDraft());if(mounted.current){setFilter('pending');requestAnimationFrame(()=>input.current?.focus());}}
  });
 };
 const mutate=(change:(doc:QuickNotesSnapshot['doc'])=>QuickNotesSnapshot['doc'])=>{
  const before=snapshotRef.current;if(!before)return;
  void save(async()=>writeQuickNotes(window.desktop,vault.id,change(before.doc),before));
 };
 const edit=(task:ChecklistTask)=>{
  if(quickNoteIsDirty(draftRef.current)){setError(label('当前草稿已保留，请先记下这条便签，再编辑其他条目。','Your draft is kept. Save it before editing another note.'));input.current?.focus();return;}
  changeDraft({schemaVersion:1,id:crypto.randomUUID(),text:task.text,editingId:task.id,baseText:task.text});setError('');input.current?.focus();
 };
 const tasks=snapshot?.doc.tasks||[],active=tasks.filter(t=>!t.archivedAt);
 const shown=tasks.filter(t=>filter==='archived'?!!t.archivedAt:!t.archivedAt&&(filter==='done'?t.done:!t.done));
 const locked=busy||loading||voiceActive,overlong=draft.text.length>CHECKLIST_LIMITS.text;
 return <div className="modal-shade quick-notes-shade" onKeyDown={event=>{
  event.stopPropagation();if(event.nativeEvent.isComposing)return;
  if(event.key==='Escape'&&!busy)closeNotes();
  if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();submit();}
  if(event.key==='Tab'){
   const controls=[...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled)')||[]].filter(el=>el.getClientRects().length>0),first=controls[0],last=controls.at(-1);
   if(event.shiftKey&&(document.activeElement===first||!dialog.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}>
  <section ref={dialog} className="quick-notes" role="dialog" aria-modal="true" aria-label={label('随手便签','Quick notes')} aria-busy={locked} data-testid="quick-notes">
   <header><div><span className="quick-notes-eyebrow">{label('想到就记下，一件一件完成','CAPTURE NOW · FINISH ONE BY ONE')}</span><h2><StickyNote/>{label('随手便签','Quick notes')}</h2></div><Button disabled={busy} title={label('关闭并保留草稿','Close and keep draft')} aria-label={label('关闭便签','Close quick notes')} onClick={closeNotes}><X/></Button></header>
   <div className="quick-notes-intro"><p>{label('临时想法、重要小事，像随身小本一样记下来。每条便签直接成为清单中的一件事。','Keep small ideas and important reminders in your pocket notebook. Every saved note is also a checklist task.')}</p><Button disabled={locked||!snapshot} onClick={()=>onOpenChecklist(QUICK_NOTES_PATH)}><ListChecks/>{label('打开待完成清单','Open checklist')}</Button></div>
   {cacheIssue&&<p className="quick-notes-warning" role="alert">{label('草稿暂时无法保存到本机缓存，输入仍留在当前软件内。请先记下便签，再退出软件；已有便签文件不受影响。','Draft caching is unavailable. Your input is kept in this open app. Save the note before quitting; saved notes are unaffected.')}</p>}
   {error&&<div className="quick-notes-error" role="alert">{error}{retryAsNew&&<Button disabled={locked} onClick={()=>{changeDraft({...newQuickNoteDraft(),text:draftRef.current.text});setRetryAsNew(false);setError('');input.current?.focus();}}>{label('保留原条目，将输入另存为新便签','Keep the original and save this text as a new note')}</Button>}</div>}
   <div className="quick-notes-body">
    <form className="quick-notes-composer" onSubmit={event=>{event.preventDefault();submit();}}><span className="quick-note-tab">{draft.editingId?label('编辑便签','EDIT NOTE'):label('新的一条','A NEW NOTE')}</span><label htmlFor="quick-note-text" className="sr-only">{label('便签内容','Note text')}</label><textarea id="quick-note-text" ref={input} value={draft.text} disabled={busy||voiceActive} placeholder={label('现在想记住什么？','What would you like to remember?')} onChange={event=>changeDraft({...draftRef.current,text:event.target.value})}/>
     <div className="quick-note-voice" data-testid="quick-note-voice"><div className="quick-note-voice-toolbar"><select aria-label={label('听写语言','Dictation language')} value={voiceLocale} disabled={voiceActive} onChange={event=>{const locale=event.target.value as 'zh-CN'|'en-US';setVoiceLocale(locale);try{localStorage.setItem('inkspace.quick-notes.voice-locale.v1',locale);}catch{}}}><option value="zh-CN">中文 · 普通话</option><option value="en-US">English</option></select>{voiceActive?<><Button type="button" data-testid="quick-note-voice-stop" disabled={voicePhase!=='listening'} onClick={()=>void stopVoice()}><Square/>{label('停止并加入草稿','Stop and add to draft')}</Button><Button type="button" aria-label={label('取消本次听写','Cancel this dictation')} onClick={()=>cancelVoice()}><X/></Button></>:<Button type="button" data-testid="quick-note-voice-start" disabled={busy||loading||!voiceAvailable} title={voiceAvailable?label('使用Apple本机语音识别，不保存录音','Apple on-device dictation; no audio is saved'):label('需要本机听写组件及macOS26以上','Requires the native dictation component and macOS26 or later')} onClick={()=>void startVoice()}><Mic/>{label('语音输入','Dictate')}</Button>}</div><small data-testid="quick-note-voice-status" data-phase={voicePhase} role="status" aria-live="assertive" className={voicePhase==='listening'?'quick-note-voice-ready':''}>{voicePhase==='downloading'?label('正在准备本机语言资源，请先不要说话；看到“可以开始说话”后再说…','Preparing local language assets. Please wait to speak until Ready to speak appears…'):voicePhase==='preparing'?label('正在准备听写，请先不要说话；如有系统麦克风提示请允许…','Preparing dictation. Please wait to speak and allow any microphone prompt…'):voicePhase==='arming'?label('麦克风正在启动，请先不要说话…','Starting the microphone. Please wait to speak…'):voicePhase==='listening'?label('可以开始说话 · 已收到麦克风音频 · 停止后加入草稿','Ready to speak · Microphone audio is arriving · Stop to add text to your draft.'):voicePhase==='finishing'?label('正在整理最后一句…','Finishing the last sentence…'):label('本机识别 · 自动标点 · 请检查人名、数字和专业词','On-device · Automatic punctuation · Review names, numbers and technical terms.')}</small>{voicePreview&&<div className="quick-note-voice-preview" data-testid="quick-note-voice-preview"><span>{label('识别预览','Recognized text')}</span><p>{voicePreview}</p></div>}{voiceWarning&&<p className="quick-notes-warning" data-testid="quick-note-voice-range-notice" role="status">{voiceWarning==='pending'?label('临时文字范围正在整理，听写仍在继续；已确认的文字保留。','Temporary text ranges are being finalized. Dictation continues and confirmed text is kept.'):label('部分最终结果未能安全合并，原稿与已识别文字保留。请核对缺失部分后补充；没有自动改写或猜字。','Some final results could not be merged safely. Your draft and recognized text are kept. Review and add any missing words; nothing was guessed or rewritten.')}</p>}{voiceError&&<p className="quick-note-voice-error" role="alert">{voiceError}</p>}<div className="quick-note-learning-row"><Button type="button" disabled={voiceActive||busy} onClick={()=>setProfileOpen(true)}>{label('个人语音档案','Personal vocabulary')}</Button><Button type="button" disabled={voiceActive||busy||!correction} title={label('先修改这次识别的文字，再确认要记住的词句','Correct this dictation first, then confirm the phrase to remember')} data-testid="remember-dictation-correction" onClick={()=>setProfileOpen(true)}>{label('记住这次纠正','Remember correction')}</Button></div><details><summary>{label('常用词提示（可选）','Vocabulary hints (optional)')}</summary><input aria-label={label('听写常用词','Dictation vocabulary hints')} disabled={voiceActive} value={voiceTerms} maxLength={1000} placeholder={label('人名、课程名、专业词，用逗号分隔','Names, courses or terms, separated by commas')} onChange={event=>setVoiceTerms(event.target.value)}/><small>{label('支持的本机引擎会参考这些词，不会训练个人模型。','Supported local engines can use these hints; they do not train a personal model.')}</small></details></div>
     <div className="quick-note-deadline"><span>{draft.editingId?label('保存内容，保留原来的截止日期。','Save text while keeping the existing due date.'):label('默认截止：记下当天的晚上 24:00','Default due: midnight at the end of the day you save it.')}</span><small>{label('可在待完成清单自由修改日期。','Change the date in your checklist.')}</small></div>
     {overlong&&<p className="quick-notes-error" role="alert">{label(`这一条超过 ${CHECKLIST_LIMITS.text} 字，请分成多条。输入完整保留，没有截断。`,`This note exceeds ${CHECKLIST_LIMITS.text} characters. Split it into several notes; your full input is kept.`)}</p>}
     <div className="quick-note-submit"><small>{draft.text.length} / {CHECKLIST_LIMITS.text}<br/>{label('⌘ Enter 记下 · 关闭保留草稿','⌘ Enter to save · close to keep draft')}</small><Button type="submit" className="primary" data-testid="quick-note-save" disabled={locked||!loaded||!draft.text.trim()||overlong}>{draft.editingId?<Check/>:<Plus/>}{busy?label('保存中…','Saving…'):draft.editingId?label('保存修改','Save changes'):label('记下','Save note')}</Button></div>
     {draft.editingId&&<Button type="button" disabled={busy} onClick={()=>{if(quickNoteIsDirty(draftRef.current))changeDraft({...newQuickNoteDraft(),text:draftRef.current.text});else changeDraft(newQuickNoteDraft());}}>{quickNoteIsDirty(draft)?label('将这段输入另存为新便签','Keep this text as a new note'):label('取消编辑，另记一条','Cancel edit and start a new note')}</Button>}
    </form>
    <div className="quick-notes-list"><div className="quick-notes-list-heading"><div role="group" aria-label={label('便签筛选','Note filter')}>{(['pending','done','archived'] as Filter[]).map(f=><Button key={f} aria-pressed={filter===f} onClick={()=>setFilter(f)}>{f==='pending'?label('待完成','To do'):f==='done'?label('已完成','Done'):label('归档','Archive')}</Button>)}</div><Button disabled={locked} aria-label={label('重新读取，保留输入','Refresh and keep draft')} onClick={()=>void loadRef.current()}><RefreshCw/></Button></div><p className="quick-notes-count">{label(`${active.filter(t=>!t.done).length} 件待完成 · 用上下箭头调整顺序`,`${active.filter(t=>!t.done).length} to do · move with the arrows`)}</p>
     <div className="quick-notes-items">{shown.map((task,index)=><article key={task.id} className={'quick-note-item'+(task.done?' is-done':'')} data-quick-note-id={task.id}><span className="quick-note-number">{index+1}</span><div className="quick-note-copy"><p>{task.text}</p>{task.dueDate&&<time dateTime={task.dueDate}>{label('截止 ','Due ')}{task.dueDate} · 24:00</time>}<div className="quick-note-actions">{task.archivedAt?<Button disabled={locked} aria-label={label('恢复便签：','Restore note: ')+task.text} onClick={()=>mutate(doc=>updateTask(doc,task.id,{archived:false}))}><Undo2/>{label('恢复','Restore')}</Button>:<><Button disabled={locked} aria-label={(task.done?label('标为未完成：','Mark to do: '):label('完成便签：','Complete note: '))+task.text} onClick={()=>mutate(doc=>updateTask(doc,task.id,{done:!task.done}))}><Check/>{task.done?label('未完成','To do'):label('完成','Done')}</Button><Button disabled={locked} aria-label={label('编辑便签：','Edit note: ')+task.text} onClick={()=>edit(task)}><Pencil/></Button><Button disabled={locked} aria-label={label('归档便签：','Archive note: ')+task.text} onClick={()=>mutate(doc=>updateTask(doc,task.id,{archived:true}))}><Archive/></Button></>}<Button disabled={locked} title={label('在清单中自定义截止日期','Customize deadline in checklist')} aria-label={label('在清单中编辑：','Edit in checklist: ')+task.text} onClick={()=>onOpenChecklist(QUICK_NOTES_PATH,task.id)}><ListChecks/></Button></div></div><div className="quick-note-order"><Button disabled={locked||index===0} aria-label={label('便签上移：','Move note up: ')+task.text} onClick={()=>mutate(doc=>moveQuickNote(doc,task.id,-1,shown.map(t=>t.id)))}><ArrowUp/></Button><Button disabled={locked||index===shown.length-1} aria-label={label('便签下移：','Move note down: ')+task.text} onClick={()=>mutate(doc=>moveQuickNote(doc,task.id,1,shown.map(t=>t.id)))}><ArrowDown/></Button></div></article>)}{!loading&&!shown.length&&<div className="quick-notes-empty"><StickyNote/><p>{filter==='pending'?label('把第一件想做的事记下来。','Write down your first small task.'):label('这里暂时没有便签。','No notes here yet.')}</p></div>}</div>
    </div>
   </div><footer role="status">{loading?label('读取便签中…','Loading notes…'):busy?label('保存中，请稍候…','Saving…'):status||label('便签与清单是同一份内容 · 文件保存在当前资料库主文件夹','Notes and checklist share the same file in your library’s main folder.')}</footer>
  </section>
  {profileOpen&&<PersonalVoiceProfile zh={zh} correction={correction} onRemembered={()=>setCorrectionCandidate(null)} onClose={()=>{setProfileOpen(false);requestAnimationFrame(()=>input.current?.focus());}}/>}
 </div>;
}

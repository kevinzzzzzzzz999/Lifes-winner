import {useEffect,useRef,useState} from 'react';
import {Archive,ArrowDown,ArrowUp,Check,ListChecks,Pencil,Plus,RefreshCw,StickyNote,Undo2,X} from 'lucide-react';
import type {Vault} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button} from './ui';
import {CHECKLIST_LIMITS,updateTask,type ChecklistTask} from './course-checklist';
import {QUICK_NOTES_PATH,QuickNotesError,newQuickNoteDraft,parseQuickNoteDraft,quickNoteDraftKey,quickNoteIsDirty,readQuickNotes,recordQuickNote,writeQuickNotes,editQuickNote,moveQuickNote,type QuickNoteDraft,type QuickNotesSnapshot} from './quick-notes';
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
 const locked=busy||loading,overlong=draft.text.length>CHECKLIST_LIMITS.text;
 return <div className="modal-shade quick-notes-shade" onKeyDown={event=>{
  event.stopPropagation();if(event.nativeEvent.isComposing)return;
  if(event.key==='Escape'&&!busy)onClose();
  if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();submit();}
  if(event.key==='Tab'){
   const controls=[...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled)')||[]].filter(el=>el.getClientRects().length>0),first=controls[0],last=controls.at(-1);
   if(event.shiftKey&&(document.activeElement===first||!dialog.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}>
  <section ref={dialog} className="quick-notes" role="dialog" aria-modal="true" aria-label={label('随手便签','Quick notes')} aria-busy={locked} data-testid="quick-notes">
   <header><div><span className="quick-notes-eyebrow">{label('想到就记下，一件一件完成','CAPTURE NOW · FINISH ONE BY ONE')}</span><h2><StickyNote/>{label('随手便签','Quick notes')}</h2></div><Button disabled={busy} title={label('关闭并保留草稿','Close and keep draft')} aria-label={label('关闭便签','Close quick notes')} onClick={onClose}><X/></Button></header>
   <div className="quick-notes-intro"><p>{label('临时想法、重要小事，像随身小本一样记下来。每条便签直接成为清单中的一件事。','Keep small ideas and important reminders in your pocket notebook. Every saved note is also a checklist task.')}</p><Button disabled={locked||!snapshot} onClick={()=>onOpenChecklist(QUICK_NOTES_PATH)}><ListChecks/>{label('打开待完成清单','Open checklist')}</Button></div>
   {cacheIssue&&<p className="quick-notes-warning" role="alert">{label('草稿暂时无法保存到本机缓存，输入仍留在当前软件内。请先记下便签，再退出软件；已有便签文件不受影响。','Draft caching is unavailable. Your input is kept in this open app. Save the note before quitting; saved notes are unaffected.')}</p>}
   {error&&<div className="quick-notes-error" role="alert">{error}{retryAsNew&&<Button disabled={locked} onClick={()=>{changeDraft({...newQuickNoteDraft(),text:draftRef.current.text});setRetryAsNew(false);setError('');input.current?.focus();}}>{label('保留原条目，将输入另存为新便签','Keep the original and save this text as a new note')}</Button>}</div>}
   <div className="quick-notes-body">
    <form className="quick-notes-composer" onSubmit={event=>{event.preventDefault();submit();}}><span className="quick-note-tab">{draft.editingId?label('编辑便签','EDIT NOTE'):label('新的一条','A NEW NOTE')}</span><label htmlFor="quick-note-text" className="sr-only">{label('便签内容','Note text')}</label><textarea id="quick-note-text" ref={input} value={draft.text} disabled={busy} placeholder={label('现在想记住什么？','What would you like to remember?')} onChange={event=>changeDraft({...draftRef.current,text:event.target.value})}/>
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
 </div>;
}

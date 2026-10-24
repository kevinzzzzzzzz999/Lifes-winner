import {useEffect, useRef, useState} from 'react';
import {Archive, ArrowUp, BookOpen, CalendarDays, CheckCheck, ChevronRight, FileText, Folder, ListChecks, Pencil, Plus, RefreshCw, Undo2, X} from 'lucide-react';
import type {ApiResult, DirectoryListing, Vault} from '../shared/desktop-api';
import {Button} from './ui';
import {isInternalFilePath} from '../shared/internal-file-links';
import type {Language} from './i18n';
import {parseChecklist, serializeChecklist, createChecklist, addTask, updateTask, type CourseChecklist as Checklist, type ChecklistTask} from './course-checklist';
import {initialChecklistLocation, checklistCreationLocation} from './checklist-location';
import poemsJSON from './poetry-rewards.json';
import './course-checklist.css';

type Poem = {id:string;text:string;author:string;title:string;note:string;sourceURL:string};
const poems = poemsJSON as Poem[];
const defaultName = '课程清单.inkcheck.json';
const parentOf = (path:string) => path.split('/').slice(0,-1).join('/');
const join = (folder:string,name:string) => folder ? folder+'/'+name : name;
type Snapshot = {doc:Checklist;sha:string};
type Filter = 'pending'|'done'|'all'|'archived'|'poems';
type Props={vault:Vault;initialFolder?:string;initialPath?:string;initialTaskId?:string;initialSourcePath?:string;language:Language;onClose:()=>void;onSaved:()=>void;onOpenSource?:(path:string)=>void;onOpenCalendar?:(date?:string)=>void};
export default function CourseChecklist({vault,initialFolder='',initialPath,initialTaskId,initialSourcePath,language,onClose,onSaved,onOpenSource,onOpenCalendar}:Props) {
  const zh=language==='zh', label=(cn:string,en:string)=>zh?cn:en;
  const [initialLocation]=useState(()=>initialChecklistLocation(initialFolder,initialPath));
  const [folder,setFolder]=useState(initialLocation.folder);
  const [name,setName]=useState(initialLocation.name);
  const [listing,setListing]=useState<DirectoryListing|null>(null), [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [loading,setLoading]=useState(false), [busy,setBusy]=useState(false), [missing,setMissing]=useState(false);
  const [error,setError]=useState(''), [status,setStatus]=useState(''), [query,setQuery]=useState('');
  const [text,setText]=useState(''), [section,setSection]=useState(''), [dueDate,setDueDate]=useState(''), [editing,setEditing]=useState<ChecklistTask|null>(null);
  const [sourcePath,setSourcePath]=useState(()=>isInternalFilePath(initialSourcePath)?initialSourcePath:''),[focusedTask,setFocusedTask]=useState('');
  const appliedTaskFocus=useRef('');
  const [filter,setFilter]=useState<Filter>('pending'), [reward,setReward]=useState<Poem|null>(null);
  const [discard,setDiscard]=useState<(()=>void)|null>(null);
  const gate=useRef(false), reading=useRef(false), epoch=useRef(0), dirty=useRef(false), editingOpen=useRef(false);
  const dialog=useRef<HTMLElement>(null);
  editingOpen.current=!!editing;
  dirty.current=editing?text!==editing.text||section!==editing.section||dueDate!==(editing.dueDate||'')||sourcePath!==(editing.sourcePath||''):!!(text.trim()||section.trim()||dueDate||sourcePath);
  const path=join(folder,name);
  const requireOK=<T,>(r:ApiResult<T>):T=>{if(!r.ok)throw Error(r.error.code==='CONFLICT'||r.error.code==='EXISTS'?label('这份清单已经发生变化。请重新读取，检查最新内容后再试；你的输入仍保留。','This checklist changed. Refresh, review the latest content and retry; your draft is kept.'):r.error.message);return r.value;};
  const load=async(reset=false)=>{
    if(gate.current||reading.current)return;
    const token=++epoch.current, wanted=path; reading.current=true;
    setLoading(true);
    if(reset){setSnapshot(null);setMissing(false);setListing(null);setReward(null);}
    try {
      const list=requireOK(await window.desktop.listDirectory({vaultId:vault.id,path:folder}));
      if(token!==epoch.current)return;
      setListing(list);
      if(!list.entries.some(item=>item.path===wanted)) {setSnapshot(null);setMissing(true);setError('');return;}
      const file=requireOK(await window.desktop.readFile({vaultId:vault.id,path:wanted}));
      const doc=parseChecklist(file.text||'');
      if(token!==epoch.current)return;
      setSnapshot({doc,sha:file.sha256});setMissing(false);setError('');
    } catch(e) {if(token===epoch.current){setError(e instanceof Error?e.message:String(e));setMissing(false);}}
    finally {if(token===epoch.current){reading.current=false;setLoading(false);}}
  };
  const loadLatest=useRef(load);loadLatest.current=load;
  useEffect(()=>{void load(true);return()=>{epoch.current++;reading.current=false;};},[vault.id,folder,name]);
  useEffect(()=>{
    const refresh=()=>{if(!editingOpen.current&&!dirty.current&&!gate.current&&!document.hidden)void loadLatest.current();};
    const timer=setInterval(refresh,20000);
    const off=window.desktop.onVaultChange?.(event=>{if(event.vaultId===vault.id)refresh();});
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    const before=(event:BeforeUnloadEvent)=>{if(dirty.current||gate.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',before);
    return()=>{clearInterval(timer);off?.();window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('beforeunload',before);};
  },[vault.id]);
  useEffect(()=>{
    if(!reward&&!discard)(dialog.current?.querySelector<HTMLElement>('textarea,button:not(:disabled)'))?.focus();
  },[reward,discard]);
  useEffect(()=>{
    if(!snapshot||!initialTaskId)return;
    const key=path+':'+initialTaskId.toLowerCase();if(appliedTaskFocus.current===key)return;
    const task=snapshot.doc.tasks.find(item=>item.id.toLowerCase()===initialTaskId.toLowerCase());if(!task)return;
    // Locate the original task without changing its draft or creating a second copy.
    appliedTaskFocus.current=key;setQuery('');setFilter(task.archivedAt?'archived':task.done?'done':'pending');setFocusedTask(task.id);
  },[snapshot,initialTaskId,path]);
  useEffect(()=>{
    if(!focusedTask)return;
    const task=[...dialog.current?.querySelectorAll<HTMLElement>('[data-checklist-task-id]')||[]].find(item=>item.dataset.checklistTaskId===focusedTask);
    task?.scrollIntoView({block:'nearest'});task?.focus({preventScroll:true});
  },[focusedTask,filter]);
  const clearDraft=()=>{setText('');setSection('');setDueDate('');setSourcePath('');setEditing(null);};
  const guarded=(action:()=>void)=>{if(gate.current)return;if(dirty.current)setDiscard(()=>action);else action();};
  const changeFolder=(next:string,nextName=defaultName)=>guarded(()=>{clearDraft();setFolder(next);setName(nextName);setStatus('');setError('');setFilter('pending');setFocusedTask('');});
  const save=async(next:Checklist,after?:()=>void,poem?:Poem)=>{
    if(gate.current||loading||reading.current)return;
    gate.current=true;setBusy(true);setError('');setStatus('');
    const before=snapshot;
    try {
      const content=serializeChecklist(next);
      if(before) {const result=requireOK(await window.desktop.saveText({vaultId:vault.id,path,expectedSHA256:before.sha,text:content}));setSnapshot({doc:next,sha:result.sha256});}
      else {
        if(!missing)throw Error(label('请先读取清单。','Load the checklist first.'));
        const destination=checklistCreationLocation(folder,name);
        const file=requireOK(await window.desktop.createTextFile({vaultId:vault.id,...destination,content}));setSnapshot({doc:next,sha:file.sha256});setMissing(false);
      }
      setStatus(label('已保存 · iCloud 文件夹会继续同步','Saved · your iCloud folder will sync changes'));
      after?.();if(poem)setReward(poem);onSaved();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{gate.current=false;setBusy(false);}
  };
  const create=(template=false)=>{
    let doc=createChecklist(folder.split('/').at(-1)||vault.name);
    if(template)for(const task of (zh?['预习本周资料','完成练习 / Tutorial','整理课堂笔记','复习重点和易错点','检查并提交本周作业']:['Preview this week’s material','Complete exercises / tutorial','Organize lecture notes','Review key points and mistakes','Check and submit weekly assignments']))doc=addTask(doc,task,'');
    void save(doc);
  };
  const submit=()=>{if(!snapshot||!text.trim())return;try{const next=editing?updateTask(snapshot.doc,editing.id,{text:text.trim(),section:section.trim(),dueDate:dueDate||null,sourcePath:sourcePath||null}):addTask(snapshot.doc,text.trim(),section.trim(),{...(dueDate?{dueDate}:{}),...(sourcePath?{sourcePath}:{})});void save(next,clearDraft);}catch(e){setError(String(e instanceof Error?e.message:e));}};
  const toggle=(task:ChecklistTask)=>{
    if(!snapshot)return;
    const prior=poems.find(p=>p.id===task.rewardId), candidates=poems.filter(p=>p.id!==reward?.id);
    const poem=task.rewardId?prior:(candidates.length?candidates:poems)[Math.floor(Math.random()*(candidates.length||poems.length))];
    try {void save(updateTask(snapshot.doc,task.id,{done:!task.done},{rewardId:poem?.id}),undefined,!task.done?poem:undefined);}catch(e){setError(String(e));}
  };
  const tasks=snapshot?.doc.tasks||[], visible=tasks.filter(t=>filter==='archived'?!!t.archivedAt:!t.archivedAt), active=tasks.filter(t=>!t.archivedAt), done=active.filter(t=>t.done).length;
  const shown=visible.filter(t=>(filter!=='pending'||!t.done)&&(filter!=='done'||t.done)&&(!query.trim()||[t.text,t.section].some(v=>v.toLowerCase().includes(query.trim().toLowerCase()))));
  const earned=tasks.filter(t=>t.rewardId).map(t=>({task:t,poem:poems.find(p=>p.id===t.rewardId)})).filter(v=>v.poem);
  const linkedFiles=(listing?.entries||[]).filter(item=>item.kind!=='folder'&&isInternalFilePath(item.path)&&!item.name.toLowerCase().endsWith('.inkcheck.json')&&!item.name.toLowerCase().endsWith('.inkcalendar.json')).slice(0,200);
  const locked=busy||loading;
  return <div className="modal-shade checklist-shade" onKeyDown={event=>{
    event.stopPropagation();
    if(event.nativeEvent.isComposing)return;
    if(event.key==='Escape'){if(reward)setReward(null);else if(discard)setDiscard(null);else guarded(onClose);}
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(!reward&&!discard)submit();}
    if(event.key==='Tab'){
      const scope=event.currentTarget.querySelector('.checklist-reward-shade')||event.currentTarget;
      const controls=[...scope.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')].filter(el=>el.getClientRects().length>0);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&(document.activeElement===first||!scope.contains(document.activeElement))){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}>
    <section ref={dialog} className="course-checklist" role="dialog" aria-modal="true" aria-label={label('课程清单','Course checklist')} aria-busy={locked}>
      <header inert={!!reward||!!discard}><div><span className="checklist-eyebrow">{label('一步一步，积少成多','ONE STEP AT A TIME')}</span><h2><ListChecks/>{label('课程清单','Course checklist')}</h2></div><Button autoFocus aria-label={label('关闭课程清单','Close course checklist')} disabled={busy} onClick={()=>guarded(onClose)}><X/></Button></header>
      <div className="checklist-layout" inert={!!reward||!!discard}>
        <aside className="checklist-courses"><h3>{label('课程文件夹','Course folders')}</h3><div className="checklist-folder-actions"><Button disabled={locked||!folder} onClick={()=>changeFolder(parentOf(folder))}><ArrowUp/>{label('上层','Up')}</Button><Button disabled={locked||!folder} onClick={()=>changeFolder('')}>{label('根目录','Root')}</Button></div><p className="checklist-path">{folder||vault.name}</p><nav aria-label={label('选择课程','Choose course')}>
          {listing?.entries.filter(e=>e.kind==='folder').map(e=><Button key={e.path} disabled={locked} onClick={()=>changeFolder(e.path)}><Folder/><span>{e.name}</span><ChevronRight/></Button>)}
          {listing?.entries.filter(e=>e.name.toLowerCase().endsWith('.inkcheck.json')&&e.name!==name).map(e=><Button key={e.path} disabled={locked} onClick={()=>changeFolder(folder,e.name)}><ListChecks/><span>{e.name.replace('.inkcheck.json','')}</span></Button>)}
        </nav><p className="checklist-footnote">{label('清单默认保存在资料库主文件夹。旧清单仍在原处，可在此选择文件夹，或从文件列表、日历打开；不会自动移动或合并。','Checklists default to the library’s main folder. Existing checklists stay in place: choose their folder here, or open them from Files or Calendar. Nothing is moved or merged automatically.')}</p></aside>
        <main className="checklist-main"><div className="checklist-heading"><div><h3>{snapshot?.doc.title||folder.split('/').at(-1)||vault.name}</h3><p>{snapshot?label(`${done} / ${active.length} 项完成`,`${done} / ${active.length} completed`):label('为这门课程安排下一步','Plan the next step for this course')}</p></div><div className="checklist-heading-actions">{onOpenCalendar&&<Button disabled={busy} onClick={()=>guarded(()=>onOpenCalendar(editing?.dueDate))}><CalendarDays/>{label('查看日历','View calendar')}</Button>}<Button disabled={locked} aria-label={label('刷新清单','Refresh checklist')} onClick={()=>void loadLatest.current()}><RefreshCw/></Button></div></div>
          {snapshot&&<progress aria-label={label('课程完成进度','Course progress')} max={Math.max(active.length,1)} value={done}/>}
          {error&&<p className="checklist-error" role="alert">{error}</p>}
          <p className="checklist-status" role="status">{busy?label('正在保存…','Saving…'):loading?label('正在读取…','Loading…'):status}</p>
          {missing&&!snapshot&&!loading&&<div className="checklist-empty"><BookOpen/><h3>{label('从一件小事开始','Start with one small step')}</h3><p>{label('完成一项，收获一句古诗词。','Complete a task and collect a classical Chinese verse.')}</p>{folder?<><p>{label('新清单只能保存在资料库主文件夹；旧清单仍可在原位置编辑。','New checklists belong in the library’s main folder. Existing checklists can still be edited in place.')}</p><Button className="primary" disabled={busy} onClick={()=>changeFolder('')}>{label('在主文件夹创建或打开清单','Create or open checklist in main folder')}</Button></>:<><Button className="primary" disabled={busy} onClick={()=>create()}>{label('创建空白清单','Create empty checklist')}</Button><Button disabled={busy} onClick={()=>create(true)}>{label('使用每周学习模板','Use weekly study template')}</Button></>}</div>}
          {snapshot&&<><div className="checklist-filters" role="group" aria-label={label('清单筛选','Checklist filter')}>{(['pending','done','all','archived','poems'] as Filter[]).map(f=><Button key={f} aria-pressed={filter===f} onClick={()=>setFilter(f)}>{({pending:label('待完成','To do'),done:label('已完成','Done'),all:label('全部','All'),archived:label('归档','Archive'),poems:label('已获诗词','Collected verses')})[f]}</Button>)}</div>
            {filter!=='poems'&&<input aria-label={label('搜索事项','Search tasks')} className="checklist-search" placeholder={label('搜索事项或周次…','Search tasks or week…')} value={query} onChange={e=>setQuery(e.target.value)}/>}
            <div className="checklist-tasks">{filter==='poems'?(earned.length?earned.map(({task,poem})=><article className="checklist-earned" key={task.id}><small>{task.text}</small><blockquote>{poem!.text}</blockquote><p>{poem!.author}《{poem!.title}》</p><Button onClick={()=>setReward(poem!)}>{label('查看诗词','Read verse')}</Button></article>):<p className="checklist-empty-note">{label('完成第一件事，收藏第一句诗。','Finish your first task to collect a verse.')}</p>):shown.length?shown.map(task=><article className={`checklist-task ${task.done?'is-done':''} ${focusedTask===task.id?'is-focused':''}`} key={task.id} data-checklist-task-id={task.id} tabIndex={-1}>
              {!task.archivedAt&&<input type="checkbox" aria-label={label('完成：','Complete: ')+task.text} checked={task.done} disabled={locked} onChange={()=>toggle(task)}/>}
              <div className="checklist-task-copy">{task.section&&<small>{task.section}</small>}<span>{task.text}</span>{(task.dueDate||task.sourcePath)&&<div className="checklist-task-context">{task.dueDate&&(onOpenCalendar?<button type="button" className="checklist-context-link" disabled={busy} aria-label={label('在日历查看：','View in calendar: ')+task.text} onClick={()=>guarded(()=>onOpenCalendar(task.dueDate))}><CalendarDays/><time dateTime={task.dueDate}>{task.dueDate}</time></button>:<time className="checklist-task-date" dateTime={task.dueDate}>{label('安排日期：','Scheduled: ')}{task.dueDate}</time>)}{task.sourcePath&&(onOpenSource?<button type="button" className="checklist-context-link" disabled={busy} title={task.sourcePath} aria-label={label('打开关联资料：','Open linked material: ')+task.sourcePath} onClick={()=>guarded(()=>onOpenSource(task.sourcePath!))}><FileText/><span>{task.sourcePath.split('/').at(-1)}</span></button>:<small title={task.sourcePath}>{task.sourcePath.split('/').at(-1)}</small>)}</div>}</div>
              {task.archivedAt?<Button aria-label={label('恢复：','Restore: ')+task.text} disabled={locked} onClick={()=>void save(updateTask(snapshot.doc,task.id,{archived:false}))}><Undo2/></Button>:<><Button aria-label={label('编辑：','Edit: ')+task.text} disabled={locked} onClick={()=>guarded(()=>{setEditing(task);setText(task.text);setSection(task.section);setDueDate(task.dueDate||'');setSourcePath(task.sourcePath||'');})}><Pencil/></Button><Button aria-label={label('归档：','Archive: ')+task.text} disabled={locked} onClick={()=>void save(updateTask(snapshot.doc,task.id,{archived:true}))}><Archive/></Button></>}
            </article>):<p className="checklist-empty-note">{label(query.trim()?'没有匹配的事项，试试其他关键词。':filter==='pending'&&active.length&&done===active.length?'这门课程的事项都完成了。继续保持！':'这里还没有事项。',query.trim()?'No matching tasks. Try another keyword.':filter==='pending'&&active.length&&done===active.length?'All tasks for this course are complete. Well done!':'No tasks here yet.')}</p>}</div>
            <form className="checklist-composer" onSubmit={e=>{e.preventDefault();submit();}}><label>{editing?label('编辑事项','Edit task'):label('添加事项','Add a task')}<textarea aria-label={label('事项内容','Task text')} maxLength={1000} value={text} disabled={locked} onChange={e=>setText(e.target.value)} placeholder={label('例如：完成第 3 周 Tutorial 练习','For example: finish week 3 tutorial exercises')}/></label><div><input aria-label={label('周次或分组','Week or group')} maxLength={200} value={section} disabled={locked} onChange={e=>setSection(e.target.value)} placeholder={label('周次 / 分组（可选）','Week / group (optional)')}/><label className="checklist-date-field">{label('安排日期（可选）','Scheduled date (optional)')}<input type="date" min="0001-01-01" max="9999-12-31" aria-label={label('安排日期','Scheduled date')} value={dueDate} disabled={locked} onChange={e=>setDueDate(e.target.value)}/></label>{dueDate&&<Button type="button" disabled={locked} onClick={()=>setDueDate('')}>{label('清除日期','Clear date')}</Button>}{editing&&<Button disabled={locked} onClick={clearDraft} type="button">{label('取消编辑','Cancel edit')}</Button>}<Button className="primary" disabled={locked||!text.trim()} type="submit"><Plus/>{editing?label('保存修改','Save changes'):label('添加','Add')}</Button></div><div className="checklist-source-row"><label>{label('关联资料（可选）','Linked material (optional)')}<select aria-label={label('关联资料','Linked material')} value={sourcePath} disabled={locked} onChange={event=>setSourcePath(event.target.value)}><option value="">{label('不关联资料','No linked material')}</option>{sourcePath&&!linkedFiles.some(file=>file.path===sourcePath)&&<option value={sourcePath}>{sourcePath}</option>}{linkedFiles.map(file=><option key={file.path} value={file.path}>{file.name}</option>)}</select></label><small>{label('关联本课程文件，完成事项时可直接回到原资料。','Link a course file so you can return to the material from your task.')}</small></div></form>
          </>}
        </main>
      </div>
      {reward&&<div className="checklist-reward-shade"><article className="checklist-reward" role="dialog" aria-modal="true" aria-label={label('古诗词奖励','Poetry reward')}><CheckCheck/><p className="checklist-eyebrow">{label('完成一事，赠你一句诗','A VERSE FOR YOUR PROGRESS')}</p><blockquote>{reward.text.split(/(?<=[，；])/u).map((line,index)=><span className="checklist-poem-line" key={index}>{line}</span>)}</blockquote><p className="checklist-poet">{reward.author} ·《{reward.title}》</p><p>{reward.note}</p><p className="checklist-source">{label('出处：','Source: ')}{reward.sourceURL}</p><Button autoFocus className="primary" onClick={()=>setReward(null)}>{label('收下，继续前进','Keep going')}</Button></article></div>}
      {discard&&<div className="checklist-reward-shade"><article className="checklist-confirm" role="alertdialog" aria-label={label('保留未保存内容','Keep your draft')}><h3>{label('还有未保存的事项','You have an unsaved task')}</h3><p>{label('返回可以继续编辑，已保存的清单不受影响。','Go back to continue editing. Saved checklist items are unaffected.')}</p><Button autoFocus onClick={()=>setDiscard(null)}>{label('继续编辑','Keep editing')}</Button><Button onClick={()=>{const action=discard;setDiscard(null);clearDraft();action();}}>{label('放弃这段输入','Discard this draft')}</Button></article></div>}
    </section>
  </div>;
}

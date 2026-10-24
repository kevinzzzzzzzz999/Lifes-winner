import {useEffect,useMemo,useRef,useState} from 'react';
import {CalendarDays,CheckCheck,ChevronLeft,ChevronRight,FileText,FolderOpen,ListChecks,RefreshCw,X} from 'lucide-react';
import type {Vault} from '../shared/desktop-api';
import type {Language} from './i18n';
import {Button} from './ui';
import {isChecklistDate,type ChecklistTaskPatch} from './course-checklist';
import {calendarMonthDays,calendarTasks,localCalendarDate,saveCalendarTask,scanCourseChecklists,shiftCalendarMonth,type CalendarTask,type CalendarScan,type ChecklistSnapshot} from './course-calendar';
import poemsJSON from './poetry-rewards.json';
import './calendar.css';

type Poem={id:string;text:string;author:string;title:string;note:string;sourceURL:string};
const poems=poemsJSON as Poem[];
type Props={vault:Vault;language:Language;initialDate?:string;onClose:()=>void;onOpenChecklist:(folder:string,path?:string,taskId?:string)=>void;onOpenSource?:(path:string)=>void;onSaved?:()=>void};
export default function Calendar({vault,language,initialDate,onClose,onOpenChecklist,onOpenSource,onSaved}:Props){
 const zh=language==='zh',label=(cn:string,en:string)=>zh?cn:en;
 const [today,setToday]=useState(()=>localCalendarDate()),[month,setMonth]=useState(()=>(isChecklistDate(initialDate)?initialDate:localCalendarDate()).slice(0,7)),[selected,setSelected]=useState(()=>isChecklistDate(initialDate)?initialDate:localCalendarDate());
 const [view,setView]=useState<'day'|'undated'|'overdue'>('day'),[includeDone,setIncludeDone]=useState(false),[coursePath,setCoursePath]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(0);
 const [snapshots,setSnapshots]=useState<ChecklistSnapshot[]>([]),[scan,setScan]=useState<CalendarScan|null>(null),[verified,setVerified]=useState<Set<string>>(new Set());
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 const [dates,setDates]=useState<Record<string,string>>({}),[reward,setReward]=useState<Poem|null>(null),[discard,setDiscard]=useState<(()=>void)|null>(null);
 const active=useRef(true),gate=useRef(false),reading=useRef(false),dirty=useRef(false),epoch=useRef(0),lastRead=useRef(0),rewardRef=useRef(false),dialog=useRef<HTMLElement>(null);
 dirty.current=Object.keys(dates).length>0;rewardRef.current=!!reward||!!discard;
 const refresh=async()=>{
  if(gate.current||reading.current)return;
  const token=++epoch.current;reading.current=true;setLoading(true);setError('');
  try{
   const next=await scanCourseChecklists(window.desktop,vault.id);
   if(!active.current||epoch.current!==token)return;
   setScan(next);setVerified(new Set(next.snapshots.map(item=>item.path)));
   // Partial cloud reads never replace a previously readable course with an empty
   // list. Retained rows are marked stale and cannot be modified until verified.
   setSnapshots(previous=>next.partial?[...new Map([...previous,...next.snapshots].map(item=>[item.path,item])).values()]:next.snapshots);
   setStatus(label(`已读取 ${next.snapshots.length} 份课程清单`,`${next.snapshots.length} course checklists read`));lastRead.current=Date.now();
  }catch(e){if(active.current&&epoch.current===token){setError(e instanceof Error?e.message:String(e));setVerified(new Set());}}
  finally{if(active.current&&epoch.current===token){reading.current=false;setLoading(false);}}
 };
 const latestRefresh=useRef(refresh);latestRefresh.current=refresh;
 useEffect(()=>{active.current=true;reading.current=false;gate.current=false;setBusy(false);setReward(null);setDiscard(null);setSnapshots([]);setScan(null);setVerified(new Set());setDates({});setCoursePath('');void latestRefresh.current();return()=>{active.current=false;epoch.current++;};},[vault.id]);
 useEffect(()=>{
  const auto=()=>{setToday(localCalendarDate());if(!document.hidden&&!dirty.current&&!rewardRef.current&&!gate.current&&Date.now()-lastRead.current>=30000)void latestRefresh.current();};
  const interval=setInterval(auto,60000),off=window.desktop.onVaultChange?.(event=>{if(event.vaultId===vault.id)auto();});
  window.addEventListener('focus',auto);document.addEventListener('visibilitychange',auto);
  const before=(event:BeforeUnloadEvent)=>{if(dirty.current||gate.current){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',before);
  return()=>{clearInterval(interval);off?.();window.removeEventListener('focus',auto);document.removeEventListener('visibilitychange',auto);window.removeEventListener('beforeunload',before);};
 },[vault.id]);
 useEffect(()=>{if(!reward&&!discard)dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();},[reward,discard]);
 const tasks=useMemo(()=>calendarTasks(snapshots),[snapshots]);
 const eligible=tasks.filter(row=>(includeDone||!row.task.done)&&(!coursePath||row.path===coursePath)&&(!query.trim()||[row.task.text,row.task.section,row.course].some(value=>value.toLowerCase().includes(query.trim().toLowerCase()))));
 const counts=new Map<string,number>();for(const row of eligible)if(row.task.dueDate)counts.set(row.task.dueDate,(counts.get(row.task.dueDate)||0)+1);
 const undated=eligible.filter(row=>!row.task.dueDate),overdue=eligible.filter(row=>!row.task.done&&!!row.task.dueDate&&row.task.dueDate<today);
 const rows=view==='undated'?undated:view==='overdue'?overdue:eligible.filter(row=>row.task.dueDate===selected);
 const currentPage=Math.min(page,Math.max(0,Math.ceil(rows.length/100)-1)),shownRows=rows.slice(currentPage*100,(currentPage+1)*100);
 useEffect(()=>{setPage(0);},[view,selected,includeDone,coursePath,query]);
 const days=calendarMonthDays(month),locked=busy||loading;
 const guarded=(action:()=>void)=>{if(gate.current)return;if(dirty.current)setDiscard(()=>action);else action();};
 const chooseDay=(date:string)=>{if(!date)return;setSelected(date);setMonth(date.slice(0,7));setView('day');};
 const setDraft=(row:CalendarTask,value:string)=>{setDates(previous=>{const next={...previous};if(value===(row.task.dueDate||''))delete next[row.key];else next[row.key]=value;return next;});};
 const write=async(row:CalendarTask,patch:ChecklistTaskPatch,poem?:Poem)=>{
  if(gate.current||reading.current||!verified.has(row.path))return;
  const before=snapshots.find(item=>item.path===row.path);if(!before)return;
  const token=epoch.current;gate.current=true;setBusy(true);setError('');setStatus('');
  try{
   const saved=await saveCalendarTask(window.desktop,vault.id,before,row.task.id,patch,poem?{rewardId:poem.id}:{});
   if(!active.current||epoch.current!==token)return;
   setSnapshots(previous=>previous.map(item=>item.path===saved.path?saved:item));
   if(Object.hasOwn(patch,'dueDate'))setDates(previous=>{const next={...previous};delete next[row.key];return next;});
   setStatus(label('已保存到原课程清单 · iCloud 会继续同步','Saved to the original course checklist · iCloud will sync changes'));
   if(poem)setReward(poem);onSaved?.();
  }catch(e){if(active.current&&epoch.current===token){const failure=e as {code?:string;message?:string};setError(failure.code==='CONFLICT'?label('这份课程清单已在其他窗口或设备上修改。请刷新并核对后重试；你的日期输入仍保留。','This checklist changed in another window or device. Refresh, review and retry; your date draft is kept.'):failure.message||String(e));}}
  finally{if(active.current&&epoch.current===token){gate.current=false;setBusy(false);}}
 };
 const toggle=(row:CalendarTask)=>{
  const savedPoem=poems.find(item=>item.id===row.task.rewardId),choices=poems.filter(item=>item.id!==reward?.id),pool=choices.length?choices:poems;
  const poem=row.task.rewardId?savedPoem:pool[Math.floor(Math.random()*pool.length)];
  void write(row,{done:!row.task.done},!row.task.done?poem:undefined);
 };
 return <div className="calendar-shade" onKeyDown={event=>{
  event.stopPropagation();if(event.nativeEvent.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();if(reward)setReward(null);else if(discard)setDiscard(null);else guarded(onClose);}
  if(event.key==='Tab'){
   const scope=event.currentTarget.querySelector('.calendar-overlay')||event.currentTarget,controls=[...scope.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')].filter(el=>el.getClientRects().length>0),first=controls[0],last=controls.at(-1);
   if(event.shiftKey&&(document.activeElement===first||!scope.contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}><section className="course-calendar" ref={dialog} role="dialog" aria-modal="true" aria-label={label('课程日历','Course calendar')} aria-busy={locked}>
  <header inert={!!reward||!!discard}><div><span className="calendar-eyebrow">{label('把学习安排到每一天','MAKE ROOM FOR LEARNING')}</span><h2><CalendarDays/>{label('课程日历','Course calendar')}</h2><p>{vault.name} · {label('与课程清单共用同一份文件','Shares the same files as your course checklists')}</p></div><div className="calendar-header-actions"><Button disabled={locked} onClick={()=>void refresh()}><RefreshCw/>{label('刷新','Refresh')}</Button><Button disabled={busy} aria-label={label('关闭日历','Close calendar')} onClick={()=>guarded(onClose)}><X/></Button></div></header>
  <div className="calendar-body" inert={!!reward||!!discard}>
   <div className="calendar-feedback"><p role="status">{busy?label('正在保存…','Saving…'):loading?label('正在读取课程清单…','Reading course checklists…'):status}</p>{error&&<p className="calendar-error" role="alert">{error}</p>}
    {scan?.partial&&<details className="calendar-warning"><summary>{label('当前为部分结果，部分文件夹或清单尚未读到。','Partial results: some folders or checklists could not be read.')}</summary><p>{label('已读内容会保留；显示“待核对”的课程暂不能修改。可在 Finder 下载 iCloud 文件后刷新，或直接打开课程清单。大型资料库请分课程打开文件夹。','Readable content is kept. Courses marked “Needs refresh” cannot be changed here yet. Download iCloud files in Finder and refresh, or open the course checklist. For very large libraries, open one course folder at a time.')}</p><ul>{scan.issues.map((item,i)=><li key={i}>{item.path||vault.name} · {({limit:label('达到本次读取上限','Scan limit reached'),timeout:label('文件尚未就绪或读取超时','File not ready or read timed out'),invalid:label('清单格式无效，原文件未修改','Invalid checklist; original file unchanged'),boundary:label('路径未通过检查','Path check failed'),unavailable:label('暂时无法读取','Temporarily unavailable')})[item.code]}</li>)}</ul></details>}
   </div>
   <div className="calendar-filters"><label>{label('课程','Course')}<select value={coursePath} onChange={event=>setCoursePath(event.target.value)}><option value="">{label('全部课程','All courses')}</option>{snapshots.map(item=><option key={item.path} value={item.path}>{item.doc.title} · {item.folder||vault.name}</option>)}</select></label><input type="search" aria-label={label('搜索日历事项','Search calendar tasks')} placeholder={label('搜索事项、周次或课程','Search tasks, weeks or courses')} value={query} onChange={event=>setQuery(event.target.value)}/><label className="calendar-checkbox"><input type="checkbox" checked={includeDone} onChange={event=>setIncludeDone(event.target.checked)}/>{label('显示已完成','Show completed')}</label></div>
   <div className="calendar-columns"><section className="calendar-month" aria-label={label('月份','Month')}><div className="calendar-month-heading"><h3>{zh?`${Number(month.slice(0,4))} 年 ${Number(month.slice(5))} 月`:new Intl.DateTimeFormat('en',{year:'numeric',month:'long',timeZone:'UTC'}).format(new Date(month+'-15T12:00:00Z'))}</h3><div><Button aria-label={label('上个月','Previous month')} onClick={()=>setMonth(shiftCalendarMonth(month,-1))}><ChevronLeft/></Button><Button onClick={()=>chooseDay(today)}>{label('今天','Today')}</Button><Button aria-label={label('下个月','Next month')} onClick={()=>setMonth(shiftCalendarMonth(month,1))}><ChevronRight/></Button></div></div>
    <div className="calendar-weekdays" aria-hidden="true">{(zh?['一','二','三','四','五','六','日']:['Mon','Tue','Wed','Thu','Fri','Sat','Sun']).map(day=><span key={day}>{day}</span>)}</div>
    <div className="calendar-grid">{days.map((day,i)=><button key={day.date||i} type="button" disabled={!day.date} className={`calendar-day ${day.inMonth?'':'outside-month'} ${day.date===today?'is-today':''} ${day.date===selected&&view==='day'?'is-selected':''}`} aria-pressed={day.date===selected&&view==='day'} aria-label={`${day.date}${counts.has(day.date)?label(`，${counts.get(day.date)} 项事项`,`, ${counts.get(day.date)} tasks`):''}`} onClick={()=>chooseDay(day.date)}><span>{day.date?Number(day.date.slice(-2)):''}</span>{!!counts.get(day.date)&&<small>{counts.get(day.date)}{label(' 项','')}</small>}</button>)}</div>
    <div className="calendar-quick-filters"><Button aria-pressed={view==='undated'} onClick={()=>setView('undated')}>{label('未安排日期','Unscheduled')}<b>{undated.length}</b></Button><Button aria-pressed={view==='overdue'} onClick={()=>setView('overdue')}>{label('已过期未完成','Overdue')}<b>{overdue.length}</b></Button></div>
    <p className="calendar-note">{label('先在课程清单里添加事项，再选日期安排。完成和改期都会保存回原来的课程清单。','Add tasks in a course checklist, then assign dates here. Completion and schedule changes are saved to the original checklist.')}</p><Button disabled={busy} onClick={()=>guarded(()=>onOpenChecklist(''))}><ListChecks/>{label('打开课程清单','Open course checklists')}</Button>
   </section>
   <section className="calendar-agenda"><div className="calendar-agenda-heading"><h3>{view==='day'?selected:view==='undated'?label('未安排日期','Unscheduled'):label('已过期未完成','Overdue')}</h3><span>{label(`${rows.length} 项`,`${rows.length} tasks`)}</span></div>
    {rows.length?shownRows.map(row=>{const stale=!verified.has(row.path),value=dates[row.key]??row.task.dueDate??'',hasDraft=Object.hasOwn(dates,row.key);return <article key={row.key} className={`calendar-task ${row.task.done?'is-done':''}`}>
     <div className="calendar-task-top"><input type="checkbox" aria-label={label('完成：','Complete: ')+row.task.text} checked={row.task.done} disabled={locked||stale||hasDraft} title={hasDraft?label('请先保存或取消日期修改','Save or cancel the date change first'):undefined} onChange={()=>toggle(row)}/><div><small>{row.course}{row.task.section?' · '+row.task.section:''}</small><p>{row.task.text}</p>{stale&&<span className="calendar-stale">{label('待核对 · 请刷新','Needs refresh')}</span>}</div><Button disabled={busy} title={row.path} aria-label={label('打开课程清单：','Open checklist: ')+row.course} onClick={()=>guarded(()=>onOpenChecklist(row.folder,row.path,row.task.id))}><FolderOpen/></Button></div>
     {row.task.sourcePath&&onOpenSource&&<button type="button" className="checklist-context-link calendar-task-source" title={row.task.sourcePath} disabled={busy} aria-label={label('打开关联资料：','Open linked material: ')+row.task.sourcePath} onClick={()=>guarded(()=>onOpenSource(row.task.sourcePath!))}><FileText/><span>{row.task.sourcePath.split('/').at(-1)}</span></button>}<div className="calendar-task-date"><label>{label('安排日期','Scheduled date')}<input type="date" min="0001-01-01" max="9999-12-31" aria-label={label('安排日期：','Scheduled date: ')+row.task.text} value={value} disabled={locked||stale} onChange={event=>setDraft(row,event.target.value)}/></label>{hasDraft&&<><Button className="primary" disabled={locked||stale||!!value&&!isChecklistDate(value)} onClick={()=>void write(row,{dueDate:value||null})}>{label('保存日期','Save date')}</Button><Button disabled={busy} onClick={()=>setDates(previous=>{const next={...previous};delete next[row.key];return next;})}>{label('取消','Cancel')}</Button></>}{!hasDraft&&row.task.dueDate&&<Button disabled={locked||stale} onClick={()=>setDraft(row,'')}>{label('清除日期','Clear date')}</Button>}{!row.task.dueDate&&!hasDraft&&<Button disabled={locked||stale} onClick={()=>setDraft(row,selected)}>{label('安排到所选日','Use selected day')}</Button>}</div>
    </article>;}):<div className="calendar-empty"><CalendarDays/><h4>{loading?label('正在读取…','Reading…'):scan?.partial?label('本次已读清单在这里没有事项','No matching tasks in the checklists read so far'):label('这里还没有事项','No tasks here yet')}</h4><p>{label('可在“未安排日期”中安排已有事项，或打开课程清单添加。','Schedule existing tasks under Unscheduled, or add tasks in a course checklist.')}</p></div>}
    {rows.length>100&&<div className="calendar-pagination"><Button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>{label('上一页','Previous')}</Button><span>{currentPage+1} / {Math.ceil(rows.length/100)}</span><Button disabled={(currentPage+1)*100>=rows.length} onClick={()=>setPage(currentPage+1)}>{label('下一页','Next')}</Button></div>}
   </section></div>
  </div>
  {reward&&<div className="calendar-overlay"><article className="calendar-reward" role="dialog" aria-modal="true" aria-label={label('古诗词奖励','Poetry reward')}><CheckCheck/><p>{label('完成一事，赠你一句诗','A VERSE FOR YOUR PROGRESS')}</p><blockquote>{reward.text}</blockquote><p>{reward.author} ·《{reward.title}》</p><p>{reward.note}</p><small>{reward.sourceURL}</small><Button autoFocus className="primary" onClick={()=>setReward(null)}>{label('收下，继续前进','Keep going')}</Button></article></div>}
  {discard&&<div className="calendar-overlay"><article className="calendar-reward" role="alertdialog" aria-label={label('还有未保存的日期','Unsaved dates')}><h3>{label('还有未保存的日期','You have unsaved dates')}</h3><p>{label('返回可以继续编辑。已保存的课程清单不受影响。','Go back to keep editing. Saved course checklists are unaffected.')}</p><Button autoFocus onClick={()=>setDiscard(null)}>{label('继续编辑','Keep editing')}</Button><Button onClick={()=>{const action=discard;setDiscard(null);setDates({});action();}}>{label('放弃日期输入','Discard date drafts')}</Button></article></div>}
 </section></div>;
}

import {useEffect,useState} from 'react';
import type {CalendarReminderSchedule,CalendarReminderStatus,Vault} from '../shared/desktop-api';
import type {CalendarDocument} from './calendar-types';
import {expandEvents,localDateInZone,systemTimeZone} from './calendar-model';
import {CALENDAR_FILE,readCalendar} from './calendar-store';
const PREFERENCE='winner-calendar-reminders-enabled',PREFERENCE_EVENT='winner-calendar-reminder-preference';
const DAY=86400000,EMPTY:CalendarReminderStatus={status:'idle',scheduled:0,permission:'system-managed'};
let lastStatus:CalendarReminderStatus=EMPTY;
export function getCalendarReminderPreference():boolean{try{return localStorage.getItem(PREFERENCE)!=='false';}catch{return true;}}
export function setCalendarReminderPreference(enabled:boolean){localStorage.setItem(PREFERENCE,String(enabled));window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT,{detail:{enabled}}));}
export function getCalendarReminderStatus():CalendarReminderStatus{return lastStatus;}
function publish(status:CalendarReminderStatus){lastStatus=status;window.dispatchEvent(new CustomEvent('winner-calendar-reminder-status',{detail:status}));}
export function calendarSchedules(doc:CalendarDocument,now=Date.now()):CalendarReminderSchedule[]{
 const byOffset=new Map<number,CalendarDocument['events']>();
 for(const event of doc.events)for(const minutes of new Set(event.reminders)){let events=byOffset.get(minutes);if(!events){events=[];byOffset.set(minutes,events);}events.push(event);}
 const zone=systemTimeZone(),schedules:CalendarReminderSchedule[]=[];
 // Each offset gets only its relevant occurrence window; a one-year alert must
 // not expand every daily event through the intervening year.
 for(const [minutes,events] of byOffset){
  const center=now+minutes*60000;
  const occurrences=expandEvents({...doc,events},localDateInZone(center-DAY,zone),localDateInZone(center+32*DAY,zone));
  for(const occurrence of occurrences){
   const fireAt=occurrence.startMs-minutes*60000;if(fireAt<now-5*60000||fireAt>now+30*DAY)continue;
   const event=occurrence.event;
   const when=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',...(event.allDay?{}:{timeStyle:'short'}),timeZone:event.timeZone}).format(new Date(occurrence.startMs));
   const clean=(s:string)=>s.replace(/[\x00-\x1f\x7f]/g,' ');
   schedules.push({eventId:event.id,occurrenceStart:new Date(occurrence.startMs).toISOString(),minutes,fireAt,title:clean(event.title).slice(0,300),body:clean(`${when} · ${event.timeZone}${event.location?' · '+event.location:''}`).slice(0,1000)});
   if(schedules.length>10000)throw new Error('提醒超过 10000 项，请减少重复日程或提醒。 / More than 10000 reminders; reduce repeating events or alerts.');
  }
 }
 return schedules;
}
/** Mount once in App, independent of the calendar dialog's visibility. */
export function useCalendarReminders(vault:Vault|null){
 const [enabled,setEnabledState]=useState(getCalendarReminderPreference),[status,setStatus]=useState<CalendarReminderStatus>(getCalendarReminderStatus);
 useEffect(()=>{const preference=()=>setEnabledState(getCalendarReminderPreference());window.addEventListener(PREFERENCE_EVENT,preference);return()=>window.removeEventListener(PREFERENCE_EVENT,preference);},[]);
 useEffect(()=>{
  const api=window.desktop;let stopped=false,busy=false,refreshAgain=false;
  const report=(value:CalendarReminderStatus)=>{if(!stopped){setStatus(value);publish(value);}};
  const offStatus=api.onCalendarReminderStatus?.(report);
  const refresh=async()=>{
   if(stopped||!vault)return;if(busy){refreshAgain=true;return;}busy=true;
   try{const snapshot=enabled?await readCalendar(api,vault.id):null;if(stopped)return;const response=await api.scheduleCalendarReminders({vaultId:vault.id,enabled,schedules:snapshot?calendarSchedules(snapshot.doc):[]});if(!response.ok)throw new Error(response.error.message);report(response.value);}
   catch(error){if(!stopped){await api.scheduleCalendarReminders({vaultId:vault.id,enabled:false,schedules:[]}).catch(()=>{});report({status:'error',scheduled:0,permission:'system-managed',error:error instanceof Error?error.message:String(error)});}}
   finally{busy=false;if(refreshAgain&&!stopped){refreshAgain=false;void refresh();}}
  };
  const auto=()=>{void refresh();},saved=(event:Event)=>{if((event as CustomEvent).detail?.vaultId===vault?.id)auto();};
  const offVault=api.onVaultChange?.(event=>{if(event.vaultId===vault?.id&&(event.rescan||event.paths.includes(CALENDAR_FILE)||event.reason==='resume'||event.reason==='unlock'))auto();});
  const visibility=()=>{if(document.visibilityState==='visible')auto();};
  const interval=setInterval(auto,60000);window.addEventListener('focus',auto);document.addEventListener('visibilitychange',visibility);window.addEventListener('winner-calendar-saved',saved);auto();
  if(!vault)report(EMPTY);
  return()=>{stopped=true;clearInterval(interval);offStatus?.();offVault?.();window.removeEventListener('focus',auto);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('winner-calendar-saved',saved);if(vault)void api.scheduleCalendarReminders({vaultId:vault.id,enabled:false,schedules:[]}).catch(()=>{});};
 },[vault?.id,enabled]);
 return {...status,enabled,setEnabled:setCalendarReminderPreference};
}

import type {DesktopAPI,ApiResult} from '../shared/desktop-api';
import type {CalendarDocument,CalendarSnapshot} from './calendar-types';
import {newCalendarDocument,parseCalendar,serializeCalendar} from './calendar-model';
export const CALENDAR_FILE='人生赢家日历.inkcalendar.json';
const LIMIT=4*1024*1024,TIMEOUT=17000;
type CalendarAPI=Pick<DesktopAPI,'readCalendarFile'|'saveText'|'createTextFile'>;
const reads=new WeakMap<CalendarAPI,Map<string,Promise<CalendarSnapshot>>>();
const saves=new WeakMap<CalendarAPI,Map<string,Promise<CalendarSnapshot>>>();
function unwrap<T>(result:ApiResult<T>):T{if(!result.ok)throw Object.assign(new Error(result.error.message),{code:result.error.code});return result.value;}
function bound<T>(work:Promise<T>,message:string):Promise<T>{let timer:ReturnType<typeof setTimeout>;return Promise.race([work,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(message),{code:'FILE_SCAN_TIMEOUT'})),TIMEOUT);})]).finally(()=>clearTimeout(timer));}
function jobs(map:WeakMap<CalendarAPI,Map<string,Promise<CalendarSnapshot>>>,api:CalendarAPI){let value=map.get(api);if(!value){value=new Map();map.set(api,value);}return value;}
function checked(doc:CalendarDocument){if(doc.events.length>5000)throw new Error('日程超过 5000 项，无法保存。 / Calendar exceeds 5000 events.');return doc;}
export function readCalendar(api:CalendarAPI,vaultId:string):Promise<CalendarSnapshot>{
 const pending=jobs(reads,api);let work=pending.get(vaultId);
 if(!work){work=(async()=>{const file=unwrap(await api.readCalendarFile({vaultId}));if(file===null)return {doc:newCalendarDocument(),sha:null};if(file.kind!=='text'||typeof file.text!=='string')throw new Error('无法读取日历内容。 / The calendar file is not text.');if(file.bytes>LIMIT||new TextEncoder().encode(file.text).length>LIMIT)throw new Error('日历文件超过 4 MiB。 / Calendar exceeds 4 MiB.');return {doc:checked(parseCalendar(file.text)),sha:file.sha256};})();pending.set(vaultId,work);work.finally(()=>{if(pending.get(vaultId)===work)pending.delete(vaultId);}).catch(()=>{});}
 return bound(work,'读取日历超时。请等待 iCloud 下载完成后重试。 / Calendar read timed out. Wait for the cloud download, then retry.');
}
export function saveCalendar(api:CalendarAPI,vaultId:string,snapshot:CalendarSnapshot,doc:CalendarDocument):Promise<CalendarSnapshot>{
 const pending=jobs(saves,api);if(pending.has(vaultId))return Promise.reject(new Error('上一次日历保存仍在进行，请稍后重新读取。 / The previous calendar save is still running. Reload after it finishes.'));
 let text:string;try{text=serializeCalendar(checked(doc));if(new TextEncoder().encode(text).length>LIMIT)throw new Error('日历文件超过 4 MiB。 / Calendar exceeds 4 MiB.');}catch(error){return Promise.reject(error);}
 // Persist an immutable validated copy, even if the caller edits its draft again.
 const next=parseCalendar(text);
 const work=(async()=>{const result=snapshot.sha===null?unwrap(await api.createTextFile({vaultId,parentPath:'',name:CALENDAR_FILE,content:text})):unwrap(await api.saveText({vaultId,path:CALENDAR_FILE,expectedSHA256:snapshot.sha,text}));const resultSnapshot={doc:next,sha:result.sha256};jobs(reads,api).delete(vaultId);if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('winner-calendar-saved',{detail:{vaultId}}));return resultSnapshot;})();
 pending.set(vaultId,work);work.finally(()=>{if(pending.get(vaultId)===work)pending.delete(vaultId);}).catch(()=>{});
 return bound(work,'日历保存尚未完成。请等待后重新读取核实，再次保存可能造成冲突。 / Saving is still pending. Reload to verify before saving again.');
}

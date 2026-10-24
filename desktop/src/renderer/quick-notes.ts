/** Quick notes use the existing checklist contract; there is no second task store. */
import {createChecklist,parseChecklist,serializeChecklist,newTask,updateTask,type CourseChecklist,type ChecklistTask} from './course-checklist.ts';
import type {ApiResult,OpenedFile} from '../shared/desktop-api.ts';

export const QUICK_NOTES_PATH='便签清单.inkcheck.json';
export type QuickNoteDraft={schemaVersion:1;id:string;text:string;editingId?:string;baseText?:string};
export type QuickNotesSnapshot={doc:CourseChecklist;sha:string};
export type QuickNotesIO={
 readFile:(request:{vaultId:string;path:string})=>Promise<ApiResult<OpenedFile>>;
 createTextFile:(request:{vaultId:string;parentPath:string;name:string;content:string})=>Promise<ApiResult<OpenedFile&{backupId:string}>>;
 saveText:(request:{vaultId:string;path:string;expectedSHA256:string;text:string})=>Promise<ApiResult<{sha256:string;backupId:string;bytes:number}>>;
};
export class QuickNotesError extends Error {readonly code:string;constructor(code:string,message:string){super(message);this.name='QuickNotesError';this.code=code;}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Use local calendar components. UTC slicing changes the deadline near midnight. */
export function quickNoteLocalDate(now=new Date()):string {
 if(!Number.isFinite(now.getTime()))throw new QuickNotesError('INVALID_DATE','Invalid capture date.');
 return `${String(now.getFullYear()).padStart(4,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
export function newQuickNoteDraft():QuickNoteDraft{return {schemaVersion:1,id:crypto.randomUUID(),text:''};}
export function parseQuickNoteDraft(raw:string|null):QuickNoteDraft|null {
 if(raw===null)return null;
 const value:unknown=JSON.parse(raw);
 if(!value||typeof value!=='object'||Array.isArray(value))throw new QuickNotesError('INVALID_DRAFT','Invalid quick note draft.');
 const d=value as Record<string,unknown>;
 if(d.schemaVersion!==1||typeof d.id!=='string'||!uuid.test(d.id)||typeof d.text!=='string'||(d.editingId!==undefined&&(typeof d.editingId!=='string'||!uuid.test(d.editingId)||typeof d.baseText!=='string')))throw new QuickNotesError('INVALID_DRAFT','Invalid quick note draft.');
 return {schemaVersion:1,id:d.id,text:d.text,...(typeof d.editingId==='string'?{editingId:d.editingId,baseText:d.baseText as string}:{})};
}
export const quickNoteDraftKey=(identity:string)=>'inkspace.quick-notes.draft.v1:'+encodeURIComponent(identity);
export function quickNoteIsDirty(draft:QuickNoteDraft):boolean{return draft.editingId?draft.text!==draft.baseText:!!draft.text;}
function copy(doc:CourseChecklist):CourseChecklist{return parseChecklist(serializeChecklist(doc));}
/** The stable draft ID makes a retry after an uncertain write idempotent. */
export function addQuickNote(doc:CourseChecklist,draft:QuickNoteDraft,now=new Date()):{doc:CourseChecklist;task:ChecklistTask;added:boolean} {
 const next=copy(doc),existing=next.tasks.find(t=>t.id.toLowerCase()===draft.id.toLowerCase());
 if(existing){
  const origin=existing.quickNote as Record<string,unknown>|undefined;
  if(origin?.feature==='quick-notes'&&origin.requestId===draft.id&&existing.text===draft.text)return {doc:next,task:existing,added:false};
  throw new QuickNotesError('ALREADY_RECORDED','这条便签已记录或已在清单修改。请打开清单核对；输入仍保留。 / This note was already recorded or edited in the checklist. Review it there; your draft is kept.');
 }
 const stamp=now.toISOString(),day=quickNoteLocalDate(now);
 const task=newTask(draft.text,'便签',{id:draft.id,now:stamp,dueDate:day});
 task.quickNote={feature:'quick-notes',version:1,requestId:draft.id,capturedLocalDate:day,defaultDeadline:'end-of-local-day'};
 next.tasks.push(task);next.updatedAt=stamp;serializeChecklist(next);
 return {doc:next,task,added:true};
}
export function editQuickNote(doc:CourseChecklist,draft:QuickNoteDraft,now=new Date()):CourseChecklist {
 const task=doc.tasks.find(t=>t.id.toLowerCase()===draft.editingId?.toLowerCase());
 if(!task)throw new QuickNotesError('NOT_FOUND','这条便签已不存在，输入仍保留。 / This note no longer exists; your draft is kept.');
 if(task.text!==draft.baseText&&task.text!==draft.text)throw new QuickNotesError('CONFLICT','便签内容已在别处修改，输入仍保留。请在清单核对后重新编辑。 / This note changed elsewhere. Your draft is kept; review it in the checklist before editing again.');
 return updateTask(doc,task.id,{text:draft.text},{now:now.toISOString()});
}
/** Array order is authoritative for both quick notes and the existing checklist. */
export function moveQuickNote(doc:CourseChecklist,id:string,direction:-1|1,visibleIds:string[],now=new Date()):CourseChecklist {
 const next=copy(doc),keys=visibleIds.map(v=>v.toLowerCase()),key=id.toLowerCase(),at=keys.indexOf(key),target=at+direction;
 if(new Set(keys).size!==keys.length||keys.some(v=>!next.tasks.some(t=>t.id.toLowerCase()===v)))throw new QuickNotesError('CONFLICT','排序内容已变化，请重新读取。 / The list changed; refresh before sorting.');
 if(at<0||target<0||target>=keys.length)return next;
 const from=next.tasks.findIndex(t=>t.id.toLowerCase()===key),to=next.tasks.findIndex(t=>t.id.toLowerCase()===keys[target]);
 [next.tasks[from],next.tasks[to]]=[next.tasks[to],next.tasks[from]];next.updatedAt=now.toISOString();serializeChecklist(next);return next;
}
function requireOK<T>(result:ApiResult<T>):T {
 if(result.ok)return result.value;
 throw new QuickNotesError(result.error.code,['CONFLICT','EXISTS'].includes(result.error.code)?'便签清单已变化。请重新读取后再试，输入仍保留。 / The checklist changed. Refresh and retry; your draft is kept.':result.error.message);
}
export async function readQuickNotes(io:QuickNotesIO,vaultId:string):Promise<QuickNotesSnapshot|null> {
 const result=await io.readFile({vaultId,path:QUICK_NOTES_PATH});
 if(!result.ok&&result.error.code==='NOT_FOUND')return null;
 const file=requireOK(result);return {doc:parseChecklist(file.text||''),sha:file.sha256};
}
export async function writeQuickNotes(io:QuickNotesIO,vaultId:string,next:CourseChecklist,before:QuickNotesSnapshot|null):Promise<QuickNotesSnapshot> {
 const text=serializeChecklist(next);
 if(before){const result=requireOK(await io.saveText({vaultId,path:QUICK_NOTES_PATH,expectedSHA256:before.sha,text}));return {doc:next,sha:result.sha256};}
 const file=requireOK(await io.createTextFile({vaultId,parentPath:'',name:QUICK_NOTES_PATH,content:text}));return {doc:next,sha:file.sha256};
}
/** Read before each append, then CAS. Never retry an overwrite automatically. */
export async function recordQuickNote(io:QuickNotesIO,vaultId:string,draft:QuickNoteDraft,now=new Date()):Promise<{snapshot:QuickNotesSnapshot;task:ChecklistTask;added:boolean}> {
 const before=await readQuickNotes(io,vaultId),result=addQuickNote(before?.doc||createChecklist('便签清单',undefined,now.toISOString()),draft,now);
 const snapshot=result.added?await writeQuickNotes(io,vaultId,result.doc,before):before!;
 return {snapshot,task:result.task,added:result.added};
}

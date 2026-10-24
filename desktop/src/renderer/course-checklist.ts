/** Course checklist v1. No storage side effects or optimistic completion here. */
import {isInternalFilePath} from '../shared/internal-file-links.ts';
export type ChecklistTask={id:string;text:string;section:string;done:boolean;createdAt:string;updatedAt:string;completedAt?:string;rewardId?:string;archivedAt?:string;dueDate?:string;sourcePath?:string;[key:string]:unknown};
export type CourseChecklist={schemaVersion:1;kind:'course-checklist';id:string;title:string;tasks:ChecklistTask[];updatedAt:string;[key:string]:unknown};
export type ChecklistTaskPatch={text?:string;section?:string;done?:boolean;archived?:boolean;dueDate?:string|null;sourcePath?:string|null};
export type ChecklistMutationOptions={now?:string;rewardId?:string};
export type ChecklistTaskOptions={id?:string;now?:string;dueDate?:string;sourcePath?:string};
export const CHECKLIST_LIMITS=Object.freeze({bytes:1_048_576,tasks:1000,text:1000,title:200,section:200,rewardId:200});
export const CHECKLIST_FILENAME='课程清单.inkcheck.json';
export class ChecklistError extends Error {readonly code:string;constructor(code:string,message:string){super(message);this.name='ChecklistError';this.code=code;}}
const own=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
function fail(code:string,message:string):never{throw new ChecklistError(code,message);}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function validString(value:unknown,max:number,required:boolean,label:string):asserts value is string{
 if(typeof value!=='string'||value.length>max||(required&&!value.trim())||value.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))fail('INVALID_FIELD',`${label}格式无效或超过长度限制。 / Invalid or oversized ${label}.`);
}
function uuid(value:unknown,label:string):asserts value is string{if(typeof value!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))fail('INVALID_ID',`${label} 必须是 UUID。 / ${label} must be a UUID.`);}
function utc(value:unknown,label:string):asserts value is string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value))fail('INVALID_DATE',`${label} 必须是 UTC ISO 日期。 / ${label} must be a UTC ISO date.`);
 const date=new Date(value);if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,19)!==value.slice(0,19))fail('INVALID_DATE',`${label} 不是有效日期。 / ${label} is not a valid date.`);
}
/** Date-only values are calendar dates, never UTC timestamps. */
export function isChecklistDate(value:unknown):value is string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const [year,month,day]=value.split('-').map(Number),leap=year%4===0&&(year%100!==0||year%400===0);
 return year>=1&&year<=9999&&month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}
function dueDate(value:unknown):asserts value is string {if(!isChecklistDate(value))fail('INVALID_DUE_DATE','安排日期必须是有效的 YYYY-MM-DD 日历日期。 / Scheduled date must be a valid YYYY-MM-DD calendar date.');}
function sourcePath(value:unknown):asserts value is string {if(!isInternalFilePath(value))fail('INVALID_SOURCE_PATH','关联资料必须是资料库内的有效相对路径。 / Linked material must be a valid path within this library.');}
function bytes(value:string):number{return new TextEncoder().encode(value).byteLength;}
function validateDocument(value:unknown):asserts value is CourseChecklist{
 if(!record(value))fail('INVALID_DOCUMENT','清单文件结构无效。 / Invalid checklist document.');
 if(value.schemaVersion!==1||value.kind!=='course-checklist')fail('UNSUPPORTED_SCHEMA','不支持此清单版本或类型，原文件未修改。 / Unsupported checklist version or kind; the file was not changed.');
 uuid(value.id,'清单 ID');validString(value.title,CHECKLIST_LIMITS.title,true,'标题');utc(value.updatedAt,'updatedAt');
 if(!Array.isArray(value.tasks)||value.tasks.length>CHECKLIST_LIMITS.tasks)fail('INVALID_TASKS','任务列表无效，最多包含 1,000 项（包括归档）。 / Invalid task list; maximum 1,000 including archived tasks.');
 const ids=new Set<string>();for(const task of value.tasks){
  if(!record(task))fail('INVALID_TASK','任务结构无效。 / Invalid task.');uuid(task.id,'任务 ID');const id=task.id.toLowerCase();if(ids.has(id))fail('DUPLICATE_ID','清单中存在重复任务 ID。 / Duplicate task ID.');ids.add(id);
  validString(task.text,CHECKLIST_LIMITS.text,true,'任务内容');validString(task.section,CHECKLIST_LIMITS.section,false,'分组');if(typeof task.done!=='boolean')fail('INVALID_FIELD','任务完成状态必须是真或假。 / Task completion must be boolean.');utc(task.createdAt,'createdAt');utc(task.updatedAt,'updatedAt');
  if(own(task,'completedAt')){utc(task.completedAt,'completedAt');if(!task.done)fail('INVALID_STATE','未完成任务不能包含完成日期。 / Pending tasks cannot contain completedAt.');}
  if(own(task,'dueDate'))dueDate(task.dueDate);
  if(own(task,'sourcePath'))sourcePath(task.sourcePath);
  if(own(task,'archivedAt'))utc(task.archivedAt,'archivedAt');if(own(task,'rewardId'))validString(task.rewardId,CHECKLIST_LIMITS.rewardId,true,'rewardId');
 }
}
/** Parsing never substitutes an empty document for a corrupt/unsupported file. */
export function parseChecklist(text:string):CourseChecklist{
 if(typeof text!=='string'||bytes(text)>CHECKLIST_LIMITS.bytes)fail('TOO_LARGE','清单文件超过 1 MB。 / Checklist exceeds 1 MB.');
 let value:unknown;try{value=JSON.parse(text.charCodeAt(0)===0xFEFF?text.slice(1):text,(_key,current)=>{if(typeof current==='number'&&(!Number.isFinite(current)||(Number.isInteger(current)&&!Number.isSafeInteger(current))))fail('INVALID_NUMBER','清单含无法安全保留的数值。 / Checklist contains a number that cannot be preserved safely.');return current;});}catch(error){if(error instanceof ChecklistError)throw error;fail('INVALID_JSON','清单 JSON 无法读取，原文件未修改。 / Could not read checklist JSON; the file was not changed.');}
 validateDocument(value);return value;
}
function cloneValidated(doc:CourseChecklist):CourseChecklist{
 // Structured JSON is the on-disk contract. This also rejects non-JSON input from callers.
 let json:string;try{json=JSON.stringify(doc,(_key,value)=>{if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))fail('INVALID_NUMBER','清单含无法安全保留的数值。 / Checklist contains a number that cannot be preserved safely.');if(typeof value==='undefined'||typeof value==='function'||typeof value==='symbol'||typeof value==='bigint')fail('INVALID_DOCUMENT','清单含无法保存的字段。 / Checklist contains a non-JSON field.');return value;});}catch(error){if(error instanceof ChecklistError)throw error;fail('INVALID_DOCUMENT','清单无法序列化。 / Checklist could not be serialized.');}
 return parseChecklist(json);
}
export function serializeChecklist(doc:CourseChecklist):string{const clean=cloneValidated(doc),text=JSON.stringify(clean,null,2)+'\n';if(bytes(text)>CHECKLIST_LIMITS.bytes)fail('TOO_LARGE','清单文件超过 1 MB，请减少内容。 / Checklist exceeds 1 MB; reduce its contents.');return text;}
export function createChecklist(title:string,id:string=crypto.randomUUID(),now:string=new Date().toISOString()):CourseChecklist{const doc:CourseChecklist={schemaVersion:1,kind:'course-checklist',id,title,tasks:[],updatedAt:now};validateDocument(doc);return doc;}
export const newChecklist=createChecklist;
export function newTask(text:string,section='',options:ChecklistTaskOptions={}):ChecklistTask{
 const now=options.now??new Date().toISOString(),task:ChecklistTask={id:options.id??crypto.randomUUID(),text,section,done:false,createdAt:now,updatedAt:now};if(options.dueDate!==undefined){dueDate(options.dueDate);task.dueDate=options.dueDate;}if(options.sourcePath!==undefined){sourcePath(options.sourcePath);task.sourcePath=options.sourcePath;}validateDocument({schemaVersion:1,kind:'course-checklist',id:task.id,title:'Validation',tasks:[task],updatedAt:now});return task;
}
export function addTask(doc:CourseChecklist,text:string,section='',options:ChecklistTaskOptions={}):CourseChecklist{
 const next=cloneValidated(doc),task=newTask(text,section,options);next.tasks.push(task);next.updatedAt=task.updatedAt;serializeChecklist(next);return next;
}
export function updateTask(doc:CourseChecklist,id:string,patch:ChecklistTaskPatch,options:ChecklistMutationOptions={}):CourseChecklist{
 const next=cloneValidated(doc);uuid(id,'任务 ID');if(!record(patch)||Object.keys(patch).some(key=>!['text','section','done','archived','dueDate','sourcePath'].includes(key)))fail('INVALID_PATCH','任务更改包含未知字段。 / Unsupported task change.');
 const task=next.tasks.find(task=>task.id.toLowerCase()===id.toLowerCase());if(!task)fail('NOT_FOUND','这个任务已不存在，请刷新清单。 / This task no longer exists; reload the checklist.');
 const now=options.now??new Date().toISOString();utc(now,'updatedAt');if(options.rewardId!==undefined)validString(options.rewardId,CHECKLIST_LIMITS.rewardId,true,'rewardId');let changed=false;
 if(own(patch,'text')){validString(patch.text,CHECKLIST_LIMITS.text,true,'任务内容');if(task.text!==patch.text){task.text=patch.text;changed=true;}}
 if(own(patch,'section')){validString(patch.section,CHECKLIST_LIMITS.section,false,'分组');if(task.section!==patch.section){task.section=patch.section;changed=true;}}
 if(own(patch,'dueDate')){if(patch.dueDate===null){if(own(task,'dueDate')){delete task.dueDate;changed=true;}}else{dueDate(patch.dueDate);if(task.dueDate!==patch.dueDate){task.dueDate=patch.dueDate;changed=true;}}}
 if(own(patch,'sourcePath')){if(patch.sourcePath===null){if(own(task,'sourcePath')){delete task.sourcePath;changed=true;}}else{sourcePath(patch.sourcePath);if(task.sourcePath!==patch.sourcePath){task.sourcePath=patch.sourcePath;changed=true;}}}
 if(own(patch,'done')){if(typeof patch.done!=='boolean')fail('INVALID_PATCH','完成状态无效。 / Invalid completion state.');if(task.done!==patch.done){task.done=patch.done;if(patch.done){task.completedAt=now;if(!task.rewardId&&options.rewardId)task.rewardId=options.rewardId;}else delete task.completedAt;changed=true;}}
 if(own(patch,'archived')){if(typeof patch.archived!=='boolean')fail('INVALID_PATCH','归档状态无效。 / Invalid archive state.');if(patch.archived&&!task.archivedAt){task.archivedAt=now;changed=true;}else if(!patch.archived&&task.archivedAt){delete task.archivedAt;changed=true;}}
 if(changed){task.updatedAt=now;next.updatedAt=now;}serializeChecklist(next);return next;
}
export function toggleTask(doc:CourseChecklist,id:string,options:ChecklistMutationOptions={}):CourseChecklist{uuid(id,'任务 ID');const clean=cloneValidated(doc),task=clean.tasks.find(task=>task.id.toLowerCase()===id.toLowerCase());if(!task)fail('NOT_FOUND','这个任务已不存在，请刷新清单。 / Task not found; reload the checklist.');return updateTask(clean,id,{done:!task.done},options);}
export function editTask(doc:CourseChecklist,id:string,patch:Pick<ChecklistTaskPatch,'text'|'section'|'dueDate'|'sourcePath'>,options:ChecklistMutationOptions={}):CourseChecklist{return updateTask(doc,id,patch,options);}
export function archiveTask(doc:CourseChecklist,id:string,options:ChecklistMutationOptions={}):CourseChecklist{return updateTask(doc,id,{archived:true},options);}
export function restoreTask(doc:CourseChecklist,id:string,options:ChecklistMutationOptions={}):CourseChecklist{return updateTask(doc,id,{archived:false},options);}

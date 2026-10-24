import type { CalendarDocument, CalendarEvent, CalendarOccurrence, RepeatRule } from './calendar-types.ts';

const DAY = 86_400_000;
const MAX_EVENTS = 10_000;
const MIN_YEAR = 1900, MAX_YEAR = 2200;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number[]>();
const fail = (message: string): never => { throw new Error(`日历数据无效：${message}`); };
const pad = (n: number) => String(n).padStart(2, '0');
const id = () => globalThis.crypto.randomUUID();
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function parts(value: string, dateOnly = false): number[] {
  if (typeof value !== 'string') return fail('日期必须是文本');
  const match = (dateOnly ? DATE : WALL).exec(value);
  if (!match) return fail(`日期格式不正确：${value}`);
  const [y, m, d, h = 0, min = 0] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, h, min));
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1 || h > 23 || min > 59 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return fail(`日期超出范围或不存在：${value}（1900–2200）`);
  return [y, m, d, h, min];
}
function naive(value: string): number {
  const [y, m, d, h, min] = parts(value, DATE.test(value));
  return Date.UTC(y, m - 1, d, h, min);
}
function dateString(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function wallString(ms: number): string { return new Date(ms).toISOString().slice(0, 16); }
function formatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timeZone) || timeZone.length > 100) return fail('时区必须为 IANA 时区名称');
  let result = formatters.get(timeZone);
  if (!result) {
    try { result = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
    catch { return fail(`不支持的时区：${timeZone}`); }
    if (formatters.size >= 100) formatters.clear();
    formatters.set(timeZone, result);
  }
  return result;
}
function zoneParts(ms: number, timeZone: string): number[] {
  if (!Number.isFinite(ms)) return fail('时间戳无效');
  const result: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(ms)) if (p.type !== 'literal') result[p.type] = Number(p.value);
  return [result.year, result.month, result.day, result.hour, result.minute, result.second];
}
export function localDateInZone(ms: number, timeZone: string): string {
  const [y, m, d] = zoneParts(ms, timeZone);
  return `${y}-${pad(m)}-${pad(d)}`;
}
export function localWallInZone(ms: number, timeZone: string): string {
  const [y, m, d, h, min] = zoneParts(ms, timeZone);
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}`;
}
/** Resolve a wall time using IANA rules. Folds choose the earlier instant; gaps are rejected. */
export function wallToMs(local: string, timeZone: string): number {
  const target = naive(local), expected = DATE.test(local) ? `${local}T00:00` : local;
  formatter(timeZone);
  const key = `${timeZone}:${Math.floor(target / DAY)}`;
  let choices = offsets.get(key);
  if (!choices) {
    const found = new Set<number>();
    for (const hours of [-36, -12, 0, 12, 36]) {
      const sample = target + hours * 3_600_000;
      const [y, m, d, h, min, sec] = zoneParts(sample, timeZone);
      found.add(Date.UTC(y, m - 1, d, h, min, sec) - sample);
    }
    choices = [...found];
    if (offsets.size >= 4096) offsets.clear();
    offsets.set(key, choices);
  }
  const candidates = choices.map(offset => target - offset).filter(ms => localWallInZone(ms, timeZone) === expected).sort((a, b) => a - b);
  if (!candidates.length) return fail(`夏令时切换导致此时间不存在：${local} (${timeZone})`);
  return candidates[0];
}
export function addDays(date: string, n: number): string {
  if (!Number.isSafeInteger(n)) return fail('日期偏移无效');
  const result = dateString(naive(date) + n * DAY);
  parts(result, true);
  return result;
}

export function newCalendarDocument(): CalendarDocument {
  return { schemaVersion: 1, kind: 'winner-calendar', id: id(), calendars: [{ id: id(), name: '个人', color: '#3578e5', visible: true }], events: [], updatedAt: new Date().toISOString() };
}
export function newCalendarEvent(calendarId: string, date: string, timeZone = systemTimeZone()): CalendarEvent {
  parts(date, true);
  wallToMs(`${date}T09:00`, timeZone);
  return { id: id(), uid: `${id()}@winner.local`, calendarId, title: '新日程', start: `${date}T09:00`, end: `${date}T10:00`, allDay: false, timeZone, location: '', notes: '', url: '', availability: 'busy', reminders: [], excludedStarts: [], updatedAt: new Date().toISOString() };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, name: string, max: number, required = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name}无效`);
}
function identifier(value: unknown, name: string) { text(value, name, 512, true); if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${name}包含控制字符`); }
function updated(value: unknown) { text(value, '更新时间', 40, true); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('更新时间无效'); }
function untilMs(rule: RepeatRule, event: CalendarEvent): number {
  if (!rule.until) return Infinity;
  if (DATE.test(rule.until)) return naive(rule.until) + DAY - 1; // Date UNTIL is compared in wall time below.
  return rule.until.endsWith('Z') ? Date.parse(rule.until) : wallToMs(rule.until, event.timeZone);
}
export function validateCalendar(doc: CalendarDocument): CalendarDocument {
  if (!record(doc) || doc.schemaVersion !== 1 || doc.kind !== 'winner-calendar') return fail('无法识别此日历文件');
  identifier(doc.id, '日历文档标识'); updated(doc.updatedAt);
  if (!Array.isArray(doc.calendars) || doc.calendars.length < 1 || doc.calendars.length > 100 || !Array.isArray(doc.events) || doc.events.length > 5000) return fail('日历数量（100）或日程数量（5000）超出限制');
  const calendars = new Set<string>();
  for (const c of doc.calendars) {
    if (!record(c)) return fail('日历记录无效');
    identifier(c.id, '日历标识'); text(c.name, '日历名称', 200, true);
    if (calendars.has(c.id) || typeof c.color !== 'string' || !/^#[\da-f]{6}$/i.test(c.color) || typeof c.visible !== 'boolean') return fail('日历标识重复、颜色或显示设置无效');
    calendars.add(c.id);
  }
  const ids = new Set<string>();
  for (const e of doc.events) {
    if (!record(e)) return fail('日程记录无效');
    identifier(e.id, '日程标识'); identifier(e.uid, '日程 UID');
    if (ids.has(e.id) || !calendars.has(e.calendarId)) return fail('日程标识重复或所属日历不存在');
    ids.add(e.id);
    text(e.title, '标题', 1000, true); text(e.location, '地点', 2000); text(e.notes, '备注', 100_000); text(e.url, '网址', 4000);
    if (e.url) { try { const url = new URL(e.url); if (/[\u0000-\u0020\u007f]/.test(e.url) || !['https:', 'http:'].includes(url.protocol)) fail('网址仅支持 http 和 https'); } catch { return fail('网址无效（仅支持 http 和 https）'); } }
    if (typeof e.allDay !== 'boolean' || !['busy', 'free'].includes(e.availability)) return fail('日程类型或忙闲状态无效');
    parts(e.start, e.allDay); parts(e.end, e.allDay); formatter(e.timeZone);
    if (naive(e.end) <= naive(e.start) || wallToMs(e.end, e.timeZone) <= wallToMs(e.start, e.timeZone)) return fail('结束时间必须晚于开始时间');
    if (!Array.isArray(e.reminders) || e.reminders.length > 10 || e.reminders.some(n => !Number.isInteger(n) || n < 0 || n > 525_600)) return fail('提醒必须为开始前的分钟数');
    if (!Array.isArray(e.excludedStarts) || e.excludedStarts.length > MAX_EVENTS) return fail('重复例外数量超出限制');
    for (const start of e.excludedStarts) parts(start, e.allDay);
    if (e.seriesId !== undefined) { identifier(e.seriesId, '重复系列标识'); if (e.seriesId === e.id) return fail('日程不能将自己作为重复系列'); }
    if (e.originalStart !== undefined) parts(e.originalStart, e.allDay);
    if ((e.seriesId === undefined) !== (e.originalStart === undefined)) return fail('重复实例必须同时包含系列和原始开始时间');
    if (e.seriesId !== undefined && e.repeat !== undefined) return fail('独立重复实例不能再次设置重复规则；请复制为新日程后设置重复');
    if (e.checklist !== undefined) { if (!record(e.checklist)) return fail('清单链接无效'); text(e.checklist.path, '清单路径', 4000, true); identifier(e.checklist.taskId, '清单事项标识'); }
    updated(e.updatedAt);
    if (e.repeat !== undefined) {
      const rule = e.repeat;
      if (!record(rule) || !['daily', 'weekly', 'monthly', 'yearly'].includes(rule.frequency) || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000) return fail('重复规则无效');
      if (rule.weekdays !== undefined && (rule.frequency !== 'weekly' || !Array.isArray(rule.weekdays) || !rule.weekdays.length || rule.weekdays.length > 7 || rule.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6) || new Set(rule.weekdays).size !== rule.weekdays.length)) return fail('重复星期无效');
      if (rule.weekdays && !rule.weekdays.includes(new Date(naive(e.start.slice(0, 10))).getUTCDay())) return fail('重复星期必须包含开始日期的星期');
      if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > MAX_EVENTS)) return fail('重复次数必须为 1–10000');
      if (rule.count !== undefined && rule.until !== undefined) return fail('重复次数和截止日期不能同时设置');
      if (rule.until !== undefined) {
        text(rule.until, '重复截止时间', 30, true);
        if (e.allDay && !DATE.test(rule.until)) return fail('全天日程的重复截止时间必须为日期');
        if (rule.until.endsWith('Z')) { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(rule.until) || !Number.isFinite(Date.parse(rule.until))) return fail('重复截止时间无效'); parts(rule.until.slice(0, 10), true); }
        else parts(rule.until, DATE.test(rule.until));
        if (DATE.test(rule.until) ? rule.until < e.start.slice(0, 10) : untilMs(rule, e) < wallToMs(e.start, e.timeZone)) return fail('重复截止时间早于开始时间');
      }
    }
  }
  return doc;
}
export function parseCalendar(value: string): CalendarDocument {
  if (typeof value !== 'string' || value.length > 4_194_304 || new TextEncoder().encode(value).length > 4_194_304) return fail('文件超过 4 MiB');
  let parsed: CalendarDocument;
  try { parsed = JSON.parse(value); } catch { return fail('文件不是有效 JSON'); }
  return validateCalendar(parsed);
}
export function serializeCalendar(doc: CalendarDocument): string {
  const result = JSON.stringify(validateCalendar(doc), null, 2) + '\n';
  if (new TextEncoder().encode(result).length > 4_194_304) return fail('文件超过 4 MiB');
  return result;
}

function monthDate(base: number[], monthOffset: number): string | undefined {
  const [y, m, d] = base;
  const target = new Date(Date.UTC(y, m - 1 + monthOffset, 1));
  if (target.getUTCFullYear() > MAX_YEAR) return undefined;
  const candidate = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), d));
  return candidate.getUTCMonth() === target.getUTCMonth() ? dateString(candidate.getTime()) : undefined;
}
/** Expand bounded occurrences. A returned start/end is in the event's own timezone. */
export function expandEvents(doc: CalendarDocument, fromDate: string, toDate: string): CalendarOccurrence[] {
  validateCalendar(doc); parts(fromDate, true); parts(toDate, true);
  if (toDate <= fromDate) return [];
  const viewZone = systemTimeZone(), from = wallToMs(fromDate, viewZone), to = wallToMs(toDate, viewZone);
  const result: CalendarOccurrence[] = [];
  let work = 0;
  for (const event of doc.events) {
    const duration = naive(event.end) - naive(event.start), elapsedDuration = wallToMs(event.end, event.timeZone) - wallToMs(event.start, event.timeZone), suffix = event.allDay ? '' : event.start.slice(10);
    const excluded = new Set(event.excludedStarts), rule = event.repeat, startDate = event.start.slice(0, 10);
    const startDay = naive(startDate), startParts = parts(startDate, true), weekday = new Date(startDay).getUTCDay();
    const dateUntil = rule?.until && DATE.test(rule.until) ? rule.until : undefined;
    const instantUntil = rule && !dateUntil ? untilMs(rule, event) : Infinity;
    const stopDay = Date.parse(`${localDateInZone(to + 2 * DAY, event.timeZone)}T00:00:00Z`);
    let number = 0, done = false;
    const take = (date: string) => {
      if (++work > 200_000) throw new Error('日历展开范围过大，请缩小日期范围');
      if (date > '2200-12-31' || naive(date) > stopDay || (dateUntil && date > dateUntil)) { done = true; return; }
      const start = date + suffix;
      let startMs: number, endMs: number, end: string;
      try {
        startMs = wallToMs(start, event.timeZone);
        endMs = event.allDay ? wallToMs(dateString(naive(start) + duration), event.timeZone) : startMs + elapsedDuration;
        end = event.allDay ? dateString(naive(start) + duration) : localWallInZone(endMs, event.timeZone);
      } catch { return; } // RFC 5545: nonexistent recurrence dates/times do not count.
      if (startMs > instantUntil) { done = true; return; }
      number++;
      if (rule?.count && number >= rule.count) done = true;
      if (excluded.has(start)) return;
      if (event.allDay ? start < toDate && end > fromDate : startMs < to && endMs > from) {
        if (result.length >= MAX_EVENTS) throw new Error('此范围超过 10000 个日程，请缩小日期范围');
        result.push({ key: `${event.id}:${start}`, eventId: event.id, start, end, startMs, endMs, event });
      }
    };
    take(startDate);
    if (!rule || done) continue;
    // Counted rules enumerate from DTSTART; unbounded rules seek close to the visible range.
    const near = Date.parse(`${localDateInZone(from - duration - 2 * DAY, event.timeZone)}T00:00:00Z`);
    if (rule.frequency === 'daily') {
      const first = rule.count ? 1 : Math.max(1, Math.floor((near - startDay) / (DAY * rule.interval)));
      for (let n = first; !done && n < 110_000; n++) { const ms = startDay + n * rule.interval * DAY; if (ms > stopDay || ms >= Date.UTC(2201, 0, 1)) break; take(dateString(ms)); }
    } else if (rule.frequency === 'weekly') {
      const weekStart = startDay - ((weekday + 6) % 7) * DAY;
      const days = (rule.weekdays || [weekday]).map(d => (d + 6) % 7).sort((a, b) => a - b);
      const first = rule.count ? 0 : Math.max(0, Math.floor((near - weekStart) / (7 * DAY * rule.interval)));
      for (let n = first; !done && n < 16_000; n++) {
        const week = weekStart + n * rule.interval * 7 * DAY;
        if (week > stopDay || week >= Date.UTC(2201, 0, 1)) break;
        for (const day of days) { const ms = week + day * DAY; if (ms <= startDay || ms >= Date.UTC(2201, 0, 1)) continue; take(dateString(ms)); if (done) break; }
      }
    } else {
      const step = rule.interval * (rule.frequency === 'yearly' ? 12 : 1);
      const nearDate = new Date(near), months = (nearDate.getUTCFullYear() - startParts[0]) * 12 + nearDate.getUTCMonth() - (startParts[1] - 1);
      const first = rule.count ? 1 : Math.max(1, Math.floor(months / step));
      for (let n = first; !done && n < 4000; n++) {
        const month = Date.UTC(startParts[0], startParts[1] - 1 + n * step, 1);
        if (month > stopDay || month >= Date.UTC(2201, 0, 1)) break;
        const date = monthDate(startParts, n * step); if (date) take(date);
      }
    }
  }
  return result.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.key.localeCompare(b.key));
}

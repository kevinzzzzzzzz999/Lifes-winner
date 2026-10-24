export type RepeatRule={frequency:'daily'|'weekly'|'monthly'|'yearly';interval:number;weekdays?:number[];count?:number;until?:string};
export type EventCalendar={id:string;name:string;color:string;visible:boolean};
export type CalendarEvent={id:string;uid:string;calendarId:string;title:string;start:string;end:string;allDay:boolean;timeZone:string;location:string;notes:string;url:string;availability:'busy'|'free';reminders:number[];repeat?:RepeatRule;excludedStarts:string[];seriesId?:string;originalStart?:string;checklist?:{path:string;taskId:string};updatedAt:string};
export type CalendarDocument={schemaVersion:1;kind:'winner-calendar';id:string;calendars:EventCalendar[];events:CalendarEvent[];updatedAt:string};
export type CalendarOccurrence={key:string;eventId:string;start:string;end:string;startMs:number;endMs:number;event:CalendarEvent};
export type CalendarSnapshot={doc:CalendarDocument;sha:string|null};
export type CalendarImport={events:CalendarEvent[];warnings:string[]};

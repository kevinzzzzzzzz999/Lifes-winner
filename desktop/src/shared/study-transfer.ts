import type {OpenedFile} from './desktop-api';
import type {StudyProjection} from './study';
export type StudyDelimiter='csv'|'tsv';
export interface StudyImportRow {index:number;line:number;question:string;answer:string;status:'ready'|'invalid'|'duplicate';reason?:'columns'|'empty'|'length'|'record'|'file'|'existing'}
export interface StudyImportPreview {token:string;name:string;sha256:string;boardID:string;delimiter:StudyDelimiter;header:boolean;rows:StudyImportRow[];warnings:string[];parseError?:string}
export interface StudyImportResult {results:{index:number;itemID:string;status:'imported'|'duplicate'|'failed';error?:string}[];file:OpenedFile;projection:StudyProjection}
export interface StudyExportResult {saved:boolean;count:number;omitted:number;escapedCells:number}

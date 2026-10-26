import type {OpenedFile} from './desktop-api';
import type {StudyProjection} from './study';
export type StudyDraftKind='summary'|'qa'|'cloze';
export interface StudyDraftSource {nodeID:string;title:string;quote:string;sourcePath?:string;page?:number}
export interface StudyDraftRow {id:string;index:number;source:StudyDraftSource;question:string;answer:string;status:'ready'|'unsupported';reason?:string}
export interface StudyDraftPreview {token:string;boardID:string;sourceSHA256:string;kind:StudyDraftKind;rows:StudyDraftRow[];warnings:string[]}
export interface StudyDraftCommit {token:string;rows:{id:string;question:string;answer:string}[];selectedIDs:string[]}
export interface StudyDraftResult {file:OpenedFile;projection:StudyProjection;results:{id:string;itemID:string;sourceNodeID:string;status:'saved'|'duplicate'|'failed';error?:string}[]}

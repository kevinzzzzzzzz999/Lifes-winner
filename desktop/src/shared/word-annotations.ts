export type WordAnnotationKind='comment'|'insertion'|'deletion';
export type WorkWordAnnotationReference={sourceSHA256:string;part:'word/document.xml';kind:WordAnnotationKind;annotationID:string;fingerprint:string};
export type WordAnnotationEntry=WorkWordAnnotationReference&{id:string;path:string;contents:string;anchor:string;paragraph:number;hasText:boolean;supported:boolean;author?:string;date?:string;issue?:string};
export type WordAnnotationScan={token:string;requestId:string;folderPath:string;entries:WordAnnotationEntry[];coverage:{files:number;documents:number;annotations:number;unsupported:number;unavailable:number;notDownloaded:number;limited:number};partial:boolean;warnings:string[]};
export type WordAnnotationTarget={scanToken:string;resultId:string;vaultId:string;path:string;sourceSHA256:string;annotationID:string;kind:WordAnnotationKind;quote:string};

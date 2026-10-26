export type PDFAnnotationRect={x:number;y:number;width:number;height:number};
export type PDFAnnotationEntry={id:string;path:string;sourceSHA256:string;page:number;index:number;subtype:string;contents:string;hasText:boolean;supported:boolean;rect?:PDFAnnotationRect;fingerprint:string;issue?:string};
export type PDFAnnotationScan={token:string;requestId:string;folderPath:string;entries:PDFAnnotationEntry[];coverage:{files:number;pages:number;annotations:number;unsupported:number;unavailable:number;notDownloaded:number;limited:number};partial:boolean;warnings:string[]};
export type PDFAnnotationTarget={scanToken:string;resultId:string;annotationID:string;vaultId:string;path:string;sourceSHA256:string;page:number;subtype:string;rect?:PDFAnnotationRect;quote:string};
export type WorkPDFAnnotationReference={sourceSHA256:string;index:number;fingerprint:string;subtype:string;rect?:PDFAnnotationRect};

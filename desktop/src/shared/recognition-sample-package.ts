import type {RecognitionSample,RecognitionSnapshot} from './recognition-samples';
export type SamplePackageRow={sample:RecognitionSample;status:'new'|'duplicate'|'conflict'};
export type SamplePackagePreview={token:string;sha256:string;packageBytes:number;decodedBytes:number;exportedAt:string;revision:string|null;rows:SamplePackageRow[];newCount:number;duplicateCount:number;conflictCount:number;capacityIssue:string;projectedBytes:number|null;limitBytes:number};
export type SamplePackageExportPlan={count:number;decodedBytes:number;packageBytes:number;exportedAt:string};
export type SamplePackageExportRequest={ids:string[];revision:string|null};
export type SamplePackageImportResult={added:number;skipped:number;snapshot:RecognitionSnapshot};

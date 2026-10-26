export interface StudyLayoutPackagePreview {
 token:string; name:string; boardID:string; count:number; ready:number; duplicates:number;
 canCommit:boolean; conflicts:number;
}
export interface StudyLayoutPackageResult { imported:number; duplicates:number }
export interface StudyLayoutPackageExportResult { saved:boolean; count:number }

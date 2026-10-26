export type SearchKind='text'|'notebook'|'board'|'pdf'|'image';
export type UnifiedSearchHit={id:string;path:string;kind:SearchKind;snippet:string;page?:number;nodeID?:string;cell?:number;rect?:{x:number;y:number;width:number;height:number};origin?:'board-image-ocr';imagePath?:string;imageSHA256?:string;stale:boolean;partial:boolean};
export type UnifiedSearchStatus={exists:boolean;updatedAt:string|null;coverage:Record<string,number>;documents:number;bytes:number;limitBytes:number;canContinue:boolean;readOnly:boolean;job:{id:string;state:string;processed:number;pages:number;path:string;code:string}|null};
export type UnifiedSearchResponse={results:UnifiedSearchHit[];total:number;more:boolean};
export type UnifiedSearchTarget={resultId?:string;origin?:'board-image-ocr';imagePath?:string;imageSHA256?:string;vaultId:string;path:string;kind:SearchKind;sourceSHA256:string;boardID?:string;nodeID?:string;page?:number;rect?:{x:number;y:number;width:number;height:number};quote:string};

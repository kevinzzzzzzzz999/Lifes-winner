export type PNGOrganizationMove={from:string;to:string;bytes:number;sha256:string};
export type PNGOrganizationPreview={token:string;requestId:string;boardPath:string;boardID:string;boardSHA256:string;destination:string;moves:PNGOrganizationMove[];references:{path:string;kind:string;count:number}[];blockers:{message:string;path?:string;from?:string}[];warnings:string[];scannedFiles:number;complete:boolean;canCommit:boolean};
export type PNGOrganizationHistory={entries:{id:string;createdAt:string;state:string;boardPath:string;destination:string;files:number;canUndo:boolean}[];warnings:string[]};
export type PNGOrganizationResult={id:string;state:string;moved:{from:string;to:string}[];updatedReferences:number;warnings:string[]};

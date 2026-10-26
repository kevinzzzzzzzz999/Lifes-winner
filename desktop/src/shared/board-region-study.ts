import type {CaptureRect,OpenedFile} from './desktop-api';
import type {StudyCard,StudyProjection} from './study';
export type BoardRegionCardRequest={vaultId:string;path:string;boardID:string;expectedSHA256:string;requestId:string;canvasID:string;rect:CaptureRect;screenRect:CaptureRect};
export type BoardRegionCardPreview={token:string;requestId:string;canvasID:string;boardID:string;sourceSHA256:string;rect:CaptureRect;assetPath:string;itemID:string;dataURL:string;width:number;height:number};
export type BoardRegionCardResult={file:OpenedFile;projection:StudyProjection;itemID:string;reused:boolean;warning?:string};
export type BoardRegionCardCommit={token:string;title:string;card:StudyCard};

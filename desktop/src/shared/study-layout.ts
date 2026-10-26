export interface StudyLayoutFrame {x:number;y:number;width:number;height:number}
export interface StudyLayoutSlot {id:string;kind:'text'|'image';frame?:StudyLayoutFrame}
export interface StudyLayoutFace {aspectRatio:number;slots:StudyLayoutSlot[]}
export interface StudyCardLayout {version:1;kind:'study-card-layout';boardID:string;itemID:string;structureSignature:string;question:StudyLayoutFace;answer:StudyLayoutFace;updatedAt:string}
export interface StudyLayoutStructure {boardID:string;itemID:string;signature:string;mode:'qa'|'occlusion';answerMode:'custom'|'node';questionSlots:StudyLayoutSlot[];answerSlots:StudyLayoutSlot[]}
export interface StudyLayoutSnapshot {structure:StudyLayoutStructure;layout:StudyCardLayout|null;revision:string|null;readOnly:boolean;canReplaceStale:boolean;warning:string|null}

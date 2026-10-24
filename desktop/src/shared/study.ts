export type StudyGrade='again'|'hard'|'good'|'easy';
export interface StudyRegion {id:string;x:number;y:number;width:number;height:number}
export interface StudyContentBlock {id:string;kind:'text'|'image';text?:string;sourcePath?:string;regions?:StudyRegion[]}
export interface StudyCard {question:string;answer:string;mode:'qa'|'cloze'|'occlusion';answerMode?:'node'|'custom';questionBlocks?:StudyContentBlock[];answerBlocks?:StudyContentBlock[]}
export interface StudyEvent {schemaVersion:1;id:string;deviceID:string;createdAt:string;boardID:string;itemID:string;kind:'card'|'grade'|'delete';card?:StudyCard;grade?:StudyGrade}
export interface StudyProjectedCard {itemID:string;card:StudyCard;eventID:string;dueAt:string;intervalDays:number;reviewCount:number;lastGrade?:StudyGrade;missingNode:boolean}
export interface StudyProjection {boardID:string;cards:StudyProjectedCard[];warnings:string[]}

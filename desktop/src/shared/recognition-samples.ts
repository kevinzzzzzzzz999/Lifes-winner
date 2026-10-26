export type RecognitionKind='handwriting'|'speech';
export type RecognitionLocale='zh-CN'|'en-US';
export type RecognitionSource='pencil-draft'|'imported-image'|'microphone'|'imported-audio';
export type RecognitionSample={id:string;kind:RecognitionKind;locale:RecognitionLocale;source:RecognitionSource;mediaFileName:string;sha256:string;byteCount:number;durationSeconds?:number;confirmedText:string;enabled:boolean;createdAt:string;updatedAt:string};
export type RecognitionLibrary={version:1;kind:'personal-recognition-samples';samples:RecognitionSample[]};
export type RecognitionSnapshot={document:RecognitionLibrary;revision:string|null;readOnly:boolean;issue:string;warning:string;space:{usedBytes:number;mediaBytes:number;indexBytes:number;orphanBytes:number;orphanCount:number;missingCount:number;unknown?:boolean;limitBytes:number;count:number;limitCount:number};capabilities:{microphoneRecording:boolean;training:false}};
export type RecognitionDraft={token:string;kind:RecognitionKind;source:RecognitionSource;sha256:string;byteCount:number;durationSeconds?:number;width?:number;height?:number;dataURL:string;suggestedText:string;temporaryProvenance?:{kind:'pdf-page';page:number;sourceSHA256:string;imageSHA256:string;displayName:string;notPersisted:true}};
export type RecognitionCommit={token:string;sha256:string;revision:string|null;locale:RecognitionLocale;confirmedText:string;enabled:boolean;confirmed:true};
export type RecognitionUpdate={revision:string|null;id:string;sha256:string;action:'correct'|'setEnabled'|'delete';confirmedText?:string;locale?:RecognitionLocale;enabled?:boolean;confirmed?:true};

export type RecognitionRecordingInfo={available:boolean;maximumSeconds:60;format:'PCM WAV';recordingOnStartOnly:true};
export type RecognitionRecordingEvent={sessionId:string}&({kind:'state';phase:'permission'|'recording'|'finishing';seconds:number}|{kind:'authorized'}|{kind:'draft';draft:RecognitionDraft}|{kind:'error';code:string}|{kind:'cancelled'});

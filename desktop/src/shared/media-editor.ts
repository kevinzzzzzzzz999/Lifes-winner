export type MediaSource={id:string;path:string;name:string;duration:number;hasVideo:boolean;hasAudio:boolean;sha256?:string};
export type MediaClip={id:string;sourceID:string;start:number;end:number;speed:number;volume:number;transition?:{kind:'dissolve';duration:number}};
export type MediaOverlay=Omit<MediaClip,'transition'>&{at:number;x:number;y:number;width:number;height:number;opacity:number};
export type MediaCaption={id:string;start:number;end:number;text:string};
export type MediaCaptionStyle={fontSize:number;textColor:string;backgroundOpacity:number};
export type MediaProject={schemaVersion:1|2;id:string;title:string;createdAt:string;updatedAt:string;sources:MediaSource[];clips:MediaClip[];overlays?:MediaOverlay[];captions?:MediaCaption[];captionStyle?:MediaCaptionStyle;output:{kind:'video'|'audio';width:1280|1920;height:720|1080;fps:30}};
export type MediaEditorEvent={jobId:string;state:'running'|'completed'|'failed'|'cancelled';progress:number;message?:string;path?:string;preview?:{url:string;token:string}};

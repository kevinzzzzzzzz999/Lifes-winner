export type SubtitleCue={start:number;end:number;text:string};
export type LocalSubtitles={kind:'vtt'|'srt';cues:SubtitleCue[]}|{kind:'txt';text:string};
export type SubtitleStyle={fontSize:number;color:string;outline:number;backgroundOpacity:number;backgroundColor:string};
export type VideoPlaybackState={time:number;rate:number;paused:boolean;volume?:number;muted?:boolean;subtitles?:{name:string;enabled:boolean;data:LocalSubtitles};subtitleStyle?:SubtitleStyle};

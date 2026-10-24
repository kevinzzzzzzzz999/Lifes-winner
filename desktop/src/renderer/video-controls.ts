import type {LocalSubtitles,SubtitleCue,SubtitleStyle} from '../shared/video-playback';
export type {LocalSubtitles,SubtitleCue,SubtitleStyle} from '../shared/video-playback';
export const VIDEO_SEEK_STEPS=[1,3,5,15,30] as const;
export const VIDEO_SEEK_KEY='inkspace.video.seekSeconds';
export const VIDEO_SETTINGS_EVENT='inkspace-video-settings';
export function readVideoSeek(){try{const value=Number(localStorage.getItem(VIDEO_SEEK_KEY));return VIDEO_SEEK_STEPS.includes(value as typeof VIDEO_SEEK_STEPS[number])?value:5;}catch{return 5;}}
export const SUBTITLE_STYLE_KEY='inkspace.video.subtitleStyle';
export const SUBTITLE_STYLE_EVENT='inkspace-video-subtitle-style';
export const DEFAULT_SUBTITLE_STYLE:SubtitleStyle={fontSize:22,color:'#ffffff',outline:1,backgroundOpacity:60,backgroundColor:'#000000'};
export function normalizeSubtitleStyle(value:unknown):SubtitleStyle{const v=value&&typeof value==='object'?value as Partial<SubtitleStyle>:{};const number=(n:unknown,min:number,max:number,fallback:number)=>typeof n==='number'&&Number.isFinite(n)?Math.max(min,Math.min(max,Math.round(n))):fallback;const color=(s:unknown,fallback:string)=>typeof s==='string'&&/^#[0-9a-f]{6}$/i.test(s)?s.toLowerCase():fallback;return{fontSize:number(v.fontSize,14,48,22),color:color(v.color,'#ffffff'),outline:number(v.outline,0,3,1),backgroundOpacity:number(v.backgroundOpacity,0,100,60),backgroundColor:color(v.backgroundColor,'#000000')};}
export function readSubtitleStyle(fallback:SubtitleStyle=DEFAULT_SUBTITLE_STYLE):SubtitleStyle{try{const saved=localStorage.getItem(SUBTITLE_STYLE_KEY);return normalizeSubtitleStyle(saved?JSON.parse(saved):fallback);}catch{return normalizeSubtitleStyle(fallback);}}
export function subtitleCueCSS(style:SubtitleStyle){const v=normalizeSubtitleStyle(style),color=v.backgroundColor,background=`rgba(${parseInt(color.slice(1,3),16)},${parseInt(color.slice(3,5),16)},${parseInt(color.slice(5,7),16)},${v.backgroundOpacity/100})`,shadow=v.outline?[-1,0,1].flatMap(x=>[-1,0,1].filter(y=>x||y).map(y=>`${x*v.outline}px ${y*v.outline}px 0 #000`)).join(','):'none';return `font-size:${v.fontSize}px;color:${v.color};background-color:${background};text-shadow:${shadow};`;}
/** VTTCue uses WebVTT text syntax, so preserve untrusted markup as literal text. */
export function nativeCueText(text:string){return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
export function decodeSubtitleBytes(bytes:ArrayBuffer){const head=new Uint8Array(bytes);return new TextDecoder(head[0]===0xff&&head[1]===0xfe?'utf-16le':head[0]===0xfe&&head[1]===0xff?'utf-16be':'utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
function seconds(value:string){const match=/^(?:(\d{1,6}):)?(\d{1,6}):(\d{1,6})[.,](\d{1,3})$/.exec(value);if(!match)return NaN;const hours=Number(match[1]||0),minutes=Number(match[2]),seconds=Number(match[3]);if(minutes>59||seconds>59)return NaN;return hours*3600+minutes*60+seconds+Number(match[4].padEnd(3,'0'))/1000;}
/** Local text only: no HTML insertion, remote track URL or execution. */
export function parseLocalSubtitles(name:string,source:string):LocalSubtitles{
 if((source.length>200_000&&Array.from(source).length>200_000)||source.includes('\0'))throw Error('SUBTITLE_TOO_LARGE');
 const text=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
 if(/\.txt$/i.test(name))return {kind:'txt',text};
 const srt=/\.srt$/i.test(name);
 if(!srt&&(!/\.vtt$/i.test(name)||!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)))throw Error('INVALID_SUBTITLE');
 const cues:SubtitleCue[]=[];
 for(const block of (srt?text.trim().split(/\n[ \t]*\n/):text.split(/\n[ \t]*\n/).slice(1))){
  const lines=block.split('\n');if(!srt&&/^(NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0]))continue;
  const index=lines.findIndex(line=>line.includes('-->'));if(index<0){if(block.trim())throw Error('INVALID_SUBTITLE');continue;}
  if(srt&&(index>1||(index===1&&!/^\d+$/.test(lines[0].trim()))))throw Error('INVALID_SUBTITLE');
  const match=/^(\S+)\s+-->\s+(\S+)(?:[ \t].*)?$/.exec(lines[index].trim());if(!match)throw Error('INVALID_SUBTITLE');const start=seconds(srt?match[1].replace(',','.'):match[1]),end=seconds(srt?match[2].replace(',','.'):match[2]);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('INVALID_SUBTITLE');
  const content=lines.slice(index+1).join('\n').replace(/<\/?(?:b|i|u|ruby|rt|c|v|lang)(?:[ .][^>]*)?>/gi,'').replace(/<(?:\d{2}:)?\d{2}:\d{2}\.\d{3}>/g,'');
  if(content.length>2000||cues.length>=10000)throw Error('SUBTITLE_TOO_LARGE');if(content)cues.push({start,end,text:content});
 }
 if(!cues.length)throw Error('INVALID_SUBTITLE');return {kind:srt?'srt':'vtt',cues:cues.sort((a,b)=>a.start-b.start)};
}
export function subtitleAtTime(subtitles:LocalSubtitles|null,time:number){return subtitles&&subtitles.kind!=='txt'?subtitles.cues.filter(c=>c.start<=time&&time<c.end).slice(0,4).map(c=>c.text).join('\n'):'';}

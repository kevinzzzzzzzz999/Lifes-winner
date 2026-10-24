'use strict';
const {fail}=require('./errors.cjs'),{relativePath}=require('./vault-path.cjs');
const MEDIA_EXTENSIONS=new Set(['.mp4','.mov','.m4v','.mp3','.m4a','.wav','.aif','.aiff','.caf']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('INVALID_REQUEST');}
function text(value,max){if(typeof value!=='string'||value.length>max||value.includes('\0')||!value.isWellFormed())fail('INVALID_REQUEST');}
function clipDuration(clip){return (clip.end-clip.start)/clip.speed;}
function projectDuration(project){let duration=0;for(let i=0;i<project.clips.length;i++)duration+=clipDuration(project.clips[i])-(i<project.clips.length-1?(project.clips[i].transition?.duration||0):0);return Math.max(duration,...(project.overlays||[]).map(c=>c.at+clipDuration(c)));}
function mixGain(project){
 const envelopes=[],points=new Set([0]);let at=0;
 for(let i=0;i<project.clips.length;i++){const clip=project.clips[i],duration=clipDuration(clip),fadeIn=i?(project.clips[i-1].transition?.duration||0):0,fadeOut=i<project.clips.length-1?(clip.transition?.duration||0):0;if(project.sources.find(s=>s.id===clip.sourceID)?.hasAudio)envelopes.push({at,end:at+duration,volume:clip.volume,fadeIn,fadeOut});at+=duration-fadeOut;}
 for(const layer of project.overlays||[])if(project.sources.find(s=>s.id===layer.sourceID)?.hasAudio)envelopes.push({at:layer.at,end:layer.at+clipDuration(layer),volume:layer.volume,fadeIn:0,fadeOut:0});
 for(const e of envelopes)for(const t of [e.at,e.at+e.fadeIn,e.end-e.fadeOut,e.end])points.add(t);let peak=1;
 for(const t of points)for(const left of [false,true]){let level=0;for(const e of envelopes){if(left?!(t>e.at&&t<=e.end):!(t>=e.at&&t<e.end))continue;level+=e.volume*Math.min(1,e.fadeIn?(t-e.at)/e.fadeIn:1,e.fadeOut?(e.end-t)/e.fadeOut:1);}peak=Math.max(peak,level);}return 1/peak;
}
function validateProject(value){
 object(value,['schemaVersion','id','title','createdAt','updatedAt','sources','clips','output','overlays','captions','captionStyle']);
 if(![1,2].includes(value.schemaVersion)||!UUID.test(value.id))fail('INVALID_REQUEST');text(value.title,300);for(const field of ['createdAt','updatedAt']){text(value[field],64);if(!Number.isFinite(Date.parse(value[field])))fail('INVALID_REQUEST');}
 if(!Array.isArray(value.sources)||value.sources.length>200||!Array.isArray(value.clips)||value.clips.length>500)fail('TOO_LARGE');const ids=new Map();
 for(const source of value.sources){object(source,['id','path','name','duration','hasVideo','hasAudio','sha256']);if(!UUID.test(source.id)||ids.has(source.id))fail('INVALID_REQUEST');relativePath(source.path);text(source.name,1024);if(!MEDIA_EXTENSIONS.has(require('node:path').extname(source.path).toLowerCase())||!Number.isFinite(source.duration)||source.duration<=0||source.duration>43200||typeof source.hasVideo!=='boolean'||typeof source.hasAudio!=='boolean'||(!source.hasVideo&&!source.hasAudio)||source.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(source.sha256))fail('INVALID_REQUEST');ids.set(source.id,source);}
 const clipIDs=new Set();const checkClip=clip=>{const source=ids.get(clip.sourceID);if(!UUID.test(clip.id)||clipIDs.has(clip.id)||!source||![clip.start,clip.end,clip.speed,clip.volume].every(Number.isFinite)||clip.start<0||clip.end<=clip.start||clip.end>source.duration+0.001||clip.speed<.25||clip.speed>4||clip.volume<0||clip.volume>1)fail('INVALID_REQUEST');clipIDs.add(clip.id);};
 for(let i=0;i<value.clips.length;i++){const clip=value.clips[i];object(clip,['id','sourceID','start','end','speed','volume','transition']);checkClip(clip);if(clip.transition!==undefined){object(clip.transition,['kind','duration']);if(clip.transition.kind!=='dissolve'||!Number.isFinite(clip.transition.duration)||clip.transition.duration<=0||clip.transition.duration>5)fail('INVALID_REQUEST');if(i<value.clips.length-1&&clip.transition.duration>Math.min(clipDuration(clip)/2,clipDuration(value.clips[i+1])/2)+1e-9)fail('INVALID_REQUEST');}}
 const overlays=value.overlays??[],captions=value.captions??[];if(!Array.isArray(overlays)||overlays.length>24||!Array.isArray(captions)||captions.length>1000)fail('TOO_LARGE');const edges=[];
 for(const overlay of overlays){object(overlay,['id','sourceID','start','end','speed','volume','at','x','y','width','height','opacity']);checkClip(overlay);if(![overlay.at,overlay.x,overlay.y,overlay.width,overlay.height,overlay.opacity].every(Number.isFinite)||overlay.at<0||overlay.x<0||overlay.y<0||overlay.width<=0||overlay.height<=0||overlay.x+overlay.width>1+1e-9||overlay.y+overlay.height>1+1e-9||overlay.opacity<0||overlay.opacity>1)fail('INVALID_REQUEST');if(ids.get(overlay.sourceID).hasVideo)edges.push([overlay.at,1],[overlay.at+clipDuration(overlay),-1]);}
 let active=0;for(const [,delta] of edges.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){active+=delta;if(active>8)fail('TOO_LARGE');}
 const duration=projectDuration({...value,overlays});if(duration>43200)fail('TOO_LARGE');let previousEnd=0;const captionIDs=new Set();for(const caption of captions){object(caption,['id','start','end','text']);if(!UUID.test(caption.id)||captionIDs.has(caption.id)||![caption.start,caption.end].every(Number.isFinite)||caption.start<previousEnd||caption.end<=caption.start||caption.end>duration+1e-9)fail('INVALID_REQUEST');text(caption.text,1000);if(!caption.text.trim())fail('INVALID_REQUEST');captionIDs.add(caption.id);previousEnd=caption.end;}
 if(value.captionStyle!==undefined){const style=value.captionStyle;object(style,['fontSize','textColor','backgroundOpacity']);if(!Number.isFinite(style.fontSize)||style.fontSize<16||style.fontSize>72||!/^#[a-f0-9]{6}$/i.test(style.textColor)||!Number.isFinite(style.backgroundOpacity)||style.backgroundOpacity<0||style.backgroundOpacity>1)fail('INVALID_REQUEST');}
 object(value.output,['kind','width','height','fps']);if(!['video','audio'].includes(value.output.kind)||![[1280,720],[1920,1080]].some(([w,h])=>value.output.width===w&&value.output.height===h)||value.output.fps!==30)fail('INVALID_REQUEST');
 const result=JSON.parse(JSON.stringify(value));result.overlays=overlays.map(c=>({...c}));result.captions=captions.map(c=>({...c}));return result;
}
function tempo(speed){const parts=[];while(speed>2){parts.push('atempo=2');speed/=2;}while(speed<.5){parts.push('atempo=0.5');speed/=.5;}parts.push('atempo='+speed);return parts.join(',');}
function segmentArguments(source,clip,output,input,destination){
 const duration=(clip.end-clip.start)/clip.speed,args=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-protocol_whitelist','file,pipe','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2,mp3,wav,aiff,caf','-ss',String(clip.start),'-t',String(clip.end-clip.start),'-i',input];
 let nextInput=1,video='0:v:0',audio='0:a:0';
 if(output.kind==='video'&&!source.hasVideo){video=`${nextInput++}:v:0`;args.push('-f','lavfi','-i',`color=c=black:s=${output.width}x${output.height}:r=30:d=${duration}`);}
 if(!source.hasAudio){audio=`${nextInput++}:a:0`;args.push('-f','lavfi','-i',`anullsrc=r=48000:cl=stereo:d=${duration}`);}
 const audioFilter=(source.hasAudio?'asetpts=PTS-STARTPTS,'+tempo(clip.speed)+',':'')+`volume=${clip.volume},aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,apad`;
 const filters=[`[${audio}]${audioFilter}[a]`];
 if(output.kind==='video'){const videoFilter=(source.hasVideo?`setpts=(PTS-STARTPTS)/${clip.speed},`:'')+`scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=${duration}`;filters.push(`[${video}]${videoFilter}[v]`);}
 args.push('-filter_complex_threads','2','-filter_complex',filters.join(';'));if(output.kind==='video')args.push('-map','[v]','-c:v','libx264','-preset','fast','-crf','20','-threads','2');else args.push('-vn');
 args.push('-map','[a]','-c:a','pcm_s16le','-ar','48000','-ac','2','-t',String(duration),'-map_metadata','-1','-progress','pipe:1','-nostats','-f','mov',destination);return args;
}
module.exports={MEDIA_EXTENSIONS,UUID,object,validateProject,clipDuration,projectDuration,mixGain,tempo,segmentArguments};

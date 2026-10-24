'use strict';
const {clipDuration,projectDuration,mixGain}=require('./media-editor-format.cjs');
// All filenames are trusted, private workspace paths; caption text never enters
// FFmpeg expressions. Normalized segments make speed, silence and geometry exact.
function compositionArguments(project,output,segments,captionManifest,destination){
 const video=output.kind==='video',args=['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','2'],filters=[];
 for(const file of segments)args.push('-threads','1','-protocol_whitelist','file,pipe','-i',file);
 if(captionManifest)args.push('-protocol_whitelist','file,pipe','-f','concat','-safe','1','-i',captionManifest);
 const count=project.clips.length,duration=projectDuration(project);
 for(let i=0;i<count;i++){const d=clipDuration(project.clips[i]);filters.push(`[${i}:a]atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);if(video)filters.push(`[${i}:v]trim=duration=${d},setpts=PTS-STARTPTS,settb=AVTB,fps=30,format=yuv420p[v${i}]`);}
 let a='a0',v='v0',baseDuration=clipDuration(project.clips[0]);
 for(let i=1;i<count;i++){const overlap=project.clips[i-1].transition?.duration||0,na='basea'+i,nv='basev'+i;if(overlap){filters.push(`[${a}][a${i}]acrossfade=d=${overlap}:c1=tri:c2=tri[${na}]`);if(video)filters.push(`[${v}][v${i}]xfade=transition=fade:duration=${overlap}:offset=${baseDuration-overlap}[${nv}]`);}else{filters.push(`[${a}][a${i}]concat=n=2:v=0:a=1[${na}]`);if(video)filters.push(`[${v}][v${i}]concat=n=2:v=1:a=0,settb=AVTB[${nv}]`);}a=na;v=nv;baseDuration+=clipDuration(project.clips[i])-overlap;}
 filters.push(`[${a}]apad,atrim=duration=${duration}[baseaudio]`);const audio=['baseaudio'];
 if(video){filters.push(`[${v}]tpad=stop_mode=add:color=black:stop_duration=${Math.max(0,duration-baseDuration)},trim=duration=${duration}[basevideo]`);v='basevideo';}
 for(let i=0;i<(project.overlays||[]).length;i++){const layer=project.overlays[i],n=count+i,d=clipDuration(layer),source=project.sources.find(s=>s.id===layer.sourceID),label='layera'+i;filters.push(`[${n}:a]atrim=duration=${d},asetpts=PTS-STARTPTS,adelay=${Math.round(layer.at*48000)}S:all=1[${label}]`);audio.push(label);
  if(video&&source.hasVideo){const lv='layerv'+i,nv='overlayv'+i;filters.push(`[${n}:v]trim=duration=${d},setpts=PTS-STARTPTS,format=rgba,colorchannelmixer=aa=${layer.opacity},setpts=PTS+${layer.at}/TB[${lv}]`);filters.push(`[${v}][${lv}]overlay=x=${Math.round(layer.x*output.width)}:y=${Math.round(layer.y*output.height)}:eof_action=pass:repeatlast=0:enable='gte(t,${layer.at})*lt(t,${layer.at+d})'[${nv}]`);v=nv;}
 }
 filters.push(audio.map(x=>`[${x}]`).join('')+`amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,volume=${mixGain(project)},alimiter=limit=1:level=0:latency=1,apad,atrim=duration=${duration}[audio]`);
 if(captionManifest&&video){filters.push(`[${segments.length}:v]fps=30,format=rgba[caption]`);filters.push(`[${v}][caption]overlay=eof_action=pass:repeatlast=0[captioned]`);v='captioned';}
 if(video)filters.push(`[${v}]format=yuv420p[video]`);
 args.push('-filter_complex',filters.join(';'),'-map','[audio]','-c:a','aac','-b:a','192k');if(video)args.push('-map','[video]','-c:v','libx264','-preset','fast','-crf','20','-threads','2','-r','30');else args.push('-vn');args.push('-t',String(duration),'-movflags','+faststart','-map_metadata','-1','-progress','pipe:1','-nostats',destination);return args;
}
module.exports={compositionArguments};

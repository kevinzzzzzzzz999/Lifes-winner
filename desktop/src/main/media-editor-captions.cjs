'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {fail}=require('./errors.cjs');
// Runs in a sandboxed, network-disabled Chromium document. Canvas performs text
// shaping and fallback-font selection, including CJK, without shell commands.
function paintCaption({width,height,text,style}){
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');
 if(text){let fontSize=style.fontSize*height/720,lines=[],lineHeight,maxWidth=width*.86;let displayText=text;const family='"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  const wrap=()=>{lines=[];ctx.font=`600 ${fontSize}px ${family}`;for(const paragraph of displayText.split(/\r?\n/)){let line='';for(const character of Array.from(paragraph)){if(line&&ctx.measureText(line+character).width>maxWidth){lines.push(line);line='';}line+=character;}lines.push(line);}lineHeight=fontSize*1.35;};
  wrap();if(lines.length*lineHeight>height*.7&&text.split(/\r?\n/).length>12){displayText=text.replace(/\s+/g,' ');wrap();}while(lines.length*lineHeight>height*.7&&fontSize>14*height/720){fontSize*=.9;wrap();}
  const padding=Math.max(5,height*.018),boxHeight=lines.length*lineHeight+padding*2,bottom=height*.06,top=height-bottom-boxHeight,boxWidth=Math.min(width*.94,Math.max(...lines.map(x=>ctx.measureText(x).width))+padding*2);
  ctx.fillStyle=`rgba(0,0,0,${style.backgroundOpacity})`;ctx.fillRect((width-boxWidth)/2,top,boxWidth,boxHeight);ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=style.textColor;ctx.shadowColor='rgba(0,0,0,.85)';ctx.shadowBlur=Math.max(1,height/360);for(let i=0;i<lines.length;i++)ctx.fillText(lines[i],width/2,top+padding+lineHeight*(i+.5));
 }
 return canvas.toDataURL('image/png');
}
async function renderCaptions({BrowserWindow,project,output,workspace,job,onProgress}){
 if(!BrowserWindow)fail('UNSUPPORTED');const window=new BrowserWindow({show:false,width:32,height:32,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition:'inkcut-caption-'+job.id}});
 const cancel=()=>{if(job.cancelled||window.isDestroyed())fail('CANCELLED');};job.captionWindow=window;
 try{
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.session.webRequest.onBeforeRequest((request,callback)=>callback({cancel:!request.url.startsWith('data:text/html')}));
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'none\'"><title>Local caption rasterizer</title>'));
  const style=project.captionStyle||{fontSize:32,textColor:'#ffffff',backgroundOpacity:.5};
  const render=async(text,name)=>{cancel();const data=await window.webContents.executeJavaScript('('+paintCaption.toString()+')('+JSON.stringify({width:output.width,height:output.height,text,style})+')');cancel();if(typeof data!=='string'||!data.startsWith('data:image/png;base64,'))fail('EXPORT_FAILED');await fs.writeFile(path.join(workspace,name),Buffer.from(data.slice(22),'base64'),{flag:'wx',mode:0o600});};
  await render('','caption-blank.png');const entries=[];let time=0;
  for(let i=0;i<project.captions.length;i++){const cue=project.captions[i],name='caption-'+String(i).padStart(4,'0')+'.png';if(cue.start>time)entries.push(`file 'caption-blank.png'\nduration ${cue.start-time}`);await render(cue.text,name);entries.push(`file '${name}'\nduration ${cue.end-cue.start}`);time=cue.end;onProgress?.((i+1)/project.captions.length);}
  const duration=require('./media-editor-format.cjs').projectDuration(project);if(duration>time)entries.push(`file 'caption-blank.png'\nduration ${duration-time}`);entries.push("file 'caption-blank.png'");
  const manifest=path.join(workspace,'captions.txt');await fs.writeFile(manifest,entries.join('\n')+'\n',{flag:'wx',mode:0o600});return manifest;
 }finally{job.captionWindow=null;if(!window.isDestroyed())window.destroy();}
}
module.exports={renderCaptions,paintCaption};

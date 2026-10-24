import {normalizeClipboard} from './clipboard-rich-text';
import type {Language} from './i18n';
import type {BoardTextFormat} from '../shared/desktop-api';

import type {BoardPasteContent} from '../shared/desktop-api';
export type {BoardPasteContent} from '../shared/desktop-api';
export type ClipboardSnapshot={text:string;html:string;image?:{dataURL:string;width:number;height:number};files?:{token:string;name:string}[];warnings:string[]};
export type PastePoint={x:number;y:number};
export function clipboardBoardContent(snapshot:ClipboardSnapshot,language:Language,textFormat:BoardTextFormat='richText'):{content:BoardPasteContent;size:{width:number;height:number};notice:string}{
 const zh=language==='zh';
 if(snapshot.files){
  if(!snapshot.files.length)throw Error(zh?'无法读取剪贴板文件。请在 Finder 中重新复制；iCloud 文件请先完成下载。':'Clipboard files are unavailable. Copy them again in Finder and download iCloud files first.');
  const columns=Math.min(4,snapshot.files.length),rows=Math.ceil(snapshot.files.length/columns);
  return{content:{files:snapshot.files},size:{width:columns*384-24,height:rows*204-24},notice:''};
 }
 if(snapshot.image){
  const {width,height}=snapshot.image;
  const scale=Math.min(1,640/Math.max(1,width),640/Math.max(1,height));
  return{content:{images:[{dataURL:snapshot.image.dataURL,title:zh?'粘贴的图片':'Pasted image'}]},size:{width:Math.max(1,width*scale),height:Math.max(1,height*scale)},notice:''};
 }
 const normalized=textFormat==='richText'?normalizeClipboard({html:snapshot.html,text:snapshot.text}):snapshot.text.trim()?{text:snapshot.text,richTextHTML:'',hasTable:false,tableDimensions:undefined,warnings:[]}:null;
 if(normalized){
  const columns=normalized.tableDimensions?.columns||1,rows=normalized.tableDimensions?.rows||0;
  const width=normalized.hasTable?Math.max(480,Math.min(1400,columns*180+48)):Math.max(360,Math.min(760,Math.max(...normalized.text.split('\n').slice(0,100).map(line=>line.length))*9+32));
  const lineCount=normalized.text.split('\n').reduce((count,line)=>count+Math.max(1,Math.ceil(line.length/Math.max(20,Math.floor(width/9)))),0);
  const height=Math.max(140,Math.min(1800,normalized.hasTable?Math.max(rows*56+72,lineCount*26+72):lineCount*26+72));
  const title=normalized.hasTable?(zh?'粘贴的表格':'Pasted table'):(normalized.text.trim().split('\n')[0].slice(0,60)||(zh?'粘贴的文字':'Pasted text'));
  const notices=[...snapshot.warnings,...normalized.warnings];
  return{content:{text:{text:normalized.text,...(textFormat==='richText'?{richTextHTML:normalized.richTextHTML}:{}),textFormat,title,width,height}},size:{width,height},notice:notices.length?(zh?'部分嵌入内容或格式无法保留；图片可单独复制后粘贴。':'Some embedded content or formatting could not be retained. Copy and paste images separately.'):''};
 }
 throw Error(zh?'剪贴板中没有可粘贴的文件、文字、表格或图片。请先复制内容。':'The clipboard has no supported file, text, table or image. Copy some content first.');
}
/** Center the complete paste group on a visible click, or the current viewport. */
export function boardPastePosition(point:PastePoint|null,camera:PastePoint&{zoom:number},view:{width:number;height:number},item:{width:number;height:number},world:{width:number;height:number}):PastePoint{
 const finite=(n:number)=>Number.isFinite(n);if(![camera.x,camera.y,camera.zoom,view.width,view.height,item.width,item.height,world.width,world.height].every(finite)||camera.zoom<=0||[view.width,view.height,item.width,item.height,world.width,world.height].some(n=>n<=0)||item.width>world.width||item.height>world.height)throw Error('Invalid paste position');
 const visible=!!point&&finite(point.x)&&finite(point.y)&&Math.abs(point.x-camera.x)<=view.width/2/camera.zoom&&Math.abs(point.y-camera.y)<=view.height/2/camera.zoom;
 const x=(visible?point!.x:camera.x)-item.width/2,y=(visible?point!.y:camera.y)-item.height/2;
 return{x:Math.max(0,Math.min(world.width-item.width,x)),y:Math.max(0,Math.min(world.height-item.height,y))};
}

/** Local library links are opened only by an explicit click in the current vault. */
export function internalClipboardPath(text:string):string|null{
 try{const url=new URL(text.trim());if(url.protocol!=='inkspace:'||url.hostname!=='open'||url.username||url.password||url.hash||url.pathname&&url.pathname!=='/'||[...url.searchParams.keys()].some(key=>key!=='file')||url.searchParams.getAll('file').length!==1)return null;const path=url.searchParams.get('file');return path&&path.length<=4096&&!/^[\/]/.test(path)&&!/[\\:\u0000-\u001f\u007f]/.test(path)&&path.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!part.startsWith('.'))?path:null;}catch{return null;}
}

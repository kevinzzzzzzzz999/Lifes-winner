import {safeExternalLink} from './clipboard-rich-text';

/** Web cards reuse schema-1 text items; old readers retain the URL as plain text. */
export const BOARD_WEB_FORMAT='web';
export function boardWebURL(value:unknown):string|null {
 return typeof value==='string'?safeExternalLink(value.trim()):null;
}
export function isBoardWebCard(item:{kind?:string;textFormat?:string;url?:string;text?:string}):boolean {
 return item.kind==='text'&&item.textFormat===BOARD_WEB_FORMAT&&!!boardWebURL(item.url||item.text);
}
export function makeWebCardContent(url:string,title?:string){
 const safe=boardWebURL(url);if(!safe)throw new Error('请输入完整的 http / https 网页地址。 / Enter a complete http / https URL.');
 return {text:safe,url:safe,title:title?.trim().slice(0,512)||new URL(safe).hostname,textFormat:BOARD_WEB_FORMAT as 'web',width:720,height:560};
}
export function webLinkHTML(label:string,url:string):string|null {
 const safe=boardWebURL(url);if(!safe)return null;
 const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 return `<a href="${escape(safe)}">${escape(label.trim()||safe)}</a>`;
}

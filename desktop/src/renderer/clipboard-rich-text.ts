import {boxMarkdown,copiedMathText} from './rich-text-math';
/** Clipboard HTML is parsed in an inert template and rebuilt from a presentational
 * allowlist. No original element, class, URL or stylesheet reaches the live DOM. */
export const CLIPBOARD_RICH_LIMITS = Object.freeze({htmlInput:1_048_576,htmlOutput:300_000,text:100_000,nodes:12_000,depth:40,rows:200,columns:50,cells:2_000});
export type ClipboardRichContent={text:string;richTextHTML:string;kind:'table'|'richText'|'plain';hasTable:boolean;tableDimensions?:{rows:number;columns:number};warnings:string[]};
const ALLOWED=new Set(['a','p','div','h1','h2','h3','h4','h5','h6','span','strong','b','em','i','u','s','del','ul','ol','li','blockquote','pre','code','br','hr','table','thead','tbody','tfoot','tr','td','th','caption','sup','sub','font']);
const DROP=new Set(['head','title','script','style','iframe','frame','frameset','object','embed','svg','math','form','input','button','select','textarea','option','img','picture','video','audio','source','track','link','meta','base','noscript','template','canvas']);
const MEDIA=new Set(['img','picture','video','audio','svg','canvas','object','embed','iframe']);
const COLORS=new Set(['black','silver','gray','grey','white','maroon','red','purple','fuchsia','green','lime','olive','yellow','navy','blue','teal','aqua','orange','transparent','rebeccapurple','darkblue','darkred','darkgreen','lightblue','lightgray','lightgrey','pink','brown']);
const escape=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function limit(message:string):never{throw new Error(message);}
/** Only user-activated public web URL schemes; never credentials or executable/local URLs. */
export function safeExternalLink(value:string,allowWWW=false):string|null{
 if(typeof value!=='string'||!value||value.length>8192||/[\u0000-\u0020\u007f-\u009f\\]/.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value))return null;
 const candidate=allowWWW&&/^www\./i.test(value)?'https://'+value:value;
 if(!/^https?:\/\//i.test(candidate))return null;
 try{const url=new URL(candidate);if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)return null;return url.href;}catch{return null;}
}

function color(value:string):string|null{
 const v=value.trim().toLowerCase();if(/^#[a-f0-9]{3,4}$|^#[a-f0-9]{6}$|^#[a-f0-9]{8}$/.test(v)||COLORS.has(v))return v;
 const m=v.match(/^(rgb|rgba)\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
 if(!m||[2,3,4].some(i=>!Number.isFinite(+m[i])||+m[i]>255)||(m[1]==='rgba')!==(m[5]!=null)||(m[5]!=null&&(!Number.isFinite(+m[5])||+m[5]>1)))return null;
 return `${m[1]}(${+m[2]}, ${+m[3]}, ${+m[4]}${m[5]==null?'':`, ${+m[5]}`})`;
}
function size(value:string):string|null{const m=value.trim().match(/^(\d+(?:\.\d+)?)(px|pt|em|rem|%)$/i);if(!m)return null;const px=+m[1]*({px:1,pt:4/3,em:16,rem:16,'%':.16}[m[2].toLowerCase()]!);if(!Number.isFinite(px)||px<=0)return null;return `${Math.round(Math.max(8,Math.min(48,px))*100)/100}px`;}
function styles(source:string):Map<string,string>{
 const result=new Map<string,string>();if(source.length>4096)return result;
 for(const declaration of source.replace(/\/\*[\s\S]*?\*\//g,'').split(';')){const colon=declaration.indexOf(':');if(colon<1)continue;let name=declaration.slice(0,colon).trim().toLowerCase(),value=declaration.slice(colon+1).trim().replace(/\s*!important\s*$/i,'').toLowerCase();if(/[\\<>@]/.test(value)||/url\s*\(|expression\s*\(|var\s*\(/i.test(value))continue;let allowed:string|null=null;
  if(['color','background','background-color'].includes(name)){allowed=color(value);if(name==='background')name='background-color';}
  else if(name==='font-size')allowed=size(value);
  else if(name==='font-weight'&&/^(normal|bold|[1-9]00)$/.test(value))allowed=value;
  else if(name==='font-style'&&/^(normal|italic|oblique)$/.test(value))allowed=value;
  else if(['text-decoration','text-decoration-line'].includes(name)&&/^(none|underline|line-through|underline line-through|line-through underline)$/.test(value)){allowed=value;name='text-decoration-line';}
  else if(name==='text-align'&&/^(left|right|center|justify|start|end)$/.test(value))allowed=value;
  else if(name==='vertical-align'&&/^(top|middle|bottom|baseline|sub|super)$/.test(value))allowed=value;
  else if(name==='white-space'&&/^(normal|pre|pre-wrap|pre-line)$/.test(value))allowed=value;
  if(allowed)result.set(name,allowed);
 }
 return result;
}
type ClassRule={tag?:string;name:string;declarations:Map<string,string>};
function officeRules(fragment:DocumentFragment):ClassRule[]{
 const rules:ClassRule[]=[];let total=0;
 for(const element of fragment.querySelectorAll('style')){
  const source=(element.textContent||'').replace(/<!--|-->/g,'').replace(/\/\*[\s\S]*?\*\//g,'');total+=source.length;if(total>65536)break;
  for(const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)){if(rules.length>=256)return rules;for(const selector of match[1].split(',')){const simple=selector.trim().match(/^(?:([a-zA-Z][a-zA-Z0-9]*)\s*)?\.([a-zA-Z_][\w-]{0,63})$/);if(simple)rules.push({tag:simple[1]?.toLowerCase(),name:simple[2],declarations:styles(match[2])});}}
 }
 return rules;
}
function dimensions(root:ParentNode,strict:boolean):{rows:number;columns:number;cells:number}{
 let rows=0,columns=0,cells=0;
 for(const table of root.querySelectorAll('table')){let tableRow=0;const occupancy:number[]=[];
  for(const row of table.querySelectorAll('tr')){if(row.closest('table')!==table)continue;tableRow++;rows++;let col=0;
   for(const cell of row.children){if(!['TD','TH'].includes(cell.tagName))continue;while((occupancy[col]||0)>=tableRow)col++;const span=Math.min(50,Math.max(1,Number(cell.getAttribute('colspan'))||1)),rowspan=Math.min(200,Math.max(1,Number(cell.getAttribute('rowspan'))||1));for(let k=col;k<col+span;k++)occupancy[k]=Math.max(occupancy[k]||0,tableRow+rowspan-1);col+=span;cells++;}
   columns=Math.max(columns,col,occupancy.length);
  }
 }
 if(strict&&(rows>CLIPBOARD_RICH_LIMITS.rows||columns>CLIPBOARD_RICH_LIMITS.columns||cells>CLIPBOARD_RICH_LIMITS.cells))limit('表格过大，请分批粘贴（最多 200 行、50 列、2,000 个单元格）。 / Paste a smaller table (200 rows, 50 columns, 2,000 cells).');
 return {rows,columns,cells};
}
function normalizeHTML(source:string,strict:boolean):{html:string;text:string;rows:number;columns:number;media:number}{
 if(strict&&source.length>CLIPBOARD_RICH_LIMITS.htmlInput)limit('剪贴板 HTML 超过 1 MB，请分批复制。 / Clipboard HTML exceeds 1 MB.');
 const template=document.createElement('template');template.innerHTML=source.slice(0,CLIPBOARD_RICH_LIMITS.htmlInput);
 const rules=officeRules(template.content),output=document.createElement('div');let nodes=0,media=0;
 function walk(node:Node,parent:Node,depth:number){if(++nodes>CLIPBOARD_RICH_LIMITS.nodes||depth>CLIPBOARD_RICH_LIMITS.depth){if(strict)limit('剪贴板结构过于复杂，请分批复制。 / Clipboard structure is too complex.');return;}
  if(node.nodeType===Node.TEXT_NODE){parent.appendChild(document.createTextNode(node.textContent||''));return;}if(node.nodeType!==Node.ELEMENT_NODE)return;
  const input=node as Element,tag=input.localName.toLowerCase();
  const math=copiedMathText(input);if(math){parent.appendChild(document.createTextNode(math));return;}
  if(tag==='math'){const primary=input.querySelector('semantics')?.firstElementChild||input;parent.appendChild(document.createTextNode(primary.textContent||''));return;}
  if(MEDIA.has(tag))media++;if(DROP.has(tag))return;
  if(!ALLOWED.has(tag)){for(const child of input.childNodes)walk(child,parent,depth+1);return;}
  const link=tag==='a'?safeExternalLink(input.getAttribute('href')||''):null;
  const element=document.createElement(tag==='font'||(tag==='a'&&!link)?'span':tag),format=new Map<string,string>();
  for(const rule of rules)if((!rule.tag||rule.tag===tag)&&input.classList.contains(rule.name))for(const entry of rule.declarations)format.set(...entry);
  for(const entry of styles(input.getAttribute('style')||''))format.set(...entry);
  const alignment=(input.getAttribute('align')||'').toLowerCase(),bg=color(input.getAttribute('bgcolor')||'');if(!format.has('text-align')&&/^(left|center|right|justify)$/.test(alignment))format.set('text-align',alignment);if(bg&&!format.has('background-color'))format.set('background-color',bg);
  if(tag==='font'){const ink=color(input.getAttribute('color')||'');if(ink&&!format.has('color'))format.set('color',ink);const oldSize=Number(input.getAttribute('size'));if(Number.isInteger(oldSize)&&oldSize>=1&&oldSize<=7&&!format.has('font-size'))format.set('font-size',[10,13,16,18,24,32,48][oldSize-1]+'px');}
  if(link){element.setAttribute('href',link);element.setAttribute('rel','noopener noreferrer');}
  if(format.size)element.setAttribute('style',Array.from(format,([name,value])=>`${name}: ${value}`).join('; '));
  if(tag==='td'||tag==='th')for(const attr of ['rowspan','colspan']){const raw=input.getAttribute(attr)||'';if(/^\d{1,3}$/.test(raw)){const count=Number(raw),max=attr==='rowspan'?200:50;if(strict&&count>max)limit('合并单元格范围过大，请分批复制。 / Merged cell span is too large.');if(count>1&&count<=max)element.setAttribute(attr,String(count));}}
  parent.appendChild(element);for(const child of input.childNodes)walk(child,element,depth+1);
 }
 for(const node of template.content.childNodes)walk(node,output,0);
 const counts=dimensions(output,strict),text=richTextHTMLToText(output),html=output.innerHTML;
 if(strict&&(text.length>CLIPBOARD_RICH_LIMITS.text||html.length>CLIPBOARD_RICH_LIMITS.htmlOutput))limit('内容超过文本框上限，请分批粘贴。 / This text box is too large; paste in smaller parts.');
 return {html,text,rows:counts.rows,columns:counts.columns,media};
}
/** Plain-text counterpart for saving/search; rows are tab-separated, blocks use newlines. */
export function richTextHTMLToText(root:ParentNode):string{
 const blocks=new Set(['a','p','div','h1','h2','h3','h4','h5','h6','blockquote','pre','ul','ol','li','table','caption']);
 function text(node:Node):string{if(node.nodeType===Node.TEXT_NODE)return node.textContent||'';if(node.nodeType!==Node.ELEMENT_NODE)return '';const e=node as Element,tag=e.localName;if(tag==='br')return '\n';if(tag==='tr')return Array.from(e.children).filter(c=>['td','th'].includes(c.localName)).map(c=>Array.from(c.childNodes).map(text).join('').replace(/\n+$/,'')).join('\t')+'\n';const value=Array.from(e.childNodes).map(text).join('');return value+(blocks.has(tag)&&value&&!value.endsWith('\n')?'\n':'');}
 return Array.from(root.childNodes).map(text).join('').replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').replace(/\n{3,}/g,'\n\n').replace(/^\n+|\n+$/g,'');
}
export function sanitizeRichTextHTML(source:string):string{return normalizeHTML(source,false).html;}
export function plainTextToRichHTML(text:string):string{return text.replace(/\r\n?/g,'\n').split('\n').map(line=>`<p>${escape(line)||'<br>'}</p>`).join('');}
/** Spreadsheet TSV fallback, including quoted tabs/newlines and trailing empty cells. */
export function tabSeparatedTextToHTML(source:string):string|null{
 if(!source.includes('\t'))return null;if(source.length>CLIPBOARD_RICH_LIMITS.text)limit('剪贴板文字过长，请分批复制。 / Clipboard text is too large.');
 const rows:string[][]=[],text=source.replace(/\r\n?/g,'\n');let row:string[]=[],cell='',quoted=false,closedQuote=false,atStart=true,hasTab=false;
 const finish=()=>{row.push(cell);cell='';atStart=true;closedQuote=false;if(row.length>50)limit('表格最多支持 50 列。 / Table exceeds 50 columns.');};
 for(let i=0;i<text.length;i++){const char=text[i];if(quoted){if(char==='"'){if(text[i+1]==='"'){cell+='"';i++;}else {quoted=false;closedQuote=true;}}else cell+=char;continue;}if(closedQuote&&char!=='\t'&&char!=='\n')return null;if(char==='"'&&atStart){quoted=true;atStart=false;}else if(char==='\t'){hasTab=true;finish();}else if(char==='\n'){finish();rows.push(row);row=[];if(rows.length>200)limit('表格最多支持 200 行。 / Table exceeds 200 rows.');}else{cell+=char;atStart=false;}}
 if(quoted)return null;if(cell||row.length||!text.endsWith('\n')){finish();rows.push(row);}if(!hasTab)return null;
 const columns=Math.max(...rows.map(r=>r.length));if(rows.length*columns>2000)limit('表格最多支持 2,000 个单元格。 / Table exceeds 2,000 cells.');
 return '<table><tbody>'+rows.map(r=>'<tr>'+Array.from({length:columns},(_,i)=>'<td>'+escape(r[i]||'').replace(/\n/g,'<br>')+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
}
export function normalizeClipboard({html='',text=''}:{html?:string;text?:string}):ClipboardRichContent|null{
 let content=html.trim()?normalizeHTML(html,true):null;const omittedMedia=content?.media||0;
 if(content&&!content.text.trim()&&!content.rows)content=null;
 if(!content){if(text.length>CLIPBOARD_RICH_LIMITS.text)limit('剪贴板文字过长，请分批复制。 / Clipboard text is too large.');if(!text.trim())return null;
  const markdownTokens=text.includes('|')?boxMarkdown.lexer(text):null;
  const table=tabSeparatedTextToHTML(text)||(markdownTokens?.some(token=>token.type==='table')?boxMarkdown.parser(markdownTokens):null),link=table?null:safeExternalLink(text.replace(/^ +| +$/g,''),true),source=table||(link?`<p><a href="${escape(link)}">${escape(text)}</a></p>`:plainTextToRichHTML(text));content=normalizeHTML(source,true);return {text:content.text,richTextHTML:content.html,kind:table?'table':link?'richText':'plain',hasTable:!!table,tableDimensions:table?{rows:content.rows,columns:content.columns}:undefined,warnings:omittedMedia?['文字和表格已保留；内嵌图片或媒体请单独复制后粘贴。 / Text and tables were retained; copy embedded images or media separately.']:[]};}
 const hasTable=content.rows>0;return {text:content.text,richTextHTML:content.html,kind:hasTable?'table':'richText',hasTable,tableDimensions:hasTable?{rows:content.rows,columns:content.columns}:undefined,warnings:content.media?['文字和表格已保留；内嵌图片或媒体请单独复制后粘贴。 / Text and tables were retained; copy embedded images or media separately.']:[]};
}
export const normalizeClipboardContent=normalizeClipboard;

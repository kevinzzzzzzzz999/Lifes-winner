import katex from 'katex';
import {Marked} from 'marked';

const escapeHTML=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const escapeTeX=(text:string)=>text.replace(/[\\{}$&#_%^~]/g,c=>({'\\':'\\backslash{}','^':'\\textasciicircum{}','~':'\\textasciitilde{}'}[c]||'\\'+c));
type Formula={source:string;display:boolean;raw:string};
const escaped=(text:string,index:number)=>{let slashes=0;while(index>0&&text[--index]==='\\')slashes++;return slashes%2===1;};

/** Delimiters are retained in saved/editable HTML. Dollar rules avoid treating
 * ordinary prices such as "$10 and $20" as a formula. Code is handled by callers. */
function formulaAt(text:string,index:number):Formula|null{
 if(escaped(text,index))return null;
 const start=text.startsWith('\\(',index)?'\\(':text.startsWith('\\[',index)?'\\[':text.startsWith('$$',index)?'$$':text[index]==='$'?'$':null;
 if(!start)return null;
 const close=start==='\\('? '\\)':start==='\\['?'\\]':start;
 let end=text.indexOf(close,index+start.length);
 while(end>=0&&escaped(text,end))end=text.indexOf(close,end+close.length);
 if(end<0)return null;
 const source=text.slice(index+start.length,end);
 if(!source.trim()||source.length>10000)return null;
 if(start==='$'&&(/^[\s$]|[\s$]$/.test(source)||source.includes('\n')||/[\d$]/.test(text[end+1]||'')||text[index-1]==='$'))return null;
 return{source,display:start==='\\['||start==='$$',raw:text.slice(index,end+close.length)};
}

/** Keep math tokens intact before Markdown consumes backslash escapes. */
export const boxMarkdown=new Marked({gfm:true,breaks:false,extensions:[{
 name:'boxMath',level:'inline',start:source=>source.search(/\\[([]|\$/),
 tokenizer(source){const math=formulaAt(source,0);if(math)return{type:'boxMath',raw:math.raw,text:math.raw};},
 renderer(token){return escapeHTML(token.text as string);},
}]});

/** Convert a bounded presentation MathML subset to source, never live MathML.
 * KaTeX's TeX annotation is preferred because it preserves the author's syntax. */
function mathMLSource(root:Element):string|null{
 let count=0;
 function read(node:Element,depth=0):string|null{
  if(++count>1000||depth>32)return null;
  const tag=node.localName.toLowerCase(),children=Array.from(node.children).filter(child=>!['annotation','annotation-xml'].includes(child.localName.toLowerCase()));
  const values=children.map(child=>read(child,depth+1));if(values.some(value=>value===null))return null;
  const a=values as string[],text=node.textContent||'';
  if(['math','semantics','mrow','mstyle','mpadded','mphantom'].includes(tag))return a.join(' ');
  if(tag==='mi'||tag==='mn')return escapeTeX(text);
  if(tag==='mtext'||tag==='ms')return '\\text{'+escapeTeX(text)+'}';
  if(tag==='mo')return ({'−':'-','∞':'\\infty','±':'\\pm','∓':'\\mp','×':'\\times','÷':'\\div','≤':'\\le','≥':'\\ge','≠':'\\ne','→':'\\to','∑':'\\sum','∏':'\\prod','∫':'\\int','∂':'\\partial','∈':'\\in','∉':'\\notin','⋅':'\\cdot','…':'\\ldots','{':'\\{','}':'\\}','|':'|'}[text]||escapeTeX(text));
  if(tag==='mfrac'&&a.length===2)return '\\frac{'+a[0]+'}{'+a[1]+'}';
  if(tag==='msqrt')return '\\sqrt{'+a.join(' ')+'}';
  if(tag==='mroot'&&a.length===2)return '\\sqrt['+a[1]+']{'+a[0]+'}';
  if(tag==='msup'&&a.length===2)return '{'+a[0]+'}^{'+a[1]+'}';
  if(tag==='msub'&&a.length===2)return '{'+a[0]+'}_{'+a[1]+'}';
  if(tag==='msubsup'&&a.length===3)return '{'+a[0]+'}_{'+a[1]+'}^{'+a[2]+'}';
  if(tag==='mover'&&a.length===2)return '\\overset{'+a[1]+'}{'+a[0]+'}';
  if(tag==='munder'&&a.length===2)return '\\underset{'+a[1]+'}{'+a[0]+'}';
  if(tag==='munderover'&&a.length===3)return '\\overset{'+a[2]+'}{\\underset{'+a[1]+'}{'+a[0]+'}}';
  if(tag==='mtable')return '\\begin{matrix}'+a.join('\\\\')+'\\end{matrix}';
  if(tag==='mtr')return a.join('&');
  if(tag==='mtd')return a.join(' ');
  if(tag==='mspace')return '\\ ';
  if(tag==='mfenced')return escapeTeX(node.getAttribute('open')??'(')+a.join(escapeTeX(node.getAttribute('separators')||','))+escapeTeX(node.getAttribute('close')??')');
  return null;
 }
 return read(root);
}

/** Called while clipboard HTML is still inert. Collapse a KaTeX wrapper once,
 * including its duplicate visual/accessible trees, to one editable formula. */
export function copiedMathText(input:Element):string|null{
 const tag=input.localName.toLowerCase();
 if(tag!=='math'&&!['katex','katex-display','math-inline','math-display'].some(name=>input.classList.contains(name)))return null;
 const math=tag==='math'?input:input.querySelector('math');
 const annotation=math?.querySelector('annotation[encoding="application/x-tex"],annotation[encoding="application/x-latex"]');
 let source=annotation?.textContent||input.getAttribute('data-latex')||(math?mathMLSource(math):null);
 if(!source||source.length>10000)return null;
 source=source.trim();const enclosed=formulaAt(source,0);if(enclosed?.raw===source)source=enclosed.source;
 const display=input.classList.contains('katex-display')||input.classList.contains('math-display')||math?.getAttribute('display')==='block'||enclosed?.display;
 return display?'\\['+source+'\\]':'\\('+source+'\\)';
}

/** Accept only sanitized HTML. Generated KaTeX markup is for display only; it
 * never flows back into saved richTextHTML or the contenteditable editor. */
export function renderRichTextMath(sanitizedHTML:string):string{
 if(!/\\[([]|\$/.test(sanitizedHTML))return sanitizedHTML;
 const template=document.createElement('template');template.innerHTML=sanitizedHTML;
 const walker=document.createTreeWalker(template.content,NodeFilter.SHOW_TEXT),nodes:Text[]=[];
 while(walker.nextNode())if(!(walker.currentNode.parentElement?.closest('pre,code')))nodes.push(walker.currentNode as Text);
 let count=0,totalSource=0,totalMarkup=0;
 for(const node of nodes){
  const text=node.data,fragment=document.createDocumentFragment();let last=0;
  for(let i=0;i<text.length&&count<200;i++){
   const math=formulaAt(text,i);if(!math)continue;
   if(totalSource+math.source.length>50000)break;
   let html:string;try{html=katex.renderToString(math.source,{displayMode:math.display,throwOnError:true,trust:false,maxExpand:200,maxSize:20,strict:'ignore'});}catch{i+=math.raw.length-1;continue;}
   if(totalMarkup+html.length>2000000)break;
   count++;totalSource+=math.source.length;totalMarkup+=html.length;
   fragment.appendChild(document.createTextNode(text.slice(last,i)));
   const span=document.createElement('span');span.className=math.display?'box-math box-math-display':'box-math box-math-inline';span.setAttribute('data-formula-source',math.source);span.innerHTML=html;fragment.appendChild(span);
   i+=math.raw.length-1;last=i+1;
  }
  if(last){fragment.appendChild(document.createTextNode(text.slice(last)));node.replaceWith(fragment);}
 }
 return template.innerHTML;
}

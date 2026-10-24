/** A bounded presentation vocabulary for HTML authored inside Notebook Markdown.
 * Read normalized CSSOM values, then discard every original style attribute.
 * No source-provided declaration, selector, URL or class suffix is returned.
 */
const textTags=new Set(['A','P','DIV','SPAN','H1','H2','H3','H4','H5','H6','B','STRONG','I','EM','U','S','DEL','INS','SMALL','BIG','SUB','SUP','MARK','BLOCKQUOTE','DL','DT','DD','TD','TH','CAPTION','FIGCAPTION','PRE','CODE','UL','OL','LI']);
const listTags=new Set(['UL','OL','LI']);
const fontSizes=new Map<string,string>([
 ...[10,11,12,13,14,15,16,18,20,21,22,24,25,28,30,32,36,40,48].map(size=>[size+'px','notebook-format-font-size-'+size] as [string,string]),
 ...['x-small','small','medium','large','x-large','xx-large','xxx-large'].map(size=>[size,'notebook-format-font-size-'+size] as [string,string]),
]);
const fontWeights=new Map<string,string>([
 ['normal','notebook-format-font-weight-400'],['bold','notebook-format-font-weight-700'],
 ...[100,200,300,400,500,600,700,800,900].map(weight=>[String(weight),'notebook-format-font-weight-'+weight] as [string,string]),
]);
const fontStyles=new Map(['normal','italic','oblique'].map(style=>[style,'notebook-format-font-style-'+style]));
const markers=new Map(['disc','circle','square','decimal','decimal-leading-zero','lower-alpha','upper-alpha','lower-latin','upper-latin','lower-roman','upper-roman','none'].map(marker=>[marker,'notebook-format-marker-'+marker]));
const leftSpacing=(property:string)=>new Map<string,string>([
 ['0','notebook-format-'+property+'-0'],
 ...[0,10,20,30,40,60,80].map(value=>[value+'px','notebook-format-'+property+'-'+value] as [string,string]),
]);
const marginLeft=leftSpacing('margin-left'),paddingLeft=leftSpacing('padding-left');
const marginTop=new Map<string,string>([
 ['0','notebook-format-margin-top-0'],['-10px','notebook-format-margin-top-n10'],['-5px','notebook-format-margin-top-n5'],
 ...[0,5,10,12,16,20,24,32].map(value=>[value+'px','notebook-format-margin-top-'+value] as [string,string]),
]);

export function notebookHTMLFormattingClasses(tagName:string,style:Pick<CSSStyleDeclaration,'getPropertyValue'>):string[]{
 const tag=tagName.toUpperCase();if(!textTags.has(tag))return [];
 const result:string[]=[];
 const append=(property:string,allowed:ReadonlyMap<string,string>)=>{
  const value=style.getPropertyValue(property).trim().toLowerCase(),className=allowed.get(value);
  if(className)result.push(className);
 };
 append('font-size',fontSizes);append('font-weight',fontWeights);append('font-style',fontStyles);
 if(listTags.has(tag)){append('list-style-type',markers);append('margin-left',marginLeft);append('padding-left',paddingLeft);append('margin-top',marginTop);}
 return result;
}

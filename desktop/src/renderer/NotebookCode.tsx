import {memo,useMemo} from 'react';
import {pythonLanguage} from '@codemirror/lang-python';
import {classHighlighter,highlightTree} from '@lezer/highlight';
import './notebook-document.css';

/** Display only: keep the original source intact; the existing editor owns edits. */
export default memo(function NotebookCode({source,className}:{source:string;className:string}){
 const pieces=useMemo(()=>{
  // Very large cells remain readable without parsing them on the UI thread.
  if(source.length>100000)return source;
  try{
   const tokens:{from:number;to:number;className:string}[]=[];
   highlightTree(pythonLanguage.parser.parse(source),classHighlighter,(from,to,className)=>tokens.push({from,to,className}));
   const parts=[];let end=0;
   for(const token of tokens){
    if(token.from>end)parts.push(source.slice(end,token.from));
    parts.push(<span key={token.from} className={token.className}>{source.slice(token.from,token.to)}</span>);end=token.to;
   }
   if(end<source.length)parts.push(source.slice(end));
   return parts;
  }catch{return source;}
 },[source]);
 return <pre className={className} tabIndex={0}><code className="notebook-python">{pieces||' '}</code></pre>;
});

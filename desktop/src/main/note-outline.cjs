'use strict';
const crypto=require('node:crypto');
const {fail}=require('./errors.cjs');
const unescapeTitle=value=>value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,'$1');
const escapeTitle=value=>value.replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,'\\$1');
const LIMITS={bytes:1024*1024,nodes:500,depth:12};
function parseOutline(input){
 if(typeof input!=='string'||Buffer.byteLength(input)>LIMITS.bytes||input.includes('\0'))fail('INTEROP_OUTLINE_LIMIT');
 const nodes=[],headings=[],lists=[];let listBase=null;
 for(const raw of input.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!raw.trim())continue;
  let title,parent,depth;const heading=/^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(raw);const bullet=/^( *)(?:[-+*]|\d+[.)])\s+(.+?)\s*$/.exec(raw);
  if(heading){const level=heading[1].length;while(headings.length&&headings.at(-1).level>=level)headings.pop();parent=headings.at(-1)?.index??null;depth=parent===null?0:nodes[parent].depth+1;title=heading[2].replace(/[ \t]+#+[ \t]*$/,'');lists.length=0;listBase=null;headings.push({level,index:nodes.length});}
  else if(bullet){const indent=bullet[1].length;if(indent%2)fail('INTEROP_OUTLINE_FORMAT');const level=indent/2;if(level>=LIMITS.depth||level>lists.length)fail('INTEROP_OUTLINE_FORMAT');if(level===0){listBase=headings.at(-1)?.index??null;lists.length=0;}parent=level===0?listBase:lists[level-1];if(parent===undefined)fail('INTEROP_OUTLINE_FORMAT');depth=parent===null?0:nodes[parent].depth+1;title=bullet[2];lists.length=level;lists.push(nodes.length);}
  else fail('INTEROP_OUTLINE_FORMAT');
  if(/[\t\r\n\0]/.test(unescapeTitle(title)))fail('INTEROP_OUTLINE_FORMAT');
  if(depth>=LIMITS.depth||nodes.length>=LIMITS.nodes||Array.from(unescapeTitle(title)).length>2000||Buffer.byteLength(unescapeTitle(title))>8000)fail('INTEROP_OUTLINE_LIMIT');
  nodes.push({title:unescapeTitle(title),parent,depth});
 }
 if(!nodes.length)fail('INTEROP_OUTLINE_FORMAT');return nodes;
}
function outlineBoard(text,title,writerID){
 const nodes=parseOutline(text),board=require('./board-elements.cjs').newBoard(title,writerID),ids=nodes.map(()=>crypto.randomUUID());
 board.items=nodes.map((n,i)=>({id:ids[i],kind:'text',title:n.title,text:n.title,textFormat:'markdown',x:4000000+n.depth*380,y:4000000+i*180,width:320,height:130}));
 board.edges=nodes.flatMap((n,i)=>n.parent===null?[]:[{id:crypto.randomUUID(),from:ids[n.parent],to:ids[i],relation:'child',style:{arrow:'end',strokeColor:'#5d847c',strokeWidth:2}}]);board.viewport={x:4000000,y:4000000,zoom:0.75};require('./board-validation.cjs').validateBoard(board);return board;
}
function exportOutline(board){
 require('./board-validation.cjs').validateBoard(board);if(board.items.length>LIMITS.nodes)fail('INTEROP_OUTLINE_LIMIT');
 const nodes=new Map(board.items.map(n=>[n.id.toLowerCase(),n])),children=new Map(),parent=new Map();
 for(const e of board.edges){const from=e.from.toLowerCase(),to=e.to.toLowerCase();if(parent.has(to))fail('INTEROP_OUTLINE_GRAPH');parent.set(to,from);children.set(from,[...(children.get(from)||[]),to]);}
 const roots=board.items.filter(n=>!parent.has(n.id.toLowerCase())),seen=new Set(),lines=[];
 const visit=(id,depth)=>{if(seen.has(id)||depth>=LIMITS.depth)fail('INTEROP_OUTLINE_GRAPH');seen.add(id);const node=nodes.get(id);if(!node||!node.title.trim()||Array.from(node.title).length>2000||Buffer.byteLength(node.title)>8000||/[\t\r\n\0]/.test(node.title))fail('INTEROP_OUTLINE_FORMAT');lines.push('  '.repeat(depth)+'- '+escapeTitle(node.title));for(const child of children.get(id)||[])visit(child,depth+1);};
 for(const root of roots)visit(root.id.toLowerCase(),0);if(seen.size!==nodes.size||!lines.length)fail('INTEROP_OUTLINE_GRAPH');const text=lines.join('\n')+'\n';if(Buffer.byteLength(text)>LIMITS.bytes)fail('INTEROP_OUTLINE_LIMIT');return{text,nodeCount:nodes.size,edgeCount:board.edges.length};
}
module.exports={LIMITS,parseOutline,outlineBoard,exportOutline};

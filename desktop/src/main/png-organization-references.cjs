'use strict';
// Deliberately bounded reference rewriting, not a Markdown renderer. Unsupported
// possible references block organization instead of guessing a target.
const path=require('node:path');
const fold=s=>s.normalize('NFC').toLowerCase();
const safe=s=>typeof s==='string'&&s.length>0&&!s.startsWith('/')&&!/[\\\x00-\x1f\x7f-\x9f:]/.test(s)&&s.split('/').every(p=>p&&p!=='.'&&p!=='..');
const strictEncode=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const uriPath=s=>s.split('/').map(p=>p==='..'||p==='.'?p:strictEncode(p)).join('/');
const wikiPath=s=>s.replace(/[%#?\[\]|]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const htmlDecode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi,(all,key)=>{const k=key.toLowerCase();if(k==='amp')return'&';if(k==='quot')return'"';if(k==='apos')return"'";if(k==='lt')return'<';if(k==='gt')return'>';const n=k.startsWith('#x')?parseInt(k.slice(2),16):Number(k.slice(1));return Number.isInteger(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):all;});
const htmlEncode=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const mdDecode=s=>s.replace(/\\([\\`*{}\[\]()#+\-.!_> <>"'])/g,'$1');
function rewriteDocument({path:documentPath,text,moves,inventory}){
 const references=[],blockers=[],replacements=[];
 const invalid=reason=>({text:typeof text==='string'?text:'',references,blockers:[{reason}],changed:false});
 if(!safe(documentPath)||typeof text!=='string'||!Array.isArray(moves)||!Array.isArray(inventory)||text.length>4*1024*1024||moves.length>2000||inventory.length>100000)return invalid('Reference document exceeds safe parsing bounds.');
 const moveMap=new Map();for(const m of moves){if(!m||!safe(m.from)||!safe(m.to)||moveMap.has(m.from))return invalid('Invalid or duplicate source move.');moveMap.set(m.from,m.to);}
 const files=[...new Set([...inventory,...moves.map(m=>m.from)])];if(files.some(f=>!safe(f)))return invalid('Invalid inventory path.');
 const byFold=new Map(),byBase=new Map(),byStem=new Map();const add=(map,k,v)=>map.set(k,[...(map.get(k)||[]),v]);
 for(const file of files){add(byFold,fold(file),file);add(byBase,fold(path.posix.basename(file)),file);add(byStem,fold(path.posix.basename(file,path.posix.extname(file))),file);}
 const fileSet=new Set(files);
 const protectedMask=new Uint8Array(text.length),handled=new Uint8Array(text.length);let operations=0;
 function block(reason,from){if(!blockers.some(b=>b.reason===reason&&b.from===from))blockers.push({...from?{from}:{},reason});}
 function possible(raw){if(++operations>10000){block('Too many references to prove safe rewriting.');return moves[0]?.from;}let s=htmlDecode(raw);try{s=decodeURIComponent(s);}catch{}s=fold(s);return moves.find(m=>s.includes(fold(m.from))||s.includes(fold(path.posix.basename(m.from))))?.from;}
 function available(candidate){if(!safe(candidate))return[];if(fileSet.has(candidate))return[candidate];return byFold.get(fold(candidate))||[];}
 function destination(raw,kind){
  if(++operations>10000){block('Too many references to prove safe rewriting.');return null;}
  let value=kind==='html'?htmlDecode(raw):kind==='markdown'?mdDecode(raw):raw;
  if(!value||value.startsWith('#'))return null;
  if(/^[a-z][a-z0-9+.-]*:/i.test(value)||value.startsWith('//')){if(/^(file:|inkspace:)/i.test(value)){const from=possible(value);if(from)block('Unsupported local application/file URL reference.',from);}return null;}
  const split=value.search(/[?#]/),pathname=split<0?value:value.slice(0,split),suffix=split<0?'':value.slice(split);
  let decoded,literalPercent=false;try{decoded=decodeURIComponent(pathname);}catch{if(kind==='wiki'){decoded=pathname;literalPercent=true;}else{const from=possible(pathname);if(from)block('Malformed percent-encoded local reference.',from);return null;}}
  if(!decoded||/[\\\x00-\x1f\x7f-\x9f]/.test(decoded)){const from=possible(value);if(from)block('Unsafe local reference.',from);return null;}
  const rootBased=decoded.startsWith('/'),explicitRelative=/^\.\.?\//.test(decoded);let candidates=[];
  const normalized=(base,value)=>path.posix.normalize(path.posix.join(base,value)),lookup=literalPercent?(candidate=>fileSet.has(candidate)?[candidate]:[]):available;
  if(kind==='wiki'){
   if(rootBased)candidates=lookup(normalized('',decoded.replace(/^\//,'')));
   else if(explicitRelative)candidates=lookup(normalized(path.posix.dirname(documentPath),decoded));
   else if(decoded.includes('/'))candidates=[...lookup(normalized('',decoded)),...lookup(normalized(path.posix.dirname(documentPath),decoded))];
   else {candidates=byBase.get(fold(decoded))||[];if(!path.posix.extname(decoded))candidates=[...candidates,...(byStem.get(fold(decoded))||[])];if(literalPercent)candidates=candidates.filter(c=>path.posix.basename(c)===decoded||!path.posix.extname(decoded)&&path.posix.basename(c,path.posix.extname(c))===decoded);}
  }else candidates=available(normalized(rootBased?'':path.posix.dirname(documentPath),rootBased?decoded.slice(1):decoded));
  candidates=[...new Set(candidates)];
  if(candidates.length!==1){const affected=candidates.find(c=>moveMap.has(c))||possible(decoded);if(affected)block(candidates.length?'Ambiguous local image reference.':'Unresolved possible image reference.',affected);return null;}
  const from=candidates[0],to=moveMap.get(from);if(!to)return null;
  let target;
  if(rootBased)target='/'+(kind==='wiki'?wikiPath(to):uriPath(to));
  else if(kind==='wiki'&&!explicitRelative)target=wikiPath(to);
  else {const relative=path.posix.relative(path.posix.dirname(documentPath),to)||path.posix.basename(to);target=kind==='wiki'?wikiPath(relative):uriPath(relative);if(value.startsWith('./')&&!target.startsWith('.'))target='./'+target;}
  target+=suffix;return{value:kind==='html'?htmlEncode(target):target,from,to};
 }
 function replace(start,end,raw,kind){if(start<0||end<=start||protectedMask[start]||handled[start])return;const target=destination(raw,kind);if(target){replacements.push({start,end,text:target.value});references.push({from:target.from,to:target.to,kind});}handled.fill(1,start,end);}
 function escaped(at){let n=0;for(let i=at-1;i>=0&&text[i]==='\\';i--)n++;return n%2===1;}
 function suspicious(raw,reason){const from=possible(raw);if(from)block(reason,from);}
 // Fences/inline code/comments remain untouched. InkSpace's explicit file JSON
 // fence is an active vault-root reference, so only its single file string is edited.
 const lines=[...text.matchAll(/.*(?:\r\n|\n|$)/g)].filter(m=>m[0]);let fence=null;
 for(const line of lines){const m=/^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line[0]);if(!fence&&m){fence={start:line.index,end:line.index+line[0].length,marker:m[1][0],count:m[1].length,lang:m[2].trim().toLowerCase()};continue;}if(fence&&m&&m[1][0]===fence.marker&&m[1].length>=fence.count&&!m[2].trim()){
   const body=text.slice(fence.end,line.index);if(fence.lang==='inkspace'){
    try{const v=JSON.parse(body),matches=[...body.matchAll(/"file"\s*:\s*"((?:\\.|[^"\\])*)"/g)];if(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.file==='string'&&moveMap.has(v.file)){
      if(matches.length!==1||JSON.parse('"'+matches[0][1]+'"')!==v.file)block('Ambiguous active InkSpace file reference.',v.file);
      else {const token=matches[0],offset=token[0].lastIndexOf('"'+token[1]+'"')+1;replacements.push({start:fence.end+token.index+offset,end:fence.end+token.index+offset+token[1].length,text:JSON.stringify(moveMap.get(v.file)).slice(1,-1)});references.push({from:v.file,to:moveMap.get(v.file),kind:'inkspace'});}
    }}catch{suspicious(body,'Malformed active InkSpace file reference.');}
   }
   protectedMask.fill(1,fence.start,line.index+line[0].length);fence=null;
 }}
 if(fence){protectedMask.fill(1,fence.start);if(fence.lang==='inkspace')suspicious(text.slice(fence.end),'Incomplete active InkSpace file reference.');}
 for(const line of lines)if(!protectedMask[line.index]&&/^(?: {4}|\t)/.test(line[0])){suspicious(line[0],'Indented possible reference requires manual review.');protectedMask.fill(1,line.index,line.index+line[0].length);}
 for(const m of text.matchAll(/<!--([\s\S]*?)(?:-->|$)/g))if(!protectedMask[m.index])protectedMask.fill(1,m.index,m.index+m[0].length);
 for(const m of text.matchAll(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi))if(!protectedMask[m.index]){suspicious(m[0],'Uninspected script or stylesheet image reference.');protectedMask.fill(1,m.index,m.index+m[0].length);}
 for(let i=0;i<text.length;i++){if(text[i]!=='`'||protectedMask[i])continue;let end=i;while(text[end]==='`')end++;const marker=text.slice(i,end),close=text.indexOf(marker,end);if(close>=0&&!protectedMask[close]){protectedMask.fill(1,i,close+marker.length);i=close+marker.length-1;}else i=end-1;}
 // HTML quoted and unquoted href/src values. Other resource-bearing attributes
 // are not guessed; a potential selected image makes that document a blocker.
 function markdownAngleAt(at){let i=at-1;while(i>=0&&/\s/.test(text[i]))i--;if(text[i]==='('&&text[i-1]===']')return true;if(text[i]!==':')return false;const start=text.lastIndexOf('\n',i)+1;return /^[ \t]{0,3}\[[^\]\r\n]+\]:$/.test(text.slice(start,i+1));}
 for(const tag of text.matchAll(/<([a-z][a-z0-9:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi)){
  if(protectedMask[tag.index]||escaped(tag.index)||markdownAngleAt(tag.index))continue;const name=tag[1].toLowerCase();
  for(const a of tag[0].matchAll(/([^\s=<>"'\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)){
   const key=a[1].toLowerCase(),value=a[2]??a[3]??a[4],whole=a[0],at=whole.indexOf('=')+1,tail=whole.slice(at),lead=tail.length-tail.trimStart().length,quoted=tail.trimStart()[0]==='"'||tail.trimStart()[0]==="'",start=tag.index+a.index+at+lead+(quoted?1:0);
   if(name==='img'&&key==='src'||name==='a'&&key==='href')replace(start,start+value.length,value,'html');
   else if(['src','href','srcset','poster','background','data','style'].includes(key))suspicious(value,'Unsupported resource-bearing HTML attribute.');
  }
  handled.fill(1,tag.index,tag.index+tag[0].length);
 }
 for(const m of text.matchAll(/!?\[\[([^\]\r\n]*)\]\]/g)){
  if(protectedMask[m.index]||handled[m.index]||escaped(m.index))continue;const prefix=m[0].startsWith('!')?3:2,inner=m[1],bar=inner.search(/(?<!\\)\|/),raw=bar<0?inner:inner.slice(0,bar);replace(m.index+prefix,m.index+prefix+raw.length,raw,'wiki');handled.fill(1,m.index,m.index+m[0].length);
 }
 function urlAt(start){let i=start;while(/[ \t\r\n]/.test(text[i]||'\0'))i++;const begin=i;if(text[i]==='<'){i++;const b=i;while(i<text.length&&text[i]!=='>'&&!/[\r\n]/.test(text[i])){if(text[i]==='\\')i++;i++;}if(text[i]!=='>')return null;return{start:b,end:i,after:i+1};}
  let depth=0;for(;i<text.length;i++){const c=text[i];if(c==='\\'){i++;continue;}if(/[\s]/.test(c))break;if(c==='('){if(++depth>16)return null;}if(c===')'){if(!depth)break;depth--;}}
  return i>begin&&depth===0?{start:begin,end:i,after:i}:null;
 }
 function closedLink(after){let i=after;while(/[ \t\r\n]/.test(text[i]||'\0'))i++;if(text[i]===')')return i+1;if(text[i]!=="'"&&text[i]!=='"')return null;const quote=text[i++];for(;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]===quote){i++;while(/[ \t\r\n]/.test(text[i]||'\0'))i++;return text[i]===')'?i+1:null;}if(text[i]==='\n'&&text[i+1]==='\n')return null;}return null;}
 for(const m of text.matchAll(/!?\[(?:\\.|[^\]\\\r\n])*\]\(/g)){
  if(protectedMask[m.index]||handled[m.index]||escaped(m.index))continue;const u=urlAt(m.index+m[0].length),end=u&&closedLink(u.after);if(!u||!end){suspicious(text.slice(m.index,text.indexOf('\n',m.index)<0?text.length:text.indexOf('\n',m.index)),'Incomplete or unsupported Markdown destination.');continue;}replace(u.start,u.end,text.slice(u.start,u.end),'markdown');handled.fill(1,m.index,end);
 }
 for(const m of text.matchAll(/^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*/gm)){
  if(protectedMask[m.index]||handled[m.index])continue;const u=urlAt(m.index+m[0].length);if(!u){suspicious(text.slice(m.index,m.index+4096),'Unsupported Markdown reference definition.');continue;}replace(u.start,u.end,text.slice(u.start,u.end),'markdown');handled.fill(1,m.index,u.after);
 }
 // A failed lexer match around a plausible local image is a blocker, not a
 // silent omission. Ordinary prose and protected code are left unchanged.
 for(const line of lines){if(protectedMask[line.index])continue;const raw=line[0];if(!/(?:!?\[|<\s*(?:img|a)\b)/i.test(raw))continue;let rest='';for(let n=0;n<raw.length;n++)if(!handled[line.index+n]&&!protectedMask[line.index+n]&&!escaped(line.index+n))rest+=raw[n];if(/(?:!\[|\[\[|\]\(|<\s*(?:img|a)\b)/i.test(rest))suspicious(rest,'Unparsed possible local image reference.');}
 replacements.sort((a,b)=>a.start-b.start);for(let i=1;i<replacements.length;i++)if(replacements[i].start<replacements[i-1].end)return invalid('Overlapping reference syntax cannot be rewritten safely.');
 let output=text;for(const r of replacements.reverse())output=output.slice(0,r.start)+r.text+output.slice(r.end);
 return{text:output,references,blockers,changed:output!==text};
}
module.exports={rewriteDocument};

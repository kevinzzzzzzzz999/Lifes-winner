'use strict';
const crypto=require('node:crypto'),{fail}=require('./errors.cjs');
const MAX_BYTES=2*1024*1024,MAX_ROWS=500;
const normalize=value=>value.replace(/\r\n?/g,'\n').trim().normalize('NFC');
const pairKey=(question,answer)=>JSON.stringify([normalize(question),normalize(answer)]);
function stableID(boardID,key,role,generation=0){const b=crypto.createHash('sha256').update('inkspace.study.csv.v1\n'+boardID.toLowerCase()+'\n'+role+'\n'+key+(generation?'\ngeneration:'+generation:'')).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
function decode(data){if(!Buffer.isBuffer(data)||data.length>MAX_BYTES)fail('TOO_LARGE');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{fail('INVALID_TEXT');}if(text.includes('\0'))fail('INVALID_TEXT');return text.replace(/\r\n?/g,'\n');}
function parse(data,{delimiter='csv',header=false}={}){
 if(!['csv','tsv'].includes(delimiter)||typeof header!=='boolean')fail('INVALID_REQUEST');const text=decode(data),sep=delimiter==='tsv'?'\t':',';const records=[];let cells=[],cell='',quoted=false,closed=false,atStart=true,line=1,startLine=1,hasContent=false;
 const pushCell=()=>{cells.push(cell);cell='';closed=false;atStart=true;};
 const pushRow=()=>{pushCell();if(hasContent||cells.length!==1||cells[0]!=='')records.push({line:startLine,cells});cells=[];hasContent=false;startLine=line+1;if(records.length>MAX_ROWS+(header?1:0))fail('TOO_LARGE');};
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else{cell+=c;if(c==='\n')line++;}continue;}
  if(closed&&c!==sep&&c!=='\n')fail('STUDY_CSV_SYNTAX');
  if(c==='"'){if(!atStart)fail('STUDY_CSV_SYNTAX');quoted=true;atStart=false;hasContent=true;}
  else if(c===sep){pushCell();hasContent=true;}
  else if(c==='\n'){pushRow();line++;}
  else{cell+=c;atStart=false;hasContent=true;}
 }
 if(quoted)fail('STUDY_CSV_SYNTAX');if(hasContent||cells.length||cell||closed)pushRow();if(header)records.shift();
 const seen=new Set();return records.map((r,index)=>{const question=normalize(r.cells[0]||''),answer=normalize(r.cells[1]||''),row={index,line:r.line,question,answer,status:'ready'};
  if(r.cells.length!==2)return{...row,status:'invalid',reason:'columns'};
  if(!question||!answer)return{...row,status:'invalid',reason:'empty'};
  if(Array.from(question).length>4000||Array.from(answer).length>20000)return{...row,status:'invalid',reason:'length'};
  const zero='00000000-0000-0000-0000-000000000000';if(Buffer.byteLength(JSON.stringify({schemaVersion:1,id:zero,deviceID:zero,createdAt:'2000-01-01T00:00:00.000Z',boardID:zero,itemID:zero,kind:'card',card:{question,answer,mode:'qa',answerMode:'custom'}}))>65536)return{...row,status:'invalid',reason:'record'};
  const key=pairKey(question,answer);if(seen.has(key))return{...row,status:'duplicate',reason:'file'};seen.add(key);return row;
 });
}
function nodeAnswer(node){return typeof node?.text==='string'&&node.text.trim()?node.text:typeof node?.sourceReference?.quote==='string'?node.sourceReference.quote:'';}
function existingPairs(projection,board){const nodes=new Map(board.items.map(n=>[n.id.toLowerCase(),n])),keys=new Set();for(const entry of projection.cards){if(entry.card.mode!=='qa'||entry.missingNode||!nodes.has(entry.itemID.toLowerCase()))continue;const answer=entry.card.answerMode==='node'?nodeAnswer(nodes.get(entry.itemID.toLowerCase())):entry.card.answer;if(answer.trim())keys.add(pairKey(entry.card.question,answer));}return keys;}
function markExisting(rows,projection,board){const keys=existingPairs(projection,board);return rows.map(row=>row.status==='ready'&&keys.has(pairKey(row.question,row.answer))?{...row,status:'duplicate',reason:'existing'}:row);}
function serialize(rows,delimiter='csv',formulaProtection=false){
 if(typeof formulaProtection!=='boolean')fail('INVALID_REQUEST');
 if(!['csv','tsv'].includes(delimiter)||rows.length>MAX_ROWS)fail('TOO_LARGE');let escapedCells=0;const protect=value=>{if(formulaProtection&&/^[\t\r\n]|^\s*[=+\-@]/u.test(value)){escapedCells++;return "'"+value;}return value;};
 const quote=value=>'"'+protect(String(value).replace(/\r\n?/g,'\n')).replace(/"/g,'""').replace(/\n/g,'\r\n')+'"';
 const text='\ufeff'+rows.map(row=>[row.question,row.answer].map(quote).join(delimiter==='tsv'?'\t':',')).join('\r\n')+(rows.length?'\r\n':'');const data=Buffer.from(text);if(data.length>MAX_BYTES)fail('TOO_LARGE');return{data,escapedCells};
}
module.exports={MAX_BYTES,MAX_ROWS,normalize,pairKey,stableID,decode,parse,nodeAnswer,existingPairs,markExisting,serialize};

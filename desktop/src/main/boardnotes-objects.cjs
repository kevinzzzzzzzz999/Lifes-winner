'use strict';
// Pure metadata planning. Asset decoding and transactional publication belong to the importer.
const MAX_OBJECTS=10000,MAX_TEXT=100000,MAX_HTML=300000,WORLD=8000000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),finite=v=>typeof v==='number'&&Number.isFinite(v);
function fail(code='BOARDNOTES_INVALID'){throw Object.assign(Error(code),{code});}
function ensure(v,code){if(!v)fail(code);}
function str(v,max=10000){ensure(typeof v==='string'&&v.length<=max&&v.isWellFormed()&&!v.includes('\0'));return v;}
function name(v){str(v,1024);ensure(v&&!/[\\/:\x00-\x1f]/.test(v)&&v!=='.'&&v!=='..');return v;}
function relative(v,empty=false){str(v,4096);ensure((empty&&v==='')||v&&!v.startsWith('/')&&!/[\\:\x00-\x1f]/.test(v)&&v.split('/').every(x=>x&&x!=='.'&&x!=='..'));return v;}
function id(v){ensure(typeof v==='string'&&UUID.test(v));return v.toLowerCase();}
const common='id userID boardID recordName isDel isDirty createTime updateTime';
const recordKeys=new Set((common+' shapeType borderColorAlpha pdfDisplayMode pdfScrollDirection autoAddState alpha levelType borderColor pdfTopLayerType angle level pdfBottomLayerType page mindmapType changedSizeState y lockType playRate scanState h bgStyle mindmapSort title pdfListSelectIndex x cardType mindmapTemplate favoriteState specialLevel type lineSpaceState mindmapStretchState w zoomScale pdfOutLineState relContentID pdfInBoardState pdfAnnotationConvertState offsetX offsetY drawingLayer bgColor horizontalInnerMargin verticalInnerMargin').split(' '));
const contentKeys=new Set((common+' type coverName isCoverDirty saveScale isDrawingDirty pdfVersion fileName drawingUpdateTime coverUpdateTime h w fontFamilyName fontSize fontSizeChangeState rowSpace style text textColor').split(' '));
function scalar(v,allowed){ensure(object(v));for(const [k,x] of Object.entries(v)){if(x!==null&&typeof x==='object')fail('BOARDNOTES_UNSUPPORTED');if(!allowed.has(k)&&x!==null&&x!==false&&x!==0&&x!=='')fail('BOARDNOTES_UNSUPPORTED');if(typeof x==='string')str(x,300000);if(typeof x==='number')ensure(finite(x));}}
function collection(v){if(v==null)return[];ensure(Array.isArray(v));ensure(v.length<=MAX_OBJECTS,'TOO_LARGE');return v;}
function color(v,fallback='#000000'){if(v==null)return fallback;str(v,9);ensure(/^#?[a-f\d]{6}$/i.test(v));return '#'+v.replace(/^#/,'').toLowerCase();}
function boundary(text,n){return n===0||n===text.length||!(text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff&&text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff);}
function textRuns(content){
 const text=str(content.text,MAX_TEXT);let runs=[];
 if(content.style!=null&&content.style!==''){str(content.style,MAX_HTML);try{runs=JSON.parse(content.style);}catch{fail();}ensure(Array.isArray(runs)&&runs.length<=2000);}
 const accepted=new Set(['fontSize','fontName','foregroundColor','location','length','alignment','lineSpace','backgroundColor','underlineStyle','strikethroughStyle','kern']);
 for(const r of runs){scalar(r,accepted);ensure(Number.isSafeInteger(r.location)&&Number.isSafeInteger(r.length)&&r.location>=0&&r.length>=0&&r.location+r.length<=text.length&&boundary(text,r.location)&&boundary(text,r.location+r.length));if(r.fontSize!=null)ensure(finite(r.fontSize)&&r.fontSize>0&&r.fontSize<=500);if(r.foregroundColor!=null)color(r.foregroundColor);if(r.backgroundColor!=null)color(r.backgroundColor);if(r.fontName!=null)str(r.fontName,200);if(r.alignment!=null)ensure([0,1,2,3,4].includes(r.alignment));}
 runs.sort((a,b)=>a.location-b.location);for(let i=1;i<runs.length;i++)ensure(runs[i].location>=runs[i-1].location+runs[i-1].length,'BOARDNOTES_UNSUPPORTED');return runs;
}
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function richText(content,runs){
 let cursor=0,html='';const text=content.text,base=content.fontSize||16;
 function span(text,r){const styles=['white-space:pre-wrap','font-size:'+Math.max(8,Math.min(48,r.fontSize||base))+'px','color:'+color(r.foregroundColor, color(content.textColor))];if(r.backgroundColor)styles.push('background-color:'+color(r.backgroundColor));if(/bold|semibold|demi/i.test(r.fontName||''))styles.push('font-weight:bold');if(/italic|oblique/i.test(r.fontName||''))styles.push('font-style:italic');if(r.underlineStyle)styles.push('text-decoration:underline');if(r.strikethroughStyle)styles.push('text-decoration:line-through');return '<span style="'+styles.join(';')+'">'+escape(text).replace(/\n/g,'<br>')+'</span>';}
 for(const r of runs){if(r.location>cursor)html+=span(text.slice(cursor,r.location),{});html+=span(text.slice(r.location,r.location+r.length),r);cursor=r.location+r.length;}if(cursor<text.length)html+=span(text.slice(cursor),{});
 // The sanitizer supports color/size/emphasis, not exact source font metrics or spacing.
 const alignments=new Set(runs.map(r=>r.alignment).filter(x=>x!==undefined));const alignment=alignments.size===1?['left','center','right','justify','start'][[...alignments][0]]:'start';
 html='<div style="white-space:pre-wrap;text-align:'+alignment+'">'+html+'</div>';ensure(html.length<=MAX_HTML,'TOO_LARGE');return html;
}
function planObjects(meta,entryIndex){
 ensure(object(meta)&&object(meta.board)&&typeof meta.board.recordName==='string'&&entryIndex instanceof Map);
 const records=collection(meta.boardRecord),contents=collection(meta.boardContent);ensure((!records.length&&!contents.length)||(records.length&&contents.length));const boardID=meta.board.recordName,byContent=new Map(),ids=new Set(),resources=new Set(),objects=[],notes=[],counts={text:0,image:0,pdf:0};
 for(const c of contents){scalar(c,contentKeys);ensure([0,1].includes(c.isDel));if(c.isDel===1)continue;id(c.recordName);ensure(c.boardID===boardID&&[0,1,4].includes(c.type),'BOARDNOTES_UNSUPPORTED');ensure(!byContent.has(c.recordName.toLowerCase()));byContent.set(c.recordName.toLowerCase(),c);}
 const used=new Set();let shapeCount=0,layerCount=0,textCount=0;const resource=n=>{name(n);const e=entryIndex.get(n);ensure(e&&!e.directory&&Number.isSafeInteger(e.expanded)&&e.expanded>0);resources.add(n);};
 for(const r of records){scalar(r,recordKeys);ensure([0,1].includes(r.isDel));if(r.isDel===1)continue;const rid=id(r.recordName),cid=id(r.relContentID);ensure(r.boardID===boardID&&!ids.has(rid));ids.add(rid);ensure(!used.has(cid),'BOARDNOTES_UNSUPPORTED');used.add(cid);const c=byContent.get(cid);ensure(c&&c.type===r.type);
  ensure([r.x,r.y,r.w,r.h].every(finite)&&Math.abs(r.x)<=WORLD&&Math.abs(r.y)<=WORLD&&r.w>0&&r.h>0&&r.w<=WORLD&&r.h<=WORLD);ensure((r.angle??0)===0&&(r.alpha??1)===1,'BOARDNOTES_UNSUPPORTED');ensure((r.mindmapType??0)===0&&(r.cardType??0)===0,'BOARDNOTES_UNSUPPORTED');
  ensure([0,1].includes(r.shapeType??0)&&[0,1].includes(r.levelType??0)&&[0,1,2].includes(r.specialLevel??0),'BOARDNOTES_UNSUPPORTED');if(r.shapeType)shapeCount++;if(r.levelType||r.specialLevel)layerCount++;
  const descriptor={id:rid,kind:r.type===0?'text':r.type===1?'image':'pdf',record:structuredClone(r),content:structuredClone(c)};
  if(r.type===0){descriptor.runs=textRuns(c);if(c.fontSize!=null)ensure(finite(c.fontSize)&&c.fontSize>0&&c.fontSize<=500);color(c.textColor);color(r.bgColor,'#ffffff');textCount++;counts.text++;}
  else{resource(c.fileName);descriptor.resource=c.fileName;if(r.type===4){ensure(/\.pdf$/i.test(c.fileName));if(c.coverName!=null){name(c.coverName);ensure(entryIndex.has(c.coverName));}ensure(Number.isInteger(r.page??0)&&(r.page??0)>=0&&(r.page??0)<100000);counts.pdf++;}else{ensure(finite(c.w)&&finite(c.h)&&c.w>0&&c.h>0);counts.image++;}}
  objects.push(descriptor);
 }
 ensure(used.size===byContent.size,'BOARDNOTES_UNSUPPORTED');objects.sort((a,b)=>(a.record.level??0)-(b.record.level??0)||(a.id<b.id?-1:a.id>b.id?1:0));
 if(shapeCount)notes.push(`${shapeCount}个原图的非默认形状裁切尚未复现，保留完整原图及原形状数据。 / ${shapeCount} source image shape masks are retained as metadata; the full original image is displayed.`);
 if(layerCount)notes.push(`${layerCount}个特殊前后置层保留原属性，当前按普通对象层序显示。 / ${layerCount} special stacking rules are retained as metadata and displayed in normal object order.`);
 if(textCount)notes.push(`${textCount}个文本保留全文、字号、颜色、基础强调及原始格式；字体度量、行距和内边距可能不同。 / ${textCount} texts retain content, size, color, emphasis and source formatting; font metrics, spacing and insets may differ.`);
 const outlines=collection(meta.pdfOutLine);for(const o of outlines){scalar(o,new Set((common+' pdfRelId title stretchState level page').split(' ')));ensure([0,1].includes(o.isDel));if(o.isDel===1)continue;ensure(o.boardID===boardID);id(o.recordName);ensure(byContent.get(String(o.pdfRelId).toLowerCase())?.type===4);str(o.title);ensure(Number.isInteger(o.page)&&o.page>=0);}
 if(outlines.some(o=>o.isDel===0))notes.push('原PDF目录标记保存在原始元数据文件中，PDF原生目录照常读取；BoardNotes自定义目录尚未合并到阅读器。 / Source custom PDF outline marks are retained in the original metadata file; native PDF outlines remain available.');
 if(meta.pdfPage!=null){const v=meta.pdfPage;scalar(v,new Set((common+' pdfRelId page').split(' ')));ensure([0,1].includes(v.isDel));if(v.isDel===0){ensure(v.boardID===boardID&&byContent.get(String(v.pdfRelId).toLowerCase())?.type===4);ensure(Number.isInteger(v.page)&&v.page>=0);}}
 const sourceMetadata={boardRecord:structuredClone(records),boardContent:structuredClone(contents),pdfOutLine:structuredClone(outlines),pdfPage:meta.pdfPage?structuredClone(meta.pdfPage):null};
 // Union covers both center and top-left interpretations until the caller selects a verified anchor.
 const minX=objects.length?Math.min(...objects.map(o=>o.record.x-o.record.w/2)):0,minY=objects.length?Math.min(...objects.map(o=>o.record.y-o.record.h/2)):0,maxX=objects.length?Math.max(...objects.map(o=>o.record.x+o.record.w)):0,maxY=objects.length?Math.max(...objects.map(o=>o.record.y+o.record.h)):0;
 return{objects,resourceNames:[...resources],notes,counts,sourceMetadata,bounds:objects.length?{x:minX,y:minY,width:maxX-minX,height:maxY-minY}:null};
}
function mapObjects(plan,{translation,sourcePrefix='',assets,placementAnchor}={}){
 ensure(object(plan)&&Array.isArray(plan.objects)&&Array.isArray(translation)&&translation.length===2&&translation.every(finite)&&assets instanceof Map);relative(sourcePrefix,true);ensure(['center','topLeft'].includes(placementAnchor),'BOARDNOTES_UNSUPPORTED');
 const notes=[...plan.notes],items=plan.objects.map(o=>{const r=o.record,c=o.content,center=placementAnchor==='center',x=r.x-(center?r.w/2:0)+translation[0],y=r.y-(center?r.h/2:0)+translation[1];ensure(x>=0&&y>=0&&x+r.w<=WORLD&&y+r.h<=WORLD,'TOO_LARGE');ensure(Buffer.byteLength(JSON.stringify({record:r,content:c}),'utf8')<=512*1024,'TOO_LARGE');const item={id:o.id,kind:o.kind==='text'?'text':'document',title:o.kind==='pdf'?(r.title||'PDF'):'',x,y,width:r.w,height:r.h,boardNotesObject:{version:1,record:r,content:c,placementAnchor}};
  if(o.kind==='text'){item.text=c.text;item.textFormat='richText';item.richTextHTML=richText(c,o.runs);item.style={fillColor:color(r.bgColor,'#ffffff'),strokeColor:color(r.borderColor,'#ffffff'),textColor:color(c.textColor),fontSize:Math.max(8,Math.min(72,c.fontSize||16)),shape:'rectangle',strokeWidth:1};}
  else{const a=assets.get(o.resource);ensure(object(a)&&typeof a.filename==='string');relative(a.filename);if(o.kind==='image')ensure(/\.(png|jpe?g)$/i.test(a.filename),'BOARDNOTES_UNSUPPORTED');else ensure(/\.pdf$/i.test(a.filename));item.sourcePath=[sourcePrefix,a.filename].filter(Boolean).join('/');if(o.kind==='pdf')item.page=(r.page||0)+1;item.style={fillColor:'#ffffff',strokeColor:'#ffffff',textColor:'#000000',shape:'rectangle',strokeWidth:1};}
  return item;
 });return{items,notes,sourceMetadata:plan.sourceMetadata};
}
module.exports={planObjects,mapObjects,richText,textRuns,MAX_OBJECTS};

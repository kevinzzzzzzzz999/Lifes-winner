export type Delimiter = ',' | '\t' | ';' | '|';
export type CSVPreview = {
 rows: {index:number;cells:string[]}[];
 firstRow:string[];
 rowCount:number;
 columnCount:number;
 inconsistentRows:number;
 malformed:boolean;
 truncatedCells:boolean;
};
type ParseOptions={startRow?:number;maxRows?:number;maxColumns?:number;maxCellChars?:number;scanRows?:number};
/** Read-only RFC 4180-style scan. Storage is bounded independently of row count. */
export function parseDelimited(text:string,delimiter:Delimiter,options:ParseOptions={}):CSVPreview {
 const start=Math.max(0,Math.trunc(options.startRow||0)),limit=Math.min(1000,Math.max(0,options.maxRows??100)),maxCols=Math.min(200,Math.max(1,options.maxColumns??100)),maxChars=Math.min(20000,Math.max(1,options.maxCellChars??2000));
 const result:CSVPreview={rows:[],firstRow:[],rowCount:0,columnCount:0,inconsistentRows:0,malformed:false,truncatedCells:false};
 let row:string[]=[],field='',column=0,quoted=false,closed=false,fieldStart=true,rowStarted=false,firstColumns=0;
 const retain=()=>result.rowCount===0||(result.rowCount>=start&&result.rowCount<start+limit);
 const append=(value:string)=>{if(retain()&&column<maxCols){if(field.length<maxChars)field+=value.slice(0,maxChars-field.length);else result.truncatedCells=true;}};
 const endField=()=>{if(retain()&&column<maxCols)row.push(field);column++;field='';fieldStart=true;closed=false;};
 const endRow=()=>{endField();if(result.rowCount===0){result.firstRow=row;firstColumns=column;}else if(column!==firstColumns)result.inconsistentRows++;if(result.rowCount>=start&&result.rowCount<start+limit)result.rows.push({index:result.rowCount,cells:row});result.rowCount++;result.columnCount=Math.max(result.columnCount,column);column=0;row=[];rowStarted=false;};
 for(let i=text.charCodeAt(0)===0xfeff?1:0;i<text.length;i++){
  const c=text[i];rowStarted=true;
  if(quoted){if(c==='"'){if(text[i+1]==='"'){append('"');i++;}else{quoted=false;closed=true;}}else append(c);continue;}
  if(c===delimiter){endField();continue;}
  if(c==='\n'||c==='\r'){endRow();if(c==='\r'&&text[i+1]==='\n')i++;if(options.scanRows&&result.rowCount>=options.scanRows)return result;continue;}
  if(c==='"'&&fieldStart){quoted=true;fieldStart=false;continue;}
  if(closed||c==='"')result.malformed=true;
  fieldStart=false;append(c);
 }
 if(quoted)result.malformed=true;
 if(rowStarted||column>0)endRow();
 return result;
}
export function detectDelimiter(text:string):Delimiter {
 const candidates:Delimiter[]=[',','\t',';','|'];let best:Delimiter=',',score=0;
 for(const delimiter of candidates){const sample=parseDelimited(text.slice(0,262144),delimiter,{maxRows:32,scanRows:32,maxCellChars:1});const widths=sample.rows.map(row=>row.cells.length);const frequencies=new Map<number,number>();for(const width of widths)if(width>1)frequencies.set(width,(frequencies.get(width)||0)+1);for(const [width,count]of frequencies){const candidate=count/Math.max(1,widths.length)*100+Math.min(10,width)-Number(sample.malformed)*2;if(candidate>score){score=candidate;best=delimiter;}}}
 return best;
}

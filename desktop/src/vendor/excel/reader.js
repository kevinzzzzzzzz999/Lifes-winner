/* Structured cell reading only. No formula execution, source HTML, or network. */
function inkReadExcel(base64, extension) {
  const fail = code => { throw new Error('INKSPACE_EXCEL_' + code); };
  const workbook = XLSX.read(base64, {type:'base64', dense:false, cellStyles:true, cellText:true, cellFormula:true, bookFiles:true, bookVBA:false});
  if (!Array.isArray(workbook.SheetNames) || !workbook.SheetNames.length || workbook.SheetNames.length > 128) fail('CAPACITY');
  // Floating content is disclosed as omitted. Cell values remain readable; no
  // chart, drawing, macro or external link is executed or treated as cell data.
  let omittedVisuals = !!(workbook.files && Object.keys(workbook.files).some(k => /^xl\/(drawings|charts|media)\//i.test(k)));
  if (extension === 'xls') {
    const cfb = workbook.cfb;
    if (!cfb || !Array.isArray(cfb.FileIndex)) fail('STRUCTURE');
    const stream = cfb.FileIndex.find(x => /^(Workbook|Book)$/i.test(x.name || ''));
    if (!stream || !stream.content) fail('STRUCTURE');
    const a = stream.content;
    // LibreOffice writes an empty patriarch group even when a sheet has no
    // drawings. Accept only this exact, bounded OfficeArtDgContainer structure;
    // any actual shape, option, image or drawing triggers the visible omission warning.
    // MS-ODRAW: OfficeArtFDG csp counts the group itself as one shape.
    const emptyDrawing = (p,n) => {
      if(n!==80) return false;
      const u16=o=>a[p+o]|(a[p+o+1]<<8), u32=o=>(u16(o)|(u16(o+2)<<16))>>>0;
      const header=(o,type,length,version)=>u16(o+2)===type&&u32(o+4)===length&&(u16(o)&15)===version;
      return header(0,0xf002,72,15)&&header(8,0xf008,8,0)&&u32(16)===1&&
        header(24,0xf003,48,15)&&header(32,0xf004,40,15)&&header(40,0xf009,16,1)&&
        [48,52,56,60].every(o=>u32(o)===0)&&header(64,0xf00a,8,2)&&u32(72)===u32(20)&&u32(76)===5;
    };
    for (let pos=0; pos+4<=a.length;) {
      const id=a[pos]|(a[pos+1]<<8), size=a[pos+2]|(a[pos+3]<<8);
      if (pos+4+size>a.length) fail('STRUCTURE');
      if ([0x005d,0x007f].includes(id) || (id===0x00ec && !emptyDrawing(pos+4,size))) omittedVisuals = true;
      if ([0x0809,0x0409,0x0209,0x0009].includes(id) && size>=4 && (a[pos+6]|(a[pos+7]<<8))===0x0020) omittedVisuals = true;
      pos += 4+size;
    }
  }
  const metadata = workbook.Workbook && workbook.Workbook.Sheets;
  if (!Array.isArray(metadata) || metadata.length !== workbook.SheetNames.length) fail('STRUCTURE');
  let totalCells=0, totalCharacters=0, totalSpan=0, formulas=0, missingFormulaResults=0, merges=0, skippedSheets=0;
  const sheets=[];
  for(let index=0;index<workbook.SheetNames.length;index++) {
    if(metadata[index].Hidden) { skippedSheets++; continue; }
    const name=workbook.SheetNames[index], sheet=workbook.Sheets[name];
    if(!sheet) fail('STRUCTURE');
    if(sheet['!type']==='chart') { omittedVisuals = true; skippedSheets++; continue; }
    const keys=Object.keys(sheet); if(keys.length>250000) fail('CAPACITY');
    const rows=sheet['!rows'] || [], cols=sheet['!cols'] || [];
    const cells=[]; let minRow=Infinity,lastRow=-1,minCol=Infinity,lastCol=-1;
    for(const key of keys) {
      if(!/^[A-Z]+[1-9][0-9]*$/.test(key)) continue;
      const address=XLSX.utils.decode_cell(key), cell=sheet[key];
      if(!cell || rows[address.r]?.hidden || cols[address.c]?.hidden) continue;
      const missingResult=!!cell.f && (cell.v===undefined || cell.v===null || cell.t==='z');
      if(cell.f) formulas++;
      if(missingResult) missingFormulaResults++;
      if(!missingResult && (cell.v===undefined || cell.v===null || cell.t==='z')) continue;
      const text=missingResult ? '[=] '+String(cell.f) : String(cell.w!==undefined ? cell.w : XLSX.utils.format_cell(cell));
      if(!text.length) continue;
      if(text.length>20000) fail('CELL_TOO_TALL');
      totalCells++; totalCharacters+=text.length;
      if(totalCells>100000 || totalCharacters>4000000) fail('CAPACITY');
      cells.push({row:address.r,column:address.c,text});
      minRow=Math.min(minRow,address.r);lastRow=Math.max(lastRow,address.r);minCol=Math.min(minCol,address.c);lastCol=Math.max(lastCol,address.c);
    }
    if(lastRow<0) {minRow=lastRow=minCol=lastCol=0;}
    if(lastRow>1048575 || lastCol>16383 || lastRow-minRow>100000 || lastCol-minCol>511) fail('CAPACITY');
    totalSpan+=(lastRow-minRow+1)*(lastCol-minCol+1);if(totalSpan>500000) fail('CAPACITY');
    const hiddenRows=[],hiddenColumns=[];
    for(let r=minRow;r<=lastRow;r++) if(rows[r]?.hidden) hiddenRows.push(r);
    for(let c=minCol;c<=lastCol;c++) if(cols[c]?.hidden) hiddenColumns.push(c);
    merges+=(sheet['!merges'] || []).length;
    cells.sort((a,b)=>a.row-b.row || a.column-b.column);
    sheets.push({name,minRow,lastRow,minCol,lastCol,cells,hiddenRows,hiddenColumns});
  }
  if(!sheets.length) fail('NO_VISIBLE_SHEETS');
  return JSON.stringify({sheets,totalCells,formulas,missingFormulaResults,merges,skippedSheets,omittedVisuals});
};

if(typeof window!=='undefined') window.inkReadExcel=inkReadExcel;
if(typeof module!=='undefined') module.exports=inkReadExcel;

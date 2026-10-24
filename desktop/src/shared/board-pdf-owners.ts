const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A merged board owns the editable copies of all its source PDF ink. */
export function boardPDFOwnerIDs(board:{id?:unknown;pdfMergedOwnerIDs?:unknown}):string[]{
 const ids=[board.id,...(Array.isArray(board.pdfMergedOwnerIDs)?board.pdfMergedOwnerIDs:[])];
 return [...new Set(ids.filter((id):id is string=>typeof id==='string'&&UUID.test(id)).map(id=>id.toLowerCase()))].sort();
}

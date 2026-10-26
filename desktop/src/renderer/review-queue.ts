import type {ReviewRecord} from '../shared/desktop-api';
export type ReviewQueueKind='all'|'comment'|'highlight';
export type ReviewQueueLocation='all'|'board'|'document';
export type ReviewQueueSort='oldest'|'newest';
export const reviewQueueSource=(review:ReviewRecord)=>review.anchor?.originalSourcePath||review.anchor?.sourcePath||review.boardPath;
export const reviewQueueIsDocument=(review:ReviewRecord)=>!!(review.anchor?.originalSourcePath||review.anchor?.sourcePath);
export function filterReviewQueue(reviews:ReviewRecord[],query:string,kind:ReviewQueueKind,location:ReviewQueueLocation,source:string,sort:ReviewQueueSort):ReviewRecord[]{
 const terms=query.normalize('NFC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
 const selected=reviews.filter(review=>{
  if(kind!=='all'&&(review.style||'comment')!==kind)return false;
  if(location==='board'&&reviewQueueIsDocument(review)||location==='document'&&!reviewQueueIsDocument(review))return false;
  if(source&&reviewQueueSource(review)!==source)return false;
  if(!terms.length)return true;
  const text=[review.comment,review.boardPath,review.anchor?.sourcePath,review.anchor?.originalSourcePath,review.anchor?.page].filter(value=>value!==undefined).join('\n').normalize('NFC').toLocaleLowerCase();
  return terms.every(term=>text.includes(term));
 });
 return selected.sort((a,b)=>{const date=Date.parse(a.createdAt)-Date.parse(b.createdAt),byDate=sort==='newest'?-date:date;return byDate||a.id.localeCompare(b.id);});
}

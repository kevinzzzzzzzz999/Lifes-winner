import type {NotebookEvent} from '../shared/desktop-api';
import {parseNotebook,serializeNotebook,notebookCellSource,notebookMultilineText,type NotebookOutput} from '../shared/notebook-format';

/** Apply only outputs for the exact cell sources submitted to this run. */
export function applyNotebookEvents(current:string,submitted:string,events:NotebookEvent[],deferredClear:Set<number>):string{
 const doc=parseNotebook(current),source=parseNotebook(submitted);
 if(doc.cells.length!==source.cells.length||doc.cells.some((cell,i)=>cell.cell_type!==source.cells[i].cell_type||notebookCellSource(cell)!==notebookCellSource(source.cells[i])))throw Error('Notebook source changed while running; current edits were preserved.');
 const next={...doc,cells:doc.cells.map(c=>({...c,outputs:c.outputs?[...c.outputs]:undefined}))};
 // Preserve absent output keys on non-code cells rather than adding undefined JSON values.
 for(const cell of next.cells)if(cell.outputs===undefined)delete cell.outputs;
 for(const event of events){
  const index=event.cellIndex;if(index===undefined||!Number.isInteger(index)||index<0||index>=next.cells.length)continue;
  const cell=next.cells[index];if(cell.cell_type!=='code')continue;
  if(event.kind==='cell-start'){cell.outputs=[];cell.execution_count=event.executionCount??null;deferredClear.delete(index);}
  else if(event.kind==='clear-output'){if(event.wait)deferredClear.add(index);else{cell.outputs=[];deferredClear.delete(index);}}
  else if(event.kind==='output'&&event.output){
   if(deferredClear.delete(index))cell.outputs=[];
   const outputs=cell.outputs||[],output=event.output as NotebookOutput,last=outputs.at(-1);
   if(output.output_type==='stream'&&last?.output_type==='stream'&&output.name===last.name)outputs[outputs.length-1]={...last,text:notebookMultilineText(last.text)+notebookMultilineText(output.text)};
   else outputs.push(output);
   cell.outputs=outputs;
  }else if(event.kind==='cell-end'&&event.executionCount!==undefined)cell.execution_count=event.executionCount;
 }
 return serializeNotebook(next);
}

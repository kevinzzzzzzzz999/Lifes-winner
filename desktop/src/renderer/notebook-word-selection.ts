import type {EditorView} from '@codemirror/view';

/** Keep word selection owned by this editor, including native Mac dblclicks. */
export function selectNotebookWord(view:Pick<EditorView,'state'|'posAtCoords'|'dispatch'|'focus'|'composing'>,event:Pick<MouseEvent,'button'|'clientX'|'clientY'|'shiftKey'|'altKey'|'metaKey'|'ctrlKey'>):boolean {
 if(event.button!==0||event.shiftKey||event.altKey||event.metaKey||event.ctrlKey||view.composing)return false;
 const position=view.posAtCoords({x:event.clientX,y:event.clientY});
 if(position===null)return false;
 const word=view.state.wordAt(position);
 if(!word)return false;
 view.dispatch({selection:{anchor:word.from,head:word.to},userEvent:'select.pointer'});
 view.focus();return true;
}

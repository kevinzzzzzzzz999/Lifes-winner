const {test}=require('node:test');const assert=require('node:assert/strict');
const {EditorState}=require('@codemirror/state');
const {history,undo}=require('@codemirror/commands');
const {selectNotebookWord}=require('../src/renderer/notebook-word-selection.ts');
const event={button:0,clientX:100,clientY:200,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false};
function editor(source,position){let state=EditorState.create({doc:source,extensions:[history()]});const result={changes:0,focused:0};return{result,get state(){return state},composing:false,posAtCoords:()=>position,dispatch:transaction=>{const update=state.update(transaction);result.changes+=Number(update.docChanged);state=update.state},focus:()=>result.focused++};}
test('editing double click selects the complete Python identifier without changing source',()=>{
 for(const [source,word]of [['df_example_grouped.head()','df_example_grouped'],['pd.read_csv("file.csv")','read_csv'],['中文变量 = 42','中文变量'],['# 😀\nalpha_beta = 42','alpha_beta']]){
  const view=editor(source,source.indexOf(word)+2);assert.equal(selectNotebookWord(view,event),true);const range=view.state.selection.main;assert.equal(view.state.sliceDoc(range.from,range.to),word);assert.equal(view.state.doc.toString(),source);assert.equal(view.result.changes,0);assert.equal(view.result.focused,1);
 }
});
test('selection can be replaced and undone while preserving existing code',()=>{
 const source='first_value + second_value',view=editor(source,4);selectNotebookWord(view,event);view.dispatch(view.state.replaceSelection('new_value'));assert.equal(view.state.doc.toString(),'new_value + second_value');assert.equal(undo(view),true);assert.equal(view.state.doc.toString(),source);
});
test('modified clicks, non-left clicks, composition and points outside code keep the existing selection',()=>{
 for(const patch of [{button:2},{shiftKey:true},{altKey:true},{ctrlKey:true},{metaKey:true}]){const view=editor('alpha_beta',3);assert.equal(selectNotebookWord(view,{...event,...patch}),false);assert.equal(view.result.focused,0);assert.equal(view.state.selection.main.empty,true);}
 const composing=editor('alpha_beta',3);composing.composing=true;assert.equal(selectNotebookWord(composing,event),false);
 const outside=editor('alpha_beta',null);assert.equal(selectNotebookWord(outside,event),false);
 const whitespace=editor('alpha   beta',7);assert.equal(selectNotebookWord(whitespace,event),false);
});

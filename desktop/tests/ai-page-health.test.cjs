'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {pageHealthScript}=require('../src/main/ai-page-health.cjs');

// A small structural DOM implements only the read APIs used by the probe.
// Private page/body/message getters throw, so accidentally broad text/HTML
// access fails these tests instead of quietly returning synthetic content.
class Node{
 constructor(tag,attributes={},children=[]){this.tagName=tag.toUpperCase();this.attributes={...attributes};this.children=children;this.parentElement=null;this.isConnected=true;this.hidden=false;this.disabled=false;this.style={display:'block',visibility:'visible',opacity:'1'};this.rect={width:400,height:80};for(const child of children)child.parentElement=this;}
 getAttribute(name){return this.attributes[name]??null;}
 closest(selector){assert.equal(selector,'article');for(let node=this;node;node=node.parentElement)if(node.tagName==='ARTICLE')return node;return null;}
 getClientRects(){return this.rect?[this.rect]:[];}
 get textContent(){throw Error('PRIVATE message/body text must not be read');}
 get innerText(){throw Error('PRIVATE text must not be read');}
 get innerHTML(){throw Error('PRIVATE HTML must not be read');}
 get outerHTML(){throw Error('PRIVATE HTML must not be read');}
}
const node=(tag,attributes={},children=[])=>new Node(tag,attributes,children);
function heading(label,tag='h4',classes='sr-only'){const result=node(tag,{class:classes});Object.defineProperty(result,'textContent',{get:()=>label});return result;}
function article(children=[]){return node('article',{},[...children,node('div',{'data-private':'message body'})]);}
function role(author){return node('div',{'data-message-author-role':author});}
function run(children=[],options={}){
 const body=node('body',{},children),all=[];const visit=n=>{all.push(n);n.children.forEach(visit);};visit(body);
 const document={readyState:options.readyState??'complete',visibilityState:options.visibilityState??'visible',body,querySelectorAll(selector){
  if(selector==='[data-message-author-role="assistant"], [data-message-author-role="user"]')return all.filter(n=>['assistant','user'].includes(n.getAttribute('data-message-author-role')));
  if(selector==='h4.sr-only')return all.filter(n=>n.tagName==='H4'&&(n.getAttribute('class')||'').split(/\s+/).includes('sr-only'));
  if(selector==='button[aria-label]')return all.filter(n=>n.tagName==='BUTTON'&&n.getAttribute('aria-label')!==null);
  throw Error('Unexpected DOM selector: '+selector);
 }};
 for(const key of ['textContent','innerText','innerHTML','outerHTML','URL','location','cookie'])Object.defineProperty(document,key,{get(){throw Error('PRIVATE document field must not be read: '+key);}});
 const result=vm.runInNewContext(pageHealthScript(),{document,getComputedStyle:n=>n.style},{timeout:1000});
 return JSON.parse(JSON.stringify(result));
}
const expected={readyState:'complete',visibilityState:'visible',bodyChildren:0,assistantNodes:0,visibleAssistantNodes:0,userNodes:0,generating:false};

test('the real probe reads legacy role structure and de-duplicates nested nodes by article',()=>{
 const a=article([role('assistant'),role('assistant')]),u=article([role('user')]);
 assert.deepEqual(run([u,a]),{...expected,bodyChildren:2,assistantNodes:1,visibleAssistantNodes:1,userNodes:1});
});

test('exact static English author headings recover modern ChatGPT articles without reading message text',()=>{
 const a=article([heading('ChatGPT said:'),heading('ChatGPT said:')]),u=article([heading('You said:')]);
 assert.deepEqual(run([u,a]),{...expected,bodyChildren:2,assistantNodes:1,visibleAssistantNodes:1,userNodes:1});
});

test('exact Chinese public labels are accepted and decorative or partial headings are ignored',()=>{
 const a=article([heading('ChatGPT 说：')]),u=article([heading('你说：')]);
 const unrelated=article([heading('ChatGPT said: PRIVATE reply'),heading('ChatGPT said:','h3'),heading('ChatGPT said:','h4','normal')]);
 assert.deepEqual(run([a,u,unrelated,heading('ChatGPT said:')]),{...expected,bodyChildren:4,assistantNodes:1,visibleAssistantNodes:1,userNodes:1});
});

test('role evidence wins within an article while fallback can count other modern articles',()=>{
 const a=article([role('assistant'),heading('You said:')]),modern=article([heading('ChatGPT said:')]);
 assert.deepEqual(run([a,modern]),{...expected,bodyChildren:2,assistantNodes:2,visibleAssistantNodes:2});
});

test('ambiguous heading-only articles are rejected instead of counting the same turn as both authors',()=>{
 assert.deepEqual(run([article([heading('You said:'),heading('ChatGPT said:')])]),{...expected,bodyChildren:1});
});

test('visibility counts use the article rather than its intentionally hidden screen-reader heading',()=>{
 const h=heading('ChatGPT said:');h.style.opacity='0';h.rect={width:0,height:0};const a=article([h]);
 const hidden=article([heading('ChatGPT said:')]);hidden.style.display='none';
 const zeroRole=role('assistant');zeroRole.rect={width:0,height:80};const zero=article([zeroRole]);
 const ancestor=node('section',{},[article([role('assistant')])]);ancestor.style.visibility='hidden';
 assert.deepEqual(run([a,hidden,zero,ancestor]),{...expected,bodyChildren:4,assistantNodes:4,visibleAssistantNodes:1});
});

test('a visible article container cannot conceal a hidden legacy assistant body from the counts',()=>{
 const body=role('assistant');body.style.display='none';
 assert.deepEqual(run([article([body])]),{...expected,bodyChildren:1,assistantNodes:1,visibleAssistantNodes:0});
});

test('generation detection is a read-only exact visible stop-button label check',()=>{
 const button=node('button',{'aria-label':'Stop generating'});button.click=()=>{throw Error('Probe must never click');};
 assert.equal(run([button]).generating,true);
 for(const label of ['Stop','Stop generating response','Stop streaming','停止生成','停止生成回复'])assert.equal(run([node('button',{'aria-label':label})]).generating,true);
 for(const state of ['disabled','aria-disabled','hidden','partial']){const b=node('button',{'aria-label':state==='partial'?'Stop generating PRIVATE':'Stop generating'});if(state==='disabled')b.disabled=true;if(state==='aria-disabled')b.attributes['aria-disabled']='true';if(state==='hidden')b.style.display='none';assert.equal(run([b]).generating,false);}
});

test('returned health contains only the fixed sanitized counts, enums and boolean',()=>{
 const result=run([],{readyState:'PRIVATE_CONTENT',visibilityState:'PRIVATE_CONTENT'});
 assert.deepEqual(result,{...expected,readyState:'loading',visibilityState:'hidden'});
 assert.deepEqual(Object.keys(result),['readyState','visibilityState','bodyChildren','assistantNodes','visibleAssistantNodes','userNodes','generating']);
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

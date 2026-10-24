'use strict';

// A structural probe only: no URLs, conversation strings, HTML, screenshots,
// focus changes or page mutation. Its only text read is the website's narrowly
// selected, static screen-reader author heading, compared with exact labels.
function pageHealthScript(){
 return `(()=>{
  const limit=10000;
  const assistants=new Set(),users=new Set(),roleArticles=new Set(),assistantTargets=new Map();
  const addAssistant=(key,target)=>{assistants.add(key);if(!assistantTargets.has(key))assistantTargets.set(key,new Set());assistantTargets.get(key).add(target);};
  const visible=node=>{
   try{
    if(!node||node.isConnected===false||!Array.from(node.getClientRects()).some(rect=>rect.width>0&&rect.height>0))return false;
    for(let element=node;element;element=element.parentElement){
     const style=getComputedStyle(element);
     if(element.hidden||element.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
    }
    return true;
   }catch{return false;}
  };
  for(const node of Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="user"]')).slice(0,limit)){
   const role=node.getAttribute('data-message-author-role');
   const article=node.closest('article'),key=article||node;
   if(article)roleArticles.add(article);
   if(role==='assistant')addAssistant(key,node);else if(role==='user')users.add(key);
  }
  const assistantLabels=new Set(['ChatGPT said:','ChatGPT 说：','ChatGPT 说:','ChatGPT说：','ChatGPT说:']);
  const userLabels=new Set(['You said:','你说：','你说:','您说：','您说:']);
  const fallback=new Map();
  for(const heading of Array.from(document.querySelectorAll('h4.sr-only')).slice(0,limit)){
   const article=heading.closest('article');
   if(!article||roleArticles.has(article))continue;
   const label=(heading.textContent||'').trim().replace(/\\s+/g,' ');
   const role=assistantLabels.has(label)?'assistant':userLabels.has(label)?'user':null;
   if(!role)continue;
   if(!fallback.has(article))fallback.set(article,role);else if(fallback.get(article)!==role)fallback.set(article,null);
  }
  for(const [article,role]of fallback){if(role==='assistant')addAssistant(article,article);else if(role==='user')users.add(article);}
  let visibleAssistantNodes=0;for(const key of assistants)if(Array.from(assistantTargets.get(key)).some(visible))visibleAssistantNodes++;
  const stopLabels=new Set(['Stop generating','Stop generating response','Stop streaming','Stop','停止生成','停止生成回复','停止']);
  let generating=false;
  for(const button of Array.from(document.querySelectorAll('button[aria-label]')).slice(0,limit)){
   if(stopLabels.has(button.getAttribute('aria-label'))&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&visible(button)){generating=true;break;}
  }
  return {
   readyState:['loading','interactive','complete'].includes(document.readyState)?document.readyState:'loading',
   visibilityState:document.visibilityState==='visible'?'visible':'hidden',
   bodyChildren:Math.min(limit,document.body?.children.length||0),
   assistantNodes:assistants.size,visibleAssistantNodes,userNodes:users.size,generating
  };
 })()`;
}

module.exports={pageHealthScript};

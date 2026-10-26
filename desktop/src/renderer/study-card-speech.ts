import type {StudyCard} from '../shared/study';
import {clozeParts} from './study-outline';
export function studySpeechText(card:StudyCard,side:'question'|'answer',revealed:boolean,answer:string){
 if(side==='answer'&&!revealed)return '';
 const body=side==='question'?(card.mode==='cloze'?clozeParts(card.question).filter(p=>revealed||!p.hidden).map(p=>p.text).join(' '):card.question):answer;
 const blocks=side==='question'?card.questionBlocks:card.answerBlocks;
 return [body,...(blocks||[]).filter(b=>b.kind==='text').map(b=>b.text||'')].filter(s=>s.trim()).join('\n');
}
export type CardSpeechState='idle'|'preparing'|'playing'|'paused';
export class OwnedCardSpeech{
 private epoch=0;private owned=false;private current:SpeechSynthesisUtterance|null=null;private timer:ReturnType<typeof setTimeout>|undefined;private state:CardSpeechState='idle';
 constructor(private synth:SpeechSynthesis|undefined,private create:(text:string)=>SpeechSynthesisUtterance,private notify:(state:CardSpeechState,error:string)=>void){}
 private update(state:CardSpeechState,error=''){this.state=state;this.notify(state,error);}
 stop(){this.epoch++;clearTimeout(this.timer);const own=this.owned;this.owned=false;this.current=null;if(own)this.synth?.cancel();this.update('idle');}
 pause(){if(this.owned&&this.state==='playing'){this.synth?.pause();this.update('paused');}}
 resume(){if(this.owned&&this.state==='paused'){this.synth?.resume();this.update('playing');}}
 async start(text:string,language:'auto'|'zh-CN'|'en-US',rate:number){
  this.stop();const epoch=this.epoch;
  try{
   const synth=this.synth;if(!synth)throw Error('unavailable');if(synth.speaking||synth.pending)throw Error('busy');if(!text.trim())throw Error('empty');if(text.length>100000)throw Error('too-long');
   this.update('preparing');let voices=synth.getVoices().filter(v=>v.localService);
   if(!voices.length){await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);synth.removeEventListener('voiceschanged',done);resolve();},timer=setTimeout(done,1800);synth.addEventListener('voiceschanged',done);});voices=synth.getVoices().filter(v=>v.localService);}
   if(epoch!==this.epoch)return;if(synth.speaking||synth.pending)throw Error('busy');
   const chunks=Array.from(text.matchAll(/[\s\S]{1,220}/g)).map(m=>({text:m[0],lang:language==='auto'?(/[\p{Script=Han}]/u.test(m[0])?'zh-CN':'en-US'):language}));
   const voice=(lang:string)=>voices.find(v=>v.lang.replace('_','-').toLowerCase()===lang.toLowerCase())||voices.find(v=>v.lang.toLowerCase().startsWith(lang.slice(0,2).toLowerCase()));
   if(chunks.some(c=>!voice(c.lang)))throw Error('voice-unavailable');let index=0;this.owned=true;
   const next=()=>{if(epoch!==this.epoch||!this.owned)return;if(index===chunks.length){this.owned=false;this.current=null;this.update('idle');return;}const chunk=chunks[index++],u=this.create(chunk.text);this.current=u;u.voice=voice(chunk.lang)!;u.lang=chunk.lang;u.rate=rate;
    this.timer=setTimeout(()=>{if(epoch===this.epoch&&this.owned){this.stop();this.update('idle','startup-timeout');}},10000);
    u.onstart=()=>{if(epoch===this.epoch&&this.owned){clearTimeout(this.timer);this.update('playing');}};
    u.onend=()=>{if(epoch===this.epoch){clearTimeout(this.timer);next();}};
    u.onerror=()=>{if(epoch===this.epoch){clearTimeout(this.timer);this.owned=false;this.current=null;this.epoch++;this.update('idle','interrupted');}};
    synth.speak(u);
   };next();
  }catch(e){if(epoch!==this.epoch)return;this.stop();this.update('idle',e instanceof Error?e.message:'unavailable');}
 }
}

'use strict';
// Real loopback HTTP bytes/files, with a DownloadItem-shaped engine stand-in.
// Does not launch Electron or use a real browser profile/download directory.
const http=require('node:http'),fs=require('node:fs');
const {EventEmitter}=require('node:events');
async function fixtureServer({interval=8}={}){const body=Buffer.alloc(256*1024);for(let i=0;i<body.length;i++)body[i]=i%251;const server=http.createServer((req,res)=>{const start=Number((req.headers.range||'').match(/bytes=(\d+)-/)?.[1]||0),unknown=req.url.includes('unknown');res.writeHead(start?206:200,{'Content-Type':'application/octet-stream','Accept-Ranges':'bytes',...(!unknown?{'Content-Length':body.length-start}:{}),...(start?{'Content-Range':`bytes ${start}-${body.length-1}/${body.length}`}:{})});let offset=start;const timer=setInterval(()=>{if(offset>=body.length){clearInterval(timer);res.end();return;}res.write(body.subarray(offset,offset+4096));offset+=4096;},interval);res.once('close',()=>clearInterval(timer));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{body,url:`http://127.0.0.1:${server.address().port}/download?private-token=not-persisted`,close:()=>new Promise(resolve=>server.close(resolve))};}
class DownloadItemFixture extends EventEmitter{
 constructor({url='',file='',resumable=true,total=262144}={}){super();Object.assign(this,{url,file,resumable,total,received:0,paused:false,state:'progressing',terminal:false,generation:0,saveOptions:null});}
 getFilename(){return '../../fixture.bin';}getURL(){return this.url;}getSavePath(){return this.file;}getTotalBytes(){return this.total;}getReceivedBytes(){return this.received;}isPaused(){return this.paused;}canResume(){return this.resumable&&!this.terminal;}setSaveDialogOptions(value){this.saveOptions=value;}
 async start(){this.transfer();}
 transfer(){const generation=++this.generation;this.request=http.get(this.url,{headers:this.received?{Range:`bytes=${this.received}-`}:{}},res=>{if(generation!==this.generation){res.destroy();return;}this.state='progressing';res.on('data',chunk=>{if(generation!==this.generation||this.paused||this.terminal)return;fs.appendFileSync(this.file,chunk);this.received+=chunk.length;this.emit('updated',{},'progressing');});res.on('end',()=>{if(generation===this.generation&&!this.terminal&&!this.paused)this.finish('completed');});res.on('error',()=>this.interrupt(generation));});this.request.on('error',()=>this.interrupt(generation));}
 interrupt(generation=this.generation){if(generation!==this.generation||this.paused||this.terminal)return;this.state='interrupted';this.emit('updated',{},'interrupted');}
 pause(){if(!this.canResume())throw Error('not resumable');this.paused=true;this.generation++;this.request?.destroy();this.emit('updated',{},'progressing');}
 resume(){if(!this.canResume())throw Error('not resumable');this.paused=false;this.state='progressing';this.transfer();}
 cancel(){if(this.terminal)return;this.generation++;this.request?.destroy();this.finish('cancelled');}
 finish(state){if(this.terminal)return;this.terminal=true;this.state=state;this.emit('done',{},state);}
}
async function until(fn,timeout=4000){const end=Date.now()+timeout;while(!fn()){if(Date.now()>end)throw Error('fixture timeout');await new Promise(resolve=>setTimeout(resolve,10));}}
module.exports={fixtureServer,DownloadItemFixture,until};

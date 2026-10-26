'use strict';
// Ephemeral per-tab load state; no bodies, credentials, or persistence. URLs below
// are only the same in-memory navigation targets already held by WebContents.
const{webURL}=require('./browser-security.cjs');
const requestMethod=value=>value==='GET'?'GET':value==='POST'?'POST':'OTHER';
const host=value=>{try{return new URL(value).hostname;}catch{return null;}};
const errorName=value=>typeof value==='string'&&/^ERR_[A-Z0-9_]{1,80}$/.test(value)?value:'NETWORK_ERROR';
class BrowserPageLoadState{
 constructor(){this.epoch=0;this.phase='idle';this.url=null;this.committedURL=null;this.method='OTHER';this.error=null;this.awaitingStart=false;this.request=null;this.renderer='unknown';}
 noteRequest(url,method){try{url=webURL(url);}catch{return;}this.request={url,method:requestMethod(method),used:false};if(this.phase==='loading'&&this.url===url){this.method=this.request.method;this.request.used=true;}}
 consumeMethod(url){if(this.request?.url===url&&!this.request.used){this.request.used=true;return this.request.method;}return'OTHER';}
 begin(url,programmatic=false){url=webURL(url);this.epoch++;this.url=url;this.phase='loading';this.error=null;this.method=this.consumeMethod(url);this.awaitingStart=programmatic;return this.epoch;}
 started(url){try{url=webURL(url);}catch{return this.epoch;}if(this.awaitingStart&&this.url===url){this.awaitingStart=false;return this.epoch;}return this.begin(url);}
 redirect(url){try{url=webURL(url);}catch{return;}this.url=url;this.method=this.consumeMethod(url);this.phase='loading';this.error=null;this.awaitingStart=false;}
 commit(url){try{url=webURL(url);}catch{return false;}if(this.url!==url||this.error)return false;this.committedURL=url;return true;}
 finish(url){if(this.url!==url||this.error)return false;this.phase='loaded';this.awaitingStart=false;return true;}
 fail(url,code,description){try{url=webURL(url);}catch{return false;}if(code===-3||this.url!==url)return false;this.phase='failed';this.awaitingStart=false;this.error={epoch:this.epoch,host:host(url),code:errorName(description),errorCode:Number.isInteger(code)&&code<=0&&code>=-10000?code:null};return true;}
 stopped(url){if(this.url===url&&this.phase==='loading'&&!this.error){this.phase=this.committedURL===url?'loaded':'stopped';this.awaitingStart=false;}}
 isCurrent(epoch){return this.epoch===epoch;}
 snapshot(){return{epoch:this.epoch,phase:this.phase,host:host(this.url),method:this.method,error:this.error?{...this.error}:null};}
}
const schoolRecoveryURL=host=>host==='sts.ad.utoronto.ca'?'https://mail.utoronto.ca/':null;
module.exports={BrowserPageLoadState,requestMethod,errorName,schoolRecoveryURL};

'use strict';
// Local file invalidation while the app is alive. This does not keep the Mac
// awake, download cloud files, or claim to run during system sleep.
class VaultWatchLifecycle {
 constructor(watcher,{powerMonitor,pollMs=60000,wakeDebounceMs=150}={}) {
  this.watcher=watcher;this.powerMonitor=powerMonitor;this.closed=false;this.suspended=false;this.wakeReason=null;
  this.onSuspend=()=>{this.suspended=true;clearTimeout(this.wakeTimer);this.wakeTimer=null;this.wakeReason=null;};
  this.onResume=()=>{this.suspended=false;this.wake('resume');};
  this.onUnlock=()=>{this.suspended=false;this.wake('unlock');};
  this.wakeDebounceMs=wakeDebounceMs;
  powerMonitor.on('suspend',this.onSuspend);powerMonitor.on('resume',this.onResume);
  powerMonitor.on('unlock-screen',this.onUnlock);powerMonitor.on('user-did-become-active',this.onUnlock);
  // The main-process clock is independent of renderer visibility. Unref lets
  // normal app shutdown proceed; a screen lock deliberately does not stop it.
  this.timer=setInterval(()=>{if(!this.closed&&!this.suspended)this.watcher.invalidate('poll');},pollMs);
  this.timer.unref?.();
 }
 wake(reason){
  if(this.closed)return;
  if(this.wakeReason!=='resume')this.wakeReason=reason;
  if(this.wakeTimer)return;
  this.wakeTimer=setTimeout(()=>{this.wakeTimer=null;const next=this.wakeReason;this.wakeReason=null;if(!this.closed&&!this.suspended)this.watcher.invalidate(next);},this.wakeDebounceMs);
  this.wakeTimer.unref?.();
 }
 dispose(){
  if(this.closed)return;this.closed=true;clearInterval(this.timer);clearTimeout(this.wakeTimer);
  const p=this.powerMonitor;p.removeListener('suspend',this.onSuspend);p.removeListener('resume',this.onResume);
  p.removeListener('unlock-screen',this.onUnlock);p.removeListener('user-did-become-active',this.onUnlock);
 }
}
module.exports={VaultWatchLifecycle};

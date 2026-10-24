import {useEffect, useState} from 'react';
import type {Language} from './i18n';
import {replayDisplayMode, replayDisplayModes, type ReplayDisplayMode} from './replay-display';
import './replay-display.css';
const key = 'inkspace.replay.display-mode';
const changed = 'inkspace-replay-display-changed';
function read(): ReplayDisplayMode {
 try { return replayDisplayMode(localStorage.getItem(key)); } catch { return 'dimmed'; }
}
/** This is a viewing preference, never part of the shared board or PDF data. */
export function useReplayDisplayMode() {
 const [mode, setMode] = useState<ReplayDisplayMode>(read);
 useEffect(() => {
  const receive = (event: Event) => setMode(replayDisplayMode((event as CustomEvent).detail));
  const storage = (event: StorageEvent) => { if (event.key === key) setMode(read()); };
  window.addEventListener(changed, receive); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(changed, receive); window.removeEventListener('storage', storage); };
 }, []);
 const update = (value: ReplayDisplayMode) => {
  const next = replayDisplayMode(value); setMode(next);
  try { localStorage.setItem(key, next); } catch { /* The current view still works when preferences cannot be saved. */ }
  window.dispatchEvent(new CustomEvent(changed, {detail: next}));
 };
 return [mode, update] as const;
}
export default function ReplayDisplayControl({mode, onChange, language}: {mode: ReplayDisplayMode; onChange: (mode: ReplayDisplayMode) => void; language: Language}) {
 const zh = language === 'zh';
 const labels = zh ? {progressive:'逐步显示', dimmed:'未来笔迹淡化'} : {progressive:'Progressive', dimmed:'Dim future ink'};
 return <label className="replay-display-control">{zh?'显示方式':'Display'}<select aria-label={zh?'笔迹回放显示方式':'Ink replay display'} data-testid="replay-display-mode" value={mode} onChange={event=>onChange(replayDisplayMode(event.target.value))}>
  {replayDisplayModes.map(value=><option key={value} value={value}>{labels[value]}</option>)}
 </select></label>;
}

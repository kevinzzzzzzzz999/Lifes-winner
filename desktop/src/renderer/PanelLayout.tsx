import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Language } from './i18n';

type Side = 'left' | 'right';
type Preferences = { version: 1; leftWidth: number; rightWidth: number; leftOpen: boolean };
export const PANEL_STORAGE_KEY = 'inkspace.desktop.panels.v1';
const defaults: Preferences = { version: 1, leftWidth: 280, rightWidth: 480, leftOpen: true };
const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));
function readPreferences(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) || 'null');
    if (p?.version !== 1) return defaults;
    return { version: 1,
      leftWidth: Number.isFinite(p.leftWidth) ? clamp(p.leftWidth, 200, 520) : 280,
      rightWidth: Number.isFinite(p.rightWidth) ? clamp(p.rightWidth, 320, 960) : 480,
      leftOpen: typeof p.leftOpen === 'boolean' ? p.leftOpen : true };
  } catch { return defaults; }
}
function remember(p: Preferences) { try { localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(p)); } catch { /* The layout still works if local preferences are unavailable. */ } }

export function usePanelLayout() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [compactLeftOpen, setCompactLeftOpen] = useState(false);
  const [aiOpen, setAIOpen] = useState(false);
  const [aiEverOpened, setAIEverOpened] = useState(false);
  const [dragging, setDragging] = useState<Side | null>(null);
  const drag = useRef<{ side: Side; pointerId: number; startX: number; startWidth: number; originalWidth: number; handle: HTMLElement } | null>(null);
  const current = useRef(preferences); current.current = preferences;
  const compact = viewport < 900;
  const leftOpen = compact ? compactLeftOpen : preferences.leftOpen;
  // Window fitting never rewrites the user's chosen widths.
  const budget = Math.max(0, viewport - 360);
  const leftWidth = compact ? Math.min(preferences.leftWidth, viewport - 48)
    : Math.min(preferences.leftWidth, Math.max(200, budget - (aiOpen ? 320 : 0)));
  const rightWidth = compact ? Math.min(preferences.rightWidth, viewport - 48)
    : Math.min(preferences.rightWidth, Math.max(320, budget - (leftOpen ? leftWidth : 0)));
  const range = {
    left: { min: Math.min(200, viewport - 48), max: compact ? Math.min(520, viewport - 48) : Math.min(520, budget - (aiOpen ? rightWidth : 0)) },
    right: { min: Math.min(320, viewport - 48), max: compact ? Math.min(960, viewport - 48) : Math.min(960, budget - (leftOpen ? leftWidth : 0)) },
  };
  const geometry = useRef({ leftWidth, rightWidth, range }); geometry.current = { leftWidth, rightWidth, range };
  const changeWidth = (side: Side, value: number) => {
    const r = geometry.current.range[side];
    const next = { ...current.current, [side === 'left' ? 'leftWidth' : 'rightWidth']: Math.round(clamp(value, r.min, r.max)) };
    current.current = next; setPreferences(next);
  };
  const finish = (cancel = false) => {
    const active = drag.current; if (!active) return;
    drag.current = null;
    if (cancel) {
      const next = { ...current.current, [active.side === 'left' ? 'leftWidth' : 'rightWidth']: active.originalWidth };
      current.current = next; setPreferences(next);
    } else remember(current.current);
    setDragging(null);
    if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
  };
  const finishRef = useRef(finish); finishRef.current = finish;
  useEffect(() => {
    const resize = () => { finishRef.current(); setViewport(window.innerWidth); setCompactLeftOpen(false); };
    const blur = () => finishRef.current();
    window.addEventListener('resize', resize); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('blur', blur); };
  }, []);
  const setLeftOpen = (open: boolean) => {
    finish();
    if (compact) { setCompactLeftOpen(open); if (open) setAIOpen(false); }
    else { const next = { ...current.current, leftOpen: open }; current.current = next; setPreferences(next); remember(next); }
  };
  const setAIVisible = (open: boolean) => {
    finish(); setAIOpen(open);
    if (open) { setAIEverOpened(true); if (compact) setCompactLeftOpen(false); }
  };
  const start = (side: Side, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault(); event.currentTarget.focus();
    const key = side === 'left' ? 'leftWidth' : 'rightWidth';
    drag.current = { side, pointerId: event.pointerId, startX: event.clientX,
      startWidth: geometry.current[key], originalWidth: current.current[key], handle: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId); setDragging(side);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    changeWidth(active.side, active.startWidth + (event.clientX - active.startX) * (active.side === 'left' ? 1 : -1));
  };
  const keyboard = (side: Side, key: string, shift: boolean) => {
    const value = geometry.current[side === 'left' ? 'leftWidth' : 'rightWidth'];
    const r = geometry.current.range[side]; let next: number;
    if (key === 'Home') next = r.min;
    else if (key === 'End') next = r.max;
    else if (key === 'ArrowLeft' || key === 'ArrowRight') next = value + (key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * (shift ? 40 : 10);
    else return false;
    changeWidth(side, next); remember(current.current); return true;
  };
  const style = { '--left-pane-width': `${leftOpen ? leftWidth : 0}px`, '--ai-pane-width': `${rightWidth}px`, '--ai-reserved-width': `${aiOpen && !compact ? rightWidth : 0}px` } as CSSProperties;
  return { leftOpen, aiOpen, aiEverOpened, leftWidth, rightWidth, compact, dragging, style, range,
    revision: `${viewport}:${leftWidth}:${rightWidth}:${leftOpen}:${aiOpen}`,
    toggleLeft: () => setLeftOpen(!leftOpen), toggleAI: () => setAIVisible(!aiOpen), closeAI: () => {
      setAIVisible(false);
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="panel-toggle-right"]')?.focus());
    },
    closeCompactLeft: () => { if (compact) setCompactLeftOpen(false); }, start, move, finish, keyboard };
}

export function PanelSeparator({ side, layout, language }: { side: Side; layout: ReturnType<typeof usePanelLayout>; language: Language }) {
  const zh = language === 'zh';
  const name = side === 'left' ? zh ? '调整文件栏宽度' : 'Resize file sidebar' : zh ? '调整 AI 助手栏宽度' : 'Resize AI assistant sidebar';
  const value = side === 'left' ? layout.leftWidth : layout.rightWidth;
  const range = layout.range[side];
  return <div className={`panel-separator panel-separator-${side}`} data-testid={`panel-separator-${side}`}
    role="separator" tabIndex={0} aria-orientation="vertical" aria-label={name}
    aria-valuenow={Math.round(value)} aria-valuemin={Math.round(range.min)} aria-valuemax={Math.round(range.max)}
    aria-controls={side === 'left' ? 'file-sidebar' : 'chatgpt-sidebar'}
    title={zh ? `${name} · 拖动或使用方向键` : `${name} · Drag or use arrow keys`}
    onPointerDown={event => layout.start(side, event)} onPointerMove={layout.move}
    onPointerUp={() => layout.finish()} onPointerCancel={() => layout.finish(true)} onLostPointerCapture={() => layout.finish()}
    onKeyDown={event => { if (event.key === 'Escape') { layout.finish(true); event.preventDefault(); }
      else if (layout.keyboard(side, event.key, event.shiftKey)) event.preventDefault(); }}><span /></div>;
}

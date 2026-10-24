import { useEffect, useRef } from 'react';
import {boardInkStrokeBounds} from './board-ink-clip';
import {paintBoardInkStroke} from './board-ink-paint';

type Rect = { x: number; y: number; width: number; height: number };
type Stroke = { points: number[][]; color: string; opacity: number; clipPath?: number[][] };

// The editable node still owns its original PencilKit bytes. This canvas only
// previews the matching saved vector ink while a desktop layout is a draft.
export default function MindInkPreview({ board, id, width, height }: {
  board: Record<string, unknown>; id: string; width: number; height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const item = (board.items as (Rect & { id: string })[] | undefined)?.find(i => i.id === id);
    const ink = (board.webInk as { strokes?: Stroke[] } | undefined)?.strokes;
    if (!canvas || !item || !ink) return;
    const w = Math.max(1, Math.min(720, width)), h = Math.max(1, Math.min(500, height));
    canvas.width = Math.ceil(w * 2); canvas.height = Math.ceil(h * 2);
    const context = canvas.getContext('2d'); if (!context) return;
    const scale = Math.min(w / item.width, h / item.height);
    context.scale(2, 2); context.translate((w - item.width * scale) / 2, (h - item.height * scale) / 2);
    context.scale(scale, scale); context.translate(-item.x, -item.y);
    context.beginPath(); context.rect(item.x, item.y, item.width, item.height); context.clip();
    context.lineCap = 'round'; context.lineJoin = 'round';
    let segments = 0;
    for (const stroke of ink) {
      const bounds=boardInkStrokeBounds(stroke);
      if(!bounds||bounds.x>item.x+item.width||bounds.x+bounds.width<item.x||bounds.y>item.y+item.height||bounds.y+bounds.height<item.y)continue;
      const step = Math.max(1, Math.ceil(stroke.points.length / 4000));
      segments+=Math.ceil(stroke.points.length/step);if(segments>50000)return;
      paintBoardInkStroke(context,stroke,step);
    }
  }, [board, id, width, height]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} aria-label="Handwriting preview" />;
}

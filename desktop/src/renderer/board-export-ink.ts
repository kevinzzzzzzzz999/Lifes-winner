import {boardInkClipPath} from './board-ink-clip';

type InkPoint = readonly [number, number, number];
export type BoardExportInkStroke = {
  color: string;
  opacity: number;
  points: readonly InkPoint[];
  clipPath?: readonly (readonly number[])[];
};

const MAX_POINTS = 2_000_000;
const MAX_HTML = 100 * 1024 * 1024;
let clipSequence = 0;
const fail = (message: string): never => { throw Error(message); };

// Four decimals remain far below a display pixel at the export's maximum scale.
// Keep very small radii intact rather than rounding them to an invisible dot.
function number(value: number): string {
  if (!Number.isFinite(value)) fail('笔迹几何数据无效。 / Invalid ink geometry.');
  if (value !== 0 && Math.abs(value) < .0001) return String(value);
  const rounded = Math.round(value * 10000) / 10000;
  if (!Number.isFinite(rounded)) fail('笔迹几何数据无效。 / Invalid ink geometry.');
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function point(value: unknown): InkPoint {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'number' && Number.isFinite(v)) || value[2] <= 0 || value[2] > 10000) {
    fail('笔迹几何数据无效。 / Invalid ink geometry.');
  }
  return value as unknown as InkPoint;
}

/**
 * Pressure ink uses one filled compound path per stroke. Every point contributes
 * a round disk, and adjacent points contribute a trapezoid with their own radii.
 * All subpaths have the same winding, so nonzero fill unions overlaps without
 * holes or repeatedly blending a stroke's opacity at its joins.
 */
export async function renderBoardExportInk(
  strokes: readonly unknown[],
  bounds: {x: number; y: number},
  signal: AbortSignal,
  progress?: (message: string) => void,
): Promise<string> {
  const check = () => { if (signal.aborted) fail('已取消 / Cancelled'); };
  check();
  if (!Array.isArray(strokes) || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) fail('笔迹几何数据无效。 / Invalid ink geometry.');
  const paths: string[] = [];
  let pointCount = 0, htmlLength = 0,clipCommands=0;
  // Expanded child boards share one printed DOM: IDs must also be unique across
  // independent calls, not only within one board's SVG.
  const clipPrefix=`board-ink-clip-${++clipSequence}-`;
  const charge = (text: string) => {
    htmlLength += text.length;
    if (htmlLength > MAX_HTML) fail('白板导出内容过大，请分组导出。 / Board export exceeds its preparation budget.');
    return text;
  };
  for (let index = 0; index < strokes.length; index++) {
    check();
    const rawStroke = strokes[index] as Partial<BoardExportInkStroke> | null;
    if (!rawStroke || !Array.isArray(rawStroke.points) || !rawStroke.points.length || typeof rawStroke.opacity !== 'number' || !Number.isFinite(rawStroke.opacity) || rawStroke.opacity < 0 || rawStroke.opacity > 1) {
      fail('笔迹数据无效。 / Invalid ink data.');
    }
    const stroke = rawStroke as BoardExportInkStroke;
    let clip:string|undefined;
    if(stroke.clipPath!==undefined){
      if(!Array.isArray(stroke.clipPath))fail('笔迹裁剪数据无效。 / Invalid ink clip.');
      clipCommands+=stroke.clipPath.length;
      if(clipCommands>100000)fail('笔迹裁剪数据过多。 / Too many ink clip commands.');
      clip=boardInkClipPath(stroke.clipPath,bounds);
    }
    pointCount += stroke.points.length;
    if (pointCount > MAX_POINTS) fail('笔迹点过多，请分白板导出。 / Too many ink points for one export.');
    const parts: string[] = [];
    let previous: InkPoint | undefined;
    for (let index = 0; index < stroke.points.length; index++) {
      check();
      const current = point(stroke.points[index]);
      const x = current[0] - bounds.x, y = current[1] - bounds.y, radius = current[2] / 2;
      // Clockwise SVG arcs and the polygon order below share positive winding.
      if (stroke.opacity > 0) {
        const r = number(radius), diameter = number(radius * 2);
        parts.push(charge(`M${number(x + radius)} ${number(y)}a${r} ${r} 0 1 1 -${diameter} 0a${r} ${r} 0 1 1 ${diameter} 0Z`));
        if (previous) {
          const dx = current[0] - previous[0], dy = current[1] - previous[1], length = Math.hypot(dx, dy);
          if (length > 0) {
            const nx = -dy / length, ny = dx / length, previousRadius = previous[2] / 2;
            const px = previous[0] - bounds.x, py = previous[1] - bounds.y;
            parts.push(charge(`M${number(px + nx * previousRadius)} ${number(py + ny * previousRadius)}L${number(px - nx * previousRadius)} ${number(py - ny * previousRadius)}L${number(x - nx * radius)} ${number(y - ny * radius)}L${number(x + nx * radius)} ${number(y + ny * radius)}Z`));
          }
        }
      }
      previous = current;
      // Long single strokes also allow cancellation to arrive during preparation.
      if (index > 0 && index % 8192 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
    }
    if (parts.length) {
      const color = typeof stroke.color === 'string' && /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color : '#202020';
      const clipID=clip===undefined?undefined:clipPrefix+index;
      if(clipID)paths.push(charge(`<defs><clipPath id="${clipID}" clipPathUnits="userSpaceOnUse"><path clip-rule="nonzero" d="${clip}"/></clipPath></defs>`));
      const start = charge(`<path${clipID?` clip-path="url(#${clipID})"`:''} fill="${color}" opacity="${stroke.opacity}" fill-rule="nonzero" d="`), end = charge('"/>');
      paths.push(start + parts.join('') + end);
    }
    if ((index + 1) % 128 === 0) {
      progress?.(`正在准备笔迹 ${index + 1}/${strokes.length} / Preparing ink`);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      check();
    }
  }
  check();
  return paths.join('');
}


/** World-space CGPath commands carried by a web ink stroke's optional mask. */
export type BoardInkClipCommand =
  | readonly [0, number, number]
  | readonly [1, number, number]
  | readonly [2, number, number, number, number]
  | readonly [3, number, number, number, number, number, number]
  | readonly [4];

export type BoardInkBounds = {x: number; y: number; width: number; height: number};

const MAX_COMMANDS = 10_000;
const MAX_COORDINATE = 8_000_000;
const COMMAND_LENGTHS = [3, 3, 5, 7, 1] as const;
function fail(): never { throw Error('笔迹裁剪数据无效。 / Invalid ink clip geometry.'); }

function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) fail();
  return value;
}

function commands(value: readonly unknown[]): BoardInkClipCommand[] {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) fail();
  const path: BoardInkClipCommand[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw: unknown = value[index];
    if (!Array.isArray(raw)) fail();
    const operation: unknown = raw[0];
    if (typeof operation !== 'number' || !Number.isInteger(operation) || operation < 0 || operation > 4 || raw.length !== COMMAND_LENGTHS[operation]) fail();
    // CGPath returns the current point to the subpath start on close. A later
    // segment or repeated close is valid, so mirror that behavior in both APIs.
    if (index === 0 && operation !== 0) fail();
    const copy = [operation];
    for (let index = 1; index < raw.length; index++) copy.push(coordinate(raw[index]));
    path.push(copy as unknown as BoardInkClipCommand);
  }
  return path;
}

function number(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

/** An empty command list is an empty mask, which hides the entire stroke. */
export function boardInkClipPath(value: readonly unknown[], offset: {x: number; y: number} = {x: 0, y: 0}): string {
  const path = commands(value);
  // Export bounds may extend beyond world limits by a stroke radius and margin.
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) fail();
  const x = offset.x, y = offset.y;
  return path.map(command => {
    const point = (index: number) => `${number(command[index] - x)} ${number(command[index + 1] - y)}`;
    switch (command[0]) {
      case 0: return `M${point(1)}`;
      case 1: return `L${point(1)}`;
      case 2: return `Q${point(1)} ${point(3)}`;
      case 3: return `C${point(1)} ${point(3)} ${point(5)}`;
      case 4: return 'Z';
    }
  }).join('');
}

/** Caller owns save/restore and any existing transform. Validation is atomic. */
export function applyBoardInkClip(ctx: CanvasRenderingContext2D, value: readonly unknown[]): void {
  const path = commands(value);
  ctx.beginPath();
  for (const command of path) {
    switch (command[0]) {
      case 0: ctx.moveTo(command[1], command[2]); break;
      case 1: ctx.lineTo(command[1], command[2]); break;
      case 2: ctx.quadraticCurveTo(command[1], command[2], command[3], command[4]); break;
      case 3: ctx.bezierCurveTo(command[1], command[2], command[3], command[4], command[5], command[6]); break;
      case 4: ctx.closePath(); break;
    }
  }
  ctx.clip('nonzero');
}

/** Control-point bounds conservatively enclose every curve in the mask. */
export function boardInkClipBounds(value: readonly unknown[]): BoardInkBounds | null {
  const path = commands(value);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let x = 0, y = 0, startX = 0, startY = 0, hasSegment = false;
  const include = (x: number, y: number) => {
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  };
  for (const command of path) {
    switch (command[0]) {
      case 0:
        x = startX = command[1]; y = startY = command[2]; hasSegment = false;
        break;
      case 1:
      case 2:
      case 3:
        include(x, y);
        for (let index = 1; index < command.length; index += 2) include(command[index], command[index + 1]);
        x = command[command.length - 2]; y = command[command.length - 1]; hasSegment = true;
        break;
      case 4:
        if (hasSegment) { include(x, y); include(startX, startY); }
        x = startX; y = startY;
        break;
    }
  }
  // PencilKit may append a distant move without drawing a segment there.
  return Number.isFinite(left) ? {x: left, y: top, width: right - left, height: bottom - top} : null;
}

/** Bounds match the rendered pressure disks, intersected with an optional mask. */
export function boardInkStrokeBounds(stroke: {
  points: readonly (readonly number[])[];
  clipPath?: readonly unknown[];
  opacity?: number;
}): BoardInkBounds | null {
  if (!stroke || !Array.isArray(stroke.points)) fail();
  if (stroke.opacity !== undefined && (typeof stroke.opacity !== 'number' || !Number.isFinite(stroke.opacity) || stroke.opacity < 0 || stroke.opacity > 1)) fail();
  const clip = stroke.clipPath === undefined ? undefined : boardInkClipBounds(stroke.clipPath);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of stroke.points) {
    if (!Array.isArray(point) || point.length !== 3) fail();
    const x = coordinate(point[0]), y = coordinate(point[1]), width: unknown = point[2];
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 10_000) fail();
    const radius = width / 2;
    left = Math.min(left, x - radius); top = Math.min(top, y - radius);
    right = Math.max(right, x + radius); bottom = Math.max(bottom, y + radius);
  }
  if (stroke.points.length === 0 || stroke.opacity === 0 || clip === null) return null;
  if (clip !== undefined) {
    left = Math.max(left, clip.x); top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width); bottom = Math.min(bottom, clip.y + clip.height);
    if (left >= right || top >= bottom) return null;
  }
  return {x: left, y: top, width: right - left, height: bottom - top};
}

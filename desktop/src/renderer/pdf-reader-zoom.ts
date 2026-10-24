/** Reader percentages are multiples of the fitted page width, not PDF points. */
export const PDF_READER_MIN_ZOOM = 0.3;
export const PDF_READER_MAX_ZOOM = 32;

export function clampPDFReaderZoom(value: number, fallback = 1): number {
 const finite = Number.isFinite(value) ? value : Number.isFinite(fallback) ? fallback : 1;
 return Math.max(PDF_READER_MIN_ZOOM, Math.min(PDF_READER_MAX_ZOOM, finite));
}

/** Delta is the hook's accumulated, normalized pixel-wheel amount for one frame. */
export function pdfReaderWheelZoom(zoom: number, delta: number): number {
 const current = clampPDFReaderZoom(zoom);
 if (!Number.isFinite(delta)) return current;
 return clampPDFReaderZoom(current * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002));
}

export type PDFReaderZoomPoint = {x: number; y: number};
export type PDFReaderZoomPage = {page: string; rect: {left: number; top: number; width: number; height: number}};
export type PDFReaderZoomAnchor = {page: string; x: number; y: number; clientX: number; clientY: number};

/** Find the closest page in both axes, including a pointer over page margins.
 * Both coordinates use page-width units: source content scales with width,
 * whereas the page wrapper also contains a fixed-height page-number footer. */
export function pdfReaderZoomAnchor(pages: PDFReaderZoomPage[], point: PDFReaderZoomPoint): PDFReaderZoomAnchor | null {
 if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
 let closest: PDFReaderZoomPage | undefined;
 let distance = Infinity;
 for (const candidate of pages) {
  const r = candidate.rect;
  if (!candidate.page || ![r.left, r.top, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) continue;
  const dx = Math.max(r.left - point.x, 0, point.x - r.left - r.width);
  const dy = Math.max(r.top - point.y, 0, point.y - r.top - r.height);
  const next = dx * dx + dy * dy;
  if (next < distance) { closest = candidate; distance = next; }
 }
 if (!closest) return null;
 const r = closest.rect;
 return {page: closest.page, x: (point.x - r.left) / r.width, y: (point.y - r.top) / r.width, clientX: point.x, clientY: point.y};
}

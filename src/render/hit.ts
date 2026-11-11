// Pure geometry for committed shapes: bbox and point-in-path (spec 5.5). No canvas needed, so it runs in Node and in a worker.
import { CLOSE, CUBIC, F_EVENODD, H, LINE, MOVE, QUAD } from '../core/arena';
import type { Shape } from './batch';

/** Bounds of every vertex (control points included, a safe superset), inflated by lineWidth/2 + 2 like the active layer. */
export function shapeBBox(s: Shape, out: number[]): void {
  const v = s.vtx;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < v.length; i += 2) {
    if (v[i] < x0) x0 = v[i];
    if (v[i] > x1) x1 = v[i];
    if (v[i + 1] < y0) y0 = v[i + 1];
    if (v[i + 1] > y1) y1 = v[i + 1];
  }
  const pad = s.hdrF[H.LINE_WIDTH] / 2 + 2;
  out[0] = x0 - pad; out[1] = y0 - pad; out[2] = x1 + pad; out[3] = y1 + pad;
}

// Edge accumulation for the ray cast to +x. Module-level to keep the hover path allocation-free (single-threaded).
let winding = 0;
let crossings = 0;

function edge(x1: number, y1: number, x2: number, y2: number, px: number, py: number): void {
  const cross = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
  if (y1 <= py) {
    if (y2 > py && cross > 0) { winding++; crossings++; }
  } else if (y2 <= py && cross < 0) { winding--; crossings++; }
}

/**
 * Fill semantics of the record's winding rule; open paths are tested as implicitly closed polygons and
 * stroke width is ignored (legacy GeneralPath.contains parity). Curves are flattened (8 / 12 steps).
 */
export function pointInShape(s: Shape, px: number, py: number): boolean {
  winding = 0;
  crossings = 0;
  const v = s.vtx;
  let cx = 0, cy = 0, sx = 0, sy = 0, open = false, i = 0;
  for (let c = 0; c < s.cmd.length; c++) {
    switch (s.cmd[c]) {
      case MOVE:
        if (open) edge(cx, cy, sx, sy, px, py);
        cx = sx = v[i]; cy = sy = v[i + 1]; i += 2; open = true;
        break;
      case LINE:
        edge(cx, cy, v[i], v[i + 1], px, py);
        cx = v[i]; cy = v[i + 1]; i += 2;
        break;
      case QUAD: {
        const bx = v[i], by = v[i + 1], ex = v[i + 2], ey = v[i + 3];
        let ax = cx, ay = cy;
        for (let k = 1; k <= 8; k++) {
          const t = k / 8, u = 1 - t;
          const qx = u * u * cx + 2 * u * t * bx + t * t * ex;
          const qy = u * u * cy + 2 * u * t * by + t * t * ey;
          edge(ax, ay, qx, qy, px, py);
          ax = qx; ay = qy;
        }
        cx = ex; cy = ey; i += 4;
        break;
      }
      case CUBIC: {
        const b1x = v[i], b1y = v[i + 1], b2x = v[i + 2], b2y = v[i + 3], ex = v[i + 4], ey = v[i + 5];
        let ax = cx, ay = cy;
        for (let k = 1; k <= 12; k++) {
          const t = k / 12, u = 1 - t;
          const qx = u * u * u * cx + 3 * u * u * t * b1x + 3 * u * t * t * b2x + t * t * t * ex;
          const qy = u * u * u * cy + 3 * u * u * t * b1y + 3 * u * t * t * b2y + t * t * t * ey;
          edge(ax, ay, qx, qy, px, py);
          ax = qx; ay = qy;
        }
        cx = ex; cy = ey; i += 6;
        break;
      }
      case CLOSE:
        edge(cx, cy, sx, sy, px, py);
        cx = sx; cy = sy;
        break;
    }
  }
  if (open) edge(cx, cy, sx, sy, px, py);
  return s.hdr[H.FLAGS] & F_EVENODD ? (crossings & 1) === 1 : winding !== 0;
}

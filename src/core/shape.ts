// AlcShape construction primitives, spec 5.1. Hot path: no allocation per call.
import {
  ActiveArena, CLOSE, F_CLOSED, F_PEN_SHAPE, H, HDR_STRIDE, LINE, MOVE, QUAD, SPINE_CAP, VTX_CAP,
} from './arena';

export const START_POINTS = 5;
export const MIN_DISTANCE = 5;
export const MIN_DISTANCE_SPINE = 3;

function pushVtx(a: ActiveArena, b: number, x: number, y: number): void {
  const h = a.hdr;
  const hf = a.hdrF;
  const i = 2 * (h[b + H.VTX_OFF] + h[b + H.VTX_COUNT]++);
  a.vtx[i] = x;
  a.vtx[i + 1] = y;
  const f = Math.fround;
  if (h[b + H.VTX_COUNT] === 1) {
    hf[b + H.BB_MIN_X] = hf[b + H.BB_MAX_X] = f(x);
    hf[b + H.BB_MIN_Y] = hf[b + H.BB_MAX_Y] = f(y);
    return;
  }
  if (x < hf[b + H.BB_MIN_X]) hf[b + H.BB_MIN_X] = f(x);
  if (x > hf[b + H.BB_MAX_X]) hf[b + H.BB_MAX_X] = f(x);
  if (y < hf[b + H.BB_MIN_Y]) hf[b + H.BB_MIN_Y] = f(y);
  if (y > hf[b + H.BB_MAX_Y]) hf[b + H.BB_MAX_Y] = f(y);
}

function pushCmd(a: ActiveArena, b: number, c: number): void {
  a.cmd[a.hdr[b + H.CMD_OFF] + a.hdr[b + H.CMD_COUNT]++] = c;
}

function accept(a: ActiveArena, b: number, x: number, y: number): void {
  a.hdr[b + H.TOTAL_POINTS]++;
  a.hdrF[b + H.LAST_X] = x;
  a.hdrF[b + H.LAST_Y] = y;
  a.hdr[b + H.FLAGS] |= F_PEN_SHAPE;
}

/** True when a record can take `pairs` more vertices; false means the caller must split-commit (7.2). */
export function hasRoom(a: ActiveArena, r: number, pairs: number): boolean {
  return a.hdr[r * HDR_STRIDE + H.VTX_COUNT] + pairs <= VTX_CAP;
}

export function newShape(a: ActiveArena, r: number, x: number, y: number, rgba = 0, lineWidth = 0): void {
  const b = r * HDR_STRIDE;
  a.hdr[b + H.VTX_COUNT] = 0;
  a.hdr[b + H.CMD_COUNT] = 0;
  a.hdr[b + H.RGBA] = rgba;
  a.hdrF[b + H.LINE_WIDTH] = lineWidth < 0 ? 0 : lineWidth;
  pushCmd(a, b, MOVE);
  pushVtx(a, b, x, y);
  a.hdr[b + H.TOTAL_POINTS] = 1;
  a.hdrF[b + H.LAST_X] = x;
  a.hdrF[b + H.LAST_Y] = y;
}

export function lineTo(a: ActiveArena, r: number, x: number, y: number): void {
  const b = r * HDR_STRIDE;
  const lx = a.hdrF[b + H.LAST_X];
  const ly = a.hdrF[b + H.LAST_Y];
  if (Math.fround(x) === lx && Math.fround(y) === ly) return;
  if (a.hdr[b + H.TOTAL_POINTS] < START_POINTS || Math.hypot(x - lx, y - ly) > MIN_DISTANCE) {
    pushCmd(a, b, LINE);
    pushVtx(a, b, x, y);
    accept(a, b, x, y);
  }
}

export function curveTo(a: ActiveArena, r: number, x: number, y: number, smoothing = true): void {
  if (!smoothing) return lineTo(a, r, x, y);
  const b = r * HDR_STRIDE;
  const lx = a.hdrF[b + H.LAST_X];
  const ly = a.hdrF[b + H.LAST_Y];
  if (Math.fround(x) === lx && Math.fround(y) === ly) return;
  if (a.hdr[b + H.TOTAL_POINTS] < START_POINTS) {
    pushCmd(a, b, LINE);
    pushVtx(a, b, x, y);
    accept(a, b, x, y);
  } else if (Math.hypot(x - lx, y - ly) > MIN_DISTANCE) {
    pushCmd(a, b, QUAD);
    pushVtx(a, b, lx, ly);
    pushVtx(a, b, (lx + x) / 2, (ly + y) / 2);
    accept(a, b, x, y); // last := raw p, not the midpoint
  }
}

export function close(a: ActiveArena, r: number): void {
  const b = r * HDR_STRIDE;
  pushCmd(a, b, CLOSE);
  a.hdr[b + H.FLAGS] |= F_CLOSED;
}

// ---- Spine -> variable-width outline (5.1.4) ----

/** Point at distance d, rotated -90deg from the direction p2 -> p1. Writes into out[0..1]. */
export function rightAngle(
  x1: number, y1: number, x2: number, y2: number, d: number, out: Float32Array, o: number,
): void {
  const ang = Math.atan2(y1 - y2, x1 - x2) - Math.PI / 2;
  out[o] = x1 + d * Math.cos(ang);
  out[o + 1] = y1 + d * Math.sin(ang);
}

/**
 * Appends a spine point with half-width w. Caller guarantees the pen location changed.
 * Returns true when the spine grew (call emitSpine once per tick afterwards).
 */
export function spineTo(a: ActiveArena, r: number, x: number, y: number, w: number): boolean {
  const b = r * HDR_STRIDE;
  const n = a.hdr[b + H.SPINE_COUNT];
  if (n >= SPINE_CAP) return false;
  const base = a.hdr[b + H.SPINE_OFF];
  const s = a.spine;
  if (n > 0) {
    const p = 4 * (base + n - 1);
    if (Math.hypot(x - s[p], y - s[p + 1]) <= MIN_DISTANCE_SPINE) return false;
  }
  const k = 4 * (base + n);
  s[k] = x;
  s[k + 1] = y;
  s[k + 2] = w;
  if (n > 0) {
    const p = k - 4;
    rightAngle(x, y, s[p], s[p + 1], w, a.edgeL, 2 * (base + n)); // O_n
    rightAngle(s[p], s[p + 1], x, y, w, a.edgeR, 2 * (base + n)); // I_n
  }
  a.hdr[b + H.SPINE_COUNT] = n + 1;
  return true;
}

/** Replays the outline chain O_0, O_1..O_{n-1}, I_{n-1}..I_1, CLOSE from the stored edges. */
export function emitSpine(a: ActiveArena, r: number, smoothing = true): void {
  const b = r * HDR_STRIDE;
  const n = a.hdr[b + H.SPINE_COUNT];
  if (n === 0) return;
  const base = a.hdr[b + H.SPINE_OFF];
  newShape(a, r, a.spine[4 * base], a.spine[4 * base + 1], a.hdr[b + H.RGBA], a.hdrF[b + H.LINE_WIDTH]);
  for (let i = 1; i < n; i++) curveTo(a, r, a.edgeL[2 * (base + i)], a.edgeL[2 * (base + i) + 1], smoothing);
  for (let k = n - 1; k >= 1; k--) curveTo(a, r, a.edgeR[2 * (base + k)], a.edgeR[2 * (base + k) + 1], smoothing);
  close(a, r);
}

// ---- Smooth kernels (5.1.5) over interleaved end points ----

/** In-place 3-tap pass, endpoints fixed, sequential (Evolve parity). */
export function smooth3Tap(pts: Float32Array, n: number): void {
  for (let i = 1; i < n - 1; i++) {
    pts[2 * i] = 0.25 * pts[2 * i - 2] + 0.5 * pts[2 * i] + 0.25 * pts[2 * i + 2];
    pts[2 * i + 1] = 0.25 * pts[2 * i - 1] + 0.5 * pts[2 * i + 1] + 0.25 * pts[2 * i + 3];
  }
}

/** Smooth-affect kernel: writes M, n-2 QUADs and a final LINE into record r. */
export function smoothKernel(a: ActiveArena, r: number, pts: Float32Array, n: number): void {
  const b = r * HDR_STRIDE;
  newShape(a, r, pts[0], pts[1], a.hdr[b + H.RGBA], a.hdrF[b + H.LINE_WIDTH]);
  for (let i = 1; i < n - 1; i++) {
    const sx = 0.25 * pts[2 * i - 2] + 0.5 * pts[2 * i] + 0.25 * pts[2 * i + 2];
    const sy = 0.25 * pts[2 * i - 1] + 0.5 * pts[2 * i + 1] + 0.25 * pts[2 * i + 3];
    pushCmd(a, b, QUAD);
    pushVtx(a, b, pts[2 * i - 2], pts[2 * i - 1]);
    pushVtx(a, b, (pts[2 * i - 2] + sx) / 2, (pts[2 * i - 1] + sy) / 2);
  }
  pushCmd(a, b, LINE);
  pushVtx(a, b, pts[2 * n - 2], pts[2 * n - 1]);
}

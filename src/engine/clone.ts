// Copying records between arena slots (Mirror) and from committed shapes (Repeat stamps).
import { ActiveArena, F_GRADIENT, H, HDR_STRIDE } from '../core/arena';
import { applyAffine } from '../core/transform';
import type { Shape } from '../render/batch';

function setBounds(a: ActiveArena, db: number, vtxOff: number, n: number): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = a.vtx[2 * (vtxOff + i)];
    const y = a.vtx[2 * (vtxOff + i) + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  a.hdrF[db + H.BB_MIN_X] = x0; a.hdrF[db + H.BB_MIN_Y] = y0;
  a.hdrF[db + H.BB_MAX_X] = x1; a.hdrF[db + H.BB_MAX_Y] = y1;
}

function transformGradient(a: ActiveArena, db: number, m: readonly number[]): void {
  if (!(a.hdr[db + H.FLAGS] & F_GRADIENT)) return;
  for (const [ix, iy] of [[H.GX1, H.GY1], [H.GX2, H.GY2]]) {
    const x = a.hdrF[db + ix], y = a.hdrF[db + iy];
    a.hdrF[db + ix] = m[0] * x + m[2] * y + m[4];
    a.hdrF[db + iy] = m[1] * x + m[3] * y + m[5];
  }
}

/**
 * Copies record `src` into slot `dst` through the affine matrix [a, b, c, d, e, f]: same commands, transformed vertices, same
 * paint, gradient endpoints transformed too. Returns false (slot emptied) if it does not fit the slot's capacity.
 */
export function cloneRecord(a: ActiveArena, src: number, dst: number, m: readonly number[]): boolean {
  const sb = src * HDR_STRIDE;
  const db = dst * HDR_STRIDE;
  const n = a.hdr[sb + H.VTX_COUNT];
  const cn = a.hdr[sb + H.CMD_COUNT];
  if (n > a.hdr[db + H.VTX_CAP] || cn > a.hdr[db + H.VTX_CAP]) {
    a.hdr[db + H.VTX_COUNT] = a.hdr[db + H.CMD_COUNT] = 0;
    return false;
  }
  const so = a.hdr[sb + H.VTX_OFF];
  const dOff = a.hdr[db + H.VTX_OFF];
  a.cmd.copyWithin(a.hdr[db + H.CMD_OFF], a.hdr[sb + H.CMD_OFF], a.hdr[sb + H.CMD_OFF] + cn);
  applyAffine(a.vtx, so, a.vtx, dOff, n, m[0], m[1], m[2], m[3], m[4], m[5]);
  for (const k of [H.FLAGS, H.RGBA, H.TOTAL_POINTS, H.GRADIENT_RGBA2]) a.hdr[db + k] = a.hdr[sb + k];
  for (const k of [H.LINE_WIDTH, H.LAST_X, H.LAST_Y, H.GX1, H.GY1, H.GX2, H.GY2]) a.hdrF[db + k] = a.hdrF[sb + k];
  a.hdr[db + H.VTX_COUNT] = n;
  a.hdr[db + H.CMD_COUNT] = cn;
  transformGradient(a, db, m);
  setBounds(a, db, dOff, n);
  return true;
}

/** Loads a committed shape (a Repeat clone arriving from the worker) into slot `dst`. */
export function loadShape(a: ActiveArena, dst: number, s: Shape): boolean {
  const db = dst * HDR_STRIDE;
  const n = s.vtx.length / 2;
  if (n > a.hdr[db + H.VTX_CAP] || s.cmd.length > a.hdr[db + H.VTX_CAP]) return false;
  const dOff = a.hdr[db + H.VTX_OFF];
  a.cmd.set(s.cmd, a.hdr[db + H.CMD_OFF]);
  a.vtx.set(s.vtx, 2 * dOff);
  for (const k of [H.FLAGS, H.RGBA, H.TOTAL_POINTS, H.GRADIENT_RGBA2]) a.hdr[db + k] = s.hdr[k];
  for (const k of [H.LINE_WIDTH, H.LAST_X, H.LAST_Y, H.GX1, H.GY1, H.GX2, H.GY2]) a.hdrF[db + k] = s.hdrF[k];
  a.hdr[db + H.VTX_COUNT] = n;
  a.hdr[db + H.CMD_COUNT] = s.cmd.length;
  setBounds(a, db, dOff, n);
  return true;
}

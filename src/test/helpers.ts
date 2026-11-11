import { CLOSE, F_EVENODD, F_FILL, H, HDR_STRIDE, LINE, MOVE, type ActiveArena } from '../core/arena';
import { InputRing, KIND_MOUSE, KIND_PEN, META_HW_PRESSURE, PHASE_DOWN, PHASE_MOVE, PHASE_UP, packMeta } from '../core/inputRing';
import type { CommitSink, Engine } from '../engine/engine';
import type { Shape } from '../render/batch';

export interface Dump {
  cmd: number[];
  vtx: number[];
}

export class CaptureSink implements CommitSink {
  commits: Dump[] = [];
  commit(a: ActiveArena, recs: Int32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const b = recs[i] * HDR_STRIDE;
      const c = a.hdr[b + H.CMD_OFF];
      const v = 2 * a.hdr[b + H.VTX_OFF];
      this.commits.push({
        cmd: Array.from(a.cmd.subarray(c, c + a.hdr[b + H.CMD_COUNT])),
        vtx: Array.from(a.vtx.subarray(v, v + 2 * a.hdr[b + H.VTX_COUNT])),
      });
    }
  }
}

export type Pt = [x: number, y: number, t: number];

/** Pushes down, drags, up through a ring and ticks the engine. A single point is a tap (down + up). `pen` gives hardware pressure 1. */
export function stroke(e: Engine, pts: Pt[], opts: { pen?: boolean } = {}): void {
  const ring = new InputRing();
  const kind = opts.pen ? KIND_PEN : KIND_MOUSE;
  const flags = opts.pen ? META_HW_PRESSURE : 0;
  const write = (x: number, y: number, t: number, phase: number) => {
    ring.write(x, y, t, 1, 0, 0, phase === PHASE_UP ? 0 : 1, packMeta(kind, phase, flags));
    if (ring.length >= 1000) e.tick(ring); // like frames: drain before the ring can overflow
  };
  pts.forEach(([x, y, t], i) => {
    const last = i === pts.length - 1;
    write(x, y, t, i === 0 ? PHASE_DOWN : last ? PHASE_UP : PHASE_MOVE);
    if (i === 0 && last) write(x, y, t, PHASE_UP); // a single point is a tap: down then up
  });
  e.tick(ring);
}

export const close4 = (got: number[], want: number[], digits = 4): void => {
  if (got.length !== want.length) throw new Error(`length ${got.length} != ${want.length}: ${got}`);
  want.forEach((w, i) => {
    if (!Number.isFinite(got[i]) || Math.abs(got[i] - w) > 10 ** -digits) throw new Error(`[${i}] ${got[i]} != ${w}\n${got}`);
  });
};

/** A committed shape from raw command and vertex arrays (tests for the render side). */
export function mkShape(cmd: number[], vtx: number[], opts: { evenodd?: boolean; lw?: number; rgba?: number; fill?: boolean } = {}): Shape {
  const hdr = new Int32Array(HDR_STRIDE);
  hdr[H.CMD_COUNT] = cmd.length;
  hdr[H.VTX_COUNT] = vtx.length / 2;
  hdr[H.RGBA] = opts.rgba ?? 0x000000ff;
  if (opts.evenodd) hdr[H.FLAGS] |= F_EVENODD;
  if (opts.fill) hdr[H.FLAGS] |= F_FILL;
  const hdrF = new Float32Array(hdr.buffer);
  hdrF[H.LINE_WIDTH] = opts.lw ?? 1;
  return { hdr, hdrF, cmd: Uint8Array.from(cmd), vtx: Float32Array.from(vtx) };
}
export const squareShape = (x: number, y: number, n = 10): Shape =>
  mkShape([MOVE, LINE, LINE, LINE, CLOSE], [x, y, x + n, y, x + n, y + n, x, y + n]);

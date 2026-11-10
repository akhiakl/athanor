import { H, HDR_STRIDE, type ActiveArena } from '../core/arena';
import { InputRing, KIND_MOUSE, KIND_PEN, META_HW_PRESSURE, PHASE_DOWN, PHASE_MOVE, PHASE_UP, packMeta } from '../core/inputRing';
import type { CommitSink, Engine } from '../engine/engine';

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

/** Pushes down, drags, up through a ring and ticks the engine once. `pen` gives hardware pressure 1. */
export function stroke(e: Engine, pts: Pt[], opts: { pen?: boolean } = {}): void {
  const ring = new InputRing();
  const kind = opts.pen ? KIND_PEN : KIND_MOUSE;
  const flags = opts.pen ? META_HW_PRESSURE : 0;
  pts.forEach(([x, y, t], i) => {
    const last = i === pts.length - 1;
    const phase = i === 0 ? PHASE_DOWN : last ? PHASE_UP : PHASE_MOVE;
    ring.write(x, y, t, 1, 0, 0, last ? 0 : 1, packMeta(kind, phase, flags));
    if (ring.length >= 1000) e.tick(ring); // like frames: drain before the ring can overflow
  });
  e.tick(ring);
}

export const close4 = (got: number[], want: number[], digits = 4): void => {
  if (got.length !== want.length) throw new Error(`length ${got.length} != ${want.length}: ${got}`);
  want.forEach((w, i) => {
    if (Math.abs(got[i] - w) > 10 ** -digits) throw new Error(`[${i}] ${got[i]} != ${w}\n${got}`);
  });
};

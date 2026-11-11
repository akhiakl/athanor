// COMMITTED-domain affect modules (spec 2.12, 5.4): they act on the committed store from hover samples.
import { ActiveArena, CUBIC, F_CLOSED, H, HDR_STRIDE, LINE, MOVE, QUAD } from '../core/arena';
import { int } from '../core/math';
import { moduleRng } from '../core/prng';
import { smoothKernel } from '../core/shape';
import { packShapeBatch, type Shape } from './batch';
import type { CommittedStore } from './committed';
import { shapeRawBounds } from './hit';

/** What a committed affect can ask of the main thread (Repeat only): place a stamp, or commit the stamps it holds. */
export interface AffectIO {
  clone(buffer: ArrayBuffer): void;
  commitAffects(): void;
}
export const noIO: AffectIO = { clone() {}, commitAffects() {} };

export interface CommittedAffect {
  readonly id: string;
  /** Hover sample (buttons 0), canvas space. */
  hover?(store: CommittedStore, x: number, y: number, t: number): void;
  /** After each commit (the active arena was just flushed, so nothing is in flight). */
  committed?(store: CommittedStore): void;
  /** Pointer or key event forwarded from the main thread. */
  event?(store: CommittedStore, name: 'down' | 'key', code?: string): void;
  /** Once per frame with the number of shapes still in create[] + affect[] on the main thread. */
  tick?(store: CommittedStore, activeCount: number): void;
}

/** Random (5.4.2): jitters the segments of the hit shape near the pointer. Uniform only; shortcut: no Gaussian pref yet. */
export function randomAffect(seed: number, { distortion = 50 } = {}): CommittedAffect {
  const rng = moduleRng(seed, 'affect.random');
  const lo = -0.15 * distortion;
  const hi = 0.15 * distortion;
  return {
    id: 'affect.random',
    hover(store, x, y) {
      const id = store.hit(x, y);
      if (id < 0) return;
      const s = store.entries[id].shape;
      const px = int(x);
      const py = int(y);
      let v = 0;
      let changed = false;
      let saved = false;
      for (let c = 0; c < s.cmd.length; c++) {
        const op = s.cmd[c];
        const n = op === MOVE || op === LINE ? 1 : op === QUAD ? 2 : op === CUBIC ? 3 : 0;
        if (n === 0) continue;
        if (op !== MOVE) {
          // test point: LINE end, QUAD end, CUBIC second control point (legacy)
          const t = op === CUBIC ? v + 2 : v + 2 * (n - 1);
          // cross-shaped band, legacy OR
          if (Math.abs(int(s.vtx[t]) - px) < 5 || Math.abs(int(s.vtx[t + 1]) - py) < 5) {
            if (!saved) {
              store.willMutate(id); // pre-image for undo, once per burst
              saved = true;
            }
            for (let k = 0; k < 2 * n; k++) s.vtx[v + k] += rng.random(lo, hi);
            changed = true;
          }
        }
        v += 2 * n;
      }
      if (changed) store.touch(id); // an untouched shape must not dirty its tiles on every pointermove
    },
  };
}

// Scratch record for running the arena-based Smooth kernel over committed geometry.
const scratch = new ActiveArena();

/** End points of each segment (MOVE, LINE, QUAD, CUBIC end), interleaved. */
function endPoints(s: Shape): Float32Array {
  const out = new Float32Array(s.vtx.length);
  let n = 0;
  let v = 0;
  for (let c = 0; c < s.cmd.length; c++) {
    const op = s.cmd[c];
    const take = op === MOVE || op === LINE ? 1 : op === QUAD ? 2 : op === CUBIC ? 3 : 0;
    if (take === 0) continue;
    out[2 * n] = s.vtx[v + 2 * (take - 1)];
    out[2 * n + 1] = s.vtx[v + 2 * (take - 1) + 1];
    n++;
    v += 2 * take;
  }
  return out.subarray(0, 2 * n);
}

/**
 * Smooth (5.4.4): hover smooths the hit shape, throttled to 75 ms. `repeat` appends a smoothed copy instead
 * of replacing (copying the source attributes, a documented divergence). The caller does not send hover while a pen is down.
 */
export function smoothAffect({ repeat = false, throttleMs = 75 } = {}): CommittedAffect {
  let last = -Infinity;
  // Copies made by `repeat`, by identity (ids restart after a clear). Hovering one must not smooth it again,
  // or a resting pointer would append a new copy every throttle window without bound.
  const copies = new WeakSet<Shape>();
  return {
    id: 'affect.smooth',
    hover(store, x, y, t) {
      if (t - last < throttleMs) return;
      const id = store.hit(x, y);
      if (id < 0 || copies.has(store.entries[id].shape)) return;
      last = t;
      const e = store.entries[id];
      const pts = endPoints(e.shape);
      const n = pts.length / 2;
      if (n < 3) return; // nothing to smooth
      scratch.reset();
      const r = scratch.alloc();
      const b = r * HDR_STRIDE;
      smoothKernel(scratch, r, pts, n);
      const cmdN = scratch.hdr[b + H.CMD_COUNT];
      const vtxN = scratch.hdr[b + H.VTX_COUNT];
      if (cmdN === 0) return;
      const cmd = scratch.cmd.slice(scratch.hdr[b + H.CMD_OFF], scratch.hdr[b + H.CMD_OFF] + cmdN);
      const vtx = scratch.vtx.slice(2 * scratch.hdr[b + H.VTX_OFF], 2 * scratch.hdr[b + H.VTX_OFF] + 2 * vtxN);
      if (repeat) {
        const hdr = e.shape.hdr.slice();
        hdr[H.CMD_COUNT] = cmdN;
        hdr[H.VTX_COUNT] = vtxN;
        hdr[H.FLAGS] &= ~F_CLOSED; // smoothed output is open (no CLOSE)
        const copy: Shape = { hdr, hdrF: new Float32Array(hdr.buffer), cmd, vtx };
        copies.add(copy);
        store.add(copy, true);
      } else {
        store.willMutate(id);
        e.shape.cmd = cmd;
        e.shape.vtx = vtx;
        e.shape.hdr[H.CMD_COUNT] = cmdN;
        e.shape.hdr[H.VTX_COUNT] = vtxN;
        e.shape.hdr[H.FLAGS] &= ~F_CLOSED;
        store.touch(id);
      }
    },
  };
}

/**
 * Limit (5.4.6): keeps total shapes at `limit` by removing the oldest committed ones.
 * [DIVERGENCE] removes min(overflow, alive). Legacy removed one fewer when in-flight shapes alone exceeded
 * the limit, but wiped a lone shape anyway; one rule is simpler and predictable.
 */
export function limitAffect({ limit = 10 } = {}): CommittedAffect {
  const run = (store: CommittedStore, activeCount: number): void => {
    const n = Math.min(store.aliveCount + activeCount - limit, store.aliveCount);
    for (let k = 0; k < n; k++) {
      const id = store.oldestAlive();
      if (id < 0) break;
      store.remove(id);
    }
  };
  return { id: 'affect.limit', committed: (store) => run(store, 0), tick: run };
}

/**
 * Repeat (5.4.5, HYBRID): while hovering, stamps a copy of the newest committed shape under the pointer every `gap` ms; the copy goes
 * to the main thread, which holds it in its affect range until it is placed (pointerdown, or the pointer leaving the shape 3 times).
 */
export function repeatAffect(io: AffectIO, { repeat = true, gap = 150, margin = 10, tolerance = 10 } = {}): CommittedAffect {
  let on = repeat;
  let lastT = -Infinity;
  let outside = 0;
  let inside = false;
  let grabSet = false;
  let sw = 0, sh = 0, ox = 0, oy = 0;
  let update = false;
  const bb = [0, 0, 0, 0];

  const stamp = (store: CommittedStore, id: number, x: number, y: number): void => {
    const shape = store.entries[id].shape;
    shapeRawBounds(shape, bb);
    const bx = int(bb[0]), by = int(bb[1]), bw = int(bb[2] - bb[0]), bh = int(bb[3] - bb[1]);
    if (!grabSet || Math.abs(bw - sw) + Math.abs(bh - sh) > tolerance || update) {
      sw = bw; sh = bh;
      ox = x - bx; oy = y - by; // where on the shape the pointer grabbed it
      update = false;
      grabSet = true;
    }
    io.clone(packShapeBatch([shape], x - (bx + ox), y - (by + oy)));
  };

  return {
    id: 'affect.repeat',
    hover(store, x, y, t) {
      if (t - lastT < gap) return;
      lastT = t;
      const id = store.hitBBox(x, y, inside ? margin : 0);
      if (id >= 0) {
        outside = 0;
        inside = true;
        if (on) stamp(store, id, x, y);
      } else {
        inside = false;
        if (++outside === 3) {
          io.commitAffects();
          update = true;
        }
      }
    },
    event(_store, name, code) {
      if (name === 'down') {
        if (outside <= 2) {
          io.commitAffects();
          update = true;
        }
      } else if (code === 'KeyB') on = !on;
    },
  };
}

export type AffectParams = Record<string, number | boolean>;

/** Builds a committed affect from its registry id (worker-side factory; params arrive as plain data). */
export function createAffect(id: string, seed: number, params: AffectParams = {}, io: AffectIO = noIO): CommittedAffect | null {
  switch (id) {
    case 'affect.random': return randomAffect(seed, params as { distortion?: number });
    case 'affect.smooth': return smoothAffect(params as { repeat?: boolean; throttleMs?: number });
    case 'affect.limit': return limitAffect(params as { limit?: number });
    case 'affect.repeat': return repeatAffect(io, params as { repeat?: boolean; gap?: number });
    default: return null;
  }
}

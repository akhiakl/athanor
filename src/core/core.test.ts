import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ActiveArena, CLOSE, F_CLOSED, H, HDR_STRIDE, LINE, MOVE, QUAD } from './arena';
import { CAP, InputRing, PHASE_DOWN, PHASE_MOVE, PHASE_UP, STRIDE, metaPhase, packMeta } from './inputRing';
import { Noise } from './noise';
import { Prng, moduleRng } from './prng';
import { Resampler } from './resampler';
import { close, curveTo, emitSpine, lineTo, newShape, smooth3Tap, smoothKernel, spineTo } from './shape';

const dump = (a: ActiveArena, r: number) => {
  const b = r * HDR_STRIDE;
  const n = a.hdr[b + H.CMD_COUNT];
  const cmd = Array.from(a.cmd.subarray(a.hdr[b + H.CMD_OFF], a.hdr[b + H.CMD_OFF] + n));
  const o = 2 * a.hdr[b + H.VTX_OFF];
  const vtx = Array.from(a.vtx.subarray(o, o + 2 * a.hdr[b + H.VTX_COUNT]));
  return { cmd, vtx };
};
const close4 = (got: number[], want: number[]) => {
  expect(got).toHaveLength(want.length);
  want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 4));
};

describe('T1 curveTo warmup and gating', () => {
  it('matches the hand-derived command stream', () => {
    const a = new ActiveArena();
    const r = a.alloc();
    newShape(a, r, 0, 0);
    for (const [x, y] of [[10, 0], [20, 0], [30, 0], [40, 0], [42, 0], [50, 0], [60, 5]]) curveTo(a, r, x, y);
    lineTo(a, r, 61, 5);
    const { cmd, vtx } = dump(a, r);
    expect(cmd).toEqual([MOVE, LINE, LINE, LINE, LINE, QUAD, QUAD]);
    close4(vtx, [0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 40, 0, 45, 0, 50, 0, 55, 2.5]);
    const b = r * HDR_STRIDE;
    expect(a.hdr[b + H.TOTAL_POINTS]).toBe(7);
    expect([a.hdrF[b + H.LAST_X], a.hdrF[b + H.LAST_Y]]).toEqual([60, 5]);
  });

  it('keeps the bounding box incrementally', () => {
    const a = new ActiveArena();
    const r = a.alloc();
    newShape(a, r, 5, 5);
    curveTo(a, r, -3, 20);
    const f = a.hdrF;
    const b = r * HDR_STRIDE;
    expect([f[b + H.BB_MIN_X], f[b + H.BB_MIN_Y], f[b + H.BB_MAX_X], f[b + H.BB_MAX_Y]]).toEqual([-3, 5, 5, 20]);
  });

  it('newShape on a reused record clears the closed flag', () => {
    const a = new ActiveArena();
    const r = a.alloc();
    newShape(a, r, 0, 0);
    close(a, r);
    expect(a.hdr[r * HDR_STRIDE + H.FLAGS] & F_CLOSED).toBe(F_CLOSED);
    newShape(a, r, 1, 1);
    expect(a.hdr[r * HDR_STRIDE + H.FLAGS] & F_CLOSED).toBe(0);
  });
});

describe('T3 spine outline', () => {
  it('builds the closed variable-width polygon', () => {
    const a = new ActiveArena();
    const r = a.alloc(true);
    for (const x of [0, 10, 20]) expect(spineTo(a, r, x, 0, 4)).toBe(true);
    expect(spineTo(a, r, 21, 0, 4)).toBe(false); // within 3 px of the last spine point
    emitSpine(a, r);
    const { cmd, vtx } = dump(a, r);
    expect(cmd).toEqual([MOVE, LINE, LINE, LINE, LINE, CLOSE]);
    close4(vtx, [0, 0, 10, -4, 20, -4, 10, 4, 0, 4]);
  });
});

describe('T6 smooth kernel', () => {
  it('emits M Q L for three points', () => {
    const a = new ActiveArena();
    const r = a.alloc();
    smoothKernel(a, r, new Float32Array([0, 0, 10, 10, 20, 0]), 3);
    const { cmd, vtx } = dump(a, r);
    expect(cmd).toEqual([MOVE, QUAD, LINE]);
    close4(vtx, [0, 0, 0, 0, 5, 2.5, 20, 0]);
    const b = r * HDR_STRIDE;
    expect(a.hdr[b + H.TOTAL_POINTS]).toBe(3);
    expect([a.hdrF[b + H.LAST_X], a.hdrF[b + H.LAST_Y]]).toEqual([20, 0]);
  });

  it('3-tap pass is sequential with fixed endpoints', () => {
    const p = new Float32Array([0, 0, 10, 10, 20, 0, 30, 10]);
    smooth3Tap(p, 4);
    close4(Array.from(p), [0, 0, 10, 5, 20, 3.75, 30, 10]);
  });
});

describe('PRNG', () => {
  it('is deterministic and per-module independent', () => {
    expect(new Prng(1).next()).toBe(new Prng(1).next());
    expect(moduleRng(1, 'a').next()).not.toBe(moduleRng(1, 'b').next());
  });
  it('random(h) stays in [0,h) and random(0)=0', () => {
    const r = new Prng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.random(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(r.random(0)).toBe(0);
    expect(r.random(5, 3)).toBe(5);
  });
  it('gauss has roughly zero mean, unit variance', () => {
    const r = new Prng(1);
    let s = 0, s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) { const g = r.gauss(); s += g; s2 += g * g; }
    expect(Math.abs(s / n)).toBeLessThan(0.05);
    expect(s2 / n).toBeCloseTo(1, 1);
  });
});

describe('T13 noise golden', () => {
  const file = new URL('./__golden__/noise.json', import.meta.url);
  const sample = () => {
    const n = new Noise(1);
    return [n.noise(0.5, 0, 0), n.noise(12.3, 4.5, 0)];
  };
  it('stays in range and matches the frozen values', () => {
    const got = sample();
    got.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(0.9375); });
    // Regenerate deliberately with UPDATE_GOLDEN=1; a missing golden is a failure, not a pass.
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, JSON.stringify(got));
    expect(existsSync(file), 'noise.json missing: run with UPDATE_GOLDEN=1').toBe(true);
    const want = JSON.parse(readFileSync(file, 'utf8')) as number[];
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 12));
  });
});

describe('T15 resampler', () => {
  const run = (stepMs: number) => {
    const rs = new Resampler(120);
    const ts: number[] = [];
    let id = 0;
    const feed = (t: number, phase: number) => {
      const xy = t; // path: x = t / 10
      if (rs.push(xy / 10, 0, t, 0.5, packMeta(0, phase))) ts.push(rs.out[2]);
      id++;
    };
    feed(0, PHASE_DOWN);
    for (let t = stepMs; t < 100; t += stepMs) feed(t, PHASE_MOVE);
    feed(99, PHASE_UP);
    return ts;
  };
  it('emits 12 grid samples plus up for a 1 kHz stream', () => {
    const ts = run(1);
    expect(ts).toHaveLength(13);
    expect(ts[1]).toBeCloseTo(8.333, 2);
    expect(ts[11]).toBeCloseTo(91.667, 2);
  });
  it('ignores moves after up until the next down', () => {
    const rs = new Resampler(120);
    expect(rs.push(0, 0, 0, 1, packMeta(0, PHASE_DOWN))).toBe(true);
    expect(rs.push(1, 0, 20, 1, packMeta(0, PHASE_UP))).toBe(true);
    expect(rs.push(2, 0, 40, 1, packMeta(0, PHASE_MOVE))).toBe(false);
  });
  it('125 Hz and 1 kHz streams land on the same grid (within one tick)', () => {
    expect(Math.abs(run(8).length - run(1).length)).toBeLessThanOrEqual(1);
  });
});

describe('spine guards', () => {
  it('spineTo and emitSpine ignore records allocated without a spine', () => {
    const a = new ActiveArena();
    const r = a.alloc();
    expect(spineTo(a, r, 0, 0, 4)).toBe(false);
    emitSpine(a, r);
    expect(a.hdr[r * HDR_STRIDE + H.CMD_COUNT]).toBe(0);
  });
});

describe('capacity guards', () => {
  it('a long spine stops before the outline can overflow the vertex region', () => {
    const a = new ActiveArena();
    const r = a.alloc(true);
    const next = a.alloc();
    let accepted = 0;
    for (let i = 0; i < 5000; i++) if (spineTo(a, r, i * 10, 0, 4)) accepted++;
    emitSpine(a, r);
    expect(a.hdr[r * HDR_STRIDE + H.VTX_COUNT]).toBeLessThanOrEqual(a.hdr[r * HDR_STRIDE + H.VTX_CAP]);
    expect(accepted).toBeLessThan(5000);
    expect(a.hdr[next * HDR_STRIDE + H.VTX_COUNT]).toBe(0);
  });
  it('lineTo and curveTo refuse to write past a full record', () => {
    const a = new ActiveArena();
    const r = a.alloc();
    newShape(a, r, 0, 0);
    for (let i = 1; i < 10000; i++) lineTo(a, r, i * 10, 0);
    expect(a.hdr[r * HDR_STRIDE + H.VTX_COUNT]).toBeLessThanOrEqual(4096);
  });
});

describe('guards', () => {
  it('Resampler rejects a non-positive or non-finite rate', () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(() => new Resampler(bad)).toThrow(RangeError);
  });
  it('packMeta masks fields so they cannot corrupt each other', () => {
    expect(metaPhase(packMeta(7, 5))).toBe(1); // phase 5 -> 1, kind 7 -> 3 stays in its own bits
    expect(packMeta(0, 0, 0xffff, 0x1ff) & ~0xff7f).toBe(0);
  });
});

describe('InputRing', () => {
  it('round-trips and drops oldest moves on overflow, never phase samples', () => {
    const ring = new InputRing();
    ring.write(0, 0, 0, 1, 0, 0, 0, packMeta(0, PHASE_DOWN));
    for (let i = 1; i < CAP + 10; i++) ring.write(i, 0, i, 1, 0, 0, 0, packMeta(0, PHASE_MOVE));
    expect(ring.length).toBe(CAP);
    const out = new Float32Array(STRIDE);
    expect(ring.read(out)).toBe(true);
    expect(metaPhase(out[7])).toBe(PHASE_DOWN); // oldest is a phase sample: incoming moves were dropped instead
    ring.write(1, 1, 1, 1, 0, 0, 0, packMeta(0, PHASE_UP));
    expect(ring.length).toBe(CAP);
  });
});

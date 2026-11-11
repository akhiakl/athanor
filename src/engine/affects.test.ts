import { describe, expect, it } from 'vitest';
import { ActiveArena, CLOSE, F_GRADIENT, H, HDR_STRIDE, LINE, MOVE, VTX_CAP } from '../core/arena';
import { hsbToRgb, rgbToHsb } from '../core/color';
import { InputRing, KIND_MOUSE, PHASE_DOWN, PHASE_MOVE, PHASE_UP, packMeta } from '../core/inputRing';
import { applyAffine } from '../core/transform';
import { blindness } from '../modules/affect/blindness';
import { channelWindow, colorSwitcher } from '../modules/affect/colorSwitcher';
import { displace } from '../modules/affect/displace';
import { gradient } from '../modules/affect/gradient';
import { mirror } from '../modules/affect/mirror';
import { repeatStamps } from '../modules/affect/repeatStamps';
import { pressureShapes } from '../modules/create/pressure';
import { shapes } from '../modules/create/shapes';
import { affectModules } from '../modules/registry';
import type { Shape } from '../render/batch';
import { packShapeBatch, unpackBatch } from '../render/batch';
import { CaptureSink, close4, stroke } from '../test/helpers';
import { cloneRecord } from './clone';
import { Engine, type AffectModule, type CreateModule } from './engine';

const rec = (e: Engine, r: number) => {
  const a = e.arena;
  const b = r * HDR_STRIDE;
  const co = a.hdr[b + H.CMD_OFF], vo = 2 * a.hdr[b + H.VTX_OFF];
  return {
    cmd: Array.from(a.cmd.subarray(co, co + a.hdr[b + H.CMD_COUNT])),
    vtx: Array.from(a.vtx.subarray(vo, vo + 2 * a.hdr[b + H.VTX_COUNT])),
  };
};
const empty = new InputRing();
const ev = (ring: InputRing, x: number, y: number, t: number, phase: number) =>
  ring.write(x, y, t, 1, 0, 0, phase === PHASE_UP ? 0 : 1, packMeta(KIND_MOUSE, phase));

/** A create module that begins (0,0)-(10,0) on pointerdown and does nothing else. */
const segment: CreateModule = {
  id: 'test.segment', rateSensitive: false,
  down: (e) => { e.begin(0, 0); e.lineTo(10, 0); },
  up: (e) => e.commit(),
};

describe('T4 Mirror', () => {
  it('reflects a create vertex into fixed slots: H -> 0, V -> 1, HV -> 2', () => {
    const sink = new CaptureSink();
    const e = new Engine(1, sink);
    e.view.w = 800; e.view.h = 600;
    const m = mirror({ horizontal: true, vertical: true });
    e.addAffect(m);
    e.begin(100, 50);
    e.tick(empty);
    close4(rec(e, e.affectSlot(m, 0)).vtx, [700, 50]);
    close4(rec(e, e.affectSlot(m, 1)).vtx, [100, 550]);
    close4(rec(e, e.affectSlot(m, 2)).vtx, [700, 550]);
  });
  it('rebuilds into the same slots every tick instead of allocating', () => {
    const e = new Engine(1, new CaptureSink());
    e.view.w = 800; e.view.h = 600;
    const m = mirror();
    e.addAffect(m);
    e.begin(100, 50);
    e.tick(empty);
    const before = e.arena.recordCount;
    for (let i = 0; i < 20; i++) { e.markDirty(); e.tick(empty); }
    expect(e.arena.recordCount).toBe(before);
  });
  it('commits clones with the stroke, create first, mirrored from the FINAL geometry', () => {
    const sink = new CaptureSink();
    const e = new Engine(1, sink);
    e.view.w = 400; e.view.h = 300;
    e.addAffect(mirror());
    e.select(shapes());
    stroke(e, [[10, 20, 0], [60, 20, 8], [60, 20, 16]]);
    expect(sink.commits).toHaveLength(2);
    expect(sink.commits[0].vtx.slice(0, 2)).toEqual([10, 20]);
    expect(sink.commits[1].vtx.slice(0, 2)).toEqual([390, 20]); // 2 * 200 - 10
    expect(sink.commits[1].cmd).toEqual(sink.commits[0].cmd);
    // the up sample added the last point after the previous affect pass; the clone still has it
    expect(sink.commits[1].vtx.length).toBe(sink.commits[0].vtx.length);
  });
  it('mirrors gradient endpoints too (the legacy first-clone-only bug)', () => {
    const a = new ActiveArena();
    const src = a.alloc();
    const dst = a.alloc();
    a.hdr[src * HDR_STRIDE + H.VTX_COUNT] = 1;
    a.hdr[src * HDR_STRIDE + H.CMD_COUNT] = 1;
    a.hdr[src * HDR_STRIDE + H.FLAGS] = F_GRADIENT;
    a.hdrF[src * HDR_STRIDE + H.GX1] = 100; a.hdrF[src * HDR_STRIDE + H.GY1] = 10;
    a.hdrF[src * HDR_STRIDE + H.GX2] = 150; a.hdrF[src * HDR_STRIDE + H.GY2] = 20;
    expect(cloneRecord(a, src, dst, [-1, 0, 0, 1, 400, 0])).toBe(true);
    const hf = a.hdrF, b = dst * HDR_STRIDE;
    expect([hf[b + H.GX1], hf[b + H.GY1], hf[b + H.GX2], hf[b + H.GY2]]).toEqual([300, 10, 250, 20]);
  });
});

describe('cloneRecord capacity', () => {
  it('empties the slot instead of overflowing a smaller record', () => {
    const a = new ActiveArena();
    const src = a.alloc();
    const dst = a.alloc(false, 4);
    a.hdr[src * HDR_STRIDE + H.VTX_COUNT] = 10;
    a.hdr[src * HDR_STRIDE + H.CMD_COUNT] = 10;
    expect(cloneRecord(a, src, dst, [1, 0, 0, 1, 0, 0])).toBe(false);
    expect(a.hdr[dst * HDR_STRIDE + H.VTX_COUNT]).toBe(0);
  });
});

describe('T5 Displace', () => {
  it('pushes vertices away from the last vertex by displacement - taxicab, once per drag event', () => {
    const e = new Engine(1, new CaptureSink());
    e.select(segment);
    e.addAffect(displace({ displacement: 7 }));
    const ring = new InputRing();
    ev(ring, 0, 0, 0, PHASE_DOWN);
    e.tick(ring);
    close4(rec(e, e.current()).vtx, [0, 0, 10, 0]);
    ev(ring, 1, 1, 10, PHASE_MOVE); // delta (1,1): speed 5
    e.tick(ring);
    close4(rec(e, e.current()).vtx, [-5, 0, 15, 0]);
    ev(ring, 4, 5, 20, PHASE_MOVE); // delta (3,4): speed 0, nothing moves
    e.tick(ring);
    close4(rec(e, e.current()).vtx, [-5, 0, 15, 0]);
  });
  it('moves spine points and re-emits the outline with matching offsets', () => {
    const e = new Engine(1, new CaptureSink());
    e.select(pressureShapes({ amount: 4 }));
    e.addAffect(displace({ displacement: 7 }));
    const ring = new InputRing();
    ring.write(0, 0, 0, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_DOWN, 64)); // hardware pressure -> width 4
    for (const [x, y, t] of [[10, 0, 10], [20, 0, 20], [30, 0, 30]]) ring.write(x, y, t, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_MOVE, 64));
    e.tick(ring);
    const r = e.current();
    const before = rec(e, r).vtx;
    const ring2 = new InputRing();
    ring2.write(31, 1, 40, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_MOVE, 64));
    e.tick(ring2);
    const after = rec(e, r);
    expect(after.vtx).not.toEqual(before);
    expect(after.cmd[after.cmd.length - 1]).toBe(CLOSE);
    expect(after.vtx.every(Number.isFinite)).toBe(true);
  });
});

describe('Gradient', () => {
  it('follows a pen-drawn stroke: first vertex to last vertex, colour to alpha 0, flag set', () => {
    const sink = new CaptureSink();
    const e = new Engine(1, sink);
    e.attrs.rgba = 0x11223344;
    e.addAffect(gradient());
    e.select(shapes());
    const ring = new InputRing();
    ev(ring, 0, 0, 0, PHASE_DOWN); ev(ring, 40, 30, 8, PHASE_MOVE);
    e.tick(ring);
    const b = e.current() * HDR_STRIDE;
    expect(e.arena.hdr[b + H.FLAGS] & F_GRADIENT).toBe(F_GRADIENT);
    expect([e.arena.hdrF[b + H.GX1], e.arena.hdrF[b + H.GY1], e.arena.hdrF[b + H.GX2], e.arena.hdrF[b + H.GY2]]).toEqual([0, 0, 40, 30]);
    expect(e.arena.hdr[b + H.GRADIENT_RGBA2] >>> 0).toBe(0x11223300);
  });
  it('uses spine start and spine middle for a spine record', () => {
    const e = new Engine(1, new CaptureSink());
    e.addAffect(gradient());
    e.select(pressureShapes({ amount: 4 }));
    const ring = new InputRing();
    ring.write(0, 0, 0, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_DOWN, 64));
    for (const [x, t] of [[10, 10], [20, 20], [30, 30], [40, 40]]) ring.write(x, 0, t, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_MOVE, 64));
    e.tick(ring);
    const b = e.current() * HDR_STRIDE;
    expect([e.arena.hdrF[b + H.GX1], e.arena.hdrF[b + H.GX2]]).toEqual([0, 20]); // 5 spine points: floor(5/2) = 2 -> x = 20
  });
  it('gives non-pen records random endpoints once and keeps them', () => {
    const e = new Engine(1, new CaptureSink());
    const g = gradient();
    e.addAffect(g);
    // a record without the pen-shape flag, owned by a registered stand-in module
    const holder: AffectModule = { id: 'holder', order: 50, rateSensitive: false };
    e.addAffect(holder);
    const r = e.affectSlot(holder, 0);
    const hb = r * HDR_STRIDE;
    e.arena.hdr[hb + H.VTX_COUNT] = 2; e.arena.hdr[hb + H.CMD_COUNT] = 2;
    for (const [k, v] of [[H.BB_MIN_X, 0], [H.BB_MAX_X, 100], [H.BB_MIN_Y, 0], [H.BB_MAX_Y, 100]]) e.arena.hdrF[hb + k] = v;
    e.markDirty(); e.tick(empty);
    const first = [e.arena.hdrF[hb + H.GX1], e.arena.hdrF[hb + H.GY2]];
    expect(first.every((v) => v >= 0 && v <= 100)).toBe(true);
    e.markDirty(); e.tick(empty);
    expect([e.arena.hdrF[hb + H.GX1], e.arena.hdrF[hb + H.GY2]]).toEqual(first);
  });
});

describe('ColorSwitcher', () => {
  it('T11 window shifts instead of clipping', () => {
    const close = (got: [number, number], want: [number, number]) => want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 12));
    close(channelWindow(0.9, 0.25), [0.5, 1]);
    close(channelWindow(0.1, 0.25), [0, 0.5]);
    close(channelWindow(0.5, 0.25), [0.25, 0.75]);
  });
  it('Java HSB conversions: primaries, grey, and a round trip', () => {
    expect(hsbToRgb(0, 1, 1)).toEqual([255, 0, 0]);
    expect(hsbToRgb(1 / 3, 1, 1)).toEqual([0, 255, 0]);
    expect(hsbToRgb(2 / 3, 1, 1)).toEqual([0, 0, 255]);
    expect(hsbToRgb(0.4, 0, 0.5)).toEqual([128, 128, 128]);
    expect(hsbToRgb(1.25, 1, 1)).toEqual(hsbToRgb(0.25, 1, 1)); // hue wraps
    const [h, s, b] = rgbToHsb(200, 100, 50);
    const back = hsbToRgb(h, s, b);
    back.forEach((c, i) => expect(Math.abs(c - [200, 100, 50][i])).toBeLessThanOrEqual(1));
  });
  it('on pointerdown recolours the canvas colour and every active record, alpha 0..254', () => {
    const e = new Engine(1, new CaptureSink());
    e.attrs.rgba = 0x336699ff;
    e.select(shapes());
    e.addAffect(colorSwitcher({ baseRange: 50 }));
    const ring = new InputRing();
    ev(ring, 5, 5, 0, PHASE_DOWN);
    e.tick(ring);
    expect(e.attrs.rgba).not.toBe(0x336699ff | 0);
    expect(e.arena.hdr[e.current() * HDR_STRIDE + H.RGBA]).toBe(e.attrs.rgba);
    expect((e.attrs.rgba & 0xff)).toBeLessThanOrEqual(254);
  });
  it('with constant, re-rolls every 50 ms of a drag, not before', () => {
    const e = new Engine(1, new CaptureSink());
    e.select(shapes());
    e.addAffect(colorSwitcher({ constant: true }));
    const ring = new InputRing();
    ev(ring, 5, 5, 0, PHASE_DOWN);
    e.tick(ring);
    const c0 = e.attrs.rgba;
    ev(ring, 10, 5, 20, PHASE_MOVE);
    e.tick(ring);
    expect(e.attrs.rgba).toBe(c0);
    ev(ring, 20, 5, 60, PHASE_MOVE);
    e.tick(ring);
    expect(e.attrs.rgba).not.toBe(c0);
  });
});

describe('Blindness', () => {
  const run = (autoReveal: boolean) => {
    const e = new Engine(1, new CaptureSink());
    e.select(shapes());
    e.addAffect(blindness({ autoReveal }));
    return e;
  };
  it('hides while drawing and reveals on pointerup (autoReveal), again hidden at the next down', () => {
    const e = run(true);
    expect(e.flags.blind).toBe(true);
    const ring = new InputRing();
    ev(ring, 5, 5, 0, PHASE_DOWN); e.tick(ring);
    expect(e.flags.blind).toBe(true);
    ev(ring, 9, 5, 8, PHASE_UP); e.tick(ring);
    expect(e.flags.blind).toBe(false);
    ev(ring, 5, 5, 20, PHASE_DOWN); e.tick(ring);
    expect(e.flags.blind).toBe(true);
  });
  it('without autoReveal stays hidden until R; removing the module reveals', () => {
    const e = run(false);
    const ring = new InputRing();
    ev(ring, 5, 5, 0, PHASE_DOWN); ev(ring, 9, 5, 8, PHASE_UP); e.tick(ring);
    expect(e.flags.blind).toBe(true);
    e.key('KeyX', 'x');
    expect(e.flags.blind).toBe(true);
    e.key('KeyR', 'r');
    expect(e.flags.blind).toBe(false);
    e.key('KeyR', 'r');
    e.removeAffect('affect.blindness');
    expect(e.flags.blind).toBe(false);
  });
  it('the drawing still commits while blind', () => {
    const sink = new CaptureSink();
    const e = new Engine(1, sink);
    e.select(shapes());
    e.addAffect(blindness());
    stroke(e, [[0, 0, 0], [30, 0, 8]]);
    expect(sink.commits).toHaveLength(1);
  });
});

describe('affect pipeline', () => {
  it('keeps affects sorted by order and lists create records before affect records in module order', () => {
    const e = new Engine(1, new CaptureSink());
    const mk = (id: string, order: number): AffectModule => ({ id, order, rateSensitive: false });
    const hi = mk('hi', 50), lo = mk('lo', 5), mid = mk('mid', 20);
    e.addAffect(hi); e.addAffect(lo); e.addAffect(mid);
    expect(e.affects.map((m) => m.id)).toEqual(['lo', 'mid', 'hi']);
    const c = e.begin(0, 0);
    const rHi = e.affectSlot(hi, 0);
    const rLo = e.affectSlot(lo, 0);
    const out = new Int32Array(8);
    expect(Array.from(out.subarray(0, e.activeRecords(out)))).toEqual([c, rLo, rHi]);
  });
  it('dispatches create hooks before affect hooks, affects ascending, rate-sensitive ones the resampled stream', () => {
    const log: string[] = [];
    const e = new Engine(1, new CaptureSink());
    e.select({ id: 'c', rateSensitive: false, down: () => void log.push('create.down'), drag: () => void log.push('create.drag') });
    e.addAffect({ id: 'b', order: 2, rateSensitive: false, down: () => void log.push('b.down'), drag: () => void log.push('b.drag') });
    e.addAffect({ id: 'a', order: 1, rateSensitive: false, down: () => void log.push('a.down') });
    e.addAffect({ id: 'r', order: 0, rateSensitive: true, drag: () => void log.push('r.drag') });
    const ring = new InputRing();
    ev(ring, 0, 0, 0, PHASE_DOWN);
    for (let t = 1; t <= 20; t++) ev(ring, t, 0, t, PHASE_MOVE); // 1 kHz
    e.tick(ring);
    expect(log.slice(0, 3)).toEqual(['create.down', 'a.down', 'b.down']);
    expect(log.filter((l) => l === 'create.drag')).toHaveLength(20); // every raw sample
    expect(log.filter((l) => l === 'b.drag')).toHaveLength(20);
    expect(log.filter((l) => l === 'r.drag').length).toBeLessThan(6); // ~120 Hz: 2 in 20 ms
    expect(log.filter((l) => l === 'r.drag').length).toBeGreaterThan(0);
  });
  it('removeAffect empties that module\'s records and runs its deselect', () => {
    const e = new Engine(1, new CaptureSink());
    let deselected = false;
    const m: AffectModule = { id: 'm', order: 1, rateSensitive: false, deselect: () => void (deselected = true) };
    e.addAffect(m);
    const r = e.affectSlot(m, 0);
    e.arena.hdr[r * HDR_STRIDE + H.VTX_COUNT] = 3;
    e.removeAffect('m');
    expect(deselected).toBe(true);
    expect(e.arena.hdr[r * HDR_STRIDE + H.VTX_COUNT]).toBe(0);
    expect(e.hasAffect('m')).toBe(false);
  });
  it('registry lists the five active affects in spec order', () => {
    expect(affectModules.map((d) => d.id)).toEqual(['affect.displace', 'affect.gradient', 'affect.mirror', 'affect.blindness', 'affect.colorSwitcher']);
    for (const d of affectModules) expect(d.make().id).toBe(d.id);
  });
});

describe('arena record capacity', () => {
  it('small caps let many stamps share the arena that 4096-pair records would exhaust', () => {
    const a = new ActiveArena();
    let n = 0;
    while (a.alloc(false, 64) >= 0) n++;
    expect(n).toBe(64); // limited by the record count, not the vertex budget
    const b = new ActiveArena();
    let full = 0;
    while (b.alloc() >= 0) full++;
    expect(full).toBe(16);
    expect(a.hdr[H.VTX_CAP]).toBe(64);
    expect(VTX_CAP).toBe(4096);
  });
});

describe('Repeat stamps (main-thread half)', () => {
  const shapeOf = (n: number): Shape => {
    const hdr = new Int32Array(HDR_STRIDE);
    hdr[H.VTX_COUNT] = n; hdr[H.CMD_COUNT] = n; hdr[H.RGBA] = 0x00ff00ff;
    const cmd = new Uint8Array(n).fill(LINE); cmd[0] = MOVE;
    return { hdr, hdrF: new Float32Array(hdr.buffer), cmd, vtx: Float32Array.from({ length: 2 * n }, (_, i) => i) };
  };
  it('holds stamps as active records, then places only them and keeps the create stroke', () => {
    const sink = new CaptureSink();
    const e = new Engine(1, sink);
    const stamps = repeatStamps();
    e.addAffect(stamps);
    e.begin(0, 0); // an unfinished create stroke
    stamps.add(e, shapeOf(5));
    stamps.add(e, shapeOf(7));
    const out = new Int32Array(8);
    expect(e.activeRecords(out)).toBe(3);
    stamps.place(e);
    expect(sink.commits).toHaveLength(2);
    expect(sink.commits.map((c) => c.vtx.length)).toEqual([10, 14]);
    expect(e.createCount).toBe(1); // the stroke is untouched
    expect(e.activeRecords(out)).toBe(1);
    stamps.add(e, shapeOf(3)); // slots were freed and are usable again
    expect(e.activeRecords(out)).toBe(2);
  });
  it('a full arena flushes and carries on instead of dropping the stamp', () => {
    const sink = new CaptureSink();
    const e = new Engine(1, sink);
    const stamps = repeatStamps();
    e.addAffect(stamps);
    for (let i = 0; i < 70; i++) stamps.add(e, shapeOf(40));
    const total = sink.commits.length + (() => { const o = new Int32Array(128); return e.activeRecords(o); })();
    expect(total).toBe(70); // nothing lost
  });
});

describe('batch and transform helpers', () => {
  it('packShapeBatch translates vertices, bounds and gradient endpoints', () => {
    const hdr = new Int32Array(HDR_STRIDE);
    hdr[H.VTX_COUNT] = 2; hdr[H.CMD_COUNT] = 2; hdr[H.FLAGS] = F_GRADIENT;
    const hdrF = new Float32Array(hdr.buffer);
    hdrF[H.GX1] = 1; hdrF[H.GY1] = 2; hdrF[H.GX2] = 3; hdrF[H.GY2] = 4;
    const s: Shape = { hdr, hdrF, cmd: Uint8Array.of(MOVE, LINE), vtx: Float32Array.of(0, 0, 10, 5) };
    const [t] = unpackBatch(packShapeBatch([s], 100, 200));
    expect(Array.from(t.vtx)).toEqual([100, 200, 110, 205]);
    expect([t.hdrF[H.GX1], t.hdrF[H.GY1], t.hdrF[H.GX2], t.hdrF[H.GY2]]).toEqual([101, 202, 103, 204]);
    expect(Array.from(s.vtx)).toEqual([0, 0, 10, 5]); // the source is untouched
  });
  it('applyAffine reflects and translates in place-safe order', () => {
    const v = Float32Array.of(1, 2, 3, 4);
    applyAffine(v, 0, v, 0, 2, -1, 0, 0, 1, 10, 0);
    expect(Array.from(v)).toEqual([9, 2, 7, 4]);
  });
});

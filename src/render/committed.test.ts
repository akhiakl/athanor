import { describe, expect, it } from 'vitest';
import { CLOSE, F_EVENODD, H, HDR_STRIDE, LINE, MOVE, QUAD } from '../core/arena';
import { Engine } from '../engine/engine';
import { shapes } from '../modules/create/shapes';
import { stroke } from '../test/helpers';
import { limitAffect, randomAffect, smoothAffect } from './affects';
import type { Shape } from './batch';
import { CommittedStore } from './committed';
import { RenderCore } from './core';
import type { Ctx2D } from './draw';
import { pointInShape } from './hit';

function mk(cmd: number[], vtx: number[], opts: { evenodd?: boolean; lw?: number; rgba?: number } = {}): Shape {
  const hdr = new Int32Array(HDR_STRIDE);
  hdr[H.CMD_COUNT] = cmd.length;
  hdr[H.VTX_COUNT] = vtx.length / 2;
  hdr[H.RGBA] = opts.rgba ?? 0x000000ff;
  if (opts.evenodd) hdr[H.FLAGS] |= F_EVENODD;
  const hdrF = new Float32Array(hdr.buffer);
  hdrF[H.LINE_WIDTH] = opts.lw ?? 1;
  return { hdr, hdrF, cmd: Uint8Array.from(cmd), vtx: Float32Array.from(vtx) };
}
const square = (x: number, y: number, n = 10) =>
  mk([MOVE, LINE, LINE, LINE, CLOSE], [x, y, x + n, y, x + n, y + n, x, y + n]);

describe('pointInShape', () => {
  it('nonzero fill of a closed square', () => {
    const s = square(0, 0);
    expect(pointInShape(s, 5, 5)).toBe(true);
    expect(pointInShape(s, 15, 5)).toBe(false);
    expect(pointInShape(s, 5, -1)).toBe(false);
  });
  it('treats an open path as an implicitly closed polygon', () => {
    const tri = mk([MOVE, LINE, LINE], [0, 0, 10, 0, 5, 10]);
    expect(pointInShape(tri, 5, 3)).toBe(true);
    expect(pointInShape(tri, 9, 9)).toBe(false);
  });
  it('even-odd leaves the hole of a nested square empty', () => {
    const outer = [0, 0, 20, 0, 20, 20, 0, 20];
    const inner = [5, 5, 15, 5, 15, 15, 5, 15];
    const cmd = [MOVE, LINE, LINE, LINE, CLOSE, MOVE, LINE, LINE, LINE, CLOSE];
    // inner wound the same way: nonzero fills it, even-odd does not
    expect(pointInShape(mk(cmd, [...outer, ...inner]), 10, 10)).toBe(true);
    expect(pointInShape(mk(cmd, [...outer, ...inner], { evenodd: true }), 10, 10)).toBe(false);
    expect(pointInShape(mk(cmd, [...outer, ...inner], { evenodd: true }), 2, 2)).toBe(true);
  });
  it('flattens quadratic curves', () => {
    const bowl = mk([MOVE, QUAD, LINE, CLOSE], [0, 0, 10, 20, 20, 0, 20, 0]); // curve bulges to y = 10
    expect(pointInShape(bowl, 10, 8)).toBe(true);
    expect(pointInShape(bowl, 10, 12)).toBe(false);
  });
});

describe('CommittedStore', () => {
  it('hit returns the topmost live shape and skips removed ones', () => {
    const st = new CommittedStore(256, 600, 600);
    const a = st.add(square(0, 0));
    const b = st.add(square(5, 5));
    expect(st.hit(7, 7)).toBe(b);
    st.remove(b);
    expect(st.hit(7, 7)).toBe(a);
    expect(st.hit(300, 300)).toBe(-1);
    expect(st.hit(-5, -5)).toBe(-1);
    expect(st.aliveCount).toBe(1);
  });
  it('remove dirties exactly the tiles the shape touches', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(square(250, 250, 12)); // straddles 4 tiles
    st.remove(id);
    expect(st.dirtyCount).toBe(4);
  });
  it('touch dirties old and new tiles and keeps hit testing correct after a move', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(square(10, 10));
    const s = st.entries[id].shape;
    for (let i = 0; i < s.vtx.length; i += 2) s.vtx[i] += 400; // jump two tiles right
    st.touch(id);
    expect(st.dirtyCount).toBe(2); // tile 0 (old) and tile of x=410 (new)
    expect(st.hit(415, 15)).toBe(id);
    expect(st.hit(15, 15)).toBe(-1);
  });
  it('setSize rebuilds the grid from live shapes and dirties everything', () => {
    const st = new CommittedStore(256, 300, 300);
    const id = st.add(square(280, 280, 10));
    st.setSize(600, 600);
    expect(st.dirtyCount).toBe(9);
    expect(st.hit(285, 285)).toBe(id);
  });
  it('clear empties the log and resets the oldest pointer', () => {
    const st = new CommittedStore(256, 300, 300);
    st.add(square(0, 0));
    st.clear();
    expect(st.aliveCount).toBe(0);
    st.add(square(0, 0));
    expect(st.oldestAlive()).toBe(0);
  });
});

describe('tile membership under repeated touch', () => {
  const shift = (st: CommittedStore, id: number, dx: number) => {
    const v = st.entries[id].shape.vtx;
    for (let i = 0; i < v.length; i += 2) v[i] += dx;
    st.touch(id);
  };
  it('never duplicates an id when a shape moves back and forth across a tile boundary', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(square(240, 10, 12));
    for (let k = 0; k < 4; k++) { shift(st, id, 300); shift(st, id, -300); }
    for (let t = 0; t < st.cols * st.rows; t++) {
      const ids = st.tileIds(t);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it('keeps log order, so a touched older shape stays below newer ones', () => {
    const st = new CommittedStore(256, 600, 600);
    const older = st.add(square(240, 10, 12));
    const newer = st.add(square(241, 11, 10));
    shift(st, older, 300);
    shift(st, older, -300);
    for (let t = 0; t < st.cols * st.rows; t++) expect([...st.tileIds(t)]).toEqual([...st.tileIds(t)].sort((a, b) => a - b));
    expect(st.hit(246, 16)).toBe(newer);
  });
});

describe('hitBBox', () => {
  it('finds the newest shape whose bounds, grown by the margin, contain the point, across a tile edge', () => {
    const st = new CommittedStore(256, 600, 600);
    const a = st.add(square(100, 100)); // bounds 97.5 .. 112.5 with the stroke pad
    expect(st.hitBBox(125, 105, 0)).toBe(-1);
    expect(st.hitBBox(120, 105, 10)).toBe(a);
    const b = st.add(square(105, 105));
    expect(st.hitBBox(108, 108, 0)).toBe(b); // newest wins
    st.remove(b);
    expect(st.hitBBox(108, 108, 0)).toBe(a);
    const c = st.add(square(250, 250, 12)); // straddles the tile edge at 256
    expect(st.hitBBox(270, 255, 10)).toBe(c); // point in the next tile
  });
});

describe('Random', () => {
  it('jitters segments in the cross band within +-0.15 v, never the MOVE point', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(square(0, 0));
    const before = Array.from(st.entries[id].shape.vtx);
    randomAffect(1, { distortion: 50 }).hover!(st, 6, 6, 0);
    const after = Array.from(st.entries[id].shape.vtx);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after).not.toEqual(before);
    after.forEach((v, i) => expect(Math.abs(v - before[i])).toBeLessThan(7.5));
    expect(st.dirtyCount).toBeGreaterThan(0);
  });
  it('does nothing when the pointer is not over a shape', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(square(0, 0));
    const before = Array.from(st.entries[id].shape.vtx);
    randomAffect(1).hover!(st, 100, 100, 0);
    expect(Array.from(st.entries[id].shape.vtx)).toEqual(before);
  });
  it('is deterministic for a seed', () => {
    const run = () => {
      const st = new CommittedStore(256, 600, 600);
      const id = st.add(square(0, 0));
      randomAffect(7).hover!(st, 6, 6, 0);
      return Array.from(st.entries[id].shape.vtx);
    };
    expect(run()).toEqual(run());
  });
});

describe('Random without a band hit', () => {
  it('leaves an untouched shape clean: no vertex change and no dirty tiles', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(square(0, 0, 100));
    const before = Array.from(st.entries[id].shape.vtx);
    randomAffect(1).hover!(st, 50, 50, 0); // inside, but every test point is >= 50 px away on both axes
    expect(Array.from(st.entries[id].shape.vtx)).toEqual(before);
    expect(st.dirtyCount).toBe(0);
  });
});

describe('Smooth', () => {
  const zig = () => mk([MOVE, LINE, LINE, LINE, CLOSE], [0, 0, 10, 10, 20, 0, 30, 10], { rgba: 0x11223344 });
  it('replaces the hit shape with the smoothed M Q... L stream and is throttled to 75 ms', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(zig());
    const af = smoothAffect();
    af.hover!(st, 20, 3, 1000);
    expect(Array.from(st.entries[id].shape.cmd)).toEqual([MOVE, QUAD, QUAD, LINE]);
    const once = Array.from(st.entries[id].shape.vtx);
    af.hover!(st, 20, 3, 1050); // inside the throttle window
    expect(Array.from(st.entries[id].shape.vtx)).toEqual(once);
    // the smoothed shape is a sliver now: find a point that still hits it for the un-throttled call
    let hx = -1, hy = -1;
    for (let y = 0; y <= 10 && hx < 0; y += 0.5) for (let x = 0; x <= 30; x += 0.5) if (st.hit(x, y) === id) { hx = x; hy = y; break; }
    expect(hx).toBeGreaterThanOrEqual(0);
    af.hover!(st, hx, hy, 1100);
    expect(Array.from(st.entries[id].shape.vtx)).not.toEqual(once);
  });
  it('repeat appends a smoothed copy with the source attributes and leaves the original', () => {
    const st = new CommittedStore(256, 600, 600);
    const id = st.add(zig());
    smoothAffect({ repeat: true }).hover!(st, 20, 3, 0);
    expect(st.aliveCount).toBe(2);
    expect(Array.from(st.entries[id].shape.cmd)).toEqual([MOVE, LINE, LINE, LINE, CLOSE]);
    expect(st.entries[1].shape.hdr[H.RGBA]).toBe(0x11223344);
    expect(st.dirtyCount).toBeGreaterThan(0); // the copy was not drawn by anyone yet
  });
  it('repeat does not smooth its own copies, so a resting pointer cannot grow the store', () => {
    const st = new CommittedStore(256, 600, 600);
    st.add(zig());
    const af = smoothAffect({ repeat: true });
    af.hover!(st, 20, 3, 0);
    expect(st.aliveCount).toBe(2);
    let hx = -1, hy = -1; // a point where the copy is now the topmost hit
    for (let y = 0; y <= 10 && hx < 0; y += 0.5) for (let x = 0; x <= 30; x += 0.5) if (st.hit(x, y) === 1) { hx = x; hy = y; break; }
    expect(hx).toBeGreaterThanOrEqual(0);
    for (let k = 1; k <= 20; k++) af.hover!(st, hx, hy, k * 100);
    expect(st.aliveCount).toBe(2);
  });
});

describe('Limit', () => {
  const fill = (n: number) => {
    const st = new CommittedStore(256, 600, 600);
    for (let i = 0; i < n; i++) st.add(square(i * 3, 0));
    return st;
  };
  it('removes the oldest shapes down to the limit', () => {
    const st = fill(15);
    limitAffect({ limit: 10 }).committed!(st);
    expect(st.aliveCount).toBe(10);
    expect(st.entries.slice(0, 5).every((e) => !e.alive)).toBe(true);
    expect(st.entries[5].alive).toBe(true);
  });
  it('counts active shapes toward the total and removes at least one over the limit', () => {
    const st = fill(10);
    limitAffect({ limit: 10 }).tick!(st, 1);
    expect(st.aliveCount).toBe(9);
  });
  it('uses one rule at the edges: remove min(overflow, alive), including a lone shape', () => {
    const lone = fill(1);
    limitAffect({ limit: 3 }).tick!(lone, 5);
    expect(lone.aliveCount).toBe(0);
    const some = fill(3);
    limitAffect({ limit: 1 }).tick!(some, 10);
    expect(some.aliveCount).toBe(0);
    const edge = fill(4);
    limitAffect({ limit: 2 }).tick!(edge, 0);
    expect(edge.aliveCount).toBe(2);
  });
  it('never removes anything at or under the limit', () => {
    const st = fill(10);
    limitAffect({ limit: 10 }).committed!(st);
    limitAffect({ limit: 10 }).tick!(st, 0);
    expect(st.aliveCount).toBe(10);
  });
});

function counting(): Ctx2D & { fills: number; strokes: number } {
  const noop = () => {};
  const c = {
    fills: 0, strokes: 0, fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter',
    createLinearGradient: () => ({ addColorStop: noop }),
    beginPath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, closePath: noop,
    stroke() { c.strokes++; }, fill: noop, fillRect() { c.fills++; }, clearRect: noop, rect: noop, clip: noop, save: noop, restore: noop,
  };
  return c as unknown as Ctx2D & { fills: number; strokes: number };
}

describe('RenderCore replay', () => {
  it('replays dirty tiles within the time budget and reports what is left', () => {
    const ctx = counting();
    const core = new RenderCore(ctx);
    core.store.setSize(1024, 1024); // 16 tiles
    let t = 0;
    const left = core.replay(2, () => t++); // each tile costs one "ms" of the fake clock
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(16);
    expect(core.replay(Infinity)).toBe(0);
  });
  it('a Limit affect removes old strokes from the canvas on the next replay', () => {
    const ctx = counting();
    const core = new RenderCore(ctx);
    core.store.setSize(256, 256);
    core.affects.push(limitAffect({ limit: 3 }));
    const e = new Engine(1, core);
    e.select(shapes());
    for (let i = 0; i < 6; i++) stroke(e, [[i * 10, 5, 0], [i * 10 + 8, 5, 8]]);
    expect(core.store.aliveCount).toBe(3);
    ctx.strokes = 0;
    expect(core.replay(Infinity)).toBe(0);
    expect(ctx.strokes).toBe(3); // only the survivors are redrawn
  });
});

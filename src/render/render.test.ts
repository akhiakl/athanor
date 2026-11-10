import { describe, expect, it } from 'vitest';
import { ActiveArena, F_FILL, H, HDR_STRIDE } from '../core/arena';
import { newShape, curveTo, close } from '../core/shape';
import { Engine } from '../engine/engine';
import { pressureShapes } from '../modules/create/pressure';
import { shapes } from '../modules/create/shapes';
import { stroke } from '../test/helpers';
import { ActiveRenderer } from './active';
import { packBatch, unpackBatch } from './batch';
import { MainThreadRenderCore } from './core';
import { rgbaToCss, type Ctx2D } from './draw';

/** Records every call as a string; properties are plain fields. */
function mockCtx(): Ctx2D & { calls: string[] } {
  const calls: string[] = [];
  const rec = (n: string) => (...a: number[]) => void calls.push(`${n}(${a.join(',')})`);
  return {
    calls, fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter',
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), quadraticCurveTo: rec('quad'),
    bezierCurveTo: rec('cubic'), closePath: rec('close'), stroke: () => void calls.push('stroke'),
    fill: (r?: string) => void calls.push(`fill(${r})`), fillRect: rec('fillRect'), clearRect: rec('clearRect'),
    rect: rec('rect'), clip: () => void calls.push('clip'), save: () => void calls.push('save'), restore: () => void calls.push('restore'),
  };
}

describe('CommitBatch', () => {
  it('round-trips records through pack/unpack', () => {
    const a = new ActiveArena();
    const recs = new Int32Array(2);
    for (let i = 0; i < 2; i++) {
      const r = a.alloc();
      recs[i] = r;
      newShape(a, r, i, i, 0x11223344, 3);
      for (let k = 1; k < 9; k++) curveTo(a, r, i + k * 10, i + k * 7);
      a.hdr[r * HDR_STRIDE + H.FLAGS] |= i === 1 ? F_FILL : 0;
    }
    const out = unpackBatch(packBatch(a, recs, 2));
    expect(out).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      const b = recs[i] * HDR_STRIDE;
      expect(Array.from(out[i].cmd)).toEqual(Array.from(a.cmd.subarray(a.hdr[b + H.CMD_OFF], a.hdr[b + H.CMD_OFF] + a.hdr[b + H.CMD_COUNT])));
      expect(out[i].vtx.length).toBe(2 * a.hdr[b + H.VTX_COUNT]);
      expect(out[i].hdr[H.RGBA]).toBe(0x11223344);
      expect(out[i].hdrF[H.LINE_WIDTH]).toBe(3);
    }
    expect(out[1].hdr[H.FLAGS] & F_FILL).toBe(F_FILL);
  });
});

describe('drawing', () => {
  it('maps the command stream and stroke style (round cap, bevel join)', () => {
    const ctx = mockCtx();
    const core = new MainThreadRenderCore(ctx);
    const a = new ActiveArena();
    const r = a.alloc();
    newShape(a, r, 0, 0, 0xff000080, 2);
    for (const x of [10, 20, 30, 40, 50, 60]) curveTo(a, r, x, x === 60 ? 5 : 0);
    close(a, r);
    core.commit(a, Int32Array.of(r), 1);
    expect(ctx.calls[0]).toBe('beginPath()');
    expect(ctx.calls[1]).toBe('moveTo(0,0)');
    expect(ctx.calls).toContain('quad(40,0,45,0)');
    expect(ctx.calls).toContain('close()');
    expect(ctx.calls.at(-1)).toBe('stroke');
    expect(ctx.strokeStyle).toBe('rgba(255,0,0,0.502)');
    expect([ctx.lineWidth, ctx.lineCap, ctx.lineJoin]).toEqual([2, 'round', 'bevel']);
  });
  it('rgbaToCss unpacks 0xRRGGBBAA including a high red byte', () => {
    expect(rgbaToCss(0xff8000ff | 0)).toBe('rgba(255,128,0,1.000)');
  });
});

describe('MainThreadRenderCore + Engine', () => {
  it('a committed stroke lands in the log and on the committed canvas, then the active layer clears', () => {
    const committed = mockCtx();
    const core = new MainThreadRenderCore(committed);
    const e = new Engine(1, core);
    e.select(shapes());
    const activeCtx = mockCtx();
    const active = new ActiveRenderer();
    stroke(e, [[0, 0, 0], [30, 0, 8]]);
    // nothing committed yet?  up is the last point, so finished:
    expect(core.log).toHaveLength(1);
    expect(committed.calls).toContain('stroke');
    active.render(activeCtx, e); // nothing active and nothing previous: no work
    expect(activeCtx.calls).toHaveLength(0);
  });
  it('clear and redraw replay the log over the background', () => {
    const ctx = mockCtx();
    const core = new MainThreadRenderCore(ctx, '#fff', 100, 50);
    const e = new Engine(1, core);
    e.select(shapes());
    stroke(e, [[0, 0, 0], [30, 0, 8]]);
    ctx.calls.length = 0;
    core.redraw(200, 100);
    expect(ctx.calls[0]).toBe('fillRect(0,0,200,100)');
    expect(ctx.calls).toContain('stroke');
    core.clear();
    expect(core.log).toHaveLength(0);
  });
});

describe('ActiveRenderer dirty rect', () => {
  it('clears the union of previous and current bounds, and nothing once idle', () => {
    const ctx = mockCtx();
    const sinkCore = new MainThreadRenderCore(mockCtx());
    const e = new Engine(1, sinkCore);
    e.select(shapes());
    const active = new ActiveRenderer();
    e.begin(10, 10);
    e.lineTo(50, 10);
    active.render(ctx, e);
    expect(ctx.calls).toContain('clearRect(7.5,7.5,45,5)'); // bbox inflated by lineWidth/2 + 2 = 2.5
    e.commit();
    ctx.calls.length = 0;
    active.render(ctx, e); // erases the previous footprint once
    expect(ctx.calls.some((c) => c.startsWith('clearRect'))).toBe(true);
    ctx.calls.length = 0;
    active.render(ctx, e);
    expect(ctx.calls).toHaveLength(0);
  });
  it('draws a Pressure ribbon on the active layer before it commits', () => {
    const ctx = mockCtx();
    const e = new Engine(1, new MainThreadRenderCore(mockCtx()));
    e.select(pressureShapes({ amount: 4 }));
    const active = new ActiveRenderer();
    e.beginSpine();
    for (const x of [0, 10, 20]) e.spineTo(x, 0, 4);
    e.flushSpines();
    active.render(ctx, e);
    expect(ctx.calls.filter((c) => c.startsWith('lineTo') || c.startsWith('quad')).length).toBeGreaterThan(0);
    expect(ctx.calls).toContain('close()');
  });
});

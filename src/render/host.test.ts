import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/engine';
import { shapes } from '../modules/create/shapes';
import { stroke } from '../test/helpers';
import { ActiveRenderer } from './active';
import { RenderClient } from './client';
import type { Ctx2D } from './draw';
import { RenderHost, type HostCanvas, type HostCtx } from './host';
import type { FromWorker, ToWorker } from './protocol';

function mockCtx() {
  const calls: string[] = [];
  const rec = (n: string) => (...a: number[]) => void calls.push(`${n}(${a.join(',')})`);
  const ctx = {
    calls, fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter',
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), quadraticCurveTo: rec('quad'),
    bezierCurveTo: rec('cubic'), closePath: rec('close'), stroke: () => void calls.push('stroke'),
    fill: () => void calls.push('fill'), fillRect: rec('fillRect'), clearRect: rec('clearRect'),
    rect: rec('rect'), clip: () => void calls.push('clip'), save: () => void calls.push('save'), restore: () => void calls.push('restore'),
    setTransform: rec('setTransform'),
  };
  return ctx as unknown as HostCtx & { calls: string[] };
}

/** A worker stand-in: messages are structured-cloned with their transfer list, so detached buffers are real. */
function rig(opts: { worker: boolean }) {
  const ctx = mockCtx();
  const canvas: HostCanvas = { width: 0, height: 0, getContext: () => ctx };
  const sent: ToWorker[] = [];
  const hoverSizes: number[] = []; // captured before the transfer detaches the buffer
  const changes = { n: 0 };
  let client!: RenderClient;
  const host = new RenderHost((m: FromWorker) => client.onMessage(m), () => {}, { budgetMs: 4, ackImmediately: !opts.worker });
  client = new RenderClient(
    (m, transfer) => {
      sent.push(m);
      if (m.type === 'hover') hoverSizes.push(m.samples.length / 3);
      host.handle(opts.worker ? (structuredClone(m, { transfer }) as ToWorker) : m);
    },
    opts.worker,
    () => changes.n++,
  );
  host.handle({ type: 'init', canvas: canvas as unknown as OffscreenCanvas, dpr: 2, w: 300, h: 200, seed: 1 });
  return { ctx, canvas, host, client, sent, changes, hoverSizes };
}

const draw = (e: Engine, x = 0) => stroke(e, [[x, 5, 0], [x + 30, 5, 8]]);

describe('RenderHost init and resize', () => {
  it('sizes the canvas by dpr, restores the transform, and reports ready', () => {
    const { canvas, ctx, client } = rig({ worker: true });
    expect([canvas.width, canvas.height]).toEqual([600, 400]);
    expect(ctx.calls).toContain('setTransform(2,0,0,2,0,0)');
    expect(client.ready).toBe(true);
    client.resize(100, 50, 1);
    expect([canvas.width, canvas.height]).toEqual([100, 50]);
    expect(ctx.calls.filter((c) => c === 'setTransform(1,0,0,1,0,0)')).toHaveLength(1);
  });
  it('drops messages that arrive before init', () => {
    const host = new RenderHost(() => {}, () => {}, { budgetMs: 4 });
    expect(() => host.handle({ type: 'clear' })).not.toThrow();
    expect(host.store).toBeNull();
  });
});

describe('commit across the worker boundary', () => {
  it('keeps the batch pending on the active layer until the worker acks after its frame', () => {
    const { client, host, ctx, changes } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    expect(host.store!.aliveCount).toBe(1);
    expect(ctx.calls).toContain('stroke'); // drawn on the committed canvas
    expect(client.pending).toHaveLength(1); // not acked yet: still shown by the active layer
    expect(host.frame()).toBe(false);
    expect(client.pending).toHaveLength(0);
    expect(changes.n).toBe(1); // the active layer was told to erase it
  });
  it('detaches the sent buffer but the pending copy stays drawable', () => {
    const { client, sent } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    const msg = sent.find((m) => m.type === 'commit') as Extract<ToWorker, { type: 'commit' }>;
    expect(msg.buffer.byteLength).toBe(0); // transferred away
    expect(client.pending[0].vtx.length).toBe(4);
  });
  it('local mode acks immediately, so nothing is ever pending', () => {
    const { client } = rig({ worker: false });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    expect(client.pending).toHaveLength(0);
  });
  it('the active renderer shows a pending shape, then erases it once acked', () => {
    const { client, host } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    const ctx = mockCtx();
    const active = new ActiveRenderer();
    active.render(ctx as unknown as Ctx2D, e, client.pending);
    expect(ctx.calls).toContain('stroke');
    host.frame();
    ctx.calls.length = 0;
    active.render(ctx as unknown as Ctx2D, e, client.pending);
    expect(ctx.calls.some((c) => c.startsWith('clearRect'))).toBe(true);
    expect(ctx.calls).not.toContain('stroke');
  });
});

describe('hover and affects over the protocol', () => {
  it('coalesces hover into batches of at most 64 samples', () => {
    const { client, hoverSizes } = rig({ worker: true });
    client.setAffect('affect.random', true);
    for (let i = 0; i < 100; i++) client.hover(i, 0, i);
    client.flush();
    expect(hoverSizes).toEqual([64, 36]);
  });
  it('an enabled Random affect jitters a committed shape on hover; disabling stops it', () => {
    const { client, host } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    stroke(e, [[0, 0, 0], [20, 0, 8], [20, 20, 16], [0, 20, 24], [0, 1, 32]]); // a loop
    const vtx = () => Array.from(host.store!.entries[0].shape.vtx);
    const before = vtx();
    client.hover(16, 16, 0);
    client.flush();
    expect(vtx()).toEqual(before); // no affect yet
    client.setAffect('affect.random', true);
    client.hover(16, 16, 1);
    client.flush();
    expect(vtx()).not.toEqual(before);
    const after = vtx();
    client.setAffect('affect.random', false);
    client.hover(16, 16, 2);
    client.flush();
    expect(vtx()).toEqual(after);
  });
  it('sends the per-frame tick only while an affect is on, and Limit trims the log', () => {
    const { client, host, sent } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    client.tick(0);
    expect(sent.some((m) => m.type === 'tick')).toBe(false);
    client.setAffect('affect.limit', true, { limit: 2 });
    for (let i = 0; i < 4; i++) draw(e, i * 40);
    expect(host.store!.aliveCount).toBe(2);
    client.tick(0);
    expect(sent.some((m) => m.type === 'tick')).toBe(true);
  });
  it('clear drops pending shapes at once, and a late ack is harmless', () => {
    const { client, host, changes } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    expect(client.pending).toHaveLength(1);
    const before = changes.n;
    client.clear();
    expect(client.pending).toHaveLength(0); // cleared strokes must not linger on the active layer
    expect(changes.n).toBeGreaterThan(before);
    host.frame(); // the worker still acks the old batch
    expect(client.pending).toHaveLength(0);
  });
  it('dropPending forgets in-flight batches', () => {
    const { client } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    client.dropPending();
    expect(client.pending).toHaveLength(0);
  });
  it('clear empties the log and replay redraws the background', () => {
    const { client, host, ctx } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    ctx.calls.length = 0;
    client.clear();
    expect(host.store!.aliveCount).toBe(0);
    expect(ctx.calls.some((c) => c.startsWith('fillRect'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/engine';
import { shapes } from '../modules/create/shapes';
import { stroke } from '../test/helpers';
import { ActiveRenderer } from './active';
import { RenderClient } from './client';
import type { Ctx2D } from './draw';
import { RenderHost, type HostCanvas, type HostCtx } from './host';
import type { Shape } from './batch';
import type { FromWorker, ToWorker } from './protocol';
import { MemoryStorage } from '../doc/storage';

function mockCtx() {
  const calls: string[] = [];
  const rec = (n: string) => (...a: number[]) => void calls.push(`${n}(${a.join(',')})`);
  const ctx = {
    calls, fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter',
    createLinearGradient: (...a: number[]) => { calls.push(`gradient(${a.join(',')})`); return { addColorStop: (o: number, c: string) => void calls.push(`stop(${o},${c})`) } as unknown as CanvasGradient; },
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), quadraticCurveTo: rec('quad'),
    bezierCurveTo: rec('cubic'), closePath: rec('close'), stroke: () => void calls.push('stroke'),
    fill: () => void calls.push('fill'), fillRect: rec('fillRect'), clearRect: rec('clearRect'),
    rect: rec('rect'), clip: () => void calls.push('clip'), save: () => void calls.push('save'), restore: () => void calls.push('restore'),
    setTransform: rec('setTransform'),
  };
  return ctx as unknown as HostCtx & { calls: string[] };
}

/** A worker stand-in: messages are structured-cloned with their transfer list, so detached buffers are real. */
function rig(opts: { worker: boolean; storage?: MemoryStorage }) {
  const ctx = mockCtx();
  const canvas: HostCanvas = { width: 0, height: 0, getContext: () => ctx };
  const sent: ToWorker[] = [];
  const hoverSizes: number[] = []; // captured before the transfer detaches the buffer
  const changes = { n: 0 };
  let client!: RenderClient;
  const exportCanvas = { getContext: () => mockCtx() as never, convertToBlob: async (o?: { type?: string }) => new Blob(['png-bytes'], { type: o?.type }) };
  const host = new RenderHost((m: FromWorker) => client.onMessage(m), () => {}, { budgetMs: 4, ackImmediately: !opts.worker, makeCanvas: () => exportCanvas, openStorage: opts.storage ? async () => opts.storage! : undefined });
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

describe('a failing message does not take the worker down', () => {
  it('reports a corrupt batch, still acks it, and keeps the log and later commits working', () => {
    const errors: string[] = [];
    const { client, host } = rig({ worker: true });
    const orig = client.onMessage.bind(client);
    client.onMessage = (m) => (m.type === 'error' ? void errors.push(m.message) : orig(m));
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    expect(host.store!.aliveCount).toBe(1);
    host.handle({ type: 'commit', batchId: 99, buffer: new ArrayBuffer(2) }); // corrupt: shorter than its count word
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/corrupt CommitBatch/);
    expect(host.store!.aliveCount).toBe(1); // the earlier drawing survives
    draw(e, 50);
    expect(host.store!.aliveCount).toBe(2); // and the host keeps working
    host.frame();
    expect(client.pending).toHaveLength(0);
  });
});

describe('transfer flag', () => {
  it('clearing it after construction stops the defensive copy and the transfer list', () => {
    const sent: Array<{ m: ToWorker; t?: Transferable[] }> = [];
    const client = new RenderClient((m, t) => void sent.push({ m, t }), true, () => {});
    client.transfer = false;
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    const commit = sent.find((x) => x.m.type === 'commit')!;
    expect(commit.t).toBeUndefined();
    expect(client.pending[0].vtx.buffer).toBe((commit.m as Extract<ToWorker, { type: 'commit' }>).buffer); // shared, not copied
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

describe('undo history over the protocol', () => {
  it('reports what undo and redo can do, only when it changes, and a gesture is one step', () => {
    const { client, host } = rig({ worker: true });
    const states: string[] = [];
    client.onHistory = (u, r) => void states.push(`${u}/${r}`);
    const e = new Engine(1, client);
    e.select(shapes());
    client.historyBegin();
    draw(e, 0);
    draw(e, 50); // two commits in one gesture
    client.historyEnd();
    expect(host.store!.aliveCount).toBe(2);
    expect(states).toEqual(['true/false']);
    client.undo();
    expect(host.store!.aliveCount).toBe(0);
    expect(states).toEqual(['true/false', 'false/true']);
    client.redo();
    expect(host.store!.aliveCount).toBe(2);
    expect(states.at(-1)).toBe('true/false');
  });
  it('undo is ignored mid-stroke and clear can be undone', () => {
    const { client, host } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    client.historyBegin();
    draw(e, 50);
    client.undo(); // a stroke is open: nothing happens
    expect(host.store!.aliveCount).toBe(2);
    client.historyEnd();
    client.clear();
    expect(host.store!.aliveCount).toBe(0);
    client.undo();
    expect(host.store!.aliveCount).toBe(2);
  });
  it('replays the tiles an undo dirtied so the canvas shows it', () => {
    const { client, ctx } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    ctx.calls.length = 0;
    client.undo();
    expect(ctx.calls.some((c) => c.startsWith('fillRect'))).toBe(true); // background redrawn where the shape was
  });
});

describe('export over the protocol', () => {
  it('returns an SVG blob of the committed log and a PNG blob at the asked scale', async () => {
    const { client } = rig({ worker: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    const svg = await client.export('svg');
    expect(svg.type).toBe('image/svg+xml');
    expect(await svg.text()).toContain('<path ');
    const png = await client.export('png', { scale: 2 });
    expect(png.type).toBe('image/png');
  });
  it('rejects when the host cannot export', async () => {
    const r = rig({ worker: true });
    (r.host as unknown as { opts: { makeCanvas?: unknown } }).opts.makeCanvas = () => { throw new Error('no canvas'); };
    await expect(r.client.export('png')).rejects.toThrow('no canvas');
  });
});

const pageA = { pageId: 'A', width: 300, height: 200, background: 0xffffff };
const pageB = { pageId: 'B', width: 300, height: 200, background: 0xffffff };

describe('pages and autosave over the protocol', () => {
  it('opens an empty page, saves a drawing, and restores it after switching away and back', async () => {
    const mem = new MemoryStorage();
    const { client, host } = rig({ worker: true, storage: mem });
    expect(await client.openPage(pageA)).toEqual({ empty: true });
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e, 0);
    draw(e, 50);
    expect(host.store!.aliveCount).toBe(2);
    expect(await client.openPage(pageB)).toEqual({ empty: true }); // page A is flushed on the way out
    expect(host.store!.aliveCount).toBe(0);
    expect((await mem.blobKeys('p:A:')).length).toBeGreaterThan(0);
    expect(await client.openPage(pageA)).toEqual({ empty: false });
    expect(host.store!.aliveCount).toBe(2);
  });
  it('loading a page is not an undoable edit, and history starts clean', async () => {
    const mem = new MemoryStorage();
    const { client } = rig({ worker: true, storage: mem });
    const states: string[] = [];
    client.onHistory = (u, r) => void states.push(`${u}/${r}`);
    await client.openPage(pageA);
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    await client.openPage(pageB);
    await client.openPage(pageA);
    expect(states.at(-1)).toBe('false/false'); // nothing to undo right after a load
  });
  it('reports saving then saved, and flushPage writes at once', async () => {
    const mem = new MemoryStorage();
    const { client } = rig({ worker: true, storage: mem });
    const seen: string[] = [];
    client.onSave = (s) => void seen.push(s);
    await client.openPage(pageA);
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    await client.flushPage();
    expect(seen).toEqual(['saving', 'saved']);
    expect((await mem.blobKeys('p:A:log:')).length).toBe(1);
  });
  it('a failed write is reported and retried, not lost', async () => {
    const mem = new MemoryStorage();
    const { client } = rig({ worker: true, storage: mem });
    const seen: string[] = [];
    client.onSave = (s) => void seen.push(s);
    await client.openPage(pageA);
    const e = new Engine(1, client);
    e.select(shapes());
    mem.failWrites = true;
    draw(e);
    await expect(client.flushPage()).rejects.toThrow('quota');
    expect(seen.at(-1)).toBe('error');
    mem.failWrites = false;
    await client.flushPage();
    expect(seen.at(-1)).toBe('saved');
    expect(await client.openPage(pageB)).toEqual({ empty: true });
    expect(await client.openPage(pageA)).toEqual({ empty: false }); // the drawing survived the failed write
  });
  it('flushPage with nothing open or nothing pending still answers', async () => {
    const { client } = rig({ worker: true, storage: new MemoryStorage() });
    await expect(client.flushPage()).resolves.toBeUndefined(); // no page open yet
    await client.openPage(pageA);
    await expect(client.flushPage()).resolves.toBeUndefined(); // nothing changed
  });
  it('commits sent while a page is loading land on the new page', async () => {
    const mem = new MemoryStorage();
    const { client, host } = rig({ worker: true, storage: mem });
    await client.openPage(pageA);
    const e = new Engine(1, client);
    e.select(shapes());
    draw(e);
    const opening = client.openPage(pageB);
    draw(e, 60); // sent before the load finished
    await opening;
    expect(host.store!.aliveCount).toBe(1);
    await client.openPage(pageA);
    expect(host.store!.aliveCount).toBe(1); // page A kept only its own stroke
  });
  it('rejects when the host has no storage', async () => {
    const { client } = rig({ worker: true });
    await expect(client.openPage(pageA)).rejects.toThrow('storage');
  });
});

describe('Repeat over the protocol', () => {
  const setup = () => {
    const r = rig({ worker: true });
    const clones: Shape[] = [];
    let commits = 0;
    r.client.onRepeatClone = (s) => void clones.push(s);
    r.client.onRepeatCommit = () => void commits++;
    const e = new Engine(1, r.client);
    e.select(shapes());
    stroke(e, [[0, 0, 0], [40, 0, 8], [40, 40, 16], [0, 40, 24], [0, 1, 32]]); // a 40 x 40 loop
    r.client.setAffect('affect.repeat', true);
    const hover = (x: number, y: number, t: number) => { r.client.hover(x, y, t); r.client.flush(); };
    return { ...r, clones, hover, commits: () => commits };
  };

  it('stamps the shape under the pointer, translated by how far the pointer moved since the grab', () => {
    const { clones, hover } = setup();
    hover(20, 20, 0);
    expect(clones).toHaveLength(1);
    expect(Array.from(clones[0].vtx.slice(0, 2))).toEqual([0, 0]); // first stamp lands on the source
    hover(30, 25, 200);
    expect(clones).toHaveLength(2);
    expect(Array.from(clones[1].vtx.slice(0, 2))).toEqual([10, 5]); // pointer moved (10, 5)
  });
  it('is throttled by the gap (150 ms by default)', () => {
    const { clones, hover } = setup();
    hover(20, 20, 0);
    hover(22, 20, 100);
    hover(24, 20, 149);
    expect(clones).toHaveLength(1);
    hover(26, 20, 150);
    expect(clones).toHaveLength(2);
  });
  it('asks the main thread to place its stamps after three hovers outside, and not again', () => {
    const { hover, commits } = setup();
    hover(20, 20, 0);
    hover(500, 500, 200);
    hover(500, 500, 400);
    expect(commits()).toBe(0);
    hover(500, 500, 600);
    expect(commits()).toBe(1);
    hover(500, 500, 800);
    expect(commits()).toBe(1);
  });
  it('places on pointerdown while the pointer is over the shape, but not once it has been away', () => {
    const { client, hover, commits } = setup();
    hover(20, 20, 0);
    client.event('down');
    expect(commits()).toBe(1);
    for (let i = 1; i <= 4; i++) hover(500, 500, i * 200); // away: 3rd hover commits, the 4th is past it
    const afterAway = commits();
    client.event('down');
    expect(commits()).toBe(afterAway);
  });
  it('key B toggles stamping off and on', () => {
    const { client, clones, hover } = setup();
    client.event('key', 'KeyB');
    hover(20, 20, 0);
    expect(clones).toHaveLength(0);
    client.event('key', 'KeyB');
    hover(20, 20, 200);
    expect(clones).toHaveLength(1);
  });
  it('event messages are not sent while no committed affect is on', () => {
    const { client, sent } = rig({ worker: true });
    client.event('down');
    expect(sent.some((m) => m.type === 'event')).toBe(false);
  });
});

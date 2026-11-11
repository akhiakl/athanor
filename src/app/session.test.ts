import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Docs } from '../doc/docs';
import { MemoryStorage } from '../doc/storage';
import type { Engine } from '../engine/engine';
import type { RenderClient } from '../render/client';
import { createPages } from './pages';
import { createSession } from './session';

async function setup() {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
  let n = 0;
  const docs = new Docs(new MemoryStorage(), () => 1000 + n, () => `id${++n}`);
  const state = { revision: 0, cleared: 0, failFlush: false };
  const client = {
    onSave: null,
    openPage: async () => ({ empty: true }),
    flushPage: async () => { if (state.failFlush) throw new Error('quota'); return { revision: state.revision }; },
    clear: () => { state.cleared++; state.revision++; }, // clearing is a change like any other
  } as unknown as RenderClient;
  const said: string[] = [];
  const pages = createPages(docs, client, { commit() {} } as unknown as Engine, () => ({ w: 800, h: 600 }), (m) => said.push(m));
  await pages.boot();
  const session = createSession(docs, pages, client, (m) => said.push(m), () => new Date(2026, 10, 12, 1, 2, 3));
  return { docs, pages, client, state, said, session };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('session recording', () => {
  it('snapshots only when the page changed, as a session page after the current one', async () => {
    const { session, pages, state } = await setup();
    await session.start();
    await session.tick();
    expect(pages.pages.value).toHaveLength(1); // unchanged since the baseline
    state.revision = 3;
    await session.tick();
    expect(pages.pages.value).toHaveLength(2);
    const snap = pages.pages.value[1];
    expect(snap.origin).toBe('session');
    expect(snap.name).toBe('session-20261112-010203');
    expect(pages.current.value).toBe(pages.pages.value[0].id); // the editor stays on the page being drawn
    await session.tick();
    expect(pages.pages.value).toHaveLength(2); // still unchanged since the snapshot
  });
  it('accumulates snapshots in order, each after the previous one', async () => {
    const { session, pages, state } = await setup();
    await session.start();
    for (const r of [1, 2, 3]) { state.revision = r; await session.tick(); }
    expect(pages.pages.value.map((p) => p.origin)).toEqual(['user', 'session', 'session', 'session']);
    expect(session.count.value).toBe(3);
  });
  it('autoClear clears the page after a snapshot and does not snapshot the blank page next round', async () => {
    const { session, pages, state } = await setup();
    session.setAutoClear(true);
    await session.start();
    state.revision = 5;
    await session.tick();
    expect(state.cleared).toBe(1);
    expect(pages.pages.value).toHaveLength(2);
    await session.tick(); // the clear itself is not "new drawing"
    expect(pages.pages.value).toHaveLength(2);
    state.revision += 4; // the user draws again
    await session.tick();
    expect(pages.pages.value).toHaveLength(3);
  });
  it('runs on its interval and stops when asked', async () => {
    const { session, pages, state } = await setup();
    session.setInterval(30);
    await session.start();
    state.revision = 1;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(pages.pages.value).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pages.pages.value).toHaveLength(2);
    session.stop();
    state.revision = 2;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pages.pages.value).toHaveLength(2);
    expect(session.recording.value).toBe(false);
  });
  it('changing the interval while recording restarts the period', async () => {
    const { session, pages, state } = await setup();
    await session.start(); // 60 s
    state.revision = 1;
    await vi.advanceTimersByTimeAsync(50_000);
    session.setInterval(10);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(pages.pages.value).toHaveLength(2);
  });
  it('ignores rounds that overlap and survives a failed flush', async () => {
    const { session, pages, state, said } = await setup();
    await session.start();
    state.revision = 1;
    state.failFlush = true;
    await session.tick();
    expect(pages.pages.value).toHaveLength(1);
    expect(said.at(-1)).toContain('Could not save a snapshot');
    state.failFlush = false;
    await Promise.all([session.tick(), session.tick()]); // two at once: one snapshot
    expect(pages.pages.value).toHaveLength(2);
  });
  it('remembers interval and autoClear, and rejects intervals it does not offer', async () => {
    const a = await setup();
    a.session.setInterval(120);
    a.session.setAutoClear(true);
    a.session.setInterval(7);
    expect(a.session.intervalSec.value).toBe(120);
    const b = createSession(a.docs, a.pages, a.client, () => {});
    expect([b.intervalSec.value, b.autoClear.value]).toEqual([120, true]);
  });
  it('toggle starts and stops, announcing each', async () => {
    const { session, said } = await setup();
    await session.toggle();
    expect(session.recording.value).toBe(true);
    session.toggle();
    expect(session.recording.value).toBe(false);
    expect(said).toContain('Recording');
    expect(said.at(-1)).toBe('Recording stopped, 0 snapshots');
  });
});

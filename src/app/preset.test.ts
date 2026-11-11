import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Docs } from '../doc/docs';
import { MemoryStorage } from '../doc/storage';
import { Engine } from '../engine/engine';
import { repeatStamps } from '../modules/affect/repeatStamps';
import { CaptureSink } from '../test/helpers';
import type { RenderClient } from '../render/client';
import { templateById } from '../home/templates';
import { createApp } from './app';
import { applyPreset } from './preset';
import { createPages } from './pages';
import { createSession } from './session';
import { watchThumbs, THUMB_DELAY_MS } from './thumbs';

beforeEach(() => {
  vi.useFakeTimers();
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function rig() {
  let n = 0;
  const docs = new Docs(new MemoryStorage(), () => 1000 + n, () => `id${++n}`);
  const state = { revision: 1, exports: 0, fail: false };
  const client = {
    onSave: null as unknown, setAffect() {}, clear() {}, select() {},
    openPage: async () => ({ empty: true }),
    flushPage: async () => ({ revision: state.revision }),
    export: async (f: string, o: { scale: number }) => { if (state.fail) throw new Error('no canvas'); state.exports++; return new Blob([f + o.scale], { type: 'image/webp' }); },
  } as unknown as RenderClient & { onSave: ((s: string) => void) | null };
  const engine = new Engine(1, new CaptureSink());
  const app = createApp(engine, client, repeatStamps(), { redraw() {} });
  const pages = createPages(docs, client, engine, () => ({ w: 800, h: 600 }), () => {});
  const session = createSession(docs, pages, client, () => {});
  return { docs, client, engine, app, pages, session, state };
}

describe('template presets', () => {
  it('Mirror mandala turns Mirror on with both axes', () => {
    const r = rig();
    applyPreset(templateById('mandala').preset!, r.app, r.session);
    expect(r.engine.hasAffect('affect.mirror')).toBe(true);
    expect(r.app.valuesOf('affect.mirror')).toMatchObject({ horizontal: true, vertical: true });
  });
  it('Blind warm-up turns Blindness on, and applying twice does not toggle it off', () => {
    const r = rig();
    const p = templateById('blind').preset!;
    applyPreset(p, r.app, r.session);
    applyPreset(p, r.app, r.session);
    expect(r.engine.hasAffect('affect.blindness')).toBe(true);
  });
  it('Timed session sets the interval and auto-clear without starting', () => {
    const r = rig();
    applyPreset(templateById('timed').preset!, r.app, r.session);
    expect([r.session.intervalSec.value, r.session.autoClear.value, r.session.recording.value]).toEqual([60, true, false]);
  });
  it('selects a create module and ignores an unknown one', () => {
    const r = rig();
    applyPreset({ create: 'create.speedShapes' }, r.app, r.session);
    expect(r.app.createId.value).toBe('create.speedShapes');
    applyPreset({ create: 'create.nope' }, r.app, r.session);
    expect(r.app.createId.value).toBe('create.speedShapes');
  });
});

describe('thumbnail watcher', () => {
  it('renders page 1 once after saving settles, stores it without moving "last edited", and skips an unchanged page', async () => {
    const r = rig();
    await r.pages.boot();
    const before = (await r.docs.getFile(r.pages.file.value!.id))!.updatedAt;
    const stop = watchThumbs(r.docs, r.pages, r.client);
    r.pages.save.value = 'saving';
    r.pages.save.value = 'saved';
    await vi.advanceTimersByTimeAsync(THUMB_DELAY_MS - 100);
    expect(r.state.exports).toBe(0); // still settling
    await vi.advanceTimersByTimeAsync(200);
    expect(r.state.exports).toBe(1);
    const f = (await r.docs.getFile(r.pages.file.value!.id))!;
    expect(f.thumb?.type).toBe('image/webp');
    expect(f.updatedAt).toBe(before);
    r.pages.save.value = 'saving'; r.pages.save.value = 'saved'; // saved again, nothing changed
    await vi.advanceTimersByTimeAsync(THUMB_DELAY_MS + 100);
    expect(r.state.exports).toBe(1);
    stop();
  });
  it('only page 1 gets a thumbnail, and a failed render is retried next time', async () => {
    const r = rig();
    await r.pages.boot();
    await r.pages.add(); // now on page 2
    const stop = watchThumbs(r.docs, r.pages, r.client);
    r.pages.save.value = 'saved';
    await vi.advanceTimersByTimeAsync(THUMB_DELAY_MS + 100);
    expect(r.state.exports).toBe(0);
    await r.pages.step(-1);
    r.state.fail = true;
    r.pages.save.value = 'saving'; r.pages.save.value = 'saved';
    await vi.advanceTimersByTimeAsync(THUMB_DELAY_MS + 100);
    r.state.fail = false;
    r.pages.save.value = 'saving'; r.pages.save.value = 'saved';
    await vi.advanceTimersByTimeAsync(THUMB_DELAY_MS + 100);
    expect(r.state.exports).toBe(1);
    stop();
  });
});

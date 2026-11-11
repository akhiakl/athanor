import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Docs } from '../doc/docs';
import { MemoryStorage } from '../doc/storage';
import type { Engine } from '../engine/engine';
import type { RenderClient } from '../render/client';
import { createPages } from './pages';

function setup(storage = new MemoryStorage()) {
  let n = 0;
  const docs = new Docs(storage, () => 1000 + n, () => `id${++n}`);
  const opened: string[] = [];
  const flushes = { n: 0, fail: false };
  const client = {
    onSave: null as unknown,
    openPage: async (p: { pageId: string }) => { opened.push(p.pageId); return { empty: true }; },
    flushPage: async () => { flushes.n++; if (flushes.fail) throw new Error('quota'); },
  } as unknown as RenderClient & { onSave: ((s: string, m?: string) => void) | null };
  const engine = { commit: () => { opened.push('commit'); } } as unknown as Engine;
  const said: string[] = [];
  const pages = createPages(docs, client, engine, () => ({ w: 800, h: 600 }), (m) => said.push(m));
  return { docs, pages, opened, said, client, flushes, storage };
}

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
});

describe('pages controller', () => {
  it('boots a new file with one page at the viewport size and opens it', async () => {
    const { pages, opened, docs } = setup();
    await pages.boot();
    expect(pages.ready.value).toBe(true);
    expect(pages.pages.value).toHaveLength(1);
    expect(pages.current.value).toBe(pages.pages.value[0].id);
    expect([pages.pages.value[0].width, pages.pages.value[0].height]).toEqual([800, 600]);
    expect(opened).toEqual(['commit', pages.current.value]); // the stroke in flight is committed before the switch
    expect((await docs.listFiles())).toHaveLength(1);
  });
  it('reopens the last file at the page it was left on', async () => {
    const s = setup();
    await s.pages.boot();
    await s.pages.add();
    const second = s.pages.current.value;
    const again = setup(s.storage);
    await again.pages.boot();
    expect(again.pages.pages.value).toHaveLength(2);
    expect(again.pages.current.value).toBe(second);
    expect((await again.docs.listFiles())).toHaveLength(1); // no second file
  });
  it('adds, steps and stops at the ends', async () => {
    const { pages, said } = setup();
    await pages.boot();
    await pages.add();
    await pages.add();
    expect(pages.pages.value).toHaveLength(3);
    expect(pages.index()).toBe(2);
    await pages.step(1);
    expect(pages.index()).toBe(2); // no wrap
    await pages.step(-1);
    expect(pages.index()).toBe(1);
    await pages.step(-1);
    await pages.step(-1);
    expect(pages.index()).toBe(0);
    expect(said).toContain('Page 1 of 3');
  });
  it('serializes rapid page changes so opens never interleave', async () => {
    const { pages, opened } = setup();
    await pages.boot();
    await pages.add();
    await pages.add();
    opened.length = 0;
    await pages.show(pages.pages.value[0].id);
    const a = pages.step(1), b = pages.step(1);
    await Promise.all([a, b]);
    expect(pages.index()).toBe(2);
    expect(opened.filter((x) => x !== 'commit')).toHaveLength(3);
  });
  it('duplicates after flushing the open page, so the copy has the latest drawing', async () => {
    const { pages, flushes } = setup();
    await pages.boot();
    await pages.duplicate();
    expect(flushes.n).toBe(1);
    expect(pages.pages.value).toHaveLength(2);
    expect(pages.pages.value[1].name).toContain('copy');
    expect(pages.current.value).toBe(pages.pages.value[1].id);
  });
  it('still duplicates when the flush failed (the failure is already reported)', async () => {
    const { pages, flushes } = setup();
    await pages.boot();
    flushes.fail = true;
    await pages.duplicate();
    expect(pages.pages.value).toHaveLength(2);
  });
  it('deletes a page, moves to a neighbour, and refuses the last one with a message', async () => {
    const { pages, said } = setup();
    await pages.boot();
    const first = pages.current.value;
    await pages.add();
    await pages.remove();
    expect(pages.current.value).toBe(first);
    expect(pages.pages.value).toHaveLength(1);
    await pages.remove();
    expect(pages.pages.value).toHaveLength(1);
    expect(said.at(-1)).toBe('A file needs at least one page');
  });
  it('renames and reorders', async () => {
    const { pages } = setup();
    await pages.boot();
    const first = pages.current.value;
    await pages.add();
    await pages.rename(first, 'Sketch');
    expect(pages.pages.value[0].name).toBe('Sketch');
    await pages.move(first, 1);
    expect(pages.pages.value.map((p) => p.name)[1]).toBe('Sketch');
  });
  it('tracks the save state and says so when saving fails', async () => {
    const { pages, client, said } = setup();
    client.onSave?.('saving');
    expect(pages.save.value).toBe('saving');
    client.onSave?.('error', 'quota');
    expect(pages.save.value).toBe('error');
    expect(pages.saveMessage.value).toBe('quota');
    expect(said.at(-1)).toContain('Could not save');
    client.onSave?.('saved');
    expect(pages.save.value).toBe('saved');
  });
  it('boots the file and page a route names, and throws NotFoundError for a missing or trashed file', async () => {
    const s = setup();
    const a = await s.docs.createFile('A', 800, 600);
    const p2 = await s.docs.addPage(a.file.id);
    await s.pages.boot({ fileId: a.file.id, pageId: a.page.id });
    expect(s.pages.current.value).toBe(a.page.id); // the page asked for, not the last used
    await s.pages.show(p2.id);
    await s.pages.boot({ fileId: a.file.id });
    expect(s.pages.current.value).toBe(p2.id); // no page given: where it was left
    await s.pages.boot({ fileId: a.file.id, pageId: 'nope' });
    expect(s.pages.current.value).toBe(p2.id); // an unknown page falls back
    await expect(s.pages.boot({ fileId: 'missing' })).rejects.toMatchObject({ name: 'NotFoundError' });
    await s.docs.trashFile(a.file.id);
    await expect(s.pages.boot({ fileId: a.file.id })).rejects.toMatchObject({ name: 'NotFoundError' });
  });
  it('reopen loads the current page again (after the worker was replaced)', async () => {
    const { pages, opened } = setup();
    await pages.boot();
    opened.length = 0;
    await pages.reopen();
    expect(opened).toEqual(['commit', pages.current.value]);
  });
});

import { describe, expect, it } from 'vitest';
import { LINE, MOVE } from '../core/arena';
import { CommittedStore } from '../render/committed';
import { HistoryLog } from '../render/history';
import { mkShape, squareShape } from '../test/helpers';
import { Docs, newId } from './docs';
import { Kind, applySegments, concat, decodeSegments, encodeSegment } from './pageLog';
import { COMPACT_SLACK, PagePersistence } from './persistence';
import { PageRecorder } from './recorder';
import { PageSaver } from './saver';
import { MemoryStorage } from './storage';

const header = { width: 800, height: 600, background: 0xffffff };
const store = () => new CommittedStore(256, 800, 600);
const state = (s: CommittedStore) => s.entries.map((e) => [e.alive, Array.from(e.shape.vtx)]);
const replay = (bytes: Uint8Array, into = store()) => { applySegments(into, decodeSegments(bytes).segments); return into; };

describe('PageRecorder', () => {
  it('records adds, removals, revives and mutations so a replay matches the live store', () => {
    const live = store();
    const rec = new PageRecorder(live); rec.attach();
    live.add(squareShape(0, 0)); live.add(squareShape(30, 0)); live.add(squareShape(60, 0));
    live.remove(1);
    live.revive(1);
    live.remove(0);
    live.entries[2].shape.vtx[0] = 99; live.touch(2);
    const copy = replay(rec.flush()!);
    expect(state(copy)).toEqual(state(live));
    expect(copy.aliveIds()).toEqual([1, 2]);
  });
  it('stores a shape that was added and jittered in one window once, in its final state', () => {
    const live = store();
    const rec = new PageRecorder(live); rec.attach();
    live.add(mkShape([MOVE, LINE], [0, 0, 10, 0]));
    for (let i = 0; i < 50; i++) { live.entries[0].shape.vtx[2] += 1; live.touch(0); }
    const segs = decodeSegments(rec.flush()!).segments;
    expect(segs.map((s) => s.kind)).toEqual([Kind.Commit]); // no 50 mutate segments
    expect(state(replay(concat(segs.map((s) => encodeSegment(s)))))).toEqual(state(live));
  });
  it('coalesces repeated mutations of an older shape into one segment', () => {
    const live = store();
    live.add(mkShape([MOVE, LINE], [0, 0, 10, 0]));
    const rec = new PageRecorder(live); rec.attach();
    for (let i = 0; i < 30; i++) { live.entries[0].shape.vtx[2] += 1; live.touch(0); }
    expect(decodeSegments(rec.flush()!).segments.map((s) => s.kind)).toEqual([Kind.Mutate]);
  });
  it('sees undo and redo, which the history applies silently', () => {
    const live = store();
    const log = new HistoryLog(live, 200, () => 0); live.journal = log;
    const rec = new PageRecorder(live); rec.attach();
    log.scope(() => live.add(squareShape(0, 0)));
    log.undo();
    log.redo();
    log.undo();
    expect(state(replay(rec.flush()!))).toEqual(state(live)); // alive=false at the end
    expect(live.aliveCount).toBe(0);
  });
  it('flushes nothing when nothing changed, and stops after detach', () => {
    const live = store();
    const rec = new PageRecorder(live); rec.attach();
    expect(rec.flush()).toBeNull();
    rec.detach();
    live.add(squareShape(0, 0));
    expect(rec.dirty).toBe(false);
  });
});

describe('PagePersistence', () => {
  it('loads what was appended, across chunks', async () => {
    const mem = new MemoryStorage();
    const live = store();
    const p = new PagePersistence(mem, 'pg', header);
    const saver = new PageSaver(live, p, () => {}, 0, false);
    live.add(squareShape(0, 0)); await saver.flush();
    live.add(squareShape(30, 0)); live.remove(0); await saver.flush();
    const copy = store();
    const r = await PagePersistence.restore(mem, 'pg', copy, header);
    expect(r.loaded).toBe(true);
    expect(state(copy)).toEqual(state(live));
  });
  it('an unknown page loads as empty', async () => {
    const r = await PagePersistence.restore(new MemoryStorage(), 'none', store(), header);
    expect(r.loaded).toBe(false);
  });
  it('loses only the torn last chunk after a crash mid-write', async () => {
    const mem = new MemoryStorage();
    const live = store();
    const saver = new PageSaver(live, new PagePersistence(mem, 'pg', header), () => {}, 0, false);
    live.add(squareShape(0, 0)); await saver.flush();
    live.add(squareShape(30, 0)); await saver.flush();
    const k = (await mem.blobKeys('p:pg:log:')).at(-1)!;
    mem.blobs.set(k, mem.blobs.get(k)!.subarray(0, 12)); // power loss in the second chunk
    const copy = store();
    await PagePersistence.restore(mem, 'pg', copy, header);
    expect(copy.aliveIds()).toEqual([0]);
  });
  it('compacts into a snapshot and keeps loading the same state', async () => {
    const mem = new MemoryStorage();
    const live = store();
    const p = new PagePersistence(mem, 'pg', header);
    const saver = new PageSaver(live, p, () => {}, 0, false);
    for (let i = 0; i < 4; i++) { live.add(squareShape(i * 30, 0)); await saver.flush(); }
    live.remove(2);
    await saver.flush();
    await p.compact(live);
    expect(await mem.blobKeys('p:pg:log:')).toEqual([]);
    expect((await mem.blobKeys('p:pg:snap:')).length).toBe(1);
    live.add(squareShape(200, 0)); await saver.flush(); // appends after the snapshot
    const copy = store();
    await PagePersistence.restore(mem, 'pg', copy, header);
    expect(state(copy)).toEqual(state(live));
  });
  it('never replays a chunk twice when a crash left old chunks behind a new snapshot', async () => {
    const mem = new MemoryStorage();
    const live = store();
    const p = new PagePersistence(mem, 'pg', header);
    const saver = new PageSaver(live, p, () => {}, 0, false);
    live.add(squareShape(0, 0)); await saver.flush();
    live.add(squareShape(30, 0)); await saver.flush();
    const old = new Map([...mem.blobs].filter(([k]) => k.includes(':log:')));
    await p.compact(live);
    for (const [k, v] of old) mem.blobs.set(k, v); // the deletes never happened
    const copy = store();
    await PagePersistence.restore(mem, 'pg', copy, header);
    expect(copy.entries).toHaveLength(2); // not 4
    expect(state(copy)).toEqual(state(live));
  });
  it('asks for compaction once the log outgrows twice the snapshot plus slack', async () => {
    const mem = new MemoryStorage();
    const live = store();
    const p = new PagePersistence(mem, 'pg', header);
    expect(p.needsCompaction).toBe(false);
    await p.append(new Uint8Array(COMPACT_SLACK + 10));
    expect(p.needsCompaction).toBe(true);
    await p.compact(live);
    expect(p.needsCompaction).toBe(false);
  });
  it('destroy removes every blob of the page and nobody else', async () => {
    const mem = new MemoryStorage();
    const a = new PagePersistence(mem, 'a', header), b = new PagePersistence(mem, 'b', header);
    await a.append(new Uint8Array(3)); await b.append(new Uint8Array(3));
    await a.destroy();
    expect(await mem.blobKeys('p:a:')).toEqual([]);
    expect((await mem.blobKeys('p:b:')).length).toBe(1);
  });
});

describe('PageSaver', () => {
  it('keeps what it could not write and retries it in order, reporting status', async () => {
    const mem = new MemoryStorage();
    const live = store();
    const seen: string[] = [];
    const saver = new PageSaver(live, new PagePersistence(mem, 'pg', header), (s) => seen.push(s), 0, false);
    mem.failWrites = true;
    live.add(squareShape(0, 0)); await saver.flush();
    expect(saver.status).toBe('error');
    live.add(squareShape(30, 0));
    mem.failWrites = false;
    await saver.flush();
    expect(saver.status).toBe('saved');
    expect(seen).toEqual(['saving', 'error', 'saving', 'saved']);
    const copy = store();
    await PagePersistence.restore(mem, 'pg', copy, header);
    expect(copy.aliveIds()).toEqual([0, 1]); // nothing lost to the failed write
  });
  it('tick respects the interval', async () => {
    const mem = new MemoryStorage();
    const live = store();
    const saver = new PageSaver(live, new PagePersistence(mem, 'pg', header), () => {}, 1000, false);
    live.add(squareShape(0, 0));
    saver.tick(0); // first flush is immediate: lastFlush starts at -Infinity
    await saver.flush(0);
    live.add(squareShape(30, 0));
    saver.tick(500);
    expect(saver.recorder.dirty).toBe(true); // too soon
    saver.tick(1500);
    expect(saver.recorder.dirty).toBe(false);
  });
});

describe('ids', () => {
  it('are 26 chars, time sortable, and random in the tail', () => {
    const fixed = (n: number) => new Uint8Array(n).fill(7);
    const a = newId(1_000, fixed), b = newId(2_000, fixed);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
    expect(newId(1_000)).not.toBe(newId(1_000));
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(a)).toBe(true);
  });
});

describe('Docs', () => {
  let n = 0;
  const make = () => new Docs(new MemoryStorage(), () => 1000 + n, () => `id${++n}`);

  it('creates a file with one page and lists newest first, skipping the trash', async () => {
    const d = make();
    const a = await d.createFile('A', 800, 600);
    const b = await d.createFile('B', 100000, 0);
    expect(b.page.width).toBe(8192); // clamped
    expect(b.page.height).toBe(1);
    await d.renameFile(a.file.id, 'A2');
    expect((await d.listFiles()).map((f) => f.name)).toEqual(['A2', 'B']);
    await d.trashFile(b.file.id);
    expect((await d.listFiles()).map((f) => f.name)).toEqual(['A2']);
    await d.restoreFile(b.file.id);
    expect(await d.listFiles()).toHaveLength(2);
  });
  it('adds pages after a given page at its size, and keeps order', async () => {
    const d = make();
    const { file, page } = await d.createFile('F', 640, 480);
    const p2 = await d.addPage(file.id);
    const p3 = await d.addPage(file.id, page.id);
    expect((await d.pages(file.id)).map((p) => p.id)).toEqual([page.id, p3.id, p2.id]);
    expect([p3.width, p3.height]).toEqual([640, 480]);
    await d.movePage(p2.id, 0);
    expect((await d.pages(file.id)).map((p) => p.id)).toEqual([p2.id, page.id, p3.id]);
    await d.renamePage(p3.id, '  Sketch ');
    expect((await d.getPage(p3.id))!.name).toBe('Sketch');
    await d.renamePage(p3.id, '   '); // blank keeps the old name
    expect((await d.getPage(p3.id))!.name).toBe('Sketch');
  });
  it('duplicates a page with its saved drawing', async () => {
    const d = make();
    const { file, page } = await d.createFile('F', 800, 600);
    const live = store();
    const saver = new PageSaver(live, new PagePersistence(d.storage, page.id, header), () => {}, 0, false);
    live.add(squareShape(5, 5)); await saver.flush();
    const copy = await d.duplicatePage(page.id);
    expect((await d.pages(file.id)).map((p) => p.id)).toEqual([page.id, copy.id]);
    const restored = store();
    await PagePersistence.restore(d.storage, copy.id, restored, header);
    expect(state(restored)).toEqual(state(live));
  });
  it('deletes a page with its content, moves the cursor, and refuses the last page', async () => {
    const d = make();
    const { file, page } = await d.createFile('F', 800, 600);
    const p2 = await d.addPage(file.id);
    await new PagePersistence(d.storage, p2.id, header).append(new Uint8Array(3));
    expect(await d.deletePage(p2.id)).toBe(page.id);
    expect(await d.getPage(p2.id)).toBeUndefined();
    expect(await d.storage.blobKeys(`p:${p2.id}:`)).toEqual([]);
    expect((await d.getFile(file.id))!.lastPageId).toBe(page.id);
    await expect(d.deletePage(page.id)).rejects.toThrow('at least one page');
  });
  it('remembers the last page shown', async () => {
    const d = make();
    const { file } = await d.createFile('F', 800, 600);
    const p2 = await d.addPage(file.id);
    await d.setLastPage(file.id, p2.id);
    expect((await d.getFile(file.id))!.lastPageId).toBe(p2.id);
  });
});

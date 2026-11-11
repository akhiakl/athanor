import { describe, expect, it } from 'vitest';
import { CommittedStore } from '../render/committed';
import { squareShape } from '../test/helpers';
import { Docs } from './docs';
import { ImportError, exportAthanor, importAthanor, parseManifest } from './athanorFile';
import { applySegments } from './pageLog';
import { PagePersistence } from './persistence';
import { PageSaver } from './saver';
import { MemoryStorage } from './storage';
import { unzip, zip } from './zip';

let n = 0;
const make = () => new Docs(new MemoryStorage(), () => 1000 + n, () => `id${++n}`);
const header = { width: 640, height: 480, background: 0xffffff };

async function draw(d: Docs, pageId: string, xs: number[]): Promise<CommittedStore> {
  const live = new CommittedStore(256, 640, 480);
  const saver = new PageSaver(live, new PagePersistence(d.storage, pageId, header), () => {}, 0, false);
  for (const x of xs) live.add(squareShape(x, 0));
  live.remove(0);
  await saver.flush();
  return live;
}
const shapesOf = async (d: Docs, pageId: string) => {
  const s = new CommittedStore(256, 640, 480);
  const l = await new PagePersistence(d.storage, pageId, header).load();
  if (l) applySegments(s, l.segments);
  return s.entries.map((e) => [e.alive, Array.from(e.shape.vtx)]);
};

describe('.athanor export and import', () => {
  it('round-trips a multi-page file under new ids, keeping drawings, names and sizes', async () => {
    const d = make();
    const { file, page } = await d.createFile('Sketchbook', 640, 480);
    const p2 = await d.addPage(file.id);
    await d.renamePage(p2.id, 'Second');
    await draw(d, page.id, [0, 30, 60]);
    await draw(d, p2.id, [100]);
    const bytes = await exportAthanor(d, file.id);
    const imported = await importAthanor(d, bytes);
    expect(imported.file.id).not.toBe(file.id);
    expect(imported.file.name).toBe('Sketchbook');
    expect(imported.pages.map((p) => [p.name, p.width, p.height])).toEqual([['Page 1', 640, 480], ['Second', 640, 480]]);
    expect(await shapesOf(d, imported.pages[0].id)).toEqual(await shapesOf(d, page.id));
    expect(await shapesOf(d, imported.pages[1].id)).toEqual(await shapesOf(d, p2.id));
    expect((await d.listFiles()).length).toBe(2); // the original is untouched
  });
  it('an empty page exports and imports', async () => {
    const d = make();
    const { file } = await d.createFile('Blank', 320, 200);
    const back = await importAthanor(d, await exportAthanor(d, file.id));
    expect(back.pages).toHaveLength(1);
  });
  it('the archive is a plain ZIP with a readable manifest', async () => {
    const d = make();
    const { file } = await d.createFile('F', 320, 200);
    const entries = unzip(await exportAthanor(d, file.id));
    expect(entries.map((e) => e.name)[0]).toBe('manifest.json');
    const m = JSON.parse(new TextDecoder().decode(entries[0].data));
    expect(m).toMatchObject({ format: 'athanor', version: 1, name: 'F' });
  });
});

const manifest = (over: Record<string, unknown> = {}, pages: unknown[] = [{ id: 'p1', name: 'P', width: 100, height: 100, background: 0xffffff, origin: 'user' }]) =>
  JSON.stringify({ format: 'athanor', version: 1, name: 'F', createdAt: 1, pages, ...over });

describe('manifest validation', () => {
  it('accepts a good manifest', () => {
    expect(parseManifest(manifest()).pages).toHaveLength(1);
  });
  it.each([
    ['not json', '{nope', /not valid JSON/],
    ['wrong format', manifest({ format: 'other' }), /not an Athanor file/],
    ['newer version', manifest({ version: 2 }), /newer version/],
    ['version zero', manifest({ version: 0 }), /unknown format version/],
    ['no pages', manifest({}, []), /no pages/],
    ['bad size', manifest({}, [{ id: 'p1', name: 'P', width: 0, height: 10, background: 0, origin: 'user' }]), /invalid size/],
    ['huge size', manifest({}, [{ id: 'p1', name: 'P', width: 100000, height: 10, background: 0, origin: 'user' }]), /invalid size/],
    ['fractional size', manifest({}, [{ id: 'p1', name: 'P', width: 10.5, height: 10, background: 0, origin: 'user' }]), /invalid size/],
    ['bad colour', manifest({}, [{ id: 'p1', name: 'P', width: 10, height: 10, background: -1, origin: 'user' }]), /background/],
    ['bad origin', manifest({}, [{ id: 'p1', name: 'P', width: 10, height: 10, background: 0, origin: 'x' }]), /origin/],
    ['hostile id', manifest({}, [{ id: '../../etc', name: 'P', width: 10, height: 10, background: 0, origin: 'user' }]), /page id/],
    ['repeated id', manifest({}, [1, 2].map(() => ({ id: 'p1', name: 'P', width: 10, height: 10, background: 0, origin: 'user' }))), /repeated/],
  ])('rejects %s', (_n, json, re) => {
    expect(() => parseManifest(json as string)).toThrow(re as RegExp);
    expect(() => parseManifest(json as string)).toThrow(ImportError);
  });
});

describe('import failures leave nothing behind', () => {
  const good = async () => {
    const d = make();
    const { file, page } = await d.createFile('F', 640, 480);
    await draw(d, page.id, [0, 30]);
    return { d, bytes: await exportAthanor(d, file.id) };
  };
  it('rejects garbage and non-Athanor ZIPs', async () => {
    const d = make();
    await expect(importAthanor(d, new TextEncoder().encode('hello'))).rejects.toThrow(/damaged or not an Athanor/);
    await expect(importAthanor(d, zip([{ name: 'readme.txt', data: new Uint8Array(1) }]))).rejects.toThrow(/no manifest/);
    expect(await d.listFiles()).toEqual([]);
  });
  it('rejects a page whose snapshot is missing, damaged or the wrong size', async () => {
    const { d, bytes } = await good();
    const entries = unzip(bytes);
    const snap = entries.find((e) => e.name.endsWith('.snap'))!;
    await expect(importAthanor(d, zip(entries.filter((e) => e !== snap)))).rejects.toThrow(/missing its content/);
    const torn = { ...snap, data: snap.data.subarray(0, snap.data.length - 6) };
    await expect(importAthanor(d, zip(entries.map((e) => (e === snap ? torn : e))))).rejects.toThrow(/damaged/);
    const m = JSON.parse(new TextDecoder().decode(entries[0].data));
    m.pages[0].width = 100;
    const wrong = { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(m)) };
    await expect(importAthanor(d, zip([wrong, ...entries.slice(1)]))).rejects.toThrow(/does not match/);
    expect((await d.listFiles()).length).toBe(1); // only the original: failed imports wrote nothing
  });
  it('rejects a flipped byte through the ZIP CRC', async () => {
    const { d, bytes } = await good();
    const bad = bytes.slice();
    bad[60] ^= 0xff;
    await expect(importAthanor(d, bad)).rejects.toThrow(ImportError);
  });
});

describe('backup and restore (8.6.3)', async () => {
  const { backupAll, restoreBackup } = await import('./backup');
  const populated = async () => {
    const d = make();
    const a = await d.createFile('Alpha', 640, 480);
    const b = await d.createFile('Beta', 640, 480);
    await draw(d, a.page.id, [0, 30]);
    return { d, a, b };
  };

  it('backs up every file as one ZIP of .athanor files with distinct names', async () => {
    const { d } = await populated();
    await d.createFile('Alpha', 100, 100); // same name twice
    const { bytes, count } = await backupAll(d);
    expect(count).toBe(3);
    const names = unzip(bytes).map((e) => e.name).sort();
    expect(names).toEqual(['Alpha (2).athanor', 'Alpha.athanor', 'Beta.athanor']);
  });
  it('restores into an empty store with the original file ids and drawings', async () => {
    const { d, a } = await populated();
    const { bytes } = await backupAll(d);
    const fresh = make();
    const r = await restoreBackup(fresh, bytes);
    expect(r.restored.sort()).toEqual(['Alpha', 'Beta']);
    expect(r.skipped).toEqual([]);
    expect((await fresh.getFile(a.file.id))?.name).toBe('Alpha'); // the same id
    const pages = await fresh.pages(a.file.id);
    expect(await shapesOf(fresh, pages[0].id)).toEqual(await shapesOf(d, a.page.id));
  });
  it('restoring twice changes nothing: existing ids are skipped, trashed ones too', async () => {
    const { d, a } = await populated();
    const { bytes } = await backupAll(d);
    const r = await restoreBackup(d, bytes);
    expect(r.restored).toEqual([]);
    expect(r.skipped.sort()).toEqual(['Alpha', 'Beta']);
    expect((await d.listFiles()).length).toBe(2);
    await d.trashFile(a.file.id);
    expect((await restoreBackup(d, bytes)).skipped).toContain('Alpha'); // in the trash is still "exists"
  });
  it('reports a damaged file and still restores the others', async () => {
    const { d } = await populated();
    const entries = unzip((await backupAll(d)).bytes);
    const torn = { ...entries[0], data: entries[0].data.subarray(0, 40) };
    const fresh = make();
    const r = await restoreBackup(fresh, zip([torn, entries[1]]));
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].name).toBe(entries[0].name);
    expect(r.restored).toHaveLength(1);
  });
  it('accepts a single .athanor file, and rejects non-backups with a clear message', async () => {
    const { d, a } = await populated();
    const one = await exportAthanor(d, a.file.id);
    const fresh = make();
    expect((await restoreBackup(fresh, one)).restored).toEqual(['Alpha']);
    await expect(restoreBackup(fresh, new TextEncoder().encode('hello, not a zip file at all'))).rejects.toThrow(/not a backup/);
    await expect(restoreBackup(fresh, zip([{ name: 'readme.txt', data: new Uint8Array(1) }]))).rejects.toThrow(/no Athanor files/);
  });
  it('a file exported without an id imports as a new file', async () => {
    const d = make();
    const { file } = await d.createFile('Old', 100, 100);
    const entries = unzip(await exportAthanor(d, file.id));
    const m = JSON.parse(new TextDecoder().decode(entries[0].data));
    delete m.id;
    const old = zip([{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(m)) }, ...entries.slice(1)]);
    const r = await restoreBackup(d, old);
    expect(r.restored).toEqual(['Old']);
    expect((await d.listFiles()).length).toBe(2);
  });
});

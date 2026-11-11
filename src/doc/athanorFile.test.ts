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

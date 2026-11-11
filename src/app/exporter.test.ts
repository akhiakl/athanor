import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderClient } from '../render/client';
import { copyCanvas, defaultScale, exportName } from './exporter';

const blob = (type: string) => Promise.resolve(new Blob(['x'], { type }));
const fakeClient = () => {
  const calls: string[] = [];
  const client = { export: (format: string, o?: { scale?: number }) => { calls.push(`${format}@${o?.scale ?? 1}`); return blob(format === 'png' ? 'image/png' : 'image/svg+xml'); } } as unknown as RenderClient;
  return { client, calls };
};

afterEach(() => vi.unstubAllGlobals());

describe('export helpers', () => {
  it('names files by local time', () => {
    expect(exportName('png', new Date(2026, 10, 12, 1, 5, 3))).toBe('athanor-20261112-010503.png');
    expect(exportName('svg', new Date(2026, 0, 2, 13, 14, 15))).toBe('athanor-20260102-131415.svg');
  });
  it('defaults to the device pixel ratio inside 1..4 and the canvas limit', () => {
    expect(defaultScale(800, 600, 2)).toBe(2);
    expect(defaultScale(800, 600, 0.5)).toBe(1);
    expect(defaultScale(800, 600, 8)).toBe(4);
    expect(defaultScale(3000, 2000, 2)).toBe(1);
  });
});

describe('copy to clipboard (3.4.4)', () => {
  it('builds the ClipboardItem from promises synchronously and adds SVG only where supported', async () => {
    const written: Record<string, Promise<Blob>>[] = [];
    class Item { constructor(public items: Record<string, Promise<Blob>>) { written.push(items); } static supports = (t: string) => t === 'image/svg+xml'; }
    vi.stubGlobal('ClipboardItem', Item);
    vi.stubGlobal('navigator', { clipboard: { write: async () => {} } });
    const { client, calls } = fakeClient();
    const p = copyCanvas(client, 2);
    expect(calls).toEqual(['png@2', 'svg@1']); // both requested before anything was awaited
    expect(await p).toBe('png+svg');
    expect(Object.keys(written[0])).toEqual(['image/png', 'image/svg+xml']);
  });
  it('copies PNG only when SVG is not supported', async () => {
    class Item { constructor(_: Record<string, Promise<Blob>>) {} static supports = () => false; }
    vi.stubGlobal('ClipboardItem', Item);
    vi.stubGlobal('navigator', { clipboard: { write: async () => {} } });
    const { client, calls } = fakeClient();
    expect(await copyCanvas(client, 1)).toBe('png');
    expect(calls).toEqual(['png@1']);
  });
  it('says so when the browser cannot copy images', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyCanvas(fakeClient().client, 1)).rejects.toThrow('not supported');
  });
});

import { describe, expect, it } from 'vitest';
import { CUBIC, F_GRADIENT, H, LINE, MOVE, QUAD, CLOSE } from '../core/arena';
import { mkShape, squareShape } from '../test/helpers';
import { CommittedStore } from './committed';
import { MAX_PIXELS, maxScale, num, pathData, pngBlob, svgBlob, svgChunks, thumbBlob, type ExportCanvas } from './export';

const opts = { width: 300, height: 200, background: '#ffffff', transparent: false };
const entriesOf = (...shapes: ReturnType<typeof mkShape>[]) => {
  const s = new CommittedStore(256, 300, 200);
  for (const sh of shapes) s.add(sh);
  return s;
};

describe('number formatting', () => {
  it('keeps two decimals, trims zeros and never prints -0', () => {
    expect(num(1)).toBe('1');
    expect(num(1.006)).toBe('1.01');
    expect(num(2.5)).toBe('2.5');
    expect(num(-0.001)).toBe('0');
    expect(num(10.126)).toBe('10.13');
  });
});

describe('SVG path data', () => {
  it('emits M, L, Q, C and Z from the command stream', () => {
    const s = mkShape([MOVE, LINE, QUAD, CUBIC, CLOSE], [0, 0, 10, 0, 15, 5, 20, 0, 21, 1, 22, 2, 23, 3, 24, 4]);
    expect(pathData(s)).toBe('M0 0L10 0Q15 5 20 0C21 1 22 2 23 3Z'.replace('23 3Z', '23 3Z'));
  });
});

describe('SVG export (3.4.1)', () => {
  it('writes the background rect, then one path per live shape in log order', () => {
    const store = entriesOf(mkShape([MOVE, LINE], [0, 0, 10, 0], { lw: 2, rgba: 0xff000080 }), squareShape(5, 5));
    const svg = svgChunks(store.entries, opts).join('');
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">');
    expect(svg).toContain('<rect width="100%" height="100%" fill="#ffffff"/>');
    expect(svg).toContain('<path d="M0 0L10 0" fill="none" stroke="#ff0000" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel"/>');
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg.indexOf('M0 0L10 0')).toBeLessThan(svg.indexOf('M5 5'));
  });
  it('omits the background when transparent, and tombstoned shapes always', () => {
    const store = entriesOf(squareShape(0, 0), squareShape(20, 0));
    store.remove(0);
    const svg = svgChunks(store.entries, { ...opts, transparent: true }).join('');
    expect(svg).not.toContain('<rect');
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).not.toContain('M0 0');
  });
  it('fills use fill-rule and opacity', () => {
    const store = entriesOf(mkShape([MOVE, LINE, LINE, CLOSE], [0, 0, 9, 0, 9, 9], { fill: true, evenodd: true, rgba: 0x00ff0040 }));
    const svg = svgChunks(store.entries, opts).join('');
    expect(svg).toContain('fill="#00ff00" fill-opacity="0.25" fill-rule="evenodd"');
    expect(svg).not.toContain('stroke');
  });
  it('gradients become a linearGradient in defs and a url() paint; a degenerate one stays solid', () => {
    const g = mkShape([MOVE, LINE], [0, 0, 50, 0], { rgba: 0xff0000ff });
    g.hdr[H.FLAGS] |= F_GRADIENT;
    g.hdrF[H.GX1] = 0; g.hdrF[H.GY1] = 0; g.hdrF[H.GX2] = 50; g.hdrF[H.GY2] = 0;
    g.hdr[H.GRADIENT_RGBA2] = 0x0000ff00;
    const flat = mkShape([MOVE, LINE], [0, 10, 50, 10], { rgba: 0x00ff00ff });
    flat.hdr[H.FLAGS] |= F_GRADIENT; // endpoints all zero
    const svg = svgChunks(entriesOf(g, flat).entries, opts).join('');
    expect(svg).toContain('<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="50" y2="0" spreadMethod="pad">');
    expect(svg).toContain('<stop offset="0" stop-color="#ff0000" stop-opacity="1"/><stop offset="1" stop-color="#0000ff" stop-opacity="0"/>');
    expect(svg).toContain('stroke="url(#g0)"');
    expect(svg).toContain('stroke="#00ff00"'); // the degenerate gradient kept its solid colour
    expect(svg.match(/<linearGradient /g)).toHaveLength(1);
  });
  it('streams in chunks of about 64 KB and the Blob joins them', async () => {
    const store = new CommittedStore(256, 300, 200);
    for (let i = 0; i < 3000; i++) store.add(squareShape(i % 200, i % 100));
    const chunks = svgChunks(store.entries, opts);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(64 * 1024 + 400);
    const blob = svgBlob(store.entries, opts);
    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toBe(chunks.join(''));
  });
  it('writes a well-formed document: every path closes and the root closes', () => {
    const svg = svgChunks(entriesOf(squareShape(0, 0)).entries, opts).join('');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg.match(/<path [^>]*\/>/g)).toHaveLength(1);
  });
});

function fakeCanvas() {
  const calls: string[] = [];
  const dims = { w: 0, h: 0 };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => (k === 'calls' ? calls : (...a: unknown[]) => void calls.push(`${k}(${a.join(',')})`)),
    set: (_t, k: string, v) => { calls.push(`${k}=${String(v)}`); return true; },
  });
  const make = (w: number, h: number): ExportCanvas => {
    dims.w = w; dims.h = h;
    return { getContext: () => ctx as never, convertToBlob: async (o) => new Blob(['png'], { type: o?.type }) };
  };
  return { make, calls, dims };
}

describe('PNG export (3.4.2)', () => {
  it('is W*k by H*k, scaled by k, background first, then the shapes', async () => {
    const f = fakeCanvas();
    const blob = await pngBlob(entriesOf(squareShape(0, 0)).entries, opts, 3, f.make);
    expect(blob.type).toBe('image/png');
    expect([f.dims.w, f.dims.h]).toEqual([900, 600]);
    expect(f.calls[0]).toBe('setTransform(3,0,0,3,0,0)');
    expect(f.calls).toContain('fillStyle=#ffffff');
    expect(f.calls.indexOf('fillRect(0,0,300,200)')).toBeLessThan(f.calls.indexOf('stroke()'));
  });
  it('a transparent export skips the background fill', async () => {
    const f = fakeCanvas();
    await pngBlob(entriesOf(squareShape(0, 0)).entries, { ...opts, transparent: true }, 1, f.make);
    expect(f.calls.some((c) => c.startsWith('fillRect'))).toBe(false);
  });
  it('skips tombstoned shapes', async () => {
    const f = fakeCanvas();
    const store = entriesOf(squareShape(0, 0));
    store.remove(0);
    await pngBlob(store.entries, opts, 1, f.make);
    expect(f.calls.some((c) => c.startsWith('stroke'))).toBe(false);
  });
  it('clamps the scale so the canvas stays under 16.7 megapixels', async () => {
    const f = fakeCanvas();
    await pngBlob(entriesOf(squareShape(0, 0)).entries, { ...opts, width: 3000, height: 2000 }, 4, f.make);
    expect(f.dims.w * f.dims.h).toBeLessThanOrEqual(MAX_PIXELS);
    expect(maxScale(3000, 2000)).toBe(1);
    expect(maxScale(300, 200)).toBe(4);
    expect(maxScale(1920, 1080)).toBe(2);
  });
});

describe('thumbnail export', () => {
  it('is the requested width, keeps the aspect ratio, paints the page background and never enlarges', async () => {
    const f = fakeCanvas();
    await thumbBlob(entriesOf(squareShape(0, 0)).entries, opts, 150, f.make);
    expect([f.dims.w, f.dims.h]).toEqual([150, 100]);
    expect(f.calls[0]).toBe('setTransform(0.5,0,0,0.5,0,0)');
    expect(f.calls).toContain('fillStyle=#ffffff');
    await thumbBlob(entriesOf().entries, opts, 900, f.make);
    expect([f.dims.w, f.dims.h]).toEqual([300, 200]); // a small page is not upscaled
  });
});

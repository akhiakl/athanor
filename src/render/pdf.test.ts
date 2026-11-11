import { describe, expect, it } from 'vitest';
import { CLOSE, F_GRADIENT, H, LINE, MOVE, QUAD } from '../core/arena';
import { mkShape, squareShape } from '../test/helpers';
import { CommittedStore } from './committed';
import { pdfBytes, pdfBlob } from './pdf';

const text = (b: Uint8Array): string => Array.from(b, (c) => String.fromCharCode(c)).join('');
const store = (...shapes: ReturnType<typeof mkShape>[]) => {
  const s = new CommittedStore(256, 300, 200);
  for (const sh of shapes) s.add(sh);
  return s;
};
const page = (s: CommittedStore, w = 300, h = 200) => ({ width: w, height: h, background: 0xffffff, entries: s.entries });

/** Test-only reader: validates the xref table against real object offsets, the page tree and every stream length. */
function read(bytes: Uint8Array) {
  const t = text(bytes);
  expect(t.startsWith('%PDF-1.4\n')).toBe(true);
  expect(t.endsWith('%%EOF\n')).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(t)![1]);
  expect(t.slice(startxref, startxref + 4)).toBe('xref');
  const m = /xref\n0 (\d+)\n/.exec(t.slice(startxref))!;
  const count = Number(m[1]);
  const lines = t.slice(startxref + m[0].length).split('\n').slice(0, count);
  expect(lines[0]).toBe('0000000000 65535 f ');
  expect(lines.every((l) => l.length === 19)).toBe(true); // 19 chars + "\n" = the mandatory 20-byte entry
  const objs = new Map<number, string>();
  lines.slice(1).forEach((l, i) => {
    const n = i + 1, off = Number(l.slice(0, 10));
    expect(t.slice(off, off + `${n} 0 obj\n`.length)).toBe(`${n} 0 obj\n`);
    const end = t.indexOf('\nendobj\n', off);
    objs.set(n, t.slice(off + `${n} 0 obj\n`.length, end));
  });
  const size = Number(/\/Size (\d+)/.exec(t.slice(startxref))![1]);
  expect(size).toBe(count);
  for (const [n, body] of objs) { // every stream declares its true length
    const s = /\/Length (\d+) >>\nstream\n/.exec(body);
    if (s) expect(body.slice(s.index + s[0].length).replace(/\nendstream$/, '').length, `object ${n}`).toBe(Number(s[1]));
    for (const r of body.split('\nstream\n')[0].matchAll(/(\d+) 0 R\b/g)) expect(objs.has(Number(r[1])), `object ${n} refers to ${r[1]}`).toBe(true); // dictionaries only: stream data has operators like "0 0 RG"
  }
  const root = Number(/\/Root (\d+) 0 R/.exec(t)![1]);
  const kids = [...objs.get(Number(/\/Pages (\d+) 0 R/.exec(objs.get(root)!)![1]))!.matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1]));
  return { t, objs, pages: kids.map((k) => objs.get(k)!), content: (pageBody: string) => {
      const o = objs.get(Number(/\/Contents (\d+) 0 R/.exec(pageBody)![1]))!;
      return o.slice(o.indexOf('\nstream\n') + 8).replace(/\nendstream$/, '');
    },
  };
}

describe('PDF writer (3.4.3)', () => {
  it('writes a structurally valid document: xref offsets, page tree, stream lengths, references', () => {
    const r = read(pdfBytes([page(store(squareShape(5, 5)))]));
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toContain('/MediaBox [0 0 300 200]');
    expect(r.t).toContain('/Creator (Athanor)');
  });
  it('flips to a top-left origin, paints the background, then each shape in order', () => {
    const r = read(pdfBytes([page(store(mkShape([MOVE, LINE], [0, 0, 10, 0], { lw: 2, rgba: 0xff000080 }), squareShape(5, 5, 4)))]));
    const c = r.content(r.pages[0]);
    expect(c.startsWith('1 0 0 -1 0 200 cm\n1 1 1 rg\n0 0 300 200 re f\n')).toBe(true);
    expect(c).toContain('1 0 0 RG\n2 w 1 J 2 j\n0 0 m\n10 0 l\nS');
    expect(c.indexOf('10 0 l')).toBeLessThan(c.indexOf('5 5 m'));
    expect(c).toMatch(/h\nS\nQ/); // closed square, stroked
  });
  it('dedupes alpha states and applies them per shape', () => {
    const a = mkShape([MOVE, LINE], [0, 0, 5, 5], { rgba: 0x00ff0080 });
    const b = mkShape([MOVE, LINE], [0, 9, 5, 5], { rgba: 0x0000ff80 });
    const c = mkShape([MOVE, LINE], [0, 3, 5, 5], { rgba: 0x000000ff });
    const r = read(pdfBytes([page(store(a, b, c))]));
    expect(r.pages[0].match(/\/G128 \d+ 0 R/g)).toHaveLength(1);
    expect((r.content(r.pages[0]).match(/\/G128 gs/g) ?? [])).toHaveLength(2);
    expect([...r.objs.values()].filter((o) => o.includes('/ca 0.502')).length).toBe(1);
    expect(r.content(r.pages[0])).not.toMatch(/G255/); // opaque shapes need no state
  });
  it('fills use f or f*, and a quad is raised to a cubic with the right control points', () => {
    const q = mkShape([MOVE, QUAD, CLOSE], [0, 0, 30, 0, 60, 0], { fill: true });
    const eo = mkShape([MOVE, LINE, LINE, CLOSE], [0, 0, 9, 0, 9, 9], { fill: true, evenodd: true });
    const r = read(pdfBytes([page(store(q, eo))]));
    const c = r.content(r.pages[0]);
    expect(c).toContain('20 0 40 0 60 0 c');
    expect(c).toMatch(/h\nf\nQ/);
    expect(c).toMatch(/h\nf\*\nQ/);
    expect(c).not.toContain(' w '); // fills carry no stroke width
  });
  it('a gradient with equal alphas is a shading pattern; a fade adds a luminosity soft mask', () => {
    const solid = mkShape([MOVE, LINE], [0, 0, 50, 0], { rgba: 0xff0000ff });
    solid.hdr[H.FLAGS] |= F_GRADIENT; solid.hdrF[H.GX1] = 0; solid.hdrF[H.GY1] = 0; solid.hdrF[H.GX2] = 50; solid.hdrF[H.GY2] = 0; solid.hdr[H.GRADIENT_RGBA2] = 0x0000ffff;
    const fade = mkShape([MOVE, LINE], [0, 10, 50, 10], { rgba: 0xff0000ff });
    fade.hdr[H.FLAGS] |= F_GRADIENT; fade.hdrF[H.GX1] = 0; fade.hdrF[H.GY1] = 10; fade.hdrF[H.GX2] = 50; fade.hdrF[H.GY2] = 10; fade.hdr[H.GRADIENT_RGBA2] = 0x0000ff00;
    const r = read(pdfBytes([page(store(solid, fade))]));
    const bodies = [...r.objs.values()];
    expect(bodies.filter((b) => b.includes('/ShadingType 2 /ColorSpace /DeviceRGB')).length).toBe(2);
    expect(bodies.filter((b) => b.includes('/PatternType 2') && b.includes('/Matrix [1 0 0 -1 0 200]')).length).toBe(2);
    expect(bodies.some((b) => b.includes('/S /Luminosity'))).toBe(true);
    expect(bodies.filter((b) => b.includes('/DeviceGray')).length).toBeGreaterThan(0);
    expect(r.content(r.pages[0])).toMatch(/\/Pattern CS \/P1 SCN/);
    expect(r.content(r.pages[0])).toContain('/S2 gs'); // only the fading one is masked
  });
  it('a degenerate gradient stays a solid colour', () => {
    const g = mkShape([MOVE, LINE], [0, 0, 50, 0], { rgba: 0x00ff00ff });
    g.hdr[H.FLAGS] |= F_GRADIENT;
    const r = read(pdfBytes([page(store(g))]));
    expect(r.content(r.pages[0])).toContain('0 1 0 RG');
    expect(r.t).not.toContain('/PatternType');
  });
  it('writes one PDF page per document page, with their own sizes, and skips tombstones', () => {
    const s = store(squareShape(0, 0), squareShape(20, 0));
    s.remove(0);
    const r = read(pdfBytes([page(s), { width: 100, height: 50, background: 0x336699, entries: [] }]));
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1]).toContain('/MediaBox [0 0 100 50]');
    expect(r.content(r.pages[0]).match(/ m\n/g)).toHaveLength(1);
    expect(r.content(r.pages[1])).toContain('0.2 0.4 0.6 rg'); // background 0x336699
  });
  it('escapes the title and keeps the file ASCII apart from the binary marker', () => {
    const b = pdfBytes([page(store())], { title: 'Sketch (v2) \\ ü', created: new Date(Date.UTC(2026, 10, 12, 1, 2, 3)) });
    expect(text(b)).toContain('/Title (Sketch \\(v2\\) \\\\ ?)');
    expect(text(b)).toContain('D:20261112010203Z');
    const high = Array.from(b).filter((c) => c > 127).length;
    expect(high).toBe(4);
  });
  it('an empty document with no pages is still valid', () => {
    const r = read(pdfBytes([]));
    expect(r.pages).toEqual([]);
  });
  it('Blob has the PDF media type', () => {
    expect(pdfBlob([page(store())]).type).toBe('application/pdf');
  });
});

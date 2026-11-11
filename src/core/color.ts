// Java-compatible HSB <-> RGB (spec 5.4.7): h wraps, standard hexcone, channels rounded half up.
export function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  const to = (v: number) => Math.trunc(v * 255 + 0.5);
  if (s === 0) return [to(b), to(b), to(b)];
  const hh = (h - Math.floor(h)) * 6;
  const f = hh - Math.floor(hh);
  const p = b * (1 - s);
  const q = b * (1 - s * f);
  const t = b * (1 - s * (1 - f));
  switch (Math.trunc(hh)) {
    case 0: return [to(b), to(t), to(p)];
    case 1: return [to(q), to(b), to(p)];
    case 2: return [to(p), to(b), to(t)];
    case 3: return [to(p), to(q), to(b)];
    case 4: return [to(t), to(p), to(b)];
    default: return [to(b), to(p), to(q)];
  }
}

export function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  const s = max === 0 ? 0 : (max - min) / max;
  if (s === 0) return [0, 0, v];
  const d = max - min;
  const rc = (max - r) / d, gc = (max - g) / d, bc = (max - b) / d;
  let h = r === max ? bc - gc : g === max ? 2 + rc - bc : 4 + gc - rc;
  h /= 6;
  if (h < 0) h += 1;
  return [h, s, v];
}

/** Packed 0xRRGGBBAA as a signed int32 (the arena stores it that way). */
export const packRgba = (r: number, g: number, b: number, a: number): number => ((r << 24) | (g << 16) | (b << 8) | a) | 0;

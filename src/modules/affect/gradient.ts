import { F_GRADIENT, F_PEN_SHAPE, H, HDR_STRIDE, MAX_RECORDS } from '../../core/arena';
import type { AffectModule, Engine } from '../../engine/engine';
import type { Prng } from '../../core/prng';

/**
 * Gradient, spec 5.4.8: a linear gradient from the record colour to the same colour at alpha 0. Pen-drawn records follow
 * their stroke (spine start to spine middle, else first to last vertex); other records get fixed random endpoints once.
 */
export function gradient(): AffectModule {
  const recs = new Int32Array(2 * MAX_RECORDS);
  let rng: Prng | null = null;
  return {
    id: 'affect.gradient',
    order: 1,
    rateSensitive: false,
    affect(e: Engine) {
      rng ??= e.rng('affect.gradient');
      const a = e.arena;
      const n = e.activeRecords(recs);
      for (let i = 0; i < n; i++) {
        const b = recs[i] * HDR_STRIDE;
        const count = a.hdr[b + H.VTX_COUNT];
        if (count === 0) continue;
        a.hdr[b + H.GRADIENT_RGBA2] = (a.hdr[b + H.RGBA] & 0xffffff00) | 0; // same RGB, alpha 0
        const off = a.hdr[b + H.VTX_OFF];
        const spine = a.hdr[b + H.SPINE_OFF];
        if (a.hdr[b + H.FLAGS] & F_PEN_SHAPE) {
          if (spine >= 0 && a.hdr[b + H.SPINE_COUNT] > 0) {
            const mid = Math.floor(a.hdr[b + H.SPINE_COUNT] / 2);
            a.hdrF[b + H.GX1] = a.spine[4 * spine];
            a.hdrF[b + H.GY1] = a.spine[4 * spine + 1];
            a.hdrF[b + H.GX2] = a.spine[4 * (spine + mid)];
            a.hdrF[b + H.GY2] = a.spine[4 * (spine + mid) + 1];
          } else {
            a.hdrF[b + H.GX1] = a.vtx[2 * off];
            a.hdrF[b + H.GY1] = a.vtx[2 * off + 1];
            a.hdrF[b + H.GX2] = a.vtx[2 * (off + count - 1)];
            a.hdrF[b + H.GY2] = a.vtx[2 * (off + count - 1) + 1];
          }
          a.hdr[b + H.FLAGS] |= F_GRADIENT;
        } else if (!(a.hdr[b + H.FLAGS] & F_GRADIENT)) {
          // stamps and glyphs: random endpoints inside the bounds, fixed from then on
          const x0 = a.hdrF[b + H.BB_MIN_X], y0 = a.hdrF[b + H.BB_MIN_Y];
          const w = a.hdrF[b + H.BB_MAX_X] - x0, h = a.hdrF[b + H.BB_MAX_Y] - y0;
          a.hdrF[b + H.GX1] = rng.random(x0, x0 + w);
          a.hdrF[b + H.GY1] = rng.random(y0, y0 + h);
          a.hdrF[b + H.GX2] = rng.random(x0, x0 + w);
          a.hdrF[b + H.GY2] = rng.random(y0, y0 + h);
          a.hdr[b + H.FLAGS] |= F_GRADIENT;
        }
      }
    },
  };
}

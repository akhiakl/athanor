import { H, HDR_STRIDE, MAX_RECORDS } from '../../core/arena';
import { hsbToRgb, packRgba, rgbToHsb } from '../../core/color';
import { int } from '../../core/math';
import type { Prng } from '../../core/prng';
import type { AffectModule } from '../../engine/engine';

/** Window of width `2 * half` around c0, shifted (not clipped) to stay inside [0, 1], spec 5.4.7. */
export function channelWindow(c0: number, half: number): [number, number] {
  let lo = c0 - half;
  let hi = c0 + half;
  if (lo < 0) {
    hi += -lo;
    lo = 0;
  } else if (hi > 1) {
    lo -= hi - 1;
    hi = 1;
  }
  return [lo, hi];
}

/**
 * ColorSwitcher, spec 5.4.7: a random colour near the base colour on every pointerdown (and every 50 ms of a drag when
 * `constant`), applied to the canvas colour and to every active record.
 */
export function colorSwitcher({ baseRange = 50, constant = false } = {}): AffectModule {
  let base: [number, number, number] = [0, 0, 0];
  let last = -Infinity;
  let rng: Prng | null = null;
  const recs = new Int32Array(2 * MAX_RECORDS);

  const apply = (e: Parameters<NonNullable<AffectModule['down']>>[0]): void => {
    rng ??= e.rng('affect.colorSwitcher');
    const half = baseRange / 100 / 2;
    const [h0, s0, b0] = base;
    const pick = (c: number) => {
      const [lo, hi] = channelWindow(c, half);
      return rng!.random(lo, hi);
    };
    const [r, g, b] = hsbToRgb(pick(h0), pick(s0), pick(b0));
    const rgba = packRgba(r, g, b, int(rng.random(255))); // alpha 0..254, legacy
    e.attrs.rgba = rgba;
    const n = e.activeRecords(recs);
    for (let i = 0; i < n; i++) e.arena.hdr[recs[i] * HDR_STRIDE + H.RGBA] = rgba;
  };

  return {
    id: 'affect.colorSwitcher',
    order: 101,
    rateSensitive: false,
    setup(e) {
      const u = e.attrs.rgba >>> 0;
      base = rgbToHsb(u >>> 24, (u >>> 16) & 255, (u >>> 8) & 255);
    },
    down(e, s) {
      last = s.t;
      apply(e);
    },
    drag(e, s) {
      if (constant && s.t - last >= 50) {
        last = s.t;
        apply(e);
      }
    },
  };
}

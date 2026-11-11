import { H, HDR_STRIDE } from '../../core/arena';
import { idiv } from '../../core/math';
import { cloneRecord } from '../../engine/clone';
import type { AffectModule } from '../../engine/engine';

/**
 * Mirror, spec 5.4.1: reflects every create record across a vertical axis (horizontal flag, default on) and/or a horizontal
 * axis (vertical flag), into fixed slots of its own affect range. The page moves the axes through `setAxis` (axis-move mode).
 */
export interface MirrorModule extends AffectModule {
  setAxis(x: number, y: number): void;
  /** Current axes; NaN until the first affect pass centres them. */
  axis(): [number, number];
}

export function mirror({ horizontal = true, vertical = false } = {}): MirrorModule {
  let ax = NaN;
  let by = NaN;
  const k = (horizontal ? 1 : 0) + (vertical ? 1 : 0) + (horizontal && vertical ? 1 : 0);
  const mats: number[][] = [];
  const build = (): void => { // rebuilt only when the axis moves, so the per-tick pass allocates nothing
    mats.length = 0;
    if (horizontal) mats.push([-1, 0, 0, 1, 2 * ax, 0]);
    if (vertical) mats.push([1, 0, 0, -1, 0, 2 * by]);
    if (horizontal && vertical) mats.push([-1, 0, 0, -1, 2 * ax, 2 * by]);
  };
  const self: MirrorModule = {
    id: 'affect.mirror',
    order: 2,
    rateSensitive: false,
    axis: () => [ax, by],
    setAxis(x, y) {
      ax = x;
      by = y;
      build();
    },
    affect(e) {
      if (Number.isNaN(ax)) {
        ax = idiv(e.view.w, 2);
        by = idiv(e.view.h, 2);
        build();
      }
      if (k === 0) return;
      for (let i = 0; i < e.createCount; i++) {
        const src = e.create[i];
        if (e.arena.hdr[src * HDR_STRIDE + H.VTX_COUNT] === 0) continue;
        for (let s = 0; s < k; s++) {
          const dst = e.affectSlot(self, i * k + s);
          if (dst >= 0) cloneRecord(e.arena, src, dst, mats[s]);
        }
      }
    },
  };
  return self;
}

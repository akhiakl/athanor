import { loadShape } from '../../engine/clone';
import type { AffectModule, Engine } from '../../engine/engine';
import type { Shape } from '../../render/batch';

/**
 * The main-thread half of Repeat (spec 2.12): holds the stamps the worker sends in its own affect range, so they show on the
 * active layer, until they are placed (committed to the worker's log).
 */
export function repeatStamps(): AffectModule & { add(e: Engine, s: Shape): void; place(e: Engine): void } {
  let n = 0;
  const self: AffectModule & { add(e: Engine, s: Shape): void; place(e: Engine): void } = {
    id: 'affect.repeat.stamps',
    order: 103,
    rateSensitive: false,
    add(e, s) {
      const cap = Math.max(16, s.vtx.length / 2);
      let r = e.affectSlot(self, n, cap);
      if (r < 0) {
        e.commit(); // arena full: flush everything and start over, as the 64-record limit does (7.2)
        n = 0;
        r = e.affectSlot(self, 0, cap);
        if (r < 0) return;
      }
      if (loadShape(e.arena, r, s)) n++;
    },
    place(e) {
      e.commitAffects(self);
      n = 0;
    },
    committed() {
      n = 0; // a full commit freed every slot
    },
    deselect() {
      n = 0;
    },
  };
  return self;
}

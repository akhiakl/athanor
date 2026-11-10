import { idiv, int } from '../../core/math';
import type { Prng } from '../../core/prng';
import type { CreateModule } from '../../engine/engine';

/** ScrawlShapes, spec 5.3.5. `count` persists across strokes (legacy). */
export function scrawlShapes({ flow = 10, detail = 10, noise = 10 } = {}): CreateModule {
  let ox = 0;
  let oy = 0;
  let count = 0;
  let rng: Prng | null = null;
  return {
    id: 'create.scrawlShapes',
    rateSensitive: true,
    down(e, s) {
      rng ??= e.rng('create.scrawlShapes');
      e.begin(s.x, s.y);
      ox = s.x;
      oy = s.y;
    },
    drag(e, s) {
      rng ??= e.rng('create.scrawlShapes');
      if (count % flow === 0) {
        const xStep = idiv(s.x - ox, detail);
        const yStep = idiv(s.y - oy, detail);
        let px = int(ox);
        let py = int(oy);
        for (let i = 0; i < detail - 1; i++) {
          px = int(px + xStep + rng.random(-noise, noise));
          py = int(py + yStep + rng.random(-noise, noise));
          e.curveTo(px, py);
        }
        ox = s.x;
        oy = s.y;
      }
      count++;
    },
    up: (e) => e.commit(),
  };
}

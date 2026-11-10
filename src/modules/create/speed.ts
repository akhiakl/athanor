import { idiv, int } from '../../core/math';
import type { CreateModule } from '../../engine/engine';

/** SpeedShapes, spec 5.3.1. */
export function speedShapes({ multiplier = 15, freeform = true } = {}): CreateModule {
  let ox = 0;
  let oy = 0;
  return {
    id: 'create.speedShapes',
    rateSensitive: true,
    down(e, s) {
      e.begin(s.x, s.y);
      ox = s.x;
      oy = s.y;
    },
    drag(e, s) {
      const speed = idiv(Math.abs(s.x - ox) + Math.abs(s.y - oy), 2);
      const theta = Math.atan2(s.y - oy, s.x - ox);
      const px = int(s.x + speed * multiplier * Math.cos(theta));
      const py = int(s.y + speed * multiplier * Math.sin(theta));
      if (freeform) e.curveTo(px, py);
      else e.lineTo(px, py);
      ox = s.x;
      oy = s.y;
    },
    up: (e) => e.commit(),
  };
}

import type { CreateModule } from '../../engine/engine';

/** DetachShapes, spec 5.3.12: the pen drags a tether point behind it; the tether draws. Tether persists across strokes. */
export function detachShapes({ distance = 100 } = {}): CreateModule {
  let x = 100;
  let y = 100;
  let newPath = false;
  return {
    id: 'create.detachShapes',
    rateSensitive: false,
    down() {
      newPath = true;
    },
    drag(e, s) {
      const theta = Math.atan2(s.y - y, s.x - x);
      x = s.x - Math.cos(theta) * distance;
      y = s.y - Math.sin(theta) * distance;
      const px = Math.trunc(x);
      const py = Math.trunc(y);
      if (newPath) {
        e.begin(px, py);
        newPath = false;
      } else e.curveTo(px, py);
    },
    up: (e) => e.commit(),
  };
}

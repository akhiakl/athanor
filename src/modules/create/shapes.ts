import type { CreateModule } from '../../engine/engine';

/** Freehand Shapes (2.11). shortcut: straight-line mode, outline option and guides wait for the guide layer. */
export function shapes(): CreateModule {
  return {
    id: 'create.shapes',
    rateSensitive: false,
    down: (e, s) => void e.begin(s.x, s.y),
    drag: (e, s) => e.curveTo(s.x, s.y),
    up: (e, s) => {
      e.lineTo(s.x, s.y);
      e.commit();
    },
  };
}

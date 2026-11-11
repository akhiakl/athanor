import type { AffectModule } from '../../engine/engine';

/**
 * Blindness, spec 5.4.10: hides both canvases while drawing (the page reads `engine.flags.blind`); the drawing still commits.
 * Reveal on pointerup (autoReveal, default on) or key R; hidden again at the next pointerdown. No timers.
 */
export function blindness({ autoReveal = true } = {}): AffectModule {
  return {
    id: 'affect.blindness',
    order: 3,
    rateSensitive: false,
    setup(e) {
      e.flags.blind = true;
    },
    deselect(e) {
      e.flags.blind = false;
    },
    down(e) {
      e.flags.blind = true;
    },
    up(e) {
      if (autoReveal) e.flags.blind = false;
    },
    key(e, code) {
      if (code === 'KeyR') e.flags.blind = false;
    },
  };
}

import { describe, expect, it } from 'vitest';
import { MARGIN, nudge, placementStyle, snap } from './placement';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe('toolbar placement', () => {
  it('places a bottom pill so its edges are exact at both ends', () => {
    expect(placementStyle({ edge: 'bottom', along: 0 }).left).toContain('8px + 0 *');
    expect(placementStyle({ edge: 'bottom', along: 1 }).transform).toBe('translateX(-100%)');
    expect(placementStyle({ edge: 'left', along: 0.5 }).top).toContain('100dvh');
  });
  it('snap round-trips a pill dropped on the same edge (no jump)', () => {
    const W = 1000, H = 700, pw = 400;
    for (const along of [0.25, 0.5, 0.75]) { // interior: at a corner the nearer edge legitimately wins
      const left = MARGIN + along * (W - pw - 2 * MARGIN); // where placementStyle puts it
      const r = rect(left, H - 44 - 14, pw, 44);
      expect(snap(r, 'bottom', W, H).along).toBeCloseTo(along, 5);
    }
  });
  it('picks the nearest edge and keeps the centre when the orientation changes', () => {
    const p = snap(rect(960, 300, 60, 200), 'bottom', 1000, 700);
    expect(p.edge).toBe('right');
    expect(p.along).toBeCloseTo(400 / 700, 5);
  });
  it('clamps along to 0..1', () => {
    expect(snap(rect(3, 656, 400, 44), 'bottom', 1000, 700)).toEqual({ edge: 'bottom', along: 0 });
  });
  it('keyboard: arrows slide along the edge, Shift+arrow changes edge, cross-axis arrows do nothing', () => {
    expect(nudge({ edge: 'bottom', along: 0.5 }, 'ArrowRight', false)).toEqual({ edge: 'bottom', along: 0.55 });
    expect(nudge({ edge: 'bottom', along: 0.98 }, 'ArrowRight', false)?.along).toBe(1);
    expect(nudge({ edge: 'bottom', along: 0.5 }, 'ArrowUp', false)).toBeNull();
    expect(nudge({ edge: 'bottom', along: 0.5 }, 'ArrowLeft', true)).toEqual({ edge: 'left', along: 0.5 });
    expect(nudge({ edge: 'left', along: 0.5 }, 'ArrowDown', false)?.along).toBeCloseTo(0.55, 5);
    expect(nudge({ edge: 'left', along: 0.5 }, 'x', false)).toBeNull();
  });
});

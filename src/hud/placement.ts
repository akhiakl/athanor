// Where the floating toolbar sits: pure geometry so it can be tested without a DOM.
import type { Edge, PillPos } from './hud';

export const MARGIN = 8; // the pill never touches the viewport edge

export const isHoriz = (e: Edge): boolean => e === 'top' || e === 'bottom';

/** CSS position for a pill at `pos`: exact at both ends and inside MARGIN, whatever the pill's own size. */
export function placementStyle({ edge, along }: PillPos): { left: string; top?: undefined; transform: string } | { top: string; left?: undefined; transform: string } {
  return isHoriz(edge)
    ? { left: `calc(${MARGIN}px + ${along} * (100vw - ${2 * MARGIN}px))`, transform: `translateX(${-along * 100}%)` }
    : { top: `calc(${MARGIN}px + ${along} * (100dvh - ${2 * MARGIN}px))`, transform: `translateY(${-along * 100}%)` };
}

/** Snaps a dropped pill rect to its nearest viewport edge. Same orientation: exact (no jump). Rotated: keeps the centre. */
export function snap(r: { left: number; top: number; right: number; bottom: number; width: number; height: number }, from: Edge, W: number, H: number): PillPos {
  const d: [Edge, number][] = [['top', r.top], ['bottom', H - r.bottom], ['left', r.left], ['right', W - r.right]];
  const edge = d.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  const horiz = isHoriz(edge);
  const [lo, size, view] = horiz ? [r.left, r.width, W] : [r.top, r.height, H];
  const room = view - size - 2 * MARGIN;
  const along = isHoriz(from) === horiz && room > 0 ? (lo - MARGIN) / room : (lo + size / 2) / view;
  return { edge, along: Math.max(0, Math.min(1, along)) };
}

const KEY_EDGE: Record<string, Edge> = { ArrowUp: 'top', ArrowDown: 'bottom', ArrowLeft: 'left', ArrowRight: 'right' };

/** Keyboard move for the grip: arrows slide along the edge, Shift+arrow jumps to that edge. null when the key is not a move. */
export function nudge(pos: PillPos, key: string, shift: boolean, step = 0.05): PillPos | null {
  const target = KEY_EDGE[key];
  if (!target) return null;
  if (shift) return target === pos.edge ? pos : { edge: target, along: pos.along };
  const along = isHoriz(pos.edge) ? (key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0) : (key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
  if (!along) return null; // an arrow across the edge's axis does nothing without Shift
  return { edge: pos.edge, along: Math.max(0, Math.min(1, pos.along + along)) };
}

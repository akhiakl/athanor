/** Device pixel ratio capped so one canvas never exceeds 16.7 Mpx (iOS Safari limit), spec 7.2. */
export function effectiveDpr(cssW: number, cssH: number, dpr: number): number {
  return Math.min(dpr || 1, Math.sqrt(16.7e6 / (cssW * cssH)));
}

// Legacy-parity helpers, spec section 0 notation and 5.0 utilities.
export const int = (v: number): number => Math.trunc(v);
export const idiv = (a: number, b: number): number => Math.trunc(a / b);
export const map = (v: number, a: number, b: number, c: number, d: number): number =>
  c + ((d - c) * (v - a)) / (b - a);
export const constrain = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
export const distance = (x1: number, y1: number, x2: number, y2: number): number => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
};
/** Integer mean with truncating division (XShapes parity). */
export function mean(a: ArrayLike<number>, n = a.length): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return idiv(s, n);
}

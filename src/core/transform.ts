// Spec 5.2: one affine loop over interleaved x, y floats. x' = a x + c y + e, y' = b x + d y + f.
export function applyAffine(
  src: Float32Array, srcOff: number, dst: Float32Array, dstOff: number, pairs: number,
  a: number, b: number, c: number, d: number, e: number, f: number,
): void {
  for (let i = 0; i < pairs; i++) {
    const x = src[2 * (srcOff + i)];
    const y = src[2 * (srcOff + i) + 1];
    dst[2 * (dstOff + i)] = a * x + c * y + e;
    dst[2 * (dstOff + i) + 1] = b * x + d * y + f;
  }
}

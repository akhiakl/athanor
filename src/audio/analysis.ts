// Pure audio metrics, spec 4.1.2 (levels) and 4.1.4 (pitch). No Web Audio types so Node tests can drive them.
export interface Levels {
  /** Mean |s16| / 100, the legacy getMicLevel range 0..327.68. */
  legacyLvl: number;
  rms: number;
  zcr: number;
  peak: number;
  /** High byte of the first 16-bit sample, signed (spec 4.1.3). */
  b0: number;
}

export const emptyLevels = (): Levels => ({ legacyLvl: 0, rms: 0, zcr: 0, peak: 0, b0: 0 });

/** Fills `out` from float samples in [-1, 1]. */
export function computeLevels(f: Float32Array, out: Levels): Levels {
  const n = f.length;
  if (n === 0) return Object.assign(out, emptyLevels());
  let abs = 0;
  let sq = 0;
  let peak = 0;
  let zc = 0;
  let prev = 0;
  let b0 = 0;
  for (let i = 0; i < n; i++) {
    const x = f[i];
    const s16 = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    if (i === 0) b0 = s16 >> 8;
    abs += Math.abs(s16);
    sq += x * x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
    if (i > 0 && Math.sign(x) !== Math.sign(prev)) zc++;
    prev = x;
  }
  out.legacyLvl = abs / n / 100;
  out.rms = Math.sqrt(sq / n);
  out.zcr = zc / n;
  out.peak = peak;
  out.b0 = b0;
  return out;
}

const PEAKS = 10;
const peakFreq = new Float32Array(PEAKS);
const peakPow = new Float32Array(PEAKS);

/**
 * Energy-weighted mean of the 10 strongest spectral peaks (spec 4.1.4).
 * `db` is getFloatFrequencyData output (bins 0..fft/2-1). Returns 0 when the loudest peak is below `gateDb`.
 */
export function estimatePitch(db: Float32Array, sampleRate: number, fftSize: number, gateDb: number): number {
  peakPow.fill(0);
  peakFreq.fill(0);
  const hi = Math.min(db.length - 2, fftSize / 2 - 2);
  for (let b = 2; b <= hi; b++) {
    const bb = db[b];
    if (!(bb > db[b - 1] && bb >= db[b + 1])) continue;
    const p = Math.pow(10, bb / 10);
    let slot = -1; // weakest kept peak that this one beats
    let min = p;
    for (let k = 0; k < PEAKS; k++) {
      if (peakPow[k] < min) {
        min = peakPow[k];
        slot = k;
      }
    }
    if (slot < 0) continue;
    const a = db[b - 1];
    const c = db[b + 1];
    const den = a - 2 * bb + c;
    const delta = den === 0 ? 0 : (0.5 * (a - c)) / den;
    peakPow[slot] = p;
    peakFreq[slot] = ((b + delta) * sampleRate) / fftSize;
  }
  let top = 0;
  let num = 0;
  let sum = 0;
  for (let k = 0; k < PEAKS; k++) {
    if (peakPow[k] > top) top = peakPow[k];
    num += peakFreq[k] * peakPow[k];
    sum += peakPow[k];
  }
  if (sum === 0 || top <= Math.pow(10, gateDb / 10)) return 0;
  return num / sum;
}

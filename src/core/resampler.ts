// Event-rate normalization for rateSensitive modules, spec 4.2.2, plus pressure smoothing 4.2.3.
import { PHASE_DOWN, PHASE_MOVE, metaPhase } from './inputRing';

export class Resampler {
  private period: number;
  private tLast = 0;
  private active = false;
  private pMax = 0;
  /** Output sample: x, y, t, pressure (max over the accumulated window). */
  readonly out = new Float32Array(4);

  constructor(rateHz = 120) {
    if (!(rateHz > 0) || !Number.isFinite(rateHz)) throw new RangeError(`rateHz must be a positive finite number, got ${rateHz}`);
    this.period = 1000 / rateHz;
  }

  /** Feeds one raw sample; returns true when `out` holds a module sample to consume. */
  push(x: number, y: number, t: number, pressure: number, meta: number): boolean {
    const o = this.out;
    if (metaPhase(meta) !== PHASE_MOVE) {
      // down/up/cancel always pass immediately; down restarts the grid
      this.active = metaPhase(meta) === PHASE_DOWN; // up/cancel end the stream
      this.tLast = t;
      this.pMax = 0;
      o[0] = x; o[1] = y; o[2] = t; o[3] = pressure;
      return true;
    }
    if (!this.active) return false;
    if (pressure > this.pMax) this.pMax = pressure;
    if (t - this.tLast < this.period) return false;
    // grid-locked so a 1 kHz and a 125 Hz stream land on the same ticks
    this.tLast += this.period;
    if (t - this.tLast >= this.period) this.tLast = t; // stalled: skip catch-up burst
    o[0] = x; o[1] = y; o[2] = this.tLast; o[3] = this.pMax;
    this.pMax = 0;
    return true;
  }
}

/** One-pole low-pass, tau = 12 ms: p_s += k (p - p_s), k = 1 - exp(-dt / tau). */
export function smoothPressure(prev: number, p: number, dt: number, tau = 12): number {
  return prev + (1 - Math.exp(-dt / tau)) * (p - prev);
}

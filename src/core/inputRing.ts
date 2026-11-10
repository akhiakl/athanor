// InputRing, spec 3.1. Single producer / single consumer, preallocated, never grows.
export const CAP = 4096;
export const STRIDE = 8;
const MASK = CAP - 1;

export const KIND_MOUSE = 0, KIND_PEN = 1, KIND_TOUCH = 2;
export const PHASE_MOVE = 0, PHASE_DOWN = 1, PHASE_UP = 2, PHASE_CANCEL = 3;
export const META_COALESCED = 1 << 4, META_PREDICTED = 1 << 5, META_HW_PRESSURE = 1 << 6;

export const packMeta = (kind: number, phase: number, flags = 0, pointerSlot = 0): number =>
  (kind & 3) | ((phase & 3) << 2) | (flags & 0x70) | ((pointerSlot & 0xff) << 8);
export const metaPhase = (meta: number): number => (meta >> 2) & 3;
export const metaKind = (meta: number): number => meta & 3;

export class InputRing {
  readonly data = new Float32Array(CAP * STRIDE);
  private head = 0; // uint32 counters
  private tail = 0;

  get length(): number {
    return (this.head - this.tail) >>> 0;
  }

  /**
   * Overflow: an incoming move is dropped when the oldest sample is a phase sample, otherwise the oldest move is dropped.
   * shortcut: an incoming down/up/cancel on a full ring always overwrites the oldest sample, even if that is a phase sample; unreachable at <= 4 kHz input, upgrade with the 64-slot phaseRing if it ever fires.
   */
  write(x: number, y: number, t: number, pressure: number, tiltX: number, tiltY: number, buttons: number, meta: number): void {
    if (this.length === CAP) {
      const oldestIsMove = metaPhase(this.data[(this.tail & MASK) * STRIDE + 7]) === PHASE_MOVE;
      if (!oldestIsMove && metaPhase(meta) === PHASE_MOVE) return;
      this.tail = (this.tail + 1) >>> 0;
    }
    const o = (this.head & MASK) * STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = t; d[o + 3] = pressure;
    d[o + 4] = tiltX; d[o + 5] = tiltY; d[o + 6] = buttons; d[o + 7] = meta;
    this.head = (this.head + 1) >>> 0;
  }

  /** Copies the oldest sample into out[0..STRIDE) and consumes it; false when empty. */
  read(out: Float32Array): boolean {
    if (this.head === this.tail) return false;
    const o = (this.tail & MASK) * STRIDE;
    for (let i = 0; i < STRIDE; i++) out[i] = this.data[o + i];
    this.tail = (this.tail + 1) >>> 0;
    return true;
  }
}

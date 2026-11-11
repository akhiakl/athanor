// ActiveArena: preallocated, GC-free shape storage. Spec 3.2.1 and 3.2.2.
export const MOVE = 0;
export const LINE = 1;
export const QUAD = 2;
export const CUBIC = 3;
export const CLOSE = 4;

export const HDR_STRIDE = 24;
export const MAX_RECORDS = 64;
export const VTX_CAP = 4096; // pairs per record region
export const SPINE_CAP = 4096; // spine points per record region
export const MAX_VTX_PAIRS = 65536;
export const MAX_SPINE = 16384;

/** Header slot indices (hdr = Int32 view, hdrF = Float32 view of the same buffer). */
export const H = {
  ID: 0,
  VTX_OFF: 1,
  VTX_CAP: 2,
  VTX_COUNT: 3,
  CMD_OFF: 4,
  CMD_COUNT: 5,
  SPINE_OFF: 6,
  SPINE_COUNT: 7,
  FLAGS: 8,
  RGBA: 9,
  LINE_WIDTH: 10, // f32
  TOTAL_POINTS: 11,
  LAST_X: 12, // f32
  LAST_Y: 13, // f32
  BB_MIN_X: 14, // f32
  BB_MIN_Y: 15,
  BB_MAX_X: 16,
  BB_MAX_Y: 17,
  GX1: 18,
  GY1: 19,
  GX2: 20,
  GY2: 21,
  GRADIENT_RGBA2: 22,
  OWNER: 23,
} as const;

export const F_FILL = 1;
export const F_EVENODD = 2;
export const F_PEN_SHAPE = 4;
export const F_CLOSED = 8;
export const F_GRADIENT = 16;

export class ActiveArena {
  readonly vtx = new Float32Array(2 * MAX_VTX_PAIRS);
  readonly cmd = new Uint8Array(MAX_VTX_PAIRS);
  readonly spine = new Float32Array(4 * MAX_SPINE);
  readonly edgeL = new Float32Array(2 * MAX_SPINE);
  readonly edgeR = new Float32Array(2 * MAX_SPINE);
  private readonly buf = new ArrayBuffer(MAX_RECORDS * HDR_STRIDE * 4);
  readonly hdr = new Int32Array(this.buf);
  readonly hdrF = new Float32Array(this.buf);

  private records = 0;
  private vtxBump = 0;
  private cmdBump = 0;
  private spineBump = 0;
  private nextId = 1;

  /** Allocates a record region of `cap` vertex pairs (small caps for stamps and clones); returns the record index, or -1 when exhausted. */
  alloc(withSpine = false, cap = VTX_CAP): number {
    if (
      this.records >= MAX_RECORDS ||
      this.vtxBump + cap > MAX_VTX_PAIRS ||
      (withSpine && this.spineBump + SPINE_CAP > MAX_SPINE)
    )
      return -1;
    const r = this.records++;
    const b = r * HDR_STRIDE;
    this.hdr.fill(0, b, b + HDR_STRIDE);
    this.hdr[b + H.ID] = this.nextId++;
    this.hdr[b + H.VTX_OFF] = this.vtxBump;
    this.hdr[b + H.VTX_CAP] = cap;
    this.hdr[b + H.CMD_OFF] = this.cmdBump;
    this.vtxBump += cap;
    this.cmdBump += cap;
    if (withSpine) {
      this.hdr[b + H.SPINE_OFF] = this.spineBump;
      this.spineBump += SPINE_CAP;
    } else {
      this.hdr[b + H.SPINE_OFF] = -1;
    }
    return r;
  }

  /** Recycles every record. shortcut: no per-record free list, upgrade when split-commit lands. */
  reset(): void {
    this.records = this.vtxBump = this.cmdBump = this.spineBump = 0;
  }

  get recordCount(): number {
    return this.records;
  }
}

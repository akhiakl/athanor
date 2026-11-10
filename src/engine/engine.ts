// Create-side engine: input drain -> create module hooks -> arena -> commit sink. Spec 2.3, 2.5, 2.10.
import { ActiveArena, F_FILL, H, HDR_STRIDE, MAX_RECORDS } from '../core/arena';
import { InputRing, META_HW_PRESSURE, PHASE_DOWN, PHASE_MOVE, STRIDE, KIND_MOUSE, metaKind, metaPhase } from '../core/inputRing';
import { Prng, moduleRng } from '../core/prng';
import { Resampler } from '../core/resampler';
import * as S from '../core/shape';
import { START_POINTS } from '../core/shape';
import { SyntheticPressure } from './pressure';

export const PEN_STYLUS = 1;
export const PEN_CURSOR = 3;

/** Reused for every dispatch: modules must not retain it. */
export class Sample {
  x = 0;
  y = 0;
  t = 0;
  pressureEff = 0;
  penKind = PEN_CURSOR;
  buttons = 0;
}

export interface CreateModule {
  readonly id: string;
  /** Receives 120 Hz resampled input (4.2.2) instead of every raw sample. */
  readonly rateSensitive: boolean;
  down?(e: Engine, s: Sample): void;
  drag?(e: Engine, s: Sample): void;
  up?(e: Engine, s: Sample): void;
  committed?(e: Engine): void;
  deselect?(e: Engine): void;
}

export interface CommitSink {
  /** Must copy what it needs synchronously: the arena is recycled right after. */
  commit(arena: ActiveArena, records: Int32Array, count: number): void;
}

export class Engine {
  readonly arena = new ActiveArena();
  readonly create = new Int32Array(MAX_RECORDS);
  createCount = 0;
  readonly attrs = { rgba: 0x000000ff, lineWidth: 1, fill: false, smoothing: true, syntheticPressure: true };
  readonly sample = new Sample();

  private module: CreateModule | null = null;
  private readonly raw = new Float32Array(STRIDE);
  private readonly resampler: Resampler;
  private readonly synth = new SyntheticPressure();
  private readonly carry = new Float32Array(6);
  private spineDirty = false;

  constructor(readonly seed: number, private readonly sink: CommitSink, rateHz = 120) {
    this.resampler = new Resampler(rateHz);
  }

  rng(moduleId: string): Prng {
    return moduleRng(this.seed, moduleId);
  }

  select(m: CreateModule): void {
    if (this.module) {
      this.commit();
      this.module.deselect?.(this);
    }
    this.module = m;
  }

  // ---- record construction (modules never touch the arena allocator directly) ----

  /** Last create record, or -1. */
  current(): number {
    return this.createCount > 0 ? this.create[this.createCount - 1] : -1;
  }

  private alloc(spine: boolean): number {
    let r = this.arena.alloc(spine);
    if (r < 0) {
      this.commit(); // arena exhausted: forced commit (7.2)
      r = this.arena.alloc(spine);
    }
    const b = r * HDR_STRIDE;
    this.arena.hdr[b + H.FLAGS] = this.attrs.fill ? F_FILL : 0;
    this.arena.hdr[b + H.RGBA] = this.attrs.rgba;
    this.arena.hdrF[b + H.LINE_WIDTH] = this.attrs.lineWidth;
    this.create[this.createCount++] = r;
    return r;
  }

  /** Starts a new shape with a MOVE at (x, y). */
  begin(x: number, y: number): number {
    const r = this.alloc(false);
    S.newShape(this.arena, r, x, y, this.attrs.rgba, this.attrs.lineWidth);
    return r;
  }

  /** Starts an empty spine record; geometry appears via spineTo. */
  beginSpine(): number {
    return this.alloc(true);
  }

  /**
   * Split-commit at a full record: commit everything, continue from the last emitted vertex (7.2).
   * With smoothing, the emitted vertex is a midpoint and the raw last point is ahead of it; the new
   * record keeps the raw point and an active smoothing state so the next QUAD continues the curve exactly.
   */
  private split(r: number): number {
    const a = this.arena;
    const b = r * HDR_STRIDE;
    const last = 2 * (a.hdr[b + H.VTX_OFF] + a.hdr[b + H.VTX_COUNT] - 1);
    const ex = a.vtx[last];
    const ey = a.vtx[last + 1];
    const rawX = a.hdrF[b + H.LAST_X];
    const rawY = a.hdrF[b + H.LAST_Y];
    this.commit();
    const nr = this.begin(ex, ey);
    const nb = nr * HDR_STRIDE;
    a.hdrF[nb + H.LAST_X] = rawX;
    a.hdrF[nb + H.LAST_Y] = rawY;
    a.hdr[nb + H.TOTAL_POINTS] = START_POINTS; // past the warmup: next curveTo emits a QUAD from the raw point
    return nr;
  }

  curveTo(x: number, y: number): void {
    let r = this.current();
    if (r < 0) return;
    if (!S.hasRoom(this.arena, r, this.attrs.smoothing ? 2 : 1)) r = this.split(r);
    S.curveTo(this.arena, r, x, y, this.attrs.smoothing);
  }

  lineTo(x: number, y: number): void {
    let r = this.current();
    if (r < 0) return;
    if (!S.hasRoom(this.arena, r, 1)) r = this.split(r);
    S.lineTo(this.arena, r, x, y);
  }

  spineTo(x: number, y: number, w: number): void {
    let r = this.current();
    if (r < 0) return;
    if (S.spineFull(this.arena, r)) r = this.splitSpine(r);
    if (S.spineTo(this.arena, r, x, y, w)) this.spineDirty = true;
  }

  /** Spine records keep their last 2 spine points so the ribbon stays continuous across the split. */
  private splitSpine(r: number): number {
    const b = r * HDR_STRIDE;
    const n = this.arena.hdr[b + H.SPINE_COUNT];
    const base = this.arena.hdr[b + H.SPINE_OFF];
    const k = Math.min(2, n);
    for (let i = 0; i < k; i++) {
      const o = 4 * (base + n - k + i);
      this.carry[3 * i] = this.arena.spine[o];
      this.carry[3 * i + 1] = this.arena.spine[o + 1];
      this.carry[3 * i + 2] = this.arena.spine[o + 2];
    }
    this.commit();
    const nr = this.beginSpine();
    for (let i = 0; i < k; i++) S.spineTo(this.arena, nr, this.carry[3 * i], this.carry[3 * i + 1], this.carry[3 * i + 2]);
    return nr;
  }

  // ---- commit (2.5) ----

  /** Replays spine outlines into cmd/vtx once per tick when a spine grew (5.1.4). */
  flushSpines(): void {
    if (!this.spineDirty) return;
    this.spineDirty = false;
    for (let i = 0; i < this.createCount; i++) {
      const r = this.create[i];
      if (this.arena.hdr[r * HDR_STRIDE + H.SPINE_OFF] >= 0) S.emitSpine(this.arena, r, this.attrs.smoothing);
    }
  }

  commit(): void {
    this.spineDirty = true; // spine records must be complete before leaving the arena
    this.flushSpines();
    if (this.createCount > 0) this.sink.commit(this.arena, this.create, this.createCount);
    this.createCount = 0;
    this.arena.reset();
    this.module?.committed?.(this);
  }

  // ---- input ----

  /** Drains the ring in order (2.3 step 1). */
  tick(ring: InputRing): void {
    while (ring.read(this.raw)) this.ingest(this.raw);
    this.flushSpines();
  }

  private ingest(raw: Float32Array): void {
    const meta = raw[7];
    const phase = metaPhase(meta);
    if (phase === PHASE_DOWN) this.synth.reset();
    const hw = (meta & META_HW_PRESSURE) !== 0;
    // pen: raw^2 (legacy parabolic sensitivity); mouse and touch without hardware pressure: synthetic
    const pe = hw ? raw[3] * raw[3] : this.synth.next(raw[0], raw[1], raw[2]);
    this.sample.penKind = metaKind(meta) === KIND_MOUSE ? PEN_CURSOR : PEN_STYLUS;
    this.sample.buttons = raw[6];
    if (this.module?.rateSensitive) {
      if (!this.resampler.push(raw[0], raw[1], raw[2], pe, meta)) return;
      const o = this.resampler.out;
      this.dispatch(phase, o[0], o[1], o[2], o[3]);
    } else {
      this.dispatch(phase, raw[0], raw[1], raw[2], pe);
    }
  }

  private dispatch(phase: number, x: number, y: number, t: number, pe: number): void {
    const m = this.module;
    if (!m) return;
    const s = this.sample;
    s.x = x;
    s.y = y;
    s.t = t;
    s.pressureEff = pe;
    if (phase === PHASE_DOWN) m.down?.(this, s);
    else if (phase === PHASE_MOVE) {
      if (s.buttons !== 0) m.drag?.(this, s); // hover (buttons 0) is not a create event
    } else m.up?.(this, s); // up and cancel both commit, never discard (4.2.1)
  }
}

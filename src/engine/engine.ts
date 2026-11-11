// Create-side engine: input drain -> create module hooks -> arena -> commit sink. Spec 2.3, 2.5, 2.10.
import { ActiveArena, F_FILL, H, HDR_STRIDE, MAX_RECORDS, VTX_CAP } from '../core/arena';
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

/** ACTIVE-domain affect (spec 2.12): acts on the create/affect records on the main thread, before they commit. */
export interface AffectModule {
  readonly id: string;
  /** Ascending order decides both hook order and the order records are drawn and committed (2.9). */
  readonly order: number;
  readonly rateSensitive: boolean;
  setup?(e: Engine): void;
  deselect?(e: Engine): void;
  down?(e: Engine, s: Sample): void;
  drag?(e: Engine, s: Sample): void;
  up?(e: Engine, s: Sample): void;
  key?(e: Engine, code: string, key: string): void;
  /** Once per tick when geometry changed, and once more just before a commit (2.3 step 2). */
  affect?(e: Engine): void;
  committed?(e: Engine): void;
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
  /** Canvas size in CSS px (Mirror's default axes) and flags the page reads each frame. */
  readonly view = { w: 0, h: 0 };
  readonly flags = { blind: false };
  /** Active affects, ascending by order. */
  readonly affects: AffectModule[] = [];

  private module: CreateModule | null = null;
  private readonly slots = new Map<AffectModule, number[]>();
  private readonly owners = new Map<AffectModule, number>();
  private nextOwner = 1;
  private geometryDirty = false;
  private inAffects = false;
  private readonly all = new Int32Array(2 * MAX_RECORDS); // scratch: create ++ affect records for a commit
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
    this.arena.hdr[b + H.OWNER] = 0;
    this.create[this.createCount++] = r;
    this.geometryDirty = true;
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
    this.geometryDirty = true;
  }

  lineTo(x: number, y: number): void {
    let r = this.current();
    if (r < 0) return;
    if (!S.hasRoom(this.arena, r, 1)) r = this.split(r);
    S.lineTo(this.arena, r, x, y);
    this.geometryDirty = true;
  }

  spineTo(x: number, y: number, w: number): void {
    let r = this.current();
    if (r < 0) return;
    if (S.spineFull(this.arena, r)) r = this.splitSpine(r);
    if (S.spineTo(this.arena, r, x, y, w)) this.spineDirty = this.geometryDirty = true;
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

  // ---- affect modules (spec 2.9, 2.12) ----

  addAffect(m: AffectModule): void {
    if (this.affects.includes(m)) return;
    let i = this.affects.findIndex((x) => x.order > m.order);
    if (i < 0) i = this.affects.length;
    this.affects.splice(i, 0, m);
    this.owners.set(m, this.nextOwner++);
    m.setup?.(this);
    this.geometryDirty = true;
  }

  removeAffect(id: string): void {
    const i = this.affects.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = this.affects[i];
    m.deselect?.(this);
    this.releaseSlots(m);
    this.owners.delete(m);
    this.affects.splice(i, 1);
  }

  hasAffect(id: string): boolean {
    return this.affects.some((m) => m.id === id);
  }

  /**
   * The record at `slot` of this module's private range in affect[] (2.12), allocated on first use and reused after,
   * so a per-tick rebuild (Mirror) allocates nothing. -1 when the arena is full; the caller skips that slot.
   */
  affectSlot(owner: AffectModule, slot: number, cap = VTX_CAP): number {
    let list = this.slots.get(owner);
    if (!list) this.slots.set(owner, (list = []));
    while (list.length <= slot) {
      const r = this.arena.alloc(false, cap);
      if (r < 0) return -1;
      const b = r * HDR_STRIDE;
      this.arena.hdr[b + H.OWNER] = this.owners.get(owner) ?? 0;
      list.push(r);
    }
    return list[slot];
  }

  /** Number of slots this module has allocated. */
  slotCount(owner: AffectModule): number {
    return this.slots.get(owner)?.length ?? 0;
  }

  private releaseSlots(m: AffectModule): void {
    for (const r of this.slots.get(m) ?? []) this.arena.hdr[r * HDR_STRIDE + H.VTX_COUNT] = this.arena.hdr[r * HDR_STRIDE + H.CMD_COUNT] = 0;
    this.slots.delete(m);
  }

  /** Commits only this module's non-empty records (Repeat placing its stamps) and frees its slots. */
  commitAffects(owner: AffectModule): void {
    const list = this.slots.get(owner);
    if (!list) return;
    let n = 0;
    for (const r of list) if (this.arena.hdr[r * HDR_STRIDE + H.VTX_COUNT] > 0) this.all[n++] = r;
    if (n > 0) this.sink.commit(this.arena, this.all, n);
    this.releaseSlots(owner);
  }

  /** Create records first, then affect records in module order: draw and commit order. Returns the count. */
  activeRecords(out: Int32Array): number {
    let n = 0;
    for (let i = 0; i < this.createCount; i++) out[n++] = this.create[i];
    for (const m of this.affects) for (const r of this.slots.get(m) ?? []) if (n < out.length) out[n++] = r;
    return n;
  }

  /** Re-emits a spine record's outline after its spine moved (Displace). */
  emitSpine(r: number): void {
    S.emitSpine(this.arena, r, this.attrs.smoothing);
  }

  markDirty(): void {
    this.geometryDirty = true;
  }

  key(code: string, key: string): void {
    for (const m of this.affects) m.key?.(this, code, key);
  }

  /** Runs every active affect in order. Skipped when nothing changed, and not re-entered from inside an affect. */
  private runAffects(force = false): void {
    if (this.inAffects || this.affects.length === 0 || !(this.geometryDirty || force)) return;
    this.geometryDirty = false;
    this.inAffects = true;
    try {
      for (const m of this.affects) m.affect?.(this);
    } finally {
      this.inAffects = false;
    }
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
    this.runAffects(true); // clones must match the final geometry of what they mirror
    // create first, then affect records in module order (legacy commit order)
    const n = this.activeRecords(this.all);
    let kept = 0;
    for (let i = 0; i < n; i++) if (this.arena.hdr[this.all[i] * HDR_STRIDE + H.VTX_COUNT] > 0) this.all[kept++] = this.all[i];
    if (kept > 0) this.sink.commit(this.arena, this.all, kept);
    this.createCount = 0;
    this.slots.clear();
    this.arena.reset();
    this.module?.committed?.(this);
    for (const m of this.affects) m.committed?.(this);
  }

  // ---- input ----

  /** Drains the ring in order, then runs the per-tick affect pass (2.3 steps 1-2). */
  tick(ring: InputRing): void {
    while (ring.read(this.raw)) this.ingest(this.raw);
    this.flushSpines();
    this.runAffects();
    this.flushSpines(); // an affect may have changed a spine
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
    // Geometry-accurate modules see every raw sample; rate-sensitive ones the 120 Hz resampled stream (4.2.2).
    this.dispatch(phase, raw[0], raw[1], raw[2], pe, false);
    if (this.resampler.push(raw[0], raw[1], raw[2], pe, meta)) {
      const o = this.resampler.out;
      this.dispatch(phase, o[0], o[1], o[2], o[3], true);
    }
  }

  private dispatch(phase: number, x: number, y: number, t: number, pe: number, resampled: boolean): void {
    const s = this.sample;
    s.x = x;
    s.y = y;
    s.t = t;
    s.pressureEff = pe;
    const drag = phase === PHASE_MOVE;
    if (drag && s.buttons === 0) return; // hover (buttons 0) is not a create or ACTIVE-affect event
    this.geometryDirty = true;
    // create first, then affects ascending (2.10); up and cancel both commit, never discard (4.2.1)
    const m = this.module;
    if (m && m.rateSensitive === resampled) {
      if (phase === PHASE_DOWN) m.down?.(this, s);
      else if (drag) m.drag?.(this, s);
      else m.up?.(this, s);
    }
    for (let i = 0; i < this.affects.length; i++) { // index loop: no per-sample allocation
      const a = this.affects[i];
      if (a.rateSensitive !== resampled) continue;
      if (phase === PHASE_DOWN) a.down?.(this, s);
      else if (drag) a.drag?.(this, s);
      else a.up?.(this, s);
    }
  }
}

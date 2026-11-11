// RenderCore: committed-layer logic over a 2D context. Runs in the render worker, or on the main thread as the fallback (spec 2.6).
import type { ActiveArena } from '../core/arena';
import type { CommitSink } from '../engine/engine';
import { createAffect, noIO, type AffectIO, type AffectParams, type CommittedAffect } from './affects';
import { packBatch, unpackBatch } from './batch';
import { CommittedStore } from './committed';
import { drawShape, type Ctx2D } from './draw';
import { pngBlob, svgBlob, type ExportOptions, type MakeCanvas } from './export';
import { HistoryLog } from './history';

export class RenderCore implements CommitSink {
  readonly store = new CommittedStore();
  readonly affects: CommittedAffect[] = [];
  readonly history: HistoryLog;

  constructor(private readonly ctx: Ctx2D, private background = '#ffffff', private readonly io: AffectIO = noIO, now?: () => number) {
    this.history = new HistoryLog(this.store, 200, now);
    this.store.journal = this.history;
  }

  commit(a: ActiveArena, recs: Int32Array, n: number): void {
    this.commitBatch(packBatch(a, recs, n));
  }

  /** Appends a CommitBatch (3.2.4) on top of the log and draws it directly: no replay needed for appends. */
  commitBatch(buf: ArrayBuffer): void {
    // one history group for the commit and whatever it triggers (Limit removing the oldest shapes)
    this.history.scope(() => {
      for (const s of unpackBatch(buf)) {
        this.store.add(s);
        drawShape(this.ctx, s);
      }
      for (const af of this.affects) af.committed?.(this.store);
    });
  }

  /** Enables or replaces (on) / removes (off) a committed affect by id. */
  setAffect(id: string, on: boolean, seed: number, params?: AffectParams): void {
    const i = this.affects.findIndex((a) => a.id === id);
    if (i >= 0) this.affects.splice(i, 1);
    const af = on ? createAffect(id, seed, params, this.io) : null;
    if (af) this.affects.push(af);
  }

  /** Once per frame: committed affects that depend on in-flight shapes (Limit) see the active count. */
  tick(activeCount: number): void {
    for (const af of this.affects) af.tick?.(this.store, activeCount);
  }

  /** Pointer or key event for the affects that react to it (Repeat). */
  event(name: 'down' | 'key', code?: string): void {
    for (const af of this.affects) af.event?.(this.store, name, code);
  }

  /** Hover sample (buttons 0) for the committed-domain affects. */
  hover(x: number, y: number, t: number): void {
    for (const af of this.affects) af.hover?.(this.store, x, y, t);
  }

  /** Replays dirty tiles until `budgetMs` is spent (2 ms on the main thread, 4 ms in the worker). Returns tiles left. */
  replay(budgetMs: number, now: () => number = performance.now.bind(performance)): number {
    const start = now();
    const s = this.store;
    while (s.dirtyCount > 0) {
      const t = s.popDirty();
      const [x, y, w, h] = s.tileRect(t);
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(x, y, w, h);
      this.ctx.clip();
      this.ctx.fillStyle = this.background;
      this.ctx.fillRect(x, y, w, h);
      for (const id of s.tileIds(t)) {
        const e = s.entries[id];
        if (e.alive && e.bb[0] <= x + w && e.bb[2] >= x && e.bb[1] <= y + h && e.bb[3] >= y) drawShape(this.ctx, e.shape);
      }
      this.ctx.restore();
      if (now() - start >= budgetMs) break;
    }
    return s.dirtyCount;
  }

  /** Resize: new grid, every tile dirty. shortcut: replays synchronously, upgrade to the sliced replay with a fallback bitmap (2.6). */
  resize(width: number, height: number): void {
    this.store.setSize(width, height);
    this.replay(Infinity);
  }

  /** Clear is undoable: shapes are tombstoned as one history op rather than dropped. */
  clear(): void {
    this.history.clearAll();
    this.replay(Infinity);
  }

  private exportOptions(transparent: boolean): ExportOptions {
    return { width: this.store.width, height: this.store.height, background: this.background, transparent };
  }

  exportSvg(transparent: boolean): Blob {
    return svgBlob(this.store.entries, this.exportOptions(transparent));
  }

  exportPng(scale: number, transparent: boolean, make: MakeCanvas): Promise<Blob> {
    return pngBlob(this.store.entries, this.exportOptions(transparent), scale, make);
  }

  /** Undo / redo, then replay the tiles they dirtied. Returns whether anything changed. */
  undo(): boolean {
    const ok = this.history.undo();
    if (ok) this.replay(Infinity);
    return ok;
  }
  redo(): boolean {
    const ok = this.history.redo();
    if (ok) this.replay(Infinity);
    return ok;
  }
}

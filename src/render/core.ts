// Main-thread RenderCore: the fallback path of spec 2.6, same commit contract the worker will use.
import type { ActiveArena } from '../core/arena';
import type { CommitSink } from '../engine/engine';
import type { CommittedAffect } from './affects';
import { packBatch, unpackBatch } from './batch';
import { CommittedStore } from './committed';
import { drawShape, type Ctx2D } from './draw';

export class MainThreadRenderCore implements CommitSink {
  readonly store = new CommittedStore();
  readonly affects: CommittedAffect[] = [];

  constructor(private readonly ctx: Ctx2D, private background = '#ffffff') {}

  commit(a: ActiveArena, recs: Int32Array, n: number): void {
    // Pack even in-process so the worker swap-in changes only the transport.
    for (const s of unpackBatch(packBatch(a, recs, n))) {
      this.store.add(s);
      drawShape(this.ctx, s); // appended on top: drawn directly, no replay needed
    }
    for (const af of this.affects) af.committed?.(this.store);
  }

  /** Once per frame: committed affects that depend on in-flight shapes (Limit) see the active count. */
  tick(activeCount: number): void {
    for (const af of this.affects) af.tick?.(this.store, activeCount);
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

  clear(): void {
    this.store.clear();
    this.replay(Infinity);
  }
}

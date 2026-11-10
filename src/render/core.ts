// Main-thread RenderCore: the fallback path of spec 2.6, same commit contract the worker will use.
import type { ActiveArena } from '../core/arena';
import type { CommitSink } from '../engine/engine';
import { packBatch, unpackBatch, type Shape } from './batch';
import { drawShape, type Ctx2D } from './draw';

export class MainThreadRenderCore implements CommitSink {
  /** shortcut: plain array, no chunking/SpatialGrid/baking; upgrade with the tile grid and 50k-shape ceiling (2.6, 2.7). */
  readonly log: Shape[] = [];

  constructor(private readonly ctx: Ctx2D, private background = '#ffffff', private width = 0, private height = 0) {}

  commit(a: ActiveArena, recs: Int32Array, n: number): void {
    // Pack even in-process so the worker swap-in changes only the transport.
    for (const s of unpackBatch(packBatch(a, recs, n))) {
      this.log.push(s);
      drawShape(this.ctx, s);
    }
  }

  /** Full re-raster (resize): O(N). shortcut: synchronous, upgrade to the 4 ms sliced replay. */
  redraw(width = this.width, height = this.height): void {
    this.width = width;
    this.height = height;
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, width, height);
    for (const s of this.log) drawShape(this.ctx, s);
  }

  clear(): void {
    this.log.length = 0;
    this.redraw();
  }
}

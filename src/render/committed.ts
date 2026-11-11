// CommittedStore: the committed log with a tile SpatialGrid, tombstones and a dirty-tile queue (spec 2.6, 3.2.3).
// shortcut: plain arrays instead of 4 MB chunks, no Path2D cache (shapes replay from their command stream),
// no baking; stale grid memberships are not compacted. Upgrade with the 50k-shape ceiling work (2.7).
import type { Shape } from './batch';
import { pointInShape, shapeBBox } from './hit';

export interface Entry {
  shape: Shape;
  alive: boolean;
  /** Inflated bounds x0, y0, x1, y1. */
  bb: number[];
  /** Tile range currently registered in the grid (inclusive; tx0 > tx1 means none). */
  tx0: number; ty0: number; tx1: number; ty1: number;
}

export class CommittedStore {
  readonly entries: Entry[] = [];
  aliveCount = 0;
  cols = 0;
  rows = 0;
  private tiles: number[][] = [];
  private readonly dirty = new Set<number>();
  private oldest = 0; // every id below this is dead
  private readonly scratch = [0, 0, 0, 0];

  constructor(readonly tile = 256, public width = 0, public height = 0) {
    this.layout(width, height);
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }

  private layout(w: number, h: number): void {
    this.cols = Math.ceil(w / this.tile);
    this.rows = Math.ceil(h / this.tile);
    this.tiles = Array.from({ length: this.cols * this.rows }, () => []);
  }

  /** Drops every shape and marks all tiles dirty. */
  clear(): void {
    this.entries.length = 0;
    this.aliveCount = 0;
    this.oldest = 0;
    this.layout(this.width, this.height);
    for (let t = 0; t < this.tiles.length; t++) this.dirty.add(t);
  }

  /** Resize: rebuilds the grid from the live shapes and marks every tile dirty (full re-raster, 2.6). */
  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.layout(w, h);
    for (let id = 0; id < this.entries.length; id++) {
      const e = this.entries[id];
      e.tx0 = e.ty0 = 0; e.tx1 = e.ty1 = -1;
      if (e.alive) this.register(id, e);
    }
    for (let t = 0; t < this.tiles.length; t++) this.dirty.add(t);
  }

  /** Tile lists stay ascending (= log order, so z-order) and unique, however often a shape moves. */
  private insert(t: number, id: number): void {
    const list = this.tiles[t];
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < id) lo = mid + 1;
      else hi = mid;
    }
    if (list[lo] !== id) list.splice(lo, 0, id);
  }

  private range(e: Entry): void {
    const T = this.tile;
    e.tx0 = Math.max(0, Math.floor(e.bb[0] / T));
    e.ty0 = Math.max(0, Math.floor(e.bb[1] / T));
    e.tx1 = Math.min(this.cols - 1, Math.floor(e.bb[2] / T));
    e.ty1 = Math.min(this.rows - 1, Math.floor(e.bb[3] / T));
  }

  private register(id: number, e: Entry): void {
    shapeBBox(e.shape, e.bb);
    this.range(e);
    for (let ty = e.ty0; ty <= e.ty1; ty++) for (let tx = e.tx0; tx <= e.tx1; tx++) this.insert(ty * this.cols + tx, id);
  }

  private dirtyRange(tx0: number, ty0: number, tx1: number, ty1: number): void {
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.dirty.add(ty * this.cols + tx);
  }

  /** Appends a shape on top. `dirty` marks its tiles for replay when the caller has not drawn it itself. */
  add(shape: Shape, dirty = false): number {
    const e: Entry = { shape, alive: true, bb: [0, 0, 0, 0], tx0: 0, ty0: 0, tx1: -1, ty1: -1 };
    const id = this.entries.push(e) - 1;
    this.aliveCount++;
    this.register(id, e);
    if (dirty) this.dirtyRange(e.tx0, e.ty0, e.tx1, e.ty1);
    return id;
  }

  remove(id: number): void {
    const e = this.entries[id];
    if (!e?.alive) return;
    e.alive = false;
    this.aliveCount--;
    this.dirtyRange(e.tx0, e.ty0, e.tx1, e.ty1);
  }

  /** Call after mutating a shape's vertices (or swapping its arrays): dirties old and new tiles, extends the grid. */
  touch(id: number): void {
    const e = this.entries[id];
    if (!e?.alive) return;
    const { tx0, ty0, tx1, ty1 } = e;
    shapeBBox(e.shape, e.bb);
    this.range(e);
    this.dirtyRange(tx0, ty0, tx1, ty1);
    this.dirtyRange(e.tx0, e.ty0, e.tx1, e.ty1);
    // Old tiles keep the id (stale but harmless: replay and hit re-check the bbox); the new range is
    // inserted in sorted position, so there are never duplicates and z-order matches the log.
    for (let ty = e.ty0; ty <= e.ty1; ty++) for (let tx = e.tx0; tx <= e.tx1; tx++) this.insert(ty * this.cols + tx, id);
  }

  /** Oldest still-alive id, or -1. */
  oldestAlive(): number {
    while (this.oldest < this.entries.length && !this.entries[this.oldest].alive) this.oldest++;
    return this.oldest < this.entries.length ? this.oldest : -1;
  }

  /** Topmost live shape whose fill contains (x, y): tile list newest to oldest, bbox prefilter, then exact test (2.6, 5.5). */
  hit(x: number, y: number): number {
    const tx = Math.floor(x / this.tile);
    const ty = Math.floor(y / this.tile);
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return -1;
    const list = this.tiles[ty * this.cols + tx];
    for (let k = list.length - 1; k >= 0; k--) {
      const e = this.entries[list[k]];
      if (!e.alive || x < e.bb[0] || x > e.bb[2] || y < e.bb[1] || y > e.bb[3]) continue;
      if (pointInShape(e.shape, x, y)) return list[k];
    }
    return -1;
  }

  /** Ids registered on a tile, in log order. */
  tileIds(t: number): readonly number[] {
    return this.tiles[t];
  }

  /** Takes one dirty tile (oldest marked first), or -1. */
  popDirty(): number {
    for (const t of this.dirty) {
      this.dirty.delete(t);
      return t;
    }
    return -1;
  }

  /** Tile rectangle clamped to the canvas, written into the scratch array. */
  tileRect(t: number): number[] {
    const x = (t % this.cols) * this.tile;
    const y = Math.floor(t / this.cols) * this.tile;
    const r = this.scratch;
    r[0] = x; r[1] = y;
    r[2] = Math.min(this.tile, this.width - x);
    r[3] = Math.min(this.tile, this.height - y);
    return r;
  }
}

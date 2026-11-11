// Undo / redo over the CommittedStore, spec 8.5. Operations are recorded by the store's journal; shapes are never freed while
// history refers to them (removal is a tombstone), so undo of add/remove/clear is O(ids) plus dirty-tile replay.
// shortcut: no history arena byte budget (only the step cap), no Flip/Background ops (those features do not exist yet),
// and tombstoned shapes are not physically compacted. Add the arena cap and compaction with the 50k-shape ceiling work (2.7).
import type { Shape } from './batch';
import type { CommittedStore, StoreJournal } from './committed';

export type Op =
  | { k: 'add'; ids: number[] }
  | { k: 'remove'; ids: number[] }
  | { k: 'clear'; ids: number[] }
  | { k: 'mutate'; id: number; pre: Shape; post: Shape | null };

interface Group {
  ops: Op[];
  mutated: Set<number>;
}

type Kind = 'explicit' | 'scope' | 'burst';

export const BURST_MS = 500;

export const cloneShape = (s: Shape): Shape => {
  const hdr = s.hdr.slice();
  return { hdr, hdrF: new Float32Array(hdr.buffer), cmd: s.cmd.slice(), vtx: s.vtx.slice() };
};

export class HistoryLog implements StoreJournal {
  private readonly undoStack: Group[] = [];
  private readonly redoStack: Group[] = [];
  private cur: Group | null = null;
  private kind: Kind | null = null;
  private depth = 0;
  private lastOp = -Infinity;
  private muted = 0;

  constructor(private readonly store: CommittedStore, private readonly maxSteps = 200, private readonly now: () => number = () => performance.now()) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0 || (this.cur !== null && this.kind !== 'explicit' && this.cur.ops.length > 0);
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  /** True while a pointer gesture owns a group: undo is ignored then (8.5.2). */
  get gestureOpen(): boolean {
    return this.kind === 'explicit';
  }

  private closeGroup(): void {
    const g = this.cur;
    this.cur = null;
    this.kind = null;
    if (g && g.ops.length > 0) {
      this.undoStack.push(g);
      if (this.undoStack.length > this.maxSteps) this.undoStack.shift(); // the undo horizon moves forward
    }
  }

  private openGroup(kind: Kind): void {
    this.cur = { ops: [], mutated: new Set() };
    this.kind = kind;
  }

  /** Forgets everything: a page switch starts with a clean history (it is not persisted, 8.5.3). */
  reset(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.cur = null;
    this.kind = null;
    this.depth = 0;
  }

  /** Pointer gesture: pointerdown opens a group, pointerup closes it; everything committed or mutated between belongs to it. */
  begin(): void {
    this.closeGroup();
    this.openGroup('explicit');
  }
  end(): void {
    if (this.kind === 'explicit') this.closeGroup();
  }

  /** Runs `fn` so that every op it records lands in one group (the surrounding gesture's, or a group of its own). */
  scope<T>(fn: () => T): T {
    if (this.kind === null || this.kind === 'burst') {
      this.closeGroup();
      this.openGroup('scope');
    }
    this.depth++;
    try {
      return fn();
    } finally {
      if (--this.depth === 0 && this.kind === 'scope') this.closeGroup();
    }
  }

  /** Runs `fn` without recording (applying an undo or redo, or a clear that records itself as one op). */
  silently<T>(fn: () => T): T {
    this.muted++;
    try {
      return fn();
    } finally {
      this.muted--;
    }
  }

  /** The group an op belongs to: the open one, or a burst (hover-driven ops, one group per 500 ms of quiet). */
  private target(): Group {
    const t = this.now();
    if (this.kind === null || (this.kind === 'burst' && t - this.lastOp > BURST_MS)) {
      this.closeGroup();
      this.openGroup('burst');
    }
    if (this.kind === 'burst') this.lastOp = t;
    return this.cur!;
  }

  private push(op: Op): void {
    const g = this.target();
    this.redoStack.length = 0; // a new operation after an undo drops the redo stack
    const last = g.ops[g.ops.length - 1];
    if (op.k === 'add' && last?.k === 'add') last.ids.push(...op.ids);
    else if (op.k === 'remove' && last?.k === 'remove') last.ids.push(...op.ids);
    else g.ops.push(op);
  }

  add(id: number): void {
    if (!this.muted) this.push({ k: 'add', ids: [id] });
  }
  remove(id: number): void {
    if (!this.muted) this.push({ k: 'remove', ids: [id] });
  }
  willMutate(id: number, shape: Shape): void {
    if (this.muted) return;
    const g = this.target();
    if (g.mutated.has(id)) return; // copy on first write: a long burst costs one copy per shape
    g.mutated.add(id);
    this.push({ k: 'mutate', id, pre: cloneShape(shape), post: null });
  }

  /** Clear: tombstones every live shape as a single op. */
  clearAll(): void {
    const ids = this.store.aliveIds();
    if (ids.length === 0) return;
    this.scope(() => {
      this.silently(() => {
        for (const id of ids) this.store.remove(id);
      });
      this.push({ k: 'clear', ids });
    });
  }

  /** Undo the newest group. False when there is nothing to undo or a stroke is in progress. */
  undo(): boolean {
    if (this.kind === 'explicit') return false;
    this.closeGroup();
    const g = this.undoStack.pop();
    if (!g) return false;
    this.silently(() => {
      for (let i = g.ops.length - 1; i >= 0; i--) this.apply(g.ops[i], true);
    });
    this.redoStack.push(g);
    return true;
  }

  redo(): boolean {
    if (this.kind === 'explicit') return false;
    this.closeGroup();
    const g = this.redoStack.pop();
    if (!g) return false;
    this.silently(() => {
      for (const op of g.ops) this.apply(op, false);
    });
    this.undoStack.push(g);
    return true;
  }

  private apply(op: Op, undo: boolean): void {
    const s = this.store;
    switch (op.k) {
      case 'add':
        for (const id of op.ids) undo ? s.remove(id) : s.revive(id);
        break;
      case 'remove':
      case 'clear':
        for (const id of op.ids) undo ? s.revive(id) : s.remove(id);
        break;
      case 'mutate': {
        const e = s.entries[op.id];
        if (!e) break;
        if (undo) {
          op.post ??= cloneShape(e.shape); // the post-image is captured lazily, on the first undo
          s.replaceShape(op.id, cloneShape(op.pre)); // clones: the live shape is mutated in place later and must not alias history
        } else if (op.post) s.replaceShape(op.id, cloneShape(op.post));
        break;
      }
    }
  }
}

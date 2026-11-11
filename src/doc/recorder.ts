// PageRecorder: turns store changes into log segments (8.6.2). It queues what happened, in order, and `flush` writes the queue
// as segments reading shape data at flush time, so a shape drawn and then jittered inside one window is stored once, final.
import type { CommittedStore, StoreObserver } from '../render/committed';
import { Kind, concat, encodeSegment, type Segment } from './pageLog';

type Op = { k: 'add' | 'remove' | 'revive' | 'mutate'; id: number };

export class PageRecorder implements StoreObserver {
  private ops: Op[] = [];

  /** `onDirty` fires when the queue goes from empty to non-empty: the saver arms its timer there. */
  constructor(private readonly store: CommittedStore, private readonly onDirty: () => void = () => {}) {}

  attach(): void {
    if (!this.store.observers.includes(this)) this.store.observers.push(this);
  }
  detach(): void {
    const i = this.store.observers.indexOf(this);
    if (i >= 0) this.store.observers.splice(i, 1);
    this.ops = [];
  }

  get dirty(): boolean {
    return this.ops.length > 0;
  }

  private note(op: Op): void {
    this.ops.push(op);
    if (this.ops.length === 1) this.onDirty();
  }
  added(id: number): void { this.note({ k: 'add', id }); }
  removed(id: number): void { this.note({ k: 'remove', id }); }
  revived(id: number): void { this.note({ k: 'revive', id }); }
  mutated(id: number): void { this.note({ k: 'mutate', id }); }

  /** The queued changes as encoded segments, or null when nothing changed. The queue is emptied. */
  flush(): Uint8Array | null {
    if (this.ops.length === 0) return null;
    const ops = this.ops;
    this.ops = [];
    const added = new Set<number>();
    for (const o of ops) if (o.k === 'add') added.add(o.id);
    // a shape's final state goes at its last mutate; one added in this window is already stored final by its COMMIT
    const lastMutate = new Map<number, number>();
    ops.forEach((o, i) => { if (o.k === 'mutate' && !added.has(o.id)) lastMutate.set(o.id, i); });

    const parts: Uint8Array[] = [];
    const seg = (s: Segment): void => void parts.push(encodeSegment(s));
    let run: number[] = [];
    let kind: Kind.Remove | Kind.Revive | null = null;
    const endRuns = (): void => {
      if (run.length > 0 && kind === null) seg({ kind: Kind.Commit, shapes: run.map((id) => this.store.entries[id].shape) });
      else if (run.length > 0 && kind !== null) seg({ kind, ids: run });
      run = [];
      kind = null;
    };
    ops.forEach((o, i) => {
      const want = o.k === 'add' ? null : o.k === 'remove' ? Kind.Remove : o.k === 'revive' ? Kind.Revive : undefined;
      if (want === undefined) {
        if (lastMutate.get(o.id) !== i) return; // superseded by a later mutate of the same shape
        endRuns();
        seg({ kind: Kind.Mutate, id: o.id, shape: this.store.entries[o.id].shape });
        return;
      }
      if (run.length > 0 && want !== kind) endRuns();
      kind = want;
      run.push(o.id);
    });
    endRuns();
    return parts.length > 0 ? concat(parts) : null;
  }
}

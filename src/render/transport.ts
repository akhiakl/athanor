// Message transport that can be re-pointed: it queues until a backend is attached, so the page works from the first stroke
// while the worker proves it can start, and a failed worker can be swapped for the local host without losing messages.
import type { ToWorker } from './protocol';

export type Send = (m: ToWorker, transfer?: Transferable[]) => void;

export class Transport {
  private queue: Array<[ToWorker, Transferable[] | undefined]> = [];
  private target: Send | null = null;

  readonly send: Send = (m, transfer) => {
    if (this.target) this.target(m, transfer);
    else this.queue.push([m, transfer]);
  };

  /** Points the transport at a backend and flushes anything queued, in order. Re-attaching replaces the target. */
  attach(target: Send): void {
    this.target = target;
    const q = this.queue;
    this.queue = [];
    for (const [m, t] of q) target(m, t);
  }

  get queued(): number {
    return this.queue.length;
  }
}

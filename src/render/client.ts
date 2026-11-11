// RenderClient: the main-thread side of the render protocol. It is the engine's CommitSink and owns the
// pending-until-ack list, so a committed shape stays visible on the active layer until the committed canvas shows it (2.5).
import type { ActiveArena } from '../core/arena';
import type { CommitSink } from '../engine/engine';
import type { AffectParams } from './affects';
import { packBatch, unpackBatch, type Shape } from './batch';
import type { FromWorker, ToWorker } from './protocol';

const HOVER_MAX = 64;

export class RenderClient implements CommitSink {
  private nextBatch = 1;
  private readonly inflight = new Map<number, Shape[]>();
  /** Shapes handed off but not yet acked; the active renderer draws them. Rebuilt only when it changes. */
  pending: Shape[] = [];
  ready = false;

  private hover_ = new Float32Array(HOVER_MAX * 3);
  private hoverN = 0;
  private affectsOn = new Set<string>();

  /**
   * @param send transport (worker.postMessage, or a direct call into a local RenderHost)
   * @param transfer true across a real worker: buffers are detached on send, so a copy is kept for the pending draw
   * @param onChange called when pending shrinks, so the active layer can erase it
   */
  constructor(
    private readonly send: (m: ToWorker, transfer?: Transferable[]) => void,
    private readonly transfer: boolean,
    private readonly onChange: () => void,
  ) {}

  onMessage(m: FromWorker): void {
    if (m.type === 'ready') this.ready = true;
    else if (m.type === 'alive') return; // handled by the bootstrap, before the canvas is transferred
    else if (m.type === 'commitAck' && this.inflight.delete(m.batchId)) {
      this.pending = [...this.inflight.values()].flat();
      this.onChange();
    }
  }

  commit(a: ActiveArena, recs: Int32Array, n: number): void {
    const buffer = packBatch(a, recs, n);
    const batchId = this.nextBatch++;
    const shapes = unpackBatch(this.transfer ? buffer.slice(0) : buffer);
    this.inflight.set(batchId, shapes);
    this.pending = [...this.inflight.values()].flat();
    this.send({ type: 'commit', batchId, buffer }, this.transfer ? [buffer] : undefined);
  }

  hover(x: number, y: number, t: number): void {
    if (this.hoverN === HOVER_MAX) this.flush();
    const o = 3 * this.hoverN++;
    this.hover_[o] = x;
    this.hover_[o + 1] = y;
    this.hover_[o + 2] = t;
  }

  /** Sends the coalesced hover batch (at most one message per tick, 7.2). */
  flush(): void {
    if (this.hoverN === 0) return;
    const samples = this.hover_.slice(0, 3 * this.hoverN);
    this.hoverN = 0;
    this.send({ type: 'hover', samples }, this.transfer ? [samples.buffer] : undefined);
  }

  /** Once per frame, after input is drained. Affects such as Limit need the in-flight count every frame. */
  tick(activeCount: number): void {
    this.flush();
    if (this.affectsOn.size > 0) this.send({ type: 'tick', activeCount });
  }

  setAffect(id: string, on: boolean, params?: AffectParams): void {
    if (on) this.affectsOn.add(id);
    else this.affectsOn.delete(id);
    this.send({ type: 'affect', id, on, params });
  }

  get hasAffects(): boolean {
    return this.affectsOn.size > 0;
  }

  isAffectOn(id: string): boolean {
    return this.affectsOn.has(id);
  }

  resize(w: number, h: number, dpr: number): void {
    this.send({ type: 'resize', w, h, dpr });
  }

  /** Forgets batches that were handed off but not acked, and tells the active layer to erase them. Late acks are ignored. */
  dropPending(): void {
    this.inflight.clear();
    this.pending = [];
    this.onChange();
  }

  clear(): void {
    this.dropPending(); // cleared strokes must not stay visible on the active layer until the worker acks them
    this.send({ type: 'clear' });
  }
}

// RenderHost: everything the render worker does, as a plain message-driven class. The worker file is a thin shell around it,
// and the main-thread fallback runs the same class directly, so there is one code path to test.
import type { CommittedStore } from './committed';
import { RenderCore } from './core';
import type { Ctx2D } from './draw';
import type { FromWorker, ToWorker } from './protocol';

export type HostCtx = Ctx2D & { setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void };
/** The slice of OffscreenCanvas / HTMLCanvasElement the host uses. */
export interface HostCanvas {
  width: number;
  height: number;
  getContext(type: '2d', opts?: object): HostCtx | null;
}

export interface HostOptions {
  /** Replay time per frame: 4 ms in the worker, 2 ms on the main thread (7.2). */
  budgetMs: number;
  /** Local mode: ack in the same call, since nothing is presented in between. Worker mode acks after the next frame. */
  ackImmediately?: boolean;
}

export class RenderHost {
  private core: RenderCore | null = null;
  private canvas: HostCanvas | null = null;
  private ctx: HostCtx | null = null;
  private seed = 0;
  private acks: number[] = [];

  constructor(
    private readonly post: (m: FromWorker, transfer?: Transferable[]) => void,
    private readonly requestFrame: () => void,
    private readonly opts: HostOptions,
  ) {}

  /** The committed store, for tests and stats. */
  get store(): CommittedStore | null {
    return this.core?.store ?? null;
  }

  handle(m: ToWorker): void {
    if (m.type === 'init') {
      this.canvas = m.canvas as unknown as HostCanvas;
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!this.ctx) throw new Error('2d context unavailable');
      this.core = new RenderCore(this.ctx, '#ffffff', {
        clone: (buffer) => this.post({ type: 'repeatClone', buffer }, [buffer]),
        commitAffects: () => this.post({ type: 'repeatCommit' }),
      });
      this.seed = m.seed;
      this.resize(m.dpr, m.w, m.h);
      this.post({ type: 'ready' });
      this.requestFrame();
      return;
    }
    const core = this.core;
    if (!core) return; // messages before init are dropped
    // A throwing message must not kill the worker: the log lives only here, and an uncaught error would make the page
    // swap backends and lose the drawing. Report it and carry on. (init still throws, so a worker that cannot start falls back.)
    try {
      switch (m.type) {
        case 'commit':
          try {
            core.commitBatch(m.buffer);
          } finally {
            // ack even a batch that failed to apply, or it would stay pending on the active layer forever
            if (this.opts.ackImmediately) this.post({ type: 'commitAck', batchId: m.batchId });
            else this.acks.push(m.batchId);
          }
          break;
        case 'hover':
          for (let i = 0; i + 2 < m.samples.length; i += 3) core.hover(m.samples[i], m.samples[i + 1], m.samples[i + 2]);
          break;
        case 'tick':
          core.tick(m.activeCount);
          break;
        case 'resize':
          this.resize(m.dpr, m.w, m.h);
          break;
        case 'clear':
          core.clear();
          break;
        case 'affect':
          core.setAffect(m.id, m.on, this.seed, m.params);
          break;
        case 'event':
          core.event(m.name, m.code);
          break;
      }
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    this.requestFrame();
  }

  private resize(dpr: number, w: number, h: number): void {
    const c = this.canvas!;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); // resizing the canvas reset the transform
    this.core!.resize(w, h);
  }

  /** One frame: replay dirty tiles within budget, then ack drawn batches. Returns true when another frame is needed. */
  frame(): boolean {
    const core = this.core;
    if (!core) return false;
    let left = 0;
    try {
      left = core.replay(this.opts.budgetMs);
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    for (const id of this.acks) this.post({ type: 'commitAck', batchId: id });
    this.acks.length = 0;
    return left > 0;
  }
}

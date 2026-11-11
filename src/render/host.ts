// RenderHost: everything the render worker does, as a plain message-driven class. The worker file is a thin shell around it,
// and the main-thread fallback runs the same class directly, so there is one code path to test.
import type { CommittedStore } from './committed';
import { RenderCore } from './core';
import type { Ctx2D } from './draw';
import { PagePersistence } from '../doc/persistence';
import { applySegments } from '../doc/pageLog';
import { PageSaver } from '../doc/saver';
import type { Storage } from '../doc/storage';
import type { MakeCanvas } from './export';
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
  /** Creates the canvas a PNG export draws into (OffscreenCanvas in a worker and on the main thread alike). */
  makeCanvas?: MakeCanvas;
  /** Opens document storage (IndexedDB) where the host runs. Without it, pages cannot be opened and nothing is saved. */
  openStorage?: () => Promise<Storage>;
  /** Local mode: ack in the same call, since nothing is presented in between. Worker mode acks after the next frame. */
  ackImmediately?: boolean;
}

export class RenderHost {
  private core: RenderCore | null = null;
  private canvas: HostCanvas | null = null;
  private ctx: HostCtx | null = null;
  private seed = 0;
  private acks: number[] = [];
  private lastHistory = { canUndo: false, canRedo: false };
  private storage: Promise<Storage> | null = null;
  private saver: PageSaver | null = null;
  private page: { width: number; height: number; background: number } | undefined;
  private opening = false;
  private queued: ToWorker[] = [];

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
    if (this.opening) { // a page is loading: what follows belongs to it, so it waits its turn
      this.queued.push(m);
      return;
    }
    if (m.type === 'page') {
      this.pageMessage(core, m);
      return;
    }
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
        case 'export':
          this.runExport(core, m);
          break;
        case 'history':
          if (m.op === 'begin') core.history.begin();
          else if (m.op === 'end') core.history.end();
          else if (m.op === 'undo') core.undo();
          else core.redo();
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
    this.reportHistory(core);
    this.requestFrame();
  }

  private pageMessage(core: RenderCore, m: Extract<ToWorker, { type: 'page' }>): void {
    if (m.op === 'flush') {
      const saver = this.saver;
      const answer = (): void => this.post({ type: 'pageFlushed', id: m.id, revision: saver?.revision ?? 0, error: saver?.status === 'error' ? saver.lastError?.message ?? 'save failed' : undefined });
      if (saver) void saver.flush().then(answer, answer);
      else answer();
      return;
    }
    this.opening = true;
    this.openPage(core, m).then(
      (empty) => this.finishOpen(core, { type: 'pageState', state: 'opened', pageId: m.pageId, empty }),
      (err: unknown) => this.finishOpen(core, { type: 'pageState', state: 'error', pageId: m.pageId, message: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** Releases what arrived during the load into the new page first, then answers, so the caller may draw at once. */
  private finishOpen(core: RenderCore, answer: FromWorker): void {
    this.opening = false;
    const queued = this.queued;
    this.queued = [];
    for (const q of queued) this.handle(q);
    this.reportHistory(core);
    this.post(answer);
    this.requestFrame();
  }

  /** Loads the page; resolves with whether it was empty. */
  private async openPage(core: RenderCore, m: Extract<ToWorker, { type: 'page'; op: 'open' }>): Promise<boolean> {
    if (!this.opts.openStorage) throw new Error('storage is not available in this browser');
    const storage = await (this.storage ??= this.opts.openStorage());
    if (this.saver) { // the page being left is written out before the next one replaces it
      await this.saver.flush();
      this.saver.dispose();
      this.saver = null;
    }
    core.resetPage();
    const header = { width: m.width, height: m.height, background: m.background };
    this.page = header;
    const persistence = new PagePersistence(storage, m.pageId, header);
    const loaded = await persistence.load();
    if (loaded) core.history.silently(() => applySegments(core.store, loaded.segments)); // loading is not an undoable edit
    core.history.reset();
    this.saver = new PageSaver(core.store, persistence, (state, err) => this.post({ type: 'pageState', state, message: err?.message }));
    core.replay(Infinity);
    return loaded === null;
  }

  private runExport(core: RenderCore, m: Extract<ToWorker, { type: 'export' }>): void {
    const fail = (err: unknown): void => this.post({ type: 'exportError', id: m.id, message: err instanceof Error ? err.message : String(err) });
    try {
      if (m.format === 'pdf') {
        this.post({ type: 'exportResult', id: m.id, blob: core.exportPdf(this.page) });
        return;
      }
      if (m.format === 'svg') {
        this.post({ type: 'exportResult', id: m.id, blob: core.exportSvg(m.transparent) });
        return;
      }
      const make = this.opts.makeCanvas ?? (typeof OffscreenCanvas !== 'undefined' ? (w: number, h: number) => new OffscreenCanvas(w, h) as unknown as ReturnType<MakeCanvas> : null);
      if (!make) throw new Error('PNG export needs OffscreenCanvas, which this browser lacks. Export SVG instead.');
      core.exportPng(m.scale, m.transparent, make).then((blob) => this.post({ type: 'exportResult', id: m.id, blob }), fail);
    } catch (err) {
      fail(err);
    }
  }

  /** Tells the main thread what undo and redo can do, only when that changed. */
  private reportHistory(core: RenderCore): void {
    const canUndo = core.history.canUndo, canRedo = core.history.canRedo;
    if (canUndo === this.lastHistory.canUndo && canRedo === this.lastHistory.canRedo) return;
    this.lastHistory = { canUndo, canRedo };
    this.post({ type: 'historyState', canUndo, canRedo });
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

// PageSaver: autosave for the open page. Flushes the recorder at most every second (8.6.2), keeps what could not be written so the
// next flush retries it (quota, a closing tab), and compacts when the log has outgrown its snapshot.
import type { CommittedStore } from '../render/committed';
import { concat } from './pageLog';
import type { PagePersistence } from './persistence';
import { PageRecorder } from './recorder';

export type SaveStatus = 'saved' | 'saving' | 'error';

export class PageSaver {
  readonly recorder: PageRecorder;
  private backlog: Uint8Array[] = [];
  private lastFlush = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  status: SaveStatus = 'saved';
  lastError: Error | null = null;

  constructor(
    private readonly store: CommittedStore,
    private readonly persistence: PagePersistence,
    private readonly onStatus: (s: SaveStatus, err?: Error) => void = () => {},
    private readonly intervalMs = 1000,
    /** Arm a timer when changes arrive, so a drawing is saved even after frames stop. Tests turn it off. */
    private readonly autoSchedule = true,
  ) {
    this.recorder = new PageRecorder(store, () => this.arm());
    this.recorder.attach();
  }

  private timer: ReturnType<typeof setTimeout> | null = null;

  private arm(): void {
    if (!this.autoSchedule || this.timer !== null) return;
    const wait = Math.max(0, this.intervalMs - (performance.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  get revision(): number {
    return this.recorder.revision;
  }

  get pending(): boolean {
    return this.recorder.dirty || this.backlog.length > 0;
  }

  /** Once per frame: starts a flush when something is pending and the interval has passed. */
  tick(now: number): void {
    if (this.pending && now - this.lastFlush >= this.intervalMs) void this.flush(now);
  }

  private set(s: SaveStatus, err?: Error): void {
    if (s === this.status && !err) return;
    this.status = s;
    this.lastError = err ?? null;
    this.onStatus(s, err);
  }

  /** Writes everything pending. Serialized: a flush that starts while another runs waits for it. */
  flush(now = performance.now()): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.lastFlush = now;
    const bytes = this.recorder.flush();
    if (bytes) this.backlog.push(bytes);
    this.chain = this.chain.then(() => this.write());
    return this.chain;
  }

  private async write(): Promise<void> {
    if (this.backlog.length === 0) return;
    this.set('saving');
    const batch = this.backlog;
    this.backlog = [];
    try {
      await this.persistence.append(concat(batch));
      if (this.persistence.needsCompaction && !this.recorder.dirty) await this.persistence.compact(this.store);
      this.set(this.pending ? 'saving' : 'saved');
      if (this.recorder.dirty) this.arm(); // more arrived while this write was in flight
    } catch (err) {
      this.backlog = [...batch, ...this.backlog]; // keep it, in order, for the next attempt
      this.set('error', err instanceof Error ? err : new Error(String(err)));
      this.arm(); // retry on the next interval
    }
  }

  dispose(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.recorder.detach();
  }
}

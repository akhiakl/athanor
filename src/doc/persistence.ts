// PagePersistence: one page's snapshot and log chunks in blob storage, spec 8.6.2.
//   p:{id}:snap:{seq}   snapshot covering every log chunk up to and including seq
//   p:{id}:log:{seq}    one flush worth of segments (chunk 0 starts with the file header)
// A snapshot is written before the chunks it replaces are deleted, and chunks at or below its seq are ignored on load, so a crash
// in between can never replay a chunk twice. Compaction runs when the log outgrows twice the snapshot plus 1 MB.
import { applySegments, concat, decodeHeader, decodeSegments, encodeHeader, encodeSnapshot, HEADER_BYTES, type PageHeader, type Segment } from './pageLog';
import type { CommittedStore } from '../render/committed';
import type { Storage } from './storage';

const pad = (n: number): string => String(n).padStart(8, '0');
const seqOf = (key: string): number => Number(key.slice(key.lastIndexOf(':') + 1));
export const COMPACT_SLACK = 1024 * 1024;

export interface Loaded {
  header: PageHeader;
  segments: Segment[];
}

export class PagePersistence {
  private nextSeq = 0;
  private logBytes = 0;
  private snapBytes = 0;
  private lastError: Error | null = null;

  constructor(private readonly storage: Storage, readonly pageId: string, private readonly header: PageHeader) {}

  private key(kind: 'snap' | 'log', seq: number): string {
    return `p:${this.pageId}:${kind}:${pad(seq)}`;
  }

  /** The newest snapshot plus the chunks after it, decoded; null for a page with nothing stored yet. */
  async load(): Promise<Loaded | null> {
    const snaps = await this.storage.blobKeys(`p:${this.pageId}:snap:`);
    const logs = await this.storage.blobKeys(`p:${this.pageId}:log:`);
    const snapKey = snaps.at(-1);
    const covered = snapKey ? seqOf(snapKey) : -1;
    const segments: Segment[] = [];
    let header: PageHeader | null = null;
    let bad = false;
    if (snapKey) {
      const bytes = await this.storage.getBlob(snapKey);
      header = bytes ? decodeHeader(bytes) : null;
      if (bytes && header) {
        const d = decodeSegments(bytes, HEADER_BYTES);
        segments.push(...d.segments);
        this.snapBytes = bytes.length;
        bad = d.validBytes < bytes.length;
      }
    }
    const chunks: Uint8Array[] = [];
    for (const k of logs) {
      if (seqOf(k) <= covered) continue;
      const b = await this.storage.getBlob(k);
      if (b) chunks.push(b);
    }
    if (chunks.length > 0 && !bad) {
      let all = concat(chunks);
      if (!header) {
        header = decodeHeader(all);
        all = all.subarray(HEADER_BYTES);
      }
      if (header) {
        segments.push(...decodeSegments(all).segments); // a torn or corrupt tail ends the replay, keeping everything before it
        this.logBytes = all.length;
      }
    }
    this.nextSeq = Math.max(covered, logs.length ? seqOf(logs.at(-1)!) : -1) + 1;
    return header ? { header, segments } : null;
  }

  /** Appends one flush of segments. Rejects on quota or a closed database; the caller decides how loudly to say so. */
  async append(segments: Uint8Array): Promise<void> {
    const first = this.nextSeq === 0 && this.snapBytes === 0;
    const chunk = first ? concat([encodeHeader(this.header), segments]) : segments;
    try {
      await this.storage.putBlob(this.key('log', this.nextSeq), chunk);
      this.nextSeq++;
      this.logBytes += segments.length;
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      throw this.lastError;
    }
  }

  get needsCompaction(): boolean {
    return this.logBytes > 2 * this.snapBytes + COMPACT_SLACK;
  }

  /** Writes a snapshot of the live store, then drops what it replaced. Call right after a flush so the store equals the log. */
  async compact(store: CommittedStore): Promise<void> {
    if (this.nextSeq === 0) return;
    const seq = this.nextSeq - 1;
    const snap = encodeSnapshot(store, this.header);
    await this.storage.putBlob(this.key('snap', seq), snap);
    for (const k of await this.storage.blobKeys(`p:${this.pageId}:snap:`)) if (seqOf(k) < seq) await this.storage.deleteBlob(k);
    for (const k of await this.storage.blobKeys(`p:${this.pageId}:log:`)) if (seqOf(k) <= seq) await this.storage.deleteBlob(k);
    this.snapBytes = snap.length;
    this.logBytes = 0;
  }

  /** Removes every blob of the page. */
  async destroy(): Promise<void> {
    for (const prefix of [`p:${this.pageId}:snap:`, `p:${this.pageId}:log:`]) for (const k of await this.storage.blobKeys(prefix)) await this.storage.deleteBlob(k);
  }

  /** Rebuilds a store from what is saved. Returns how many segments were applied. */
  static async restore(storage: Storage, pageId: string, store: CommittedStore, header: PageHeader): Promise<{ loaded: boolean; persistence: PagePersistence }> {
    const p = new PagePersistence(storage, pageId, header);
    const l = await p.load();
    if (l) applySegments(store, l.segments);
    return { loaded: l !== null, persistence: p };
  }
}

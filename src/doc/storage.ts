// Storage seam for documents: small records (files, pages) and binary blobs (page snapshots and log chunks). IndexedDB in the app,
// a Map in tests. shortcut: blobs live in IndexedDB; OPFS sync access handles (8.6.1) replace them when the log write path is measured.
export type RecordStore = 'files' | 'pages';

export interface Storage {
  getRecord<T>(store: RecordStore, id: string): Promise<T | undefined>;
  putRecord<T extends { id: string }>(store: RecordStore, value: T): Promise<void>;
  deleteRecord(store: RecordStore, id: string): Promise<void>;
  allRecords<T>(store: RecordStore): Promise<T[]>;
  getBlob(key: string): Promise<Uint8Array | undefined>;
  putBlob(key: string, bytes: Uint8Array): Promise<void>;
  deleteBlob(key: string): Promise<void>;
  /** Keys starting with `prefix`, ascending. */
  blobKeys(prefix: string): Promise<string[]>;
}

export class MemoryStorage implements Storage {
  readonly records = { files: new Map<string, unknown>(), pages: new Map<string, unknown>() };
  readonly blobs = new Map<string, Uint8Array>();
  /** Tests: make the next blob write fail (quota, closed database). */
  failWrites = false;

  async getRecord<T>(s: RecordStore, id: string): Promise<T | undefined> { return structuredClone(this.records[s].get(id)) as T | undefined; }
  async putRecord<T extends { id: string }>(s: RecordStore, v: T): Promise<void> { this.records[s].set(v.id, structuredClone(v)); }
  async deleteRecord(s: RecordStore, id: string): Promise<void> { this.records[s].delete(id); }
  async allRecords<T>(s: RecordStore): Promise<T[]> { return [...this.records[s].values()].map((v) => structuredClone(v) as T); }
  async getBlob(k: string): Promise<Uint8Array | undefined> { return this.blobs.get(k)?.slice(); }
  async putBlob(k: string, b: Uint8Array): Promise<void> {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.blobs.set(k, b.slice());
  }
  async deleteBlob(k: string): Promise<void> { this.blobs.delete(k); }
  async blobKeys(prefix: string): Promise<string[]> { return [...this.blobs.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

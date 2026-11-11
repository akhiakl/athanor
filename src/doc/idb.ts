// IndexedDB implementation of Storage. Database `athanor`, stores `files`, `pages`, `blobs` (spec 8.6.1; `kv` arrives with settings).
import type { RecordStore, Storage } from './storage';

const DB = 'athanor';
const VERSION = 1;

const wrap = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

const done = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error ?? new DOMException('aborted', 'AbortError'));
});

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = factory.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result; // migrations switch on event.oldVersion as versions are added
      db.createObjectStore('files', { keyPath: 'id' });
      const pages = db.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('fileId', 'fileId');
      db.createObjectStore('blobs');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close(); // another tab upgrading or resetting the database must not be blocked by this one
      res(db);
    };
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('database upgrade blocked by another tab'));
  });
}

export class IdbStorage implements Storage {
  constructor(private readonly db: IDBDatabase) {}

  private store(name: string, mode: IDBTransactionMode): { os: IDBObjectStore; tx: IDBTransaction } {
    const tx = this.db.transaction(name, mode);
    return { os: tx.objectStore(name), tx };
  }

  getRecord<T>(s: RecordStore, id: string): Promise<T | undefined> { return wrap(this.store(s, 'readonly').os.get(id)); }
  async putRecord<T extends { id: string }>(s: RecordStore, v: T): Promise<void> {
    const { os, tx } = this.store(s, 'readwrite');
    os.put(v);
    await done(tx);
  }
  async deleteRecord(s: RecordStore, id: string): Promise<void> {
    const { os, tx } = this.store(s, 'readwrite');
    os.delete(id);
    await done(tx);
  }
  allRecords<T>(s: RecordStore): Promise<T[]> { return wrap(this.store(s, 'readonly').os.getAll()); }

  async getBlob(key: string): Promise<Uint8Array | undefined> {
    const v = (await wrap(this.store('blobs', 'readonly').os.get(key))) as ArrayBuffer | Uint8Array | undefined;
    return v === undefined ? undefined : v instanceof Uint8Array ? v : new Uint8Array(v);
  }
  async putBlob(key: string, bytes: Uint8Array): Promise<void> {
    const { os, tx } = this.store('blobs', 'readwrite');
    os.put(bytes.slice().buffer, key); // a copy: the caller keeps its array
    await done(tx);
  }
  async deleteBlob(key: string): Promise<void> {
    const { os, tx } = this.store('blobs', 'readwrite');
    os.delete(key);
    await done(tx);
  }
  async blobKeys(prefix: string): Promise<string[]> {
    return (await wrap(this.store('blobs', 'readonly').os.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')))) as string[];
  }
}

/** Storage that opens the database on first use, so the page can be built synchronously and boot decides what to do if it fails. */
export function lazyIdbStorage(factory: IDBFactory = indexedDB): Storage {
  let opened: Promise<IdbStorage> | null = null;
  const db = (): Promise<IdbStorage> => (opened ??= openDb(factory).then((d) => new IdbStorage(d)));
  return {
    getRecord: (s, id) => db().then((d) => d.getRecord(s, id)),
    putRecord: (s, v) => db().then((d) => d.putRecord(s, v)),
    deleteRecord: (s, id) => db().then((d) => d.deleteRecord(s, id)),
    allRecords: (s) => db().then((d) => d.allRecords(s)),
    getBlob: (k) => db().then((d) => d.getBlob(k)),
    putBlob: (k, b) => db().then((d) => d.putBlob(k, b)),
    deleteBlob: (k) => db().then((d) => d.deleteBlob(k)),
    blobKeys: (p) => db().then((d) => d.blobKeys(p)),
  };
}

// Document model, spec 8.4: a file is an ordered list of fixed-size pages; each page is one canvas with its own log.
// shortcut: no document-level undo for page operations (8.5.4), no trash purge, and thumbnails are not stored yet.
import { PagePersistence, snapKey } from './persistence';
import type { Storage } from './storage';

/** What a template sets up when its file is first opened (8.3.1). */
export interface Preset {
  create?: string;
  affects?: string[];
  values?: Record<string, Record<string, number | boolean>>;
  session?: { intervalSec: number; autoClear: boolean; start: boolean };
}

export const TRASH_DAYS = 30;

export interface FileRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageOrder: string[];
  lastPageId: string;
  /** Set when moved to the trash; the file and its pages stay stored until purged. */
  deletedAt?: number;
  /** Page 1 as a small image for the file browser. */
  thumb?: Blob;
  preset?: Preset;
  /** True until the editor has applied `preset` once; the user's later changes are not overwritten on the next open. */
  presetPending?: boolean;
}

export interface PageRecord {
  id: string;
  fileId: string;
  name: string;
  width: number;
  height: number;
  /** 0xRRGGBB */
  background: number;
  createdAt: number;
  origin: 'user' | 'session';
  logVersion: number;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-char ULID: 48-bit millisecond time then 80 random bits, so ids sort by creation time. */
export function newId(now: number = Date.now(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let t = '';
  for (let i = 0, x = now; i < 10; i++, x = Math.floor(x / 32)) t = CROCKFORD[x % 32] + t;
  let r = '';
  const bytes = random(10);
  let bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { r += CROCKFORD[(acc >> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return t + r;
}

export const MAX_SIDE = 8192;
export const clampSide = (n: number): number => Math.min(MAX_SIDE, Math.max(1, Math.round(n)));

export class Docs {
  constructor(readonly storage: Storage, private readonly now: () => number = Date.now, private readonly id: () => string = () => newId()) {}

  /** True for any stored file id, trashed or not. */
  async hasFile(id: string): Promise<boolean> {
    return (await this.getFile(id)) !== undefined;
  }

  async listFiles(): Promise<FileRecord[]> {
    const all = await this.storage.allRecords<FileRecord>('files');
    return all.filter((f) => f.deletedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getFile(id: string): Promise<FileRecord | undefined> {
    return this.storage.getRecord<FileRecord>('files', id);
  }

  /** A new file with one blank page of the given size. */
  async createFile(name: string, width: number, height: number, preset?: Preset): Promise<{ file: FileRecord; page: PageRecord }> {
    const t = this.now();
    const fileId = this.id();
    const page = this.makePage(fileId, 'Page 1', width, height);
    const file: FileRecord = { id: fileId, name, createdAt: t, updatedAt: t, pageOrder: [page.id], lastPageId: page.id, ...(preset ? { preset, presetPending: true } : {}) };
    await this.storage.putRecord('pages', page);
    await this.storage.putRecord('files', file);
    return { file, page };
  }

  private makePage(fileId: string, name: string, width: number, height: number, background = 0xffffff, origin: PageRecord['origin'] = 'user'): PageRecord {
    return { id: this.id(), fileId, name, width: clampSide(width), height: clampSide(height), background, createdAt: this.now(), origin, logVersion: 1 };
  }

  getPage(id: string): Promise<PageRecord | undefined> {
    return this.storage.getRecord<PageRecord>('pages', id);
  }

  /** The file's pages in order. Pages missing from storage are skipped rather than failing the whole list. */
  async pages(fileId: string): Promise<PageRecord[]> {
    const file = await this.getFile(fileId);
    if (!file) return [];
    const pages = await Promise.all(file.pageOrder.map((id) => this.getPage(id)));
    return pages.filter((p): p is PageRecord => p !== undefined);
  }

  private async touch(file: FileRecord, patch: Partial<FileRecord> = {}): Promise<FileRecord> {
    const next = { ...file, ...patch, updatedAt: this.now() };
    await this.storage.putRecord('files', next);
    return next;
  }

  /** Adds a page after `afterPageId` (default: at the end), the same size as the page it follows. */
  async addPage(fileId: string, afterPageId?: string): Promise<PageRecord> {
    const file = await this.requireFile(fileId);
    const after = (afterPageId ? await this.getPage(afterPageId) : undefined) ?? (await this.getPage(file.pageOrder.at(-1)!));
    const page = this.makePage(fileId, `Page ${file.pageOrder.length + 1}`, after?.width ?? 1024, after?.height ?? 768, after?.background);
    await this.storage.putRecord('pages', page);
    const at = afterPageId ? file.pageOrder.indexOf(afterPageId) + 1 : file.pageOrder.length;
    const order = file.pageOrder.slice();
    order.splice(at, 0, page.id);
    await this.touch(file, { pageOrder: order, lastPageId: page.id });
    return page;
  }

  private async copyBlobs(from: string, to: string): Promise<void> {
    for (const prefix of [`p:${from}:snap:`, `p:${from}:log:`]) {
      for (const k of await this.storage.blobKeys(prefix)) {
        const b = await this.storage.getBlob(k);
        if (b) await this.storage.putBlob(k.replace(`p:${from}:`, `p:${to}:`), b);
      }
    }
  }

  /** Copies a page and its saved content right after it, and shows it next. */
  async duplicatePage(pageId: string): Promise<PageRecord> {
    const src = await this.requirePage(pageId);
    const file = await this.requireFile(src.fileId);
    const copy: PageRecord = { ...src, id: this.id(), name: `${src.name} copy`, createdAt: this.now() };
    await this.copyBlobs(src.id, copy.id);
    await this.storage.putRecord('pages', copy);
    const order = file.pageOrder.slice();
    order.splice(order.indexOf(src.id) + 1, 0, copy.id);
    await this.touch(file, { pageOrder: order, lastPageId: copy.id });
    return copy;
  }

  /**
   * A session snapshot (8.4): a copy of the page's saved content as a new page with origin 'session', placed after `afterId`
   * (the previous snapshot, so they accumulate in order). The editor keeps showing the page it was on.
   */
  async snapshotPage(pageId: string, name: string, afterId: string = pageId): Promise<PageRecord> {
    const src = await this.requirePage(pageId);
    const file = await this.requireFile(src.fileId);
    const snap: PageRecord = { ...src, id: this.id(), name, createdAt: this.now(), origin: 'session' };
    await this.copyBlobs(src.id, snap.id);
    await this.storage.putRecord('pages', snap);
    const order = file.pageOrder.slice();
    const at = order.indexOf(afterId);
    order.splice(at < 0 ? order.length : at + 1, 0, snap.id);
    await this.touch(file, { pageOrder: order });
    return snap;
  }

  /** A new file from imported pages (each with its snapshot bytes), under fresh ids so nothing already stored is touched. */
  async importFile(name: string, pages: { name: string; width: number; height: number; background: number; origin: PageRecord['origin']; snapshot: Uint8Array }[], id?: string): Promise<{ file: FileRecord; pages: PageRecord[] }> {
    const t = this.now();
    const fileId = id ?? this.id();
    const records: PageRecord[] = [];
    for (const p of pages) {
      const rec = this.makePage(fileId, p.name, p.width, p.height, p.background, p.origin);
      await this.storage.putBlob(snapKey(rec.id, 0), p.snapshot);
      await this.storage.putRecord('pages', rec);
      records.push(rec);
    }
    const file: FileRecord = { id: fileId, name, createdAt: t, updatedAt: t, pageOrder: records.map((r) => r.id), lastPageId: records[0].id };
    await this.storage.putRecord('files', file);
    return { file, pages: records };
  }

  /** Removes a page and its content. The last page of a file cannot be deleted. Returns the page to show next. */
  async deletePage(pageId: string): Promise<string> {
    const page = await this.requirePage(pageId);
    const file = await this.requireFile(page.fileId);
    if (file.pageOrder.length <= 1) throw new Error('A file needs at least one page.');
    const i = file.pageOrder.indexOf(pageId);
    const order = file.pageOrder.filter((id) => id !== pageId);
    const next = order[Math.min(i, order.length - 1)];
    await this.touch(file, { pageOrder: order, lastPageId: file.lastPageId === pageId ? next : file.lastPageId });
    await new PagePersistence(this.storage, pageId, { width: page.width, height: page.height, background: page.background }).destroy();
    await this.storage.deleteRecord('pages', pageId);
    return next;
  }

  async renamePage(pageId: string, name: string): Promise<void> {
    const page = await this.requirePage(pageId);
    await this.storage.putRecord('pages', { ...page, name: name.trim() || page.name });
    await this.touch(await this.requireFile(page.fileId));
  }

  async renameFile(fileId: string, name: string): Promise<void> {
    const file = await this.requireFile(fileId);
    await this.touch(file, { name: name.trim() || file.name });
  }

  /** Moves a page to `index` in the file's order. */
  async movePage(pageId: string, index: number): Promise<void> {
    const page = await this.requirePage(pageId);
    const file = await this.requireFile(page.fileId);
    const order = file.pageOrder.filter((id) => id !== pageId);
    order.splice(Math.max(0, Math.min(order.length, index)), 0, pageId);
    await this.touch(file, { pageOrder: order });
  }

  /** Remembers which page the editor shows, so the file reopens there. */
  async setLastPage(fileId: string, pageId: string): Promise<void> {
    const file = await this.requireFile(fileId);
    if (file.lastPageId !== pageId) await this.storage.putRecord('files', { ...file, lastPageId: pageId });
  }

  /** The file's preset has been applied; it will not be applied again. */
  async markPresetApplied(fileId: string): Promise<void> {
    const f = await this.requireFile(fileId);
    if (f.presetPending) await this.storage.putRecord('files', { ...f, presetPending: false });
  }

  /** Saves the file browser thumbnail without counting as an edit (the "last edited" order must not move). */
  async setThumb(fileId: string, thumb: Blob): Promise<void> {
    const f = await this.getFile(fileId);
    if (f) await this.storage.putRecord('files', { ...f, thumb });
  }

  /** A whole file copied under new ids, with every page's saved content. The open page must be flushed first. */
  async duplicateFile(fileId: string): Promise<FileRecord> {
    const src = await this.requireFile(fileId);
    const newFileId = this.id();
    const order: string[] = [];
    for (const pid of src.pageOrder) {
      const p = await this.getPage(pid);
      if (!p) continue;
      const copy: PageRecord = { ...p, id: this.id(), fileId: newFileId, createdAt: this.now() };
      await this.copyBlobs(p.id, copy.id);
      await this.storage.putRecord('pages', copy);
      order.push(copy.id);
    }
    const t = this.now();
    const { deletedAt: _d, presetPending: _p, ...rest } = src;
    const file: FileRecord = { ...rest, id: newFileId, name: `${src.name} copy`, createdAt: t, updatedAt: t, pageOrder: order, lastPageId: order[src.pageOrder.indexOf(src.lastPageId)] ?? order[0] };
    await this.storage.putRecord('files', file);
    return file;
  }

  /** Files in the trash, newest first. */
  async listTrash(): Promise<FileRecord[]> {
    const all = await this.storage.allRecords<FileRecord>('files');
    return all.filter((f) => f.deletedAt !== undefined).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }

  /** Deletes a file for good: its pages, their saved content and the record. */
  async purgeFile(fileId: string): Promise<void> {
    const f = await this.getFile(fileId);
    if (!f) return;
    for (const pid of f.pageOrder) {
      await new PagePersistence(this.storage, pid, { width: 1, height: 1, background: 0 }).destroy();
      await this.storage.deleteRecord('pages', pid);
    }
    await this.storage.deleteRecord('files', fileId);
  }

  /** Purges trash older than `TRASH_DAYS`. Returns how many files went. */
  async purgeExpired(): Promise<number> {
    const cutoff = this.now() - TRASH_DAYS * 86_400_000;
    const old = (await this.listTrash()).filter((f) => (f.deletedAt ?? 0) < cutoff);
    for (const f of old) await this.purgeFile(f.id);
    return old.length;
  }

  /** Moves a file to the trash; its pages and content stay until it is purged. */
  async trashFile(fileId: string): Promise<void> {
    await this.touch(await this.requireFile(fileId), { deletedAt: this.now() });
  }

  async restoreFile(fileId: string): Promise<void> {
    const f = await this.requireFile(fileId);
    const { deletedAt: _d, ...rest } = f;
    await this.touch(rest);
  }

  private async requireFile(id: string): Promise<FileRecord> {
    const f = await this.getFile(id);
    if (!f) throw new Error(`file ${id} not found`);
    return f;
  }
  private async requirePage(id: string): Promise<PageRecord> {
    const p = await this.getPage(id);
    if (!p) throw new Error(`page ${id} not found`);
    return p;
  }
}

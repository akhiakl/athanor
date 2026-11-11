// Document model, spec 8.4: a file is an ordered list of fixed-size pages; each page is one canvas with its own log.
// shortcut: no document-level undo for page operations (8.5.4), no trash purge, and thumbnails are not stored yet.
import { PagePersistence } from './persistence';
import type { Storage } from './storage';

export interface FileRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageOrder: string[];
  lastPageId: string;
  /** Set when moved to the trash; the file and its pages stay stored until purged. */
  deletedAt?: number;
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

  async listFiles(): Promise<FileRecord[]> {
    const all = await this.storage.allRecords<FileRecord>('files');
    return all.filter((f) => f.deletedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getFile(id: string): Promise<FileRecord | undefined> {
    return this.storage.getRecord<FileRecord>('files', id);
  }

  /** A new file with one blank page of the given size. */
  async createFile(name: string, width: number, height: number): Promise<{ file: FileRecord; page: PageRecord }> {
    const t = this.now();
    const fileId = this.id();
    const page = this.makePage(fileId, 'Page 1', width, height);
    const file: FileRecord = { id: fileId, name, createdAt: t, updatedAt: t, pageOrder: [page.id], lastPageId: page.id };
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

  /** Copies a page and its saved content right after it. */
  async duplicatePage(pageId: string): Promise<PageRecord> {
    const src = await this.requirePage(pageId);
    const file = await this.requireFile(src.fileId);
    const copy: PageRecord = { ...src, id: this.id(), name: `${src.name} copy`, createdAt: this.now() };
    for (const prefix of [`p:${src.id}:snap:`, `p:${src.id}:log:`]) {
      for (const k of await this.storage.blobKeys(prefix)) {
        const b = await this.storage.getBlob(k);
        if (b) await this.storage.putBlob(k.replace(`p:${src.id}:`, `p:${copy.id}:`), b);
      }
    }
    await this.storage.putRecord('pages', copy);
    const order = file.pageOrder.slice();
    order.splice(order.indexOf(src.id) + 1, 0, copy.id);
    await this.touch(file, { pageOrder: order, lastPageId: copy.id });
    return copy;
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

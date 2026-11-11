// Pages controller: the open file's pages as signals, and the operations on them (spec 8.4). It talks to Docs for records and to the
// render client for the open page's drawing, so a switch saves the page it leaves and loads the one it enters.
import { signal } from '@preact/signals';
import { exportAthanor, importAthanor } from '../doc/athanorFile';
import type { Docs, FileRecord, PageRecord } from '../doc/docs';
import { pagesPdf } from '../doc/pagesPdf';
import type { Engine } from '../engine/engine';
import type { RenderClient } from '../render/client';

const LAST_FILE = 'athanor.lastFile';

const readLast = (): string | null => {
  try {
    return localStorage.getItem(LAST_FILE);
  } catch {
    return null; // private window or blocked storage: open the newest file instead
  }
};
const writeLast = (id: string): void => {
  try {
    localStorage.setItem(LAST_FILE, id);
  } catch { /* the file list still finds it */ }
};

export type SaveState = 'saved' | 'saving' | 'error';

export function createPages(docs: Docs, client: RenderClient, engine: Engine, size: () => { w: number; h: number }, announce: (msg: string) => void) {
  const file = signal<FileRecord | null>(null);
  const pages = signal<PageRecord[]>([]);
  const current = signal('');
  const ready = signal(false);
  const save = signal<SaveState>('saved');
  const saveMessage = signal('');
  let opening: Promise<void> = Promise.resolve();
  let target = ''; // the page most recently asked for, so quick PageDown presses build on each other

  client.onSave = (state, message) => {
    save.value = state;
    saveMessage.value = message ?? '';
    if (state === 'error') announce(`Could not save: ${message ?? 'storage error'}. Your drawing is kept and will be retried.`);
  };

  const index = (): number => pages.value.findIndex((p) => p.id === current.value);

  /** Shows a page: the drawing in progress is committed, the page being left is saved, and this one is loaded. */
  function show(pageId: string): Promise<void> {
    target = pageId;
    // opens run one after another so rapid PageDown presses cannot interleave
    opening = opening.then(async () => {
      const page = pages.value.find((p) => p.id === pageId) ?? (await docs.getPage(pageId));
      if (!page) return;
      engine.commit(); // a stroke still in the arena belongs to the page being left
      await client.openPage({ pageId: page.id, width: page.width, height: page.height, background: page.background });
      current.value = page.id;
      if (file.value) await docs.setLastPage(file.value.id, page.id);
    });
    return opening;
  }

  async function reload(): Promise<void> {
    if (file.value) {
      pages.value = await docs.pages(file.value.id);
      file.value = (await docs.getFile(file.value.id)) ?? file.value;
    }
  }

  /**
   * Opens the file a route names, at the page it asks for (or the one it was left on). Without a route (tests, embedding) it opens the
   * last used file, the newest, or a new one. A file that is missing or in the trash throws NotFoundError so the caller can go home.
   */
  async function boot(want?: { fileId: string; pageId?: string }): Promise<void> {
    let f: FileRecord | undefined;
    if (want) {
      f = await docs.getFile(want.fileId);
      if (!f || f.deletedAt !== undefined) throw Object.assign(new Error('file not found'), { name: 'NotFoundError' });
    } else {
      const files = await docs.listFiles();
      const last = readLast();
      f = files.find((x) => x.id === last) ?? files[0];
      if (!f) {
        const { w, h } = size();
        f = (await docs.createFile('Untitled', w, h)).file;
      }
    }
    file.value = f;
    writeLast(f.id);
    pages.value = await docs.pages(f.id);
    await show(pages.value.find((p) => p.id === (want?.pageId ?? f.lastPageId))?.id ?? pages.value.find((p) => p.id === f.lastPageId)?.id ?? pages.value[0].id);
    ready.value = true;
  }

  /** Switches to another file, opened at its last page. */
  async function openFile(fileId: string): Promise<void> {
    const f = await docs.getFile(fileId);
    if (!f) throw new Error('file not found');
    await client.flushPage().catch(() => {}); // the page being left is saved before its file changes
    file.value = f;
    writeLast(f.id);
    pages.value = await docs.pages(f.id);
    await show(pages.value.find((p) => p.id === f.lastPageId)?.id ?? pages.value[0].id);
  }

  /** The file as `.athanor` bytes, current to the last stroke. */
  async function exportFile(): Promise<{ bytes: Uint8Array; name: string }> {
    if (!file.value) throw new Error('no file is open');
    await client.flushPage();
    return { bytes: await exportAthanor(docs, file.value.id), name: file.value.name };
  }

  /** Imports a `.athanor` file as a new file and opens it. Throws ImportError with a message fit to show. */
  async function importFile(bytes: Uint8Array): Promise<string> {
    const { file: imported } = await importAthanor(docs, bytes);
    await openFile(imported.id);
    return imported.name;
  }

  /** Every page of the file (or just the open one) as one PDF. */
  async function pdf(all: boolean): Promise<Blob> {
    if (!file.value) throw new Error('no file is open');
    await client.flushPage();
    const list = all ? pages.value : pages.value.filter((p) => p.id === current.value);
    return pagesPdf(docs, list, file.value.name);
  }

  /** After the render side was replaced (the worker failed and the local host took over): load the page again. */
  async function reopen(): Promise<void> {
    if (current.value) await show(current.value);
  }

  async function add(): Promise<void> {
    if (!file.value) return;
    const p = await docs.addPage(file.value.id, current.value || undefined);
    await reload();
    await show(p.id);
    announce(`Page ${index() + 1} of ${pages.value.length}`);
  }

  async function duplicate(id = current.value): Promise<void> {
    await client.flushPage().catch(() => {}); // the copy must include what was just drawn; a failed save is already reported
    const p = await docs.duplicatePage(id);
    await reload();
    await show(p.id);
    announce('Page duplicated');
  }

  async function remove(id = current.value): Promise<void> {
    if (pages.value.length <= 1) {
      announce('A file needs at least one page');
      return;
    }
    const wasCurrent = id === current.value;
    const next = await docs.deletePage(id);
    await reload();
    if (wasCurrent) await show(next);
    announce('Page deleted');
  }

  async function rename(id: string, name: string): Promise<void> {
    await docs.renamePage(id, name);
    await reload();
  }

  async function move(id: string, delta: number): Promise<void> {
    const i = pages.value.findIndex((p) => p.id === id);
    if (i < 0) return;
    await docs.movePage(id, i + delta);
    await reload();
  }

  /** PageDown / PageUp. Wraps nowhere: the ends do nothing. */
  async function step(delta: number): Promise<void> {
    const from = pages.value.findIndex((p) => p.id === (target || current.value));
    const i = from + delta;
    if (i < 0 || i >= pages.value.length) return;
    await show(pages.value[i].id);
    announce(`Page ${i + 1} of ${pages.value.length}`);
  }

  return { file, pages, current, ready, save, saveMessage, boot, reopen, reload, openFile, exportFile, importFile, pdf, show, add, duplicate, remove, rename, move, step, index };
}
export type Pages = ReturnType<typeof createPages>;

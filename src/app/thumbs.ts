// Keeps the file's browser thumbnail current: after the first page has been saved and then left alone for a moment, render a small
// preview and store it on the file. Only page 1 counts, and an unchanged page is not re-rendered.
import { effect } from '@preact/signals';
import type { Docs } from '../doc/docs';
import type { RenderClient } from '../render/client';
import type { Pages } from './pages';

export const THUMB_WIDTH = 256;
export const THUMB_DELAY_MS = 2500;

export function watchThumbs(docs: Docs, pages: Pages, client: RenderClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seen = -1;
  const run = async (): Promise<void> => {
    const f = pages.file.value;
    if (!f || pages.index() !== 0) return;
    try {
      const { revision } = await client.flushPage();
      if (revision === seen) return;
      const blob = await client.export('thumb', { scale: THUMB_WIDTH });
      seen = revision;
      await docs.setThumb(f.id, blob);
    } catch { /* a thumbnail is a nicety: the next save tries again */ }
  };
  const stop = effect(() => {
    const state = pages.save.value;
    pages.current.value; // a page switch restarts the clock too
    if (timer !== null) clearTimeout(timer);
    timer = state === 'saved' ? setTimeout(() => void run(), THUMB_DELAY_MS) : null;
  });
  return () => { stop(); if (timer !== null) clearTimeout(timer); };
}

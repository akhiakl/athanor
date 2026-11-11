// A multi-page PDF from stored pages, spec 8.4 ("Export pages as PDF"): each page is loaded into a scratch store, so any page of the
// file can be exported without opening it. The open page's pending writes must be flushed first.
import { CommittedStore } from '../render/committed';
import { pdfBlob } from '../render/pdf';
import type { Docs, PageRecord } from './docs';
import { applySegments } from './pageLog';
import { PagePersistence } from './persistence';

export async function pagesPdf(docs: Docs, pages: readonly PageRecord[], title: string): Promise<Blob> {
  const out = [];
  for (const p of pages) {
    const store = new CommittedStore(256, p.width, p.height);
    const loaded = await new PagePersistence(docs.storage, p.id, { width: p.width, height: p.height, background: p.background }).load();
    if (loaded) applySegments(store, loaded.segments);
    out.push({ width: p.width, height: p.height, background: p.background, entries: store.entries });
  }
  return pdfBlob(out, { title });
}

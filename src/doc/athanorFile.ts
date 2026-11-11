// The .athanor file, spec 8.6.3: a store-only ZIP holding manifest.json and one snapshot per page. Import validates everything it reads:
// magic, version, sizes and CRCs, and never trusts a count or a dimension before checking it.
// shortcut: no page thumbnails, baked rasters or embedded assets yet (those features do not exist), and an import always makes a new file.
import { CommittedStore } from '../render/committed';
import { Docs, MAX_SIDE, type FileRecord, type PageRecord } from './docs';
import { applySegments, decodeLog, encodeSnapshot, type PageHeader } from './pageLog';
import { PagePersistence } from './persistence';
import { unzip, zip, ZipError } from './zip';

export const FORMAT = 'athanor';
export const FORMAT_VERSION = 1;
export const MAX_PAGES = 2000;

interface ManifestPage { id: string; name: string; width: number; height: number; background: number; origin: PageRecord['origin'] }
export interface Manifest { format: typeof FORMAT; version: number; name: string; createdAt: number; pages: ManifestPage[] }

export class ImportError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/** Packs a file and its pages. The caller flushes the open page first so the stored data is current. */
export async function exportAthanor(docs: Docs, fileId: string): Promise<Uint8Array> {
  const file = await docs.getFile(fileId);
  if (!file) throw new Error('file not found');
  const pages = await docs.pages(fileId);
  const entries = [];
  for (const p of pages) {
    const header: PageHeader = { width: p.width, height: p.height, background: p.background };
    const store = new CommittedStore(256, p.width, p.height);
    const loaded = await new PagePersistence(docs.storage, p.id, header).load();
    if (loaded) applySegments(store, loaded.segments);
    entries.push({ name: `pages/${p.id}.snap`, data: encodeSnapshot(store, header) });
  }
  const manifest: Manifest = {
    format: FORMAT, version: FORMAT_VERSION, name: file.name, createdAt: file.createdAt,
    pages: pages.map(({ id, name, width, height, background, origin }) => ({ id, name, width, height, background, origin })),
  };
  return zip([{ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) }, ...entries]);
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Parses and validates the manifest; throws ImportError with a message fit to show the user. */
export function parseManifest(json: string): Manifest {
  let m: unknown;
  try {
    m = JSON.parse(json);
  } catch {
    throw new ImportError('The file is damaged: its manifest is not valid JSON.');
  }
  const o = m as Partial<Manifest> | null;
  if (!o || o.format !== FORMAT) throw new ImportError('This is not an Athanor file.');
  if (typeof o.version !== 'number' || o.version > FORMAT_VERSION) throw new ImportError('This file was made by a newer version of Athanor. Update the app to open it.');
  if (o.version < 1) throw new ImportError('This file uses an unknown format version.');
  if (!Array.isArray(o.pages) || o.pages.length === 0) throw new ImportError('The file has no pages.');
  if (o.pages.length > MAX_PAGES) throw new ImportError(`The file has too many pages (more than ${MAX_PAGES}).`);
  const seen = new Set<string>();
  for (const p of o.pages) {
    if (typeof p?.id !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(p.id) || seen.has(p.id)) throw new ImportError('The file lists an invalid or repeated page id.');
    seen.add(p.id);
    if (!isInt(p.width, 1, MAX_SIDE) || !isInt(p.height, 1, MAX_SIDE)) throw new ImportError(`Page "${String(p.name).slice(0, 40)}" has an invalid size.`);
    if (!isInt(p.background, 0, 0xffffff)) throw new ImportError('A page has an invalid background colour.');
    if (typeof p.name !== 'string') throw new ImportError('A page has no name.');
    if (p.origin !== 'user' && p.origin !== 'session') throw new ImportError('A page has an unknown origin.');
  }
  if (typeof o.name !== 'string') throw new ImportError('The file has no name.');
  return { format: FORMAT, version: o.version, name: o.name, createdAt: Number.isFinite(o.createdAt) ? (o.createdAt as number) : 0, pages: o.pages as ManifestPage[] };
}

/** Imports as a new file with fresh ids. Nothing is written until every page has been validated. */
export async function importAthanor(docs: Docs, bytes: Uint8Array): Promise<{ file: FileRecord; pages: PageRecord[] }> {
  let entries;
  try {
    entries = unzip(bytes, { maxEntries: MAX_PAGES + 1 });
  } catch (err) {
    throw new ImportError(err instanceof ZipError ? `The file is damaged or not an Athanor file (${err.message}).` : 'The file could not be read.');
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const raw = byName.get('manifest.json');
  if (!raw) throw new ImportError('This is not an Athanor file: it has no manifest.');
  let text: string;
  try {
    text = dec.decode(raw);
  } catch {
    throw new ImportError('The file is damaged: its manifest is not valid text.');
  }
  const manifest = parseManifest(text);
  const pages = manifest.pages.map((p) => {
    const snap = byName.get(`pages/${p.id}.snap`);
    if (!snap) throw new ImportError(`Page "${p.name.slice(0, 40)}" is missing its content.`);
    const d = decodeLog(snap);
    if (!d || d.validBytes < snap.length) throw new ImportError(`Page "${p.name.slice(0, 40)}" is damaged.`);
    if (d.header.width !== p.width || d.header.height !== p.height) throw new ImportError(`Page "${p.name.slice(0, 40)}" does not match its manifest.`);
    return { name: p.name.slice(0, 200), width: p.width, height: p.height, background: p.background, origin: p.origin, snapshot: snap };
  });
  return docs.importFile(manifest.name.slice(0, 200) || 'Imported', pages);
}

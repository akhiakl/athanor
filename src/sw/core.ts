// Service worker logic, spec 8.7, as functions over injected `caches` and `fetch` so it can be tested without a browser.
// shortcut: no runtime caching beyond the precache (there is nothing else to cache), and no background sync or push.
import { IdbStorage, openDb } from '../doc/idb';
import type { Storage } from '../doc/storage';

export const PREFIX = 'athanor-';
export const cacheName = (version: string): string => `${PREFIX}${version}`;

export interface CacheLike {
  addAll(urls: string[]): Promise<void>;
  match(req: string | Request): Promise<Response | undefined>;
  put(req: string | Request, res: Response): Promise<void>;
}
export interface CachesLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** Installs the full app into this version's cache. All or nothing: addAll fails if any file does, so a half-cached app never activates. */
export async function install(caches: CachesLike, version: string, precache: readonly string[]): Promise<void> {
  const cache = await caches.open(cacheName(version));
  await cache.addAll([...precache]);
}

/** Drops caches of other versions. Returns what it deleted. */
export async function activate(caches: CachesLike, version: string): Promise<string[]> {
  const keep = cacheName(version);
  const old = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== keep);
  await Promise.all(old.map((k) => caches.delete(k)));
  return old;
}

export type Decision = 'shell' | 'asset' | 'share' | 'network';

export interface Req { method: string; url: string; mode?: string }

/**
 * What to do with a request: navigations get the app shell (offline-first); precached files are cache-first; the share target is handled;
 * anything else goes to the network untouched (there is nothing else, spec 8.7).
 */
export function route(req: Req, origin: string, precached: ReadonlySet<string>): Decision {
  const url = new URL(req.url);
  if (url.origin !== origin) return 'network';
  if (req.method === 'POST' && url.pathname === '/share') return 'share';
  if (req.method !== 'GET') return 'network';
  if (req.mode === 'navigate') return 'shell';
  return precached.has(url.pathname) ? 'asset' : 'network';
}

export interface Deps {
  caches: CachesLike;
  version: string;
  fetchFn: (req: Request) => Promise<Response>;
}

/** The app shell: the precached index.html for any navigation, so every route works offline. Falls back to the network if it is missing. */
export async function shell(req: Request, { caches, version, fetchFn }: Deps): Promise<Response> {
  const hit = await (await caches.open(cacheName(version))).match('/');
  return hit ?? fetchFn(req);
}

/** Cache-first for a precached file. A miss (which should not happen) tries the network. */
export async function asset(req: Request, { caches, version, fetchFn }: Deps): Promise<Response> {
  const cache = await caches.open(cacheName(version));
  const hit = await cache.match(new URL(req.url).pathname);
  if (hit) return hit;
  return fetchFn(req);
}

/**
 * The share target (8.7): files POSTed to /share are stored for the app to import on its next load, then the browser is sent to
 * `/?import=pending`. Anything that fails still redirects, so the user lands in the app rather than on an error page.
 */
export async function share(req: Request, storage: Storage, now = Date.now()): Promise<Response> {
  try {
    const form = await req.formData();
    let n = 0;
    for (const v of form.getAll('files')) {
      if (typeof v === 'string') continue;
      await storage.putBlob(`share:${String(now).padStart(14, '0')}:${n++}:${encodeURIComponent(v.name)}`, new Uint8Array(await v.arrayBuffer()));
    }
  } catch { /* nothing usable was shared */ }
  return Response.redirect(new URL('/?import=pending', req.url).href, 303);
}

export const openStorage = async (): Promise<Storage> => new IdbStorage(await openDb());

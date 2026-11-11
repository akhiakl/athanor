// The service worker (spec 8.7). Built as /sw.js by vite.config.ts, which fills in the two placeholders below.
/// <reference lib="webworker" />
import { activate, asset, install, openStorage, route, share, shell, type CachesLike } from './sw/core';

declare const self: ServiceWorkerGlobalScope;

const PRECACHE: string[] = JSON.parse(atob('__PRECACHE__'));
const VERSION = '__VERSION__';
const precached = new Set(PRECACHE);
const caches_ = self.caches as unknown as CachesLike;
const deps = { caches: caches_, version: VERSION, fetchFn: (r: Request) => fetch(r) };

// No skipWaiting here: a new version installs in the background and waits until the person chooses to update (8.7).
self.addEventListener('install', (e) => e.waitUntil(install(caches_, VERSION, PRECACHE)));

self.addEventListener('activate', (e) => e.waitUntil(activate(caches_, VERSION).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const d = route(e.request, self.location.origin, precached);
  if (d === 'network') return; // the browser handles it as if there were no service worker
  e.respondWith(d === 'shell' ? shell(e.request, deps) : d === 'asset' ? asset(e.request, deps) : openStorage().then((s) => share(e.request, s)));
});

self.addEventListener('message', (e) => {
  const type = (e.data as { type?: string } | null)?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  else if (type === 'VERSION') (e.source as Client | null)?.postMessage({ type: 'VERSION', version: VERSION });
});

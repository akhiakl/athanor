import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../doc/storage';
import { PREFIX, activate, asset, cacheName, install, route, share, shell, type CacheLike, type CachesLike } from './core';

function fakeCaches() {
  const store = new Map<string, Map<string, Response>>();
  const key = (r: string | Request): string => (typeof r === 'string' ? r : new URL(r.url).pathname);
  const caches: CachesLike & { store: typeof store; failOn: string | null } = {
    store, failOn: null,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      const cache: CacheLike = {
        async addAll(urls) {
          for (const u of urls) if (u === caches.failOn) throw new TypeError(`failed to fetch ${u}`);
          const tmp = urls.map((u) => [u, new Response(`body of ${u}`)] as const);
          for (const [u, r] of tmp) m.set(u, r); // only after every fetch succeeded
        },
        async match(r) { return m.get(key(r))?.clone(); },
        async put(r, res) { m.set(key(r), res); },
      };
      return cache;
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
  };
  return caches;
}

const ORIGIN = 'https://athanor.test';
const pre = new Set(['/', '/assets/app-1.js', '/assets/worker-1.js', '/manifest.webmanifest']);
const req = (path: string, init: RequestInit = {}) => new Request(ORIGIN + path, init); // navigate mode can only be set by the browser; shell() does not look at it

describe('routing', () => {
  const r = (path: string, method = 'GET', mode = 'cors', origin = ORIGIN) => route({ method, url: origin + path, mode }, ORIGIN, pre);
  it('serves the app shell for every same-origin navigation, known route or not', () => {
    for (const p of ['/', '/f/01ABC', '/f/01ABC/p/02DEF', '/settings', '/open', '/new?template=blind', '/anything/at/all']) expect(r(p, 'GET', 'navigate')).toBe('shell');
  });
  it('serves precached files cache-first and leaves everything else to the network', () => {
    expect(r('/assets/app-1.js')).toBe('asset');
    expect(r('/assets/worker-1.js')).toBe('asset');
    expect(r('/manifest.webmanifest')).toBe('asset');
    expect(r('/assets/not-in-the-list.js')).toBe('network');
    expect(r('/api/x')).toBe('network');
  });
  it('handles the share target and ignores other writes and other origins', () => {
    expect(r('/share', 'POST')).toBe('share');
    expect(r('/share')).toBe('network'); // a GET is just a navigation or nothing
    expect(r('/f/1', 'POST')).toBe('network');
    expect(r('/assets/app-1.js', 'GET', 'cors', 'https://cdn.example')).toBe('network');
    expect(r('/', 'GET', 'navigate', 'https://evil.example')).toBe('network');
  });
});

describe('install and activate', () => {
  it('caches the whole precache list under the version', async () => {
    const c = fakeCaches();
    await install(c, 'v1', [...pre]);
    expect([...c.store.get(cacheName('v1'))!.keys()].sort()).toEqual([...pre].sort());
  });
  it('is all or nothing: one missing file fails the install and caches none of it', async () => {
    const c = fakeCaches();
    c.failOn = '/assets/worker-1.js';
    await expect(install(c, 'v1', [...pre])).rejects.toThrow('failed to fetch');
    expect(c.store.get(cacheName('v1'))?.size ?? 0).toBe(0);
  });
  it('activation deletes other versions of our caches and nothing else', async () => {
    const c = fakeCaches();
    await install(c, 'old', ['/']);
    await install(c, 'new', ['/']);
    await c.open('someone-elses-cache');
    expect(await activate(c, 'new')).toEqual([cacheName('old')]);
    expect(await c.keys()).toEqual([cacheName('new'), 'someone-elses-cache']);
    expect(cacheName('x').startsWith(PREFIX)).toBe(true);
  });
});

describe('serving', () => {
  const offline = () => Promise.reject(new TypeError('offline'));
  const online = (body = 'network') => () => Promise.resolve(new Response(body));

  it('the shell comes from the cache with no network at all', async () => {
    const c = fakeCaches();
    await install(c, 'v1', [...pre]);
    const res = await shell(req('/f/01ABC'), { caches: c, version: 'v1', fetchFn: offline });
    expect(await res.text()).toBe('body of /'); // index.html, whatever the URL
  });
  it('an asset comes from the cache, ignoring query strings, with no network', async () => {
    const c = fakeCaches();
    await install(c, 'v1', [...pre]);
    const res = await asset(req('/assets/app-1.js?v=2'), { caches: c, version: 'v1', fetchFn: offline });
    expect(await res.text()).toBe('body of /assets/app-1.js');
  });
  it('falls back to the network when the cache lacks it, and fails honestly when both do', async () => {
    const c = fakeCaches();
    await c.open(cacheName('v1'));
    expect(await (await shell(req('/'), { caches: c, version: 'v1', fetchFn: online('live') })).text()).toBe('live');
    await expect(asset(req('/assets/app-1.js'), { caches: c, version: 'v1', fetchFn: offline })).rejects.toThrow('offline');
  });
  it('a waiting new version does not change what the current one serves', async () => {
    const c = fakeCaches();
    await install(c, 'v1', ['/']);
    await install(c, 'v2', ['/']);
    c.store.get(cacheName('v2'))!.set('/', new Response('v2 shell'));
    expect(await (await shell(req('/'), { caches: c, version: 'v1', fetchFn: offline })).text()).toBe('body of /');
  });
});

describe('share target', () => {
  const post = (files: [string, string][], extra: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [name, data] of files) form.append('files', new File([data], name, { type: 'application/zip' }));
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return new Request(`${ORIGIN}/share`, { method: 'POST', body: form });
  };
  it('stores each shared file and redirects to the import', async () => {
    const mem = new MemoryStorage();
    const res = await share(post([['a b.athanor', 'AAA'], ['c.athanor', 'CC']], { title: 'ignored' }), mem, 1700000000000);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/?import=pending`);
    const keys = await mem.blobKeys('share:');
    expect(keys).toHaveLength(2);
    expect(decodeURIComponent(keys[0].split(':').slice(3).join(':'))).toBe('a b.athanor');
    expect(new TextDecoder().decode(await mem.getBlob(keys[0]))).toBe('AAA');
  });
  it('still redirects when the body is unreadable or storage fails', async () => {
    const bad = new Request(`${ORIGIN}/share`, { method: 'POST', body: 'not a form', headers: { 'content-type': 'text/plain' } });
    expect((await share(bad, new MemoryStorage())).status).toBe(303);
    const mem = new MemoryStorage();
    mem.failWrites = true;
    expect((await share(post([['a.athanor', 'x']]), mem)).status).toBe(303);
  });
});

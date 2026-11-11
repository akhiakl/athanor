import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

/** Public files are copied after bundling, so the service worker's precache list reads them from disk. */
function publicFiles(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base)).flatMap((f) => {
    const rel = `${base}/${f}`;
    return statSync(join(dir, rel)).isDirectory() ? publicFiles(dir, rel) : [rel];
  });
}

/**
 * Builds `src/sw.ts` as an unhashed `/sw.js` and fills in its precache list: the app shell, every built asset (all lazy chunks, the
 * render worker) and the public files. The version is a hash of that list, so any changed file makes a new service worker (spec 8.7).
 */
function serviceWorker(): Plugin {
  return {
    name: 'athanor-service-worker',
    apply: 'build',
    generateBundle(_o, bundle) {
      const sw = Object.values(bundle).find((c) => c.type === 'chunk' && c.name === 'sw');
      if (!sw || sw.type !== 'chunk') throw new Error('service worker entry missing from the bundle');
      const files = Object.values(bundle).filter((c) => c !== sw).map((c) => `/${c.fileName}`).filter((f) => f !== '/index.html');
      const precache = ['/', ...files, ...publicFiles('public')].sort();
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      // base64, so no quote style or escape a minifier chooses can break the literal it is injected into
      sw.code = sw.code.replace('__PRECACHE__', Buffer.from(JSON.stringify(precache)).toString('base64')).replace('__VERSION__', version);
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  build: {
    rollupOptions: {
      input: { index: 'index.html', sw: 'src/sw.ts' },
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});

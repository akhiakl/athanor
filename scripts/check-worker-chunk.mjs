// Fails the build if Vite did not emit the render worker: without it production silently runs the main-thread fallback.
import { readdirSync } from 'node:fs';

const files = readdirSync(new URL('../dist/assets/', import.meta.url));
if (!files.some((f) => /^worker-.*\.js$/.test(f))) {
  console.error('build check failed: no render worker chunk in dist/assets (keep `new Worker(new URL(...))` literal in src/app/main.ts)');
  process.exit(1);
}

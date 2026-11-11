// Files handed to the app by the OS share sheet (the service worker stored them in blob storage, spec 8.7) or by a file-handler launch.
import type { Storage } from '../doc/storage';

export interface Shared { name: string; bytes: Uint8Array }

/** Reads and removes every pending shared file, oldest first. A file that cannot be read is dropped rather than left to fail forever. */
export async function takeShared(storage: Storage): Promise<Shared[]> {
  const out: Shared[] = [];
  for (const key of await storage.blobKeys('share:')) {
    try {
      const bytes = await storage.getBlob(key);
      const name = decodeURIComponent(key.split(':').slice(3).join(':'));
      if (bytes) out.push({ name, bytes });
    } catch { /* a damaged entry is skipped */ }
    await storage.deleteBlob(key);
  }
  return out;
}

export type Kind = 'athanor' | 'image' | 'svg' | 'other';

export function classify(name: string): Kind {
  const n = name.toLowerCase();
  if (n.endsWith('.athanor')) return 'athanor';
  if (n.endsWith('.svg')) return 'svg';
  if (/\.(png|jpe?g|webp|gif|avif|bmp)$/.test(n)) return 'image';
  return 'other';
}

/** One sentence about what could not be used. Images and SVG become usable with Trace and Pull (roadmap step 7). */
export function unsupportedNote(files: readonly Shared[]): string {
  const n = files.filter((f) => classify(f.name) !== 'athanor').length;
  return n === 0 ? '' : `${n} shared file${n === 1 ? ' was' : 's were'} not an Athanor file. Images and SVG can be used once Trace and Pull arrive.`;
}

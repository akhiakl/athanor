// Pure helpers for the file browser: sorting, searching, and the human-readable bits.
import type { FileRecord } from '../doc/docs';

export type Sort = 'edited' | 'name' | 'created';

export function sortFiles(files: readonly FileRecord[], sort: Sort): FileRecord[] {
  const out = files.slice();
  if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || b.updatedAt - a.updatedAt);
  else if (sort === 'created') out.sort((a, b) => b.createdAt - a.createdAt);
  else out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Case-insensitive match of every word in the query against the file name. */
export function filterFiles(files: readonly FileRecord[], query: string): FileRecord[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length === 0 ? files.slice() : files.filter((f) => words.every((w) => f.name.toLowerCase().includes(w)));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000_000], ['month', 2_592_000_000], ['week', 604_800_000], ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];

/** "3 hours ago", "yesterday", "just now". */
export function relativeTime(then: number, now: number, locale?: string): string {
  const diff = then - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) if (abs >= ms) return fmt.format(Math.trunc(diff / ms), unit);
  return 'just now';
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** A name safe to use as a download file name on every platform. */
export const safeFileName = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 120) || 'untitled';

/** Distinct archive entry names: "a.athanor", "a (2).athanor". */
export function uniqueNames(names: readonly string[], ext: string): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const base = safeFileName(n);
    const k = base.toLowerCase();
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    return count === 1 ? `${base}${ext}` : `${base} (${count})${ext}`;
  });
}

// Back up all and restore, spec 8.3.1 / 8.6.3: a ZIP of one .athanor per file. Restore skips any file whose id is already stored, so
// restoring the same backup twice changes nothing, and reports what happened per file instead of stopping at the first problem.
import { exportAthanor, restoreAthanor } from './athanorFile';
import type { Docs } from './docs';
import { uniqueNames } from '../home/model';
import { unzip, zip, ZipError } from './zip';

export async function backupAll(docs: Docs): Promise<{ bytes: Uint8Array; count: number }> {
  const files = await docs.listFiles();
  const names = uniqueNames(files.map((f) => f.name), '.athanor');
  const entries = [];
  for (let i = 0; i < files.length; i++) entries.push({ name: names[i], data: await exportAthanor(docs, files[i].id) });
  return { bytes: zip(entries), count: files.length };
}

export interface RestoreReport {
  restored: string[];
  /** Files that were already stored (same id), left alone. */
  skipped: string[];
  failed: { name: string; reason: string }[];
}

/** Restores a backup ZIP, or a single .athanor file (which is also a ZIP, recognised by its manifest). */
export async function restoreBackup(docs: Docs, bytes: Uint8Array): Promise<RestoreReport> {
  const report: RestoreReport = { restored: [], skipped: [], failed: [] };
  let outer;
  try {
    outer = unzip(bytes, { maxEntries: 5000 });
  } catch (err) {
    throw new Error(err instanceof ZipError ? `That is not a backup file (${err.message}).` : 'That file could not be read.');
  }
  const inner = outer.filter((e) => e.name.toLowerCase().endsWith('.athanor'));
  const files = inner.length > 0 ? inner : outer.some((e) => e.name === 'manifest.json') ? [{ name: 'file.athanor', data: bytes }] : [];
  if (files.length === 0) throw new Error('That file has no Athanor files in it.');
  for (const f of files) {
    try {
      const r = await restoreAthanor(docs, f.data);
      if ('skipped' in r) report.skipped.push(r.skipped);
      else report.restored.push(r.file.name);
    } catch (err) {
      report.failed.push({ name: f.name, reason: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return report;
}

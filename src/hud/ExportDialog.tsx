// Export dialog, spec 6.1: format, scale, transparency, Download and Copy. Native modal <dialog>.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { App } from '../app/app';
import { copyCanvas, defaultScale, download, downloadExport, exportName, type Format } from '../app/exporter';
import type { Pages } from '../app/pages';
import type { RenderClient } from '../render/client';
import { maxScale } from '../render/export';
import type { Hud } from './hud';
import { IconCopy, IconDownload } from './icons';

export function ExportDialog({ hud, client, size, dpr, pages }: { app: App; hud: Hud; client: RenderClient; size: () => { w: number; h: number }; dpr: () => number; pages: Pages }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const open = hud.exportOpen.value;
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [allPages, setAllPages] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = dialog.current!;
    const sync = (): void => { hud.exportOpen.value = false; };
    d.addEventListener('close', sync);
    return () => d.removeEventListener('close', sync);
  }, []);

  useEffect(() => {
    const d = dialog.current!;
    if (open && !d.open) {
      const { w, h } = size();
      setScale(defaultScale(w, h, dpr()));
      setStatus('');
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const { w, h } = size();
  const limit = maxScale(w, h);
  const k = Math.min(scale, limit);
  const run = async (what: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setStatus('Working…');
    try {
      const msg = await what();
      setStatus(msg);
      hud.announce(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Export failed.';
      setStatus(msg);
      hud.announce(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} class="export" aria-label="Export">
      <h2>Export</h2>
      <fieldset>
        <legend>Format</legend>
        <label><input type="radio" name="fmt" checked={format === 'png'} onChange={() => setFormat('png')} /> PNG <small>image</small></label>
        <label><input type="radio" name="fmt" checked={format === 'svg'} onChange={() => setFormat('svg')} /> SVG <small>vector</small></label>
        <label><input type="radio" name="fmt" checked={format === 'pdf'} onChange={() => setFormat('pdf')} /> PDF <small>vector, print</small></label>
      </fieldset>
      {format === 'pdf' && pages.pages.value.length > 1 && (
        <fieldset>
          <legend>Pages</legend>
          <label><input type="radio" name="scope" checked={!allPages} onChange={() => setAllPages(false)} /> This page</label>
          <label><input type="radio" name="scope" checked={allPages} onChange={() => setAllPages(true)} /> All {pages.pages.value.length} pages <small>one PDF page each</small></label>
        </fieldset>
      )}
      {format === 'png' && (
        <fieldset>
          <legend>Size</legend>
          <div class="scales" role="group" aria-label="Scale">
            {[1, 2, 3, 4].map((n) => (
              <button key={n} type="button" aria-pressed={k === n} aria-disabled={n > limit} onClick={() => n <= limit && setScale(n)} title={n > limit ? 'Too large for the browser canvas limit' : `${w * n} × ${h * n} px`}>{n}×</button>
            ))}
          </div>
          <p class="hint">{Math.round(w * k)} × {Math.round(h * k)} px</p>
        </fieldset>
      )}
      {format !== 'pdf' && <label class="check"><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.currentTarget.checked)} /> Transparent background</label>}
      <div class="actions">
        <button type="button" class="primary" disabled={busy} onClick={() => run(async () => {
          if (format === 'pdf') download(await (allPages && pages.pages.value.length > 1 ? pages.pdf(true) : client.export('pdf')), exportName('pdf'));
          else await downloadExport(client, { format, scale: k, transparent });
          return 'Downloaded.';
        })}><IconDownload /> Download</button>
        <button type="button" disabled={busy || format === 'pdf'} title={format === 'pdf' ? 'PDF cannot be copied; use Download' : undefined} onClick={() => run(async () => ((await copyCanvas(client, k)) === 'png+svg' ? 'Copied as PNG and SVG.' : 'Copied as PNG.'))}><IconCopy /> Copy</button>
      </div>
      <fieldset class="file">
        <legend>File</legend>
        <div class="actions">
          <button type="button" disabled={busy} onClick={() => run(async () => {
            const { bytes, name } = await pages.exportFile();
            download(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${name.replace(/[\\/:*?"<>|]+/g, '-')}.athanor`);
            return 'Saved the file.';
          })}><IconDownload /> Save .athanor</button>
          <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Open…</button>
        </div>
        <input
          ref={fileInput} type="file" accept=".athanor,.zip" hidden aria-label="Open an .athanor file"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = ''; // the same file can be chosen again
            if (f) void run(async () => `Opened "${await pages.importFile(new Uint8Array(await f.arrayBuffer()))}".`);
          }}
        />
      </fieldset>
      <p class="status" role="status">{status}</p>
      <button type="button" class="close" onClick={() => (hud.exportOpen.value = false)}>Close</button>
    </dialog>
  );
}

// Export actions on the main thread: file download and clipboard copy (spec 3.4, 3.4.4). Serialization itself runs in the render worker.
import { maxScale } from '../render/export';
import { download } from './download';

export { download };
import type { RenderClient } from '../render/client';

export type Format = 'png' | 'svg' | 'pdf';
export interface ExportRequest { format: Format; scale: number; transparent: boolean }

/** athanor-20261112-014503.png */
export function exportName(format: Format, d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `athanor-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${format}`;
}

/** The default scale: the device pixel ratio, kept inside 1..4 and the canvas area limit. */
export const defaultScale = (w: number, h: number, dpr: number): number => Math.min(Math.max(1, Math.round(dpr)), maxScale(w, h));

export async function downloadExport(client: RenderClient, r: ExportRequest): Promise<void> {
  download(await client.export(r.format, { scale: r.scale, transparent: r.transparent }), exportName(r.format));
}

/**
 * Copies the canvas as an image. The ClipboardItem is built synchronously from promises (Safari keeps user activation only that way),
 * and SVG is added only where the browser supports it. Resolves to what was copied.
 */
export async function copyCanvas(client: RenderClient, scale: number): Promise<'png' | 'png+svg'> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Copying images is not supported in this browser.');
  const items: Record<string, Promise<Blob>> = { 'image/png': client.export('png', { scale }) };
  const withSvg = typeof ClipboardItem.supports === 'function' && ClipboardItem.supports('image/svg+xml');
  if (withSvg) items['image/svg+xml'] = client.export('svg');
  await navigator.clipboard.write([new ClipboardItem(items)]);
  return withSvg ? 'png+svg' : 'png';
}

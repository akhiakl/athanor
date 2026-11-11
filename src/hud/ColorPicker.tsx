// ColorPicker, spec 6.1: HSV square (canvas 160x160, redrawn only on hue change) + hue strip + alpha strip + hex input + swatch row.
// No third-party picker. The bundled-palettes set replacing the legacy ColourLovers fetch arrives with the app shell.
import { useEffect, useRef } from 'preact/hooks';
import { colorRgba, rgbaColor, type App } from '../app/app';
import { hsbToRgb } from '../core/color';
import { Range } from './Hud';
import type { Hud } from './hud';

const SIZE = 160;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const hex6 = (rgba: number): string => (rgba >>> 8).toString(16).padStart(6, '0');

function drawSquare(ctx: CanvasRenderingContext2D, hue: number): void {
  const [r, g, b] = hsbToRgb(hue, 1, 1);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const white = ctx.createLinearGradient(0, 0, SIZE, 0);
  white.addColorStop(0, '#fff');
  white.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = white;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const black = ctx.createLinearGradient(0, 0, 0, SIZE);
  black.addColorStop(0, 'rgba(0,0,0,0)');
  black.addColorStop(1, '#000');
  ctx.fillStyle = black;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

export function ColorPicker({ app, hud }: { app: App; hud: Hud }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const c = app.color.value;
  const open = hud.pickerOpen.value;

  useEffect(() => {
    // Esc and light dismiss close a modal dialog natively; keep the signal in step or the next open is a no-op
    const d = dialog.current!;
    const sync = (): void => { hud.pickerOpen.value = false; };
    d.addEventListener('close', sync);
    return () => d.removeEventListener('close', sync);
  }, []);

  useEffect(() => {
    const d = dialog.current!;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const hue = c.h;
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (ctx) drawSquare(ctx, hue);
  }, [hue, open]);

  const pick = (e: PointerEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    app.setColor({ ...app.color.value, s: clamp01((e.clientX - r.left) / r.width), b: 1 - clamp01((e.clientY - r.top) / r.height) });
  };
  const onKey = (e: KeyboardEvent): void => {
    const d = (e.shiftKey ? 0.1 : 0.01);
    const dx = e.key === 'ArrowRight' ? d : e.key === 'ArrowLeft' ? -d : 0;
    const dy = e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    app.setColor({ ...c, s: clamp01(c.s + dx), b: clamp01(c.b + dy) });
  };
  const onHex = (e: Event): void => {
    const m = /^#?([0-9a-f]{6})$/i.exec((e.currentTarget as HTMLInputElement).value.trim());
    if (m) app.setColor(rgbaColor(((parseInt(m[1], 16) << 8) | c.a) | 0, c.a));
    else (e.currentTarget as HTMLInputElement).value = hex6(colorRgba(c));
  };

  return (
    <dialog ref={dialog} class="picker" aria-label="Colour picker"
      onClick={(e) => { if (e.target === dialog.current) hud.pickerOpen.value = false; }}>
      <div class="sv" role="slider" tabIndex={0} aria-label="Saturation and brightness"
        aria-valuetext={`saturation ${Math.round(c.s * 100)}%, brightness ${Math.round(c.b * 100)}%`}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); pick(e); }}
        onPointerMove={(e) => { if (e.buttons) pick(e); }} onKeyDown={onKey}>
        <canvas ref={canvas} width={SIZE} height={SIZE} />
        <i style={{ left: `${c.s * 100}%`, top: `${(1 - c.b) * 100}%` }} />
      </div>
      <label>Hue
        <Range cls="hue" min={0} max={359} value={Math.round(c.h * 360) % 360} ariaLabel="Hue" onInput={(v) => app.setColor({ ...c, h: v / 360 })} />
      </label>
      <label>Alpha
        <Range cls="alpha" min={0} max={255} value={c.a} ariaLabel="Alpha" vars={{ '--c': `#${hex6(colorRgba(c))}` }} onInput={(v) => app.setColor({ ...c, a: v })} />
      </label>
      <label>Hex
        <input type="text" value={hex6(colorRgba(c))} maxLength={7} spellcheck={false} onChange={onHex} />
      </label>
      <div class="row">
        {app.swatches.value.map((rgba, i) => (
          <button key={i} type="button" aria-label={`Swatch ${i}`} style={{ '--c': `#${hex6(rgba)}`, '--a': String((rgba & 255) / 255) }}
            onClick={() => app.pickSwatch(i)} />
        ))}
      </div>
      <button type="button" onClick={() => (hud.pickerOpen.value = false)}>Done</button>
    </dialog>
  );
}

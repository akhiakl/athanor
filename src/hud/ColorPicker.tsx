// ColorPicker, spec 6.1: HSV square (canvas 160x160, redrawn only on hue change) + hue strip + alpha strip + hex input + swatch row.
// Non-modal: it floats beside the toolbar so the canvas stays visible while you choose. No third-party picker.
// shortcut: the bundled-palettes set replacing the legacy ColourLovers fetch arrives with the app shell.
import { useEffect, useRef } from 'preact/hooks';
import { colorRgba, rgbaColor, type App } from '../app/app';
import { hsbToRgb } from '../core/color';
import { Range } from './Hud';
import type { Hud } from './hud';

const SIZE = 160;
const GAP = 10;
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

/** Places the picker next to the toolbar (and its panels), on the side facing the canvas, clamped to the viewport. */
function place(d: HTMLDialogElement): void {
  const anchor = document.getElementById('hud-bars')?.getBoundingClientRect();
  const w = d.offsetWidth, h = d.offsetHeight, W = innerWidth, H = innerHeight;
  const clampX = (x: number): number => Math.max(8, Math.min(W - w - 8, x));
  const clampY = (y: number): number => Math.max(8, Math.min(H - h - 8, y));
  let x = (W - w) / 2, y = (H - h) / 2;
  if (anchor) {
    const edge = document.getElementById('hud-bars')?.getAttribute('data-edge');
    const trigger = document.querySelector('[data-picker-trigger]')?.getBoundingClientRect();
    const cx = trigger ? trigger.left + trigger.width / 2 : anchor.left + anchor.width / 2;
    if (edge === 'bottom') { x = cx - w / 2; y = anchor.top - h - GAP; }
    else if (edge === 'top') { x = cx - w / 2; y = anchor.bottom + GAP; }
    else if (edge === 'left') { x = anchor.right + GAP; y = anchor.top; }
    else { x = anchor.left - w - GAP; y = anchor.top; }
  }
  d.style.left = `${clampX(x)}px`;
  d.style.top = `${clampY(y)}px`;
}

export function ColorPicker({ app, hud }: { app: App; hud: Hud }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const c = app.color.value;
  const open = hud.pickerOpen.value;

  useEffect(() => {
    // Esc closes a dialog natively; keep the signal in step or the next open is a no-op
    const d = dialog.current!;
    const sync = (): void => { hud.pickerOpen.value = false; };
    d.addEventListener('close', sync);
    return () => d.removeEventListener('close', sync);
  }, []);

  useEffect(() => {
    const d = dialog.current!;
    if (!open) {
      if (d.open) d.close();
      return;
    }
    if (!d.open) d.show(); // non-modal: no backdrop, the canvas stays visible
    place(d);
    const outside = (e: PointerEvent): void => {
      const t = e.target as Element;
      if (!d.contains(t) && !t.closest('[data-picker-trigger]')) hud.pickerOpen.value = false;
    };
    const onResize = (): void => place(d);
    document.addEventListener('pointerdown', outside);
    addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      removeEventListener('resize', onResize);
    };
  }, [open, app.slot.value]);

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
    const d = e.shiftKey ? 0.1 : 0.01;
    const dx = e.key === 'ArrowRight' ? d : e.key === 'ArrowLeft' ? -d : 0;
    const dy = e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    app.setColor({ ...c, s: clamp01(c.s + dx), b: clamp01(c.b + dy) });
  };
  const onHex = (e: Event): void => {
    const input = e.currentTarget as HTMLInputElement;
    const m = /^#?([0-9a-f]{6})$/i.exec(input.value.trim());
    if (m) app.setColor(rgbaColor(((parseInt(m[1], 16) << 8) | c.a) | 0, c.a));
    else {
      input.value = hex6(colorRgba(c));
      hud.announce('Not a valid hex colour. Use six hex digits.');
    }
  };

  return (
    <dialog ref={dialog} class="picker" aria-label={`Colour picker, ${app.slot.value === 0 ? 'primary' : 'secondary'} colour`}>
      <div class="seg" role="group" aria-label="Colour slot">
        <button type="button" aria-pressed={app.slot.value === 0} onClick={() => app.setSlot(0)}>Primary</button>
        <button type="button" aria-pressed={app.slot.value === 1} onClick={() => app.setSlot(1)}>Secondary</button>
      </div>
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
      <label class="hexrow">Hex
        <span class="hexfield"><span aria-hidden="true">#</span>
          <input type="text" value={hex6(colorRgba(c))} maxLength={7} spellcheck={false} aria-label="Hex colour" onChange={onHex} />
        </span>
      </label>
      <div class="row">
        {app.swatches.value.map((rgba, i) => (
          <button key={i} type="button" aria-label={`Swatch ${i}: #${hex6(rgba)}`} style={{ '--c': `#${hex6(rgba)}`, '--a': String((rgba & 255) / 255) }} onClick={() => app.pickSwatch(i)} />
        ))}
      </div>
    </dialog>
  );
}

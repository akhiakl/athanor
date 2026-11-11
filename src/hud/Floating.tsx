// Floating toolbar, spec 8.3.2: a 44 px pill, default bottom-centre, draggable to any edge, position persisted.
// shortcut: Home, Undo/Redo, Page, Record and More wait for the app shell, history, pages and session features.
import { useRef } from 'preact/hooks';
import { affectMenu, colorRgba, createMenu, type App } from '../app/app';
import { moduleUi } from '../app/controls';
import { Menu, SubBar, SwatchBar } from './Hud';
import { IconFill, IconGrip, IconLayers, IconMinus, IconPen, IconPlus, IconSliders, IconStroke, IconSwatches, IconTrash } from './icons';
import type { Edge, Hud } from './hud';

const hex = (rgba: number): string => `#${(rgba >>> 8).toString(16).padStart(6, '0')}`;
const keyHint = (i: number, mod: string): string => `${mod}${(i + 1) % 10}`;

/** Snaps a dropped pill rect to its nearest viewport edge. Same orientation: exact (no jump). Rotated: keeps the centre. */
function snap(r: DOMRect, from: Edge, W: number, H: number): { edge: Edge; along: number } {
  const d: [Edge, number][] = [['top', r.top], ['bottom', H - r.bottom], ['left', r.left], ['right', W - r.right]];
  const edge = d.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  const horiz = edge === 'top' || edge === 'bottom';
  const same = horiz === (from === 'top' || from === 'bottom');
  const [lo, size, view] = horiz ? [r.left, r.width, W] : [r.top, r.height, H];
  const along = same && view > size ? lo / (view - size) : (lo + size / 2) / view;
  return { edge, along: Math.max(0, Math.min(1, along)) };
}

export function FloatingView({ app, hud }: { app: App; hud: Hud }) {
  const { edge, along } = hud.pos.value;
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const pill = useRef<HTMLDivElement>(null);
  const horiz = edge === 'top' || edge === 'bottom';
  const drawing = hud.stroke.value; // DRAWING: opacity 0.15, pointer-events none
  const style = horiz ? { left: `${along * 100}%`, transform: `translateX(${-along * 100}%)` } : { top: `${along * 100}%`, transform: `translateY(${-along * 100}%)` };
  const creating = createMenu.indexOf(app.createId.value);
  const on = app.affectsOn.value;
  const hasSettings = [app.createId.value, ...affectMenu.filter((id) => on.has(id))].some((id) => moduleUi[id].controls.length || moduleUi[id].buttons?.length);
  const c = app.color.value;

  const toggleCollapse = (): void => {
    hud.collapsed.value = !hud.collapsed.value;
    hud.popup.value = null;
    hud.flyout.value = false;
    hud.persist();
  };

  const onGripMove = (e: PointerEvent): void => {
    if (!drag.current || !pill.current) return;
    const el = pill.current; // follows the pointer at the point where it was grabbed
    el.style.transition = 'none';
    el.style.left = `${e.clientX - drag.current.dx}px`;
    el.style.top = `${e.clientY - drag.current.dy}px`;
    el.style.right = el.style.bottom = 'auto';
    el.style.transform = 'none';
  };
  const onGripUp = (): void => {
    if (!drag.current || !pill.current) return;
    drag.current = null;
    const el = pill.current;
    const r = el.getBoundingClientRect();
    for (const k of ['transition', 'left', 'top', 'right', 'bottom', 'transform'] as const) el.style[k] = '';
    hud.pos.value = snap(r, edge, window.innerWidth, window.innerHeight);
    hud.persist();
  };

  if (hud.collapsed.value) {
    return (
      <div id="hud-bars" class="floating collapsed" data-edge={edge} style={{ ...style, opacity: drawing ? 0.15 : 1, pointerEvents: drawing ? 'none' : 'auto' }}>
        <button type="button" class="dot" aria-label="Show toolbar" onClick={toggleCollapse} />
      </div>
    );
  }
  return (
    <>
      {hud.swatchPanel.value && !drawing && (
        <aside class="swatch-panel" aria-label="Swatches"><SwatchBar app={app} hud={hud} /></aside>
      )}
      <div
        id="hud-bars" ref={pill} class="floating" data-edge={edge} data-state={drawing ? 'DRAWING' : hud.flyout.value ? 'FLYOUT' : 'IDLE'}
        style={{ ...style, opacity: drawing ? 0.15 : 1, pointerEvents: drawing ? 'none' : 'auto' }} inert={drawing}
      >
        {hud.flyout.value && hasSettings && (
          <div class="flyout"><SubBar app={app} /></div>
        )}
        <div class="bar pill" role="toolbar" aria-label="Athanor" aria-orientation={horiz ? 'horizontal' : 'vertical'}>
          <button
            type="button" class="grip" aria-label="Move toolbar (drag to any edge)" title="Drag to move"
            onPointerDown={(e) => { const r = pill.current!.getBoundingClientRect(); drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
            onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}
          ><IconGrip /></button>
          <span class="sep" role="separator" aria-orientation={horiz ? 'vertical' : 'horizontal'} />
          <Menu id="create" hud={hud} label={moduleUi[app.createId.value].title} icon={<IconPen />}>
            {createMenu.map((id, i) => (
              <label key={id}>
                <input type="radio" name="create" checked={creating === i} onChange={() => { app.selectCreate(i); hud.popup.value = null; }} />
                {moduleUi[id].title}<kbd>{i < 10 ? keyHint(i, '') : keyHint(i - 10, 'Alt+')}</kbd>
              </label>
            ))}
          </Menu>
          <Menu id="affect" hud={hud} label="Affects" icon={<IconLayers />} badge={on.size || undefined}>
            {affectMenu.map((id, i) => (
              <label key={id}>
                <input type="checkbox" checked={on.has(id)} onChange={() => app.setAffect(id)} />
                {moduleUi[id].title}<kbd>{i < 10 ? keyHint(i, 'Mod+') : keyHint(i - 10, 'Mod+Shift+')}</kbd>
              </label>
            ))}
          </Menu>
          {hasSettings && (
            <button type="button" aria-expanded={hud.flyout.value} aria-label="Module settings" title="Module settings" onClick={() => { hud.flyout.value = !hud.flyout.value; hud.popup.value = null; }}><IconSliders /></button>
          )}
          <span class="sep" role="separator" aria-orientation={horiz ? 'vertical' : 'horizontal'} />
          <button
            type="button" class="colour" aria-label={`Colour ${hex(colorRgba(c))}. Right-click for the secondary slot`} title="Colour"
            style={{ '--c': hex(colorRgba(c)), '--a': String(c.a / 255) }}
            onClick={() => { app.setSlot(0); hud.pickerOpen.value = true; }}
            onContextMenu={(e) => { e.preventDefault(); app.setSlot(1); hud.pickerOpen.value = true; }}
          />
          {!app.fill.value && (
            <label class="stepper">
              <button type="button" aria-label="Thinner" onClick={() => app.setLineWidth(app.lineWidth.value - 1)}><IconMinus /></button>
              <input type="number" aria-label="Line width" min={1} max={75} value={app.lineWidth.value} onChange={(e) => app.setLineWidth(Number(e.currentTarget.value))} />
              <button type="button" aria-label="Thicker" onClick={() => app.setLineWidth(app.lineWidth.value + 1)}><IconPlus /></button>
            </label>
          )}
          <button type="button" aria-pressed={app.fill.value} aria-label="Fill" title={app.fill.value ? 'Fill (S)' : 'Stroke (S)'} onClick={() => app.setFill(!app.fill.value)}>
            {app.fill.value ? <IconFill /> : <IconStroke />}
          </button>
          <span class="sep" role="separator" aria-orientation={horiz ? 'vertical' : 'horizontal'} />
          <button type="button" aria-pressed={hud.swatchPanel.value} aria-label="Swatches" title="Swatches (Tab)" onClick={() => { hud.swatchPanel.value = !hud.swatchPanel.value; hud.persist(); }}><IconSwatches /></button>
          <button type="button" aria-label="Clear canvas" title="Clear (Mod+Backspace)" onClick={() => app.clear()}><IconTrash /></button>
          <button type="button" aria-label="Collapse toolbar" title="Collapse (Mod+.)" onClick={toggleCollapse}><IconMinus /></button>
        </div>
      </div>
    </>
  );
}

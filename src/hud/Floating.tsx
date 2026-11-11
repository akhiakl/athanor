// Floating toolbar, spec 8.3.2: a 44 px pill, default bottom-centre, draggable to any edge, position persisted.
// shortcut: Home, Undo/Redo, Page, Record and More wait for the app shell, history, pages and session features.
import { useEffect, useRef, useState } from 'preact/hooks';
import { affectMenu, colorRgba, createMenu, type App } from '../app/app';
import { moduleUi } from '../app/controls';
import { Menu, SubBar, SwatchBar } from './Hud';
import { IconCollapse, IconFlask, IconGrip, IconLayers, IconMinus, IconPalette, IconPlus, IconSliders, IconStyle, IconToolbar, IconTrash } from './icons';
import { affectHint, createHint, modLabel } from './keys';
import { isHoriz, nudge, placementStyle, snap } from './placement';
import type { Hud } from './hud';

const hex = (rgba: number): string => `#${(rgba >>> 8).toString(16).padStart(6, '0')}`;
const MAX_PIPS = 3;
const NARROW = '(max-width: 36rem)';

/** True on phone-width viewports, where the pill spans the width and horizontal placement is the stylesheet's job. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const q = matchMedia(NARROW);
    const on = (): void => setNarrow(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** One tab stop for the whole toolbar; arrows, Home and End move between controls (WAI-ARIA toolbar pattern). */
function useRoving(pill: { current: HTMLDivElement | null }, horiz: boolean) {
  const active = useRef<HTMLElement | null>(null);
  const items = (): HTMLElement[] =>
    [...(pill.current?.querySelectorAll<HTMLElement>('.pill button, .pill input') ?? [])].filter((e) => !e.closest('.popup') && e.getAttribute('aria-disabled') !== 'true');
  const apply = (): void => {
    const list = items();
    if (!active.current || !list.includes(active.current)) active.current = list[0] ?? null;
    // every control, disabled ones included, so exactly one stays in the tab order
    for (const el of pill.current?.querySelectorAll<HTMLElement>('.pill button, .pill input') ?? []) if (!el.closest('.popup')) el.tabIndex = el === active.current ? 0 : -1;
  };
  useEffect(apply); // after every render: controls come and go (pips, stepper, disabled settings)
  return {
    onFocusIn: (e: FocusEvent): void => {
      const t = e.target as HTMLElement;
      if (items().includes(t)) {
        active.current = t;
        apply();
      }
    },
    onKeyDown: (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (e.altKey || e.ctrlKey || e.metaKey || t.closest('.popup') || t instanceof HTMLInputElement) return;
      const next = horiz ? 'ArrowRight' : 'ArrowDown';
      const prev = horiz ? 'ArrowLeft' : 'ArrowUp';
      const list = items();
      const i = list.indexOf(t);
      if (i < 0) return;
      let j = -1;
      if (e.key === next) j = (i + 1) % list.length;
      else if (e.key === prev) j = (i - 1 + list.length) % list.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = list.length - 1;
      if (j < 0) return;
      e.preventDefault();
      list[j].focus();
    },
  };
}

export function FloatingView({ app, hud }: { app: App; hud: Hud }) {
  const pos = hud.pos.value;
  const { edge } = pos;
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const pill = useRef<HTMLDivElement>(null);
  const horiz = isHoriz(edge);
  const narrow = useNarrow();
  const roving = useRoving(pill, horiz);
  const drawing = hud.stroke.value; // DRAWING: opacity 0.15, pointer-events none
  const style = narrow && horiz ? {} : placementStyle(pos);
  const creating = createMenu.indexOf(app.createId.value);
  const on = app.affectsOn.value;
  const hasSettings = [app.createId.value, ...affectMenu.filter((id) => on.has(id))].some((id) => moduleUi[id].controls.length || moduleUi[id].buttons?.length);
  const c = app.color.value;
  const activeIds = affectMenu.filter((id) => on.has(id));
  const [armed, setArmed] = useState(false); // Clear needs a second press within 3 s: there is no undo yet
  const clearTimer = useRef(0);

  const toggleCollapse = (): void => {
    hud.collapsed.value = !hud.collapsed.value;
    hud.popup.value = null;
    hud.flyout.value = false;
    hud.pickerOpen.value = false;
    hud.announce(hud.collapsed.value ? 'Toolbar collapsed' : 'Toolbar shown');
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
  const onGripKey = (e: KeyboardEvent): void => {
    if (!e.altKey) return; // plain arrows belong to the toolbar's roving focus
    const n = nudge(pos, e.key, e.shiftKey);
    if (!n) return;
    e.preventDefault();
    hud.pos.value = n;
    hud.persist();
    hud.announce(`Toolbar ${n.edge}`);
  };

  const openSettings = (): void => {
    hud.flyout.value = !hud.flyout.value;
    hud.popup.value = null;
  };
  const onClear = (): void => {
    if (armed) {
      clearTimeout(clearTimer.current);
      setArmed(false);
      app.clear();
      hud.announce('Canvas cleared');
      return;
    }
    setArmed(true);
    hud.announce('Press clear again to confirm');
    clearTimer.current = window.setTimeout(() => setArmed(false), 3000);
  };
  const openPicker = (slot: 0 | 1): void => {
    const same = hud.pickerOpen.value && app.slot.value === slot; // the same trigger twice closes it
    app.setSlot(slot);
    hud.pickerOpen.value = !same;
  };

  const sep = <span class="sep" role="separator" aria-orientation={horiz ? 'vertical' : 'horizontal'} />;
  const common = { 'data-edge': edge, style: { ...style, opacity: drawing ? 0.15 : 1, pointerEvents: drawing ? 'none' : 'auto' } } as const;

  if (hud.collapsed.value) {
    // Round, minimal: the toolbar glyph with a badge in the current colour. The label slides out on hover or focus,
    // and once for a moment after collapsing so the first time it explains itself.
    return (
      <div id="hud-bars" class="floating collapsed" {...common}>
        <button type="button" class="launcher" aria-label="Show toolbar" title={`Show toolbar (${modLabel}.)`} onClick={toggleCollapse} style={{ '--c': hex(colorRgba(c)), '--a': String(c.a / 255) }}>
          <IconToolbar />
          <span class="chip-dot" aria-hidden="true" />
          <span class="launcher-label" aria-hidden="true">Tools</span>
        </button>
    </div>
    );
  }
  return (
    <div id="hud-bars" ref={pill} class="floating" data-state={drawing ? 'DRAWING' : hud.flyout.value ? 'FLYOUT' : 'IDLE'} inert={drawing} {...common}>
      {/* panels sit beside the pill (above it on horizontal edges, to its side on vertical ones), never over it */}
      <div class="panels">
        {hud.swatchPanel.value && <aside class="swatch-panel" aria-label="Swatches"><SwatchBar app={app} hud={hud} /></aside>}
        {hud.flyout.value && hasSettings && <div class="flyout"><SubBar app={app} /></div>}
      </div>
      <div class="bar pill" role="toolbar" aria-label="Athanor" aria-orientation={horiz ? 'horizontal' : 'vertical'} onFocusIn={roving.onFocusIn} onKeyDown={roving.onKeyDown}>
        <button
          type="button" class="grip" aria-label="Move toolbar" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" title="Drag to move, or Alt+arrows (add Shift to change edge)"
          onPointerDown={(e) => { const r = pill.current!.getBoundingClientRect(); drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp} onKeyDown={onGripKey}
        ><IconGrip /></button>
        {sep}
        <Menu id="create" hud={hud} cls="primary" label={moduleUi[app.createId.value].title} icon={<IconFlask />} ariaLabel={`Create: ${moduleUi[app.createId.value].title}`}>
          {createMenu.map((id, i) => (
            <label key={id}>
              <input type="radio" name="create" checked={creating === i} onChange={() => { app.selectCreate(i); hud.popup.value = null; }} />
              {moduleUi[id].title}<kbd>{createHint(i)}</kbd>
            </label>
          ))}
        </Menu>
        <Menu id="affect" hud={hud} label={on.size ? '' : 'Affects'} icon={<IconLayers />} badge={on.size || undefined} ariaLabel={`Affects, ${on.size} active`}>
          {affectMenu.map((id, i) => (
            <label key={id}>
              <input type="checkbox" checked={on.has(id)} onChange={() => app.setAffect(id)} />
              {moduleUi[id].title}<kbd>{affectHint(i)}</kbd>
            </label>
          ))}
        </Menu>
        {activeIds.length > 0 && (
          <span class="pips" role="group" aria-label="Active affects">
            {activeIds.slice(0, MAX_PIPS).map((id) => (
              <button key={id} type="button" class="pip" title={`${moduleUi[id].title} settings`} onClick={() => (moduleUi[id].controls.length || moduleUi[id].buttons?.length ? openSettings() : (hud.popup.value = 'affect'))}>
                {moduleUi[id].title}
              </button>
            ))}
            {activeIds.length > MAX_PIPS && <span class="pip more">+{activeIds.length - MAX_PIPS}</span>}
          </span>
        )}
        <button type="button" aria-expanded={hud.flyout.value} aria-disabled={!hasSettings} aria-label="Module settings" title={hasSettings ? 'Module settings' : 'No settings for the current modules'} onClick={() => hasSettings && openSettings()}><IconSliders /></button>
        {sep}
        <button
          type="button" class="colour" data-picker-trigger aria-label={`Colour ${hex(colorRgba(c))}`} title="Colour. Right-click or Shift+click for the secondary colour"
          style={{ '--c': hex(colorRgba(c)), '--a': String(c.a / 255) }}
          onClick={(e) => openPicker(e.shiftKey ? 1 : 0)}
          onContextMenu={(e) => { e.preventDefault(); openPicker(1); }}
        />
        {!app.fill.value && (
          <label class="stepper">
            <button type="button" aria-label="Thinner" onClick={() => app.setLineWidth(app.lineWidth.value - 1)}><IconMinus /></button>
            <input type="number" aria-label="Line width" min={1} max={75} value={app.lineWidth.value} onChange={(e) => app.setLineWidth(Number(e.currentTarget.value))} />
            <button type="button" aria-label="Thicker" onClick={() => app.setLineWidth(app.lineWidth.value + 1)}><IconPlus /></button>
          </label>
        )}
        <button type="button" aria-pressed={app.fill.value} aria-label="Fill" title="Fill instead of stroke (S)" onClick={() => app.setFill(!app.fill.value)}><IconStyle /></button>
        {sep}
        <button type="button" aria-pressed={hud.swatchPanel.value} aria-label="Swatches" title="Swatches (Tab)" onClick={() => { hud.swatchPanel.value = !hud.swatchPanel.value; hud.persist(); }}><IconPalette /></button>
        {sep}
        <button
          type="button" class={armed ? 'danger' : undefined} aria-label={armed ? 'Confirm: clear canvas' : 'Clear canvas'}
          title={armed ? 'Press again to clear' : `Clear (${modLabel}Backspace)`} onClick={onClear}
        >{armed ? <><IconTrash /><span class="chip-label">Clear?</span></> : <IconTrash />}</button>
        <button type="button" aria-label="Collapse toolbar" title={`Collapse (${modLabel}.)`} onClick={toggleCollapse}><IconCollapse /></button>
      </div>
    </div>
  );
}

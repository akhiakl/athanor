import { useEffect, useRef } from 'preact/hooks';
import { affectMenu, colorRgba, createMenu, type App } from '../app/app';
import { moduleUi, type ControlSpec } from '../app/controls';
import type { Hud } from './hud';
import { ColorPicker } from './ColorPicker';
import { FloatingView } from './Floating';
import { affectHint, createHint } from './keys';
import { IconChevron, IconLock, IconMinus, IconPlus } from './icons';

const hex = (rgba: number): string => `#${(rgba >>> 8).toString(16).padStart(6, '0')}`;

/** Native range input; the fill is drawn by CSS from --v/--min/--max (WebKit has no ::progress pseudo-element). */
export function Range({ min, max, step = 1, value, onInput, cls, ariaLabel, vars }: { min: number; max: number; step?: number; value: number; onInput: (v: number) => void; cls?: string; ariaLabel?: string; vars?: Record<string, string> }) {
  return (
    <input
      type="range" class={cls} min={min} max={max} step={step} value={value} aria-label={ariaLabel}
      style={{ '--v': value, '--min': min, '--max': max, ...vars }} onInput={(e) => onInput(Number(e.currentTarget.value))}
    />
  );
}

export function Menu({ id, hud, label, icon, badge, cls, ariaLabel, children }: { id: string; hud: Hud; label: string; icon?: preact.ComponentChildren; badge?: number; cls?: string; ariaLabel?: string; children: preact.ComponentChildren }) {
  const open = hud.popup.value === id;
  return (
    <div class="menu">
      <button type="button" class={cls} aria-label={ariaLabel} aria-haspopup="true" aria-expanded={open} onClick={() => { hud.popup.value = open ? null : id; hud.flyout.value = false; }}>
        {icon}{label && <span class="chip-label">{label}</span>}{badge ? <span class="badge" aria-label={`${badge} active`}>{badge}</span> : null}<IconChevron />
      </button>
      {open && <div class="popup" role="group" aria-label={label}>{children}</div>}
    </div>
  );
}

function MainBar({ app, hud }: { app: App; hud: Hud }) {
  const creating = createMenu.indexOf(app.createId.value);
  const on = app.affectsOn.value;
  return (
    <div class="bar" role="toolbar" aria-label="Athanor">
      <button type="button" aria-pressed={app.fill.value} onClick={() => app.setFill(!app.fill.value)}>{app.fill.value ? 'Fill' : 'Stroke'} <kbd>S</kbd></button>
      <label class="stepper">Width
        <button type="button" aria-label="Thinner" onClick={() => app.setLineWidth(app.lineWidth.value - 1)}><IconMinus /></button>
        <input type="number" min={1} max={75} value={app.lineWidth.value} onChange={(e) => app.setLineWidth(Number(e.currentTarget.value))} />
        <button type="button" aria-label="Thicker" onClick={() => app.setLineWidth(app.lineWidth.value + 1)}><IconPlus /></button>
      </label>
      <span class="sep" role="separator" />
      <Menu id="create" hud={hud} label={`Create: ${moduleUi[app.createId.value].title}`}>
        {createMenu.map((id, i) => (
          <label key={id}>
            <input type="radio" name="create" checked={creating === i} onChange={() => { app.selectCreate(i); hud.popup.value = null; }} />
            {moduleUi[id].title}<kbd>{createHint(i)}</kbd>
          </label>
        ))}
      </Menu>
      <Menu id="affect" hud={hud} label={`Affects${on.size ? ` (${on.size})` : ''}`}>
        {affectMenu.map((id, i) => (
          <label key={id}>
            <input type="checkbox" checked={on.has(id)} onChange={() => app.setAffect(id)} />
            {moduleUi[id].title}<kbd>{affectHint(i)}</kbd>
          </label>
        ))}
      </Menu>
      <span class="sep" role="separator" />
      <button type="button" onClick={() => app.clear()}>Clear</button>
      <button type="button" class="flip" onClick={() => (app.bar.value = 'swatch')}>Colours <kbd>Tab</kbd></button>
    </div>
  );
}

export function SwatchBar({ app, hud }: { app: App; hud: Hud }) {
  const c = app.color.value;
  const press = useRef(0);
  const swatches = app.swatches.value;
  const onKey = (e: KeyboardEvent, i: number): void => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + swatches.length) % swatches.length;
    if (e.altKey) { // Alt+arrow reorders
      const next = swatches.slice();
      [next[i], next[j]] = [next[j], next[i]];
      app.swatches.value = next;
      app.swatchIndex.value = j;
    } else app.pickSwatch(j);
    queueMicrotask(() => (document.querySelectorAll<HTMLElement>('.strip button')[j])?.focus());
  };
  return (
    <div class="bar" role="toolbar" aria-label="Colours">
      <button type="button" aria-pressed={app.alphaLock.value} aria-label="Lock alpha" title="Lock alpha" onClick={() => (app.alphaLock.value = !app.alphaLock.value)}><IconLock /></button>
      <label class="slider">Alpha
        <Range min={0} max={255} value={c.a} onInput={app.setAlpha} />
        <output>{c.a}</output>
      </label>
      <button
        type="button" class="colour" data-picker-trigger aria-label={`Colour ${app.slot.value === 0 ? 'primary' : 'secondary'} ${hex(colorRgba(c))}`}
        style={{ '--c': hex(colorRgba(c)), '--a': String(c.a / 255) }}
        onPointerDown={() => { press.current = window.setTimeout(() => { press.current = -1; app.setSlot(1); hud.pickerOpen.value = true; }, 500); }}
        onPointerUp={() => { if (press.current > 0) { clearTimeout(press.current); app.setSlot(0); hud.pickerOpen.value = true; } press.current = 0; }}
        onPointerLeave={() => { if (press.current > 0) clearTimeout(press.current); press.current = 0; }}
        onContextMenu={(e) => { e.preventDefault(); app.setSlot(1); hud.pickerOpen.value = true; }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.setSlot(0); hud.pickerOpen.value = true; } }}
      />
      <button type="button" aria-label="Add swatch" title="Add swatch" onClick={() => app.addSwatch()}><IconPlus /></button>
      <button type="button" aria-label="Remove swatch" title="Remove swatch" onClick={() => app.removeSwatch()}><IconMinus /></button>
      <div class="strip" role="listbox" aria-label="Swatches">
        {swatches.map((rgba, i) => (
          <button
            key={i} type="button" role="option" aria-selected={i === app.swatchIndex.value} tabIndex={i === app.swatchIndex.value ? 0 : -1}
            aria-label={`Swatch ${i}: ${hex(rgba)}`} style={{ '--c': hex(rgba), '--a': String((rgba & 255) / 255) }}
            onClick={() => app.pickSwatch(i)} onKeyDown={(e) => onKey(e, i)}
          />
        ))}
      </div>
      <button type="button" class="flip" onClick={() => (app.bar.value = 'main')}>Tools <kbd>Tab</kbd></button>
    </div>
  );
}

function Control({ spec, id, app }: { spec: ControlSpec; id: string; app: App }) {
  const v = app.values.value[id]?.[spec.param] ?? spec.def;
  const set = (x: number | boolean): void => app.setValue(id, spec.param, x);
  if (spec.kind === 'toggle') return <button type="button" aria-pressed={Boolean(v)} onClick={() => set(!v)}>{spec.label}</button>;
  if (spec.kind === 'stepper') {
    return (
      <label class="stepper">{spec.label}
        <input type="number" min={spec.min} max={spec.max} step={spec.step} value={Number(v)}
          onChange={(e) => set(Math.max(spec.min!, Math.min(spec.max!, Number(e.currentTarget.value) || spec.min!)))} />
      </label>
    );
  }
  return (
    <label class="slider">{spec.label}
      <Range min={spec.min!} max={spec.max!} step={spec.step} value={Number(v)} onInput={set} />
      <output>{Number(v)}</output>
    </label>
  );
}

export function SubBar({ app }: { app: App }) {
  const on = app.affectsOn.value;
  const ids = [app.createId.value, ...affectMenu.filter((id) => on.has(id))];
  const shown = ids.filter((id) => moduleUi[id].controls.length || moduleUi[id].buttons?.length);
  if (!shown.length) return null;
  return (
    <div class="subbar" role="region" aria-label="Module settings">
      {shown.map((id) => (
        <section key={id} aria-label={moduleUi[id].title}>
          <h2>{moduleUi[id].title}</h2>
          {moduleUi[id].controls.map((s) => <Control key={s.param} spec={s} id={id} app={app} />)}
          {moduleUi[id].buttons?.map((b) => (
            <button key={b.action} type="button" aria-pressed={b.action === 'mirror.move' ? app.axisMove.value : undefined} onClick={() => app.press(b.action)}>
              {b.label}{b.key && <kbd>{b.key}</kbd>}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function ProximityView({ app, hud }: { app: App; hud: Hud }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => (hud.height.value = el.offsetHeight)); // cached: no layout reads during strokes
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const m = hud.model.value;
  const opacity = hud.stroke.value ? 0 : m.opacity;
  const interactive = opacity > 0.99;
  return (
    <>
      <div
        id="hud-bars" ref={ref} class={m.state === 'DOCKED' ? 'docked' : ''} data-state={m.state}
        style={{ opacity, pointerEvents: interactive ? 'auto' : 'none', transform: `translateY(${(1 - opacity) * -8}px)` }}
        // inert keeps hidden controls out of the tab order and away from screen readers
        inert={!interactive} onPointerEnter={() => hud.enter()} onPointerLeave={() => hud.leave()}
      >
        {app.bar.value === 'main' ? <MainBar app={app} hud={hud} /> : <SwatchBar app={app} hud={hud} />}
        <SubBar app={app} />
      </div>
    </>
  );
}

export function HudView({ app, hud }: { app: App; hud: Hud }) {
  useEffect(() => {
    const close = (e: PointerEvent): void => {
      if (hud.popup.value && !(e.target as Element).closest('.menu')) hud.popup.value = null;
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // return focus to what opened it, so keyboard users are not dropped at the top of the page
      const trigger = hud.popup.value ? document.querySelector<HTMLElement>('.menu > button[aria-expanded="true"]') : hud.flyout.value ? document.querySelector<HTMLElement>('button[aria-label="Module settings"]') : null;
      hud.popup.value = null;
      hud.flyout.value = false;
      hud.pickerOpen.value = false;
      trigger?.focus();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  const nowOn = app.affectsOn.value; // read in render so a change re-renders and runs the effect below
  const nowCreate = app.createId.value;
  const prev = useRef({ on: nowOn, create: nowCreate });
  useEffect(() => {
    // Every source (menu, shortcut, control) goes through here: say what happened for screen readers
    const now = { on: nowOn, create: nowCreate };
    for (const id of [...now.on, ...prev.current.on]) if (now.on.has(id) !== prev.current.on.has(id)) hud.announce(`${moduleUi[id].title} ${now.on.has(id) ? 'on' : 'off'}`);
    if (now.create !== prev.current.create) hud.announce(`Create: ${moduleUi[now.create].title}`);
    prev.current = now;
  });
  return (
    <>
      <div class="sr-only" role="status" aria-live="polite">{hud.announcement.value}</div>
      {hud.mode.value === 'floating' ? <FloatingView app={app} hud={hud} /> : <ProximityView app={app} hud={hud} />}
      <ColorPicker app={app} hud={hud} />
    </>
  );
}

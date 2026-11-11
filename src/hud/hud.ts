// HUD controller: owns the state machine model, popup and stroke flags, and the timers. UI components only read signals.
import { signal } from '@preact/signals';
import { hudInitial, hudNext, type HudEvent } from './hudState';

export type Edge = 'bottom' | 'top' | 'left' | 'right';
export interface PillPos { edge: Edge; along: number }
export type HudMode = 'floating' | 'proximity';

const KEY = 'athanor.hud';
function load(): { mode?: HudMode; pos?: PillPos; collapsed?: boolean; swatches?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {}; // private window or blocked storage: defaults
  }
}

export function createHud() {
  const saved = load();
  const q = new URLSearchParams(location.search).get('hud');
  /** Spec 8.3.2: focus mode with the floating pill is the default; `hud.mode = proximity` is the legacy top-edge reveal (1.4). */
  const mode = signal<HudMode>(q === 'proximity' || q === 'floating' ? q : saved.mode === 'proximity' ? 'proximity' : 'floating');
  const pos = signal<PillPos>(saved.pos ?? { edge: 'bottom', along: 0.5 });
  const collapsed = signal(saved.collapsed ?? false);
  const swatchPanel = signal(saved.swatches ?? false);
  const flyout = signal(false);
  const persist = (): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ mode: mode.value, pos: pos.value, collapsed: collapsed.value, swatches: swatchPanel.value }));
    } catch { /* storage unavailable: the toolbar still works, it just forgets */ }
  };
  const model = signal(hudInitial());
  const height = signal(0);
  const popup = signal<string | null>(null);
  const stroke = signal(false);
  const pickerOpen = signal(false);
  let insideHud = false;
  let hideTimer = 0;
  let restoreTimer = 0;

  function dispatch(ev: HudEvent): void {
    const next = hudNext(model.value, ev);
    if (next === model.value) return;
    model.value = next;
    if (next.timer && !hideTimer) {
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        dispatch({ t: 'timer', insideHud, popup: popup.value !== null });
      }, 1000);
    } else if (!next.timer && hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }

  return {
    model, height, popup, stroke, pickerOpen, mode, pos, collapsed, swatchPanel, flyout, persist,
    dispatch,
    /** Pointer moved over the stage (not the HUD): proximity. */
    move: (y: number): void => dispatch({ t: 'move', y, h: height.value, popup: popup.value !== null || pickerOpen.value, stroke: stroke.value }),
    strokeStart(): void {
      clearTimeout(restoreTimer);
      stroke.value = true;
      popup.value = null;
      flyout.value = false; // pointerdown on the canvas closes the flyout
      dispatch({ t: 'down' });
    },
    strokeEnd(): void {
      clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => (stroke.value = false), 300); // restores 300 ms after pointerup
    },
    enter(): void {
      insideHud = true;
      dispatch({ t: 'enter' });
    },
    leave(): void {
      insideHud = false;
      dispatch({ t: 'leave' });
    },
    visible: (): boolean => model.value.state !== 'HIDDEN' && model.value.state !== 'PEEK',
  };
}
export type Hud = ReturnType<typeof createHud>;

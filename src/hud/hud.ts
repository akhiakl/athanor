// HUD controller: owns the state machine model, popup and stroke flags, and the timers. UI components only read signals.
import { signal } from '@preact/signals';
import { hudInitial, hudNext, type HudEvent } from './hudState';

export function createHud() {
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
    model, height, popup, stroke, pickerOpen,
    dispatch,
    /** Pointer moved over the stage (not the HUD): proximity. */
    move: (y: number): void => dispatch({ t: 'move', y, h: height.value, popup: popup.value !== null || pickerOpen.value, stroke: stroke.value }),
    strokeStart(): void {
      clearTimeout(restoreTimer);
      stroke.value = true;
      popup.value = null;
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

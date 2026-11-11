// Proximity HUD state machine, spec 1.4. Pure: the caller owns timers, DOM rects and the 300 ms post-stroke restore.
export type HudKind = 'HIDDEN' | 'PEEK' | 'SHOWN' | 'KEYED' | 'DOCKED';

export interface HudModel {
  state: HudKind;
  opacity: number;
  /** True while a popup is open and the pointer left the bar: the caller arms a 1000 ms timer. */
  timer: boolean;
  /** KEYED persists until the pointer has entered and then left the HUD. */
  sawInside: boolean;
}

export type HudEvent =
  | { t: 'move'; y: number; h: number; popup: boolean; stroke: boolean }
  | { t: 'down' }
  | { t: 'toggle' } // Space
  | { t: 'key' } // Tab
  | { t: 'enter' }
  | { t: 'leave' }
  | { t: 'timer'; insideHud: boolean; popup: boolean }
  | { t: 'dock'; on: boolean };

export const SHOW_Y = 10;
export const PEEK_Y = 48;

export const hudInitial = (): HudModel => ({ state: 'HIDDEN', opacity: 0, timer: false, sawInside: false });

const set = (m: HudModel, state: HudKind, opacity: number, timer = false): HudModel =>
  m.state === state && m.opacity === opacity && m.timer === timer ? m : { ...m, state, opacity, timer };

export function hudNext(m: HudModel, ev: HudEvent): HudModel {
  switch (ev.t) {
    case 'dock': return ev.on ? set(m, 'DOCKED', 1) : set(m, 'HIDDEN', 0);
    case 'down': return m.state === 'DOCKED' ? m : { ...set(m, 'HIDDEN', 0), sawInside: false };
    case 'toggle': return m.state === 'DOCKED' ? m : m.state === 'SHOWN' || m.state === 'KEYED' ? set(m, 'HIDDEN', 0) : { ...set(m, 'KEYED', 1), sawInside: false };
    case 'key': return m.state === 'DOCKED' ? m : { ...set(m, 'KEYED', 1), sawInside: false };
    case 'enter': return m.state === 'KEYED' ? { ...m, sawInside: true } : m;
    case 'leave': return m.state === 'KEYED' && m.sawInside ? set(m, 'SHOWN', 1) : m;
    case 'timer': return m.state === 'SHOWN' && m.timer && !ev.insideHud && !ev.popup ? set(m, 'HIDDEN', 0) : { ...m, timer: false };
    case 'move': {
      if (ev.stroke || m.state === 'DOCKED' || m.state === 'KEYED') return m;
      const { y, h } = ev;
      if (m.state === 'SHOWN') {
        if (y <= h + 5) return set(m, 'SHOWN', 1);
        return ev.popup ? set(m, 'SHOWN', 1, true) : set(m, 'HIDDEN', 0);
      }
      if (y < SHOW_Y) return set(m, 'SHOWN', 1);
      if (y < PEEK_Y) return set(m, 'PEEK', 1 - (y - SHOW_Y) / (PEEK_Y - SHOW_Y));
      return set(m, 'HIDDEN', 0);
    }
  }
}

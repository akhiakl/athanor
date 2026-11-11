// Session recording preferences (spec 3.3 `session.*`): shared by the editor's controller and the Settings page.
export const INTERVALS = [10, 30, 60, 120, 300] as const;
export const KEY = 'athanor.session';
export const PREFIX_MAX = 40;

export interface SessionPrefs { intervalSec: number; autoClear: boolean; prefix: string }
export const SESSION_DEFAULTS: SessionPrefs = { intervalSec: 60, autoClear: false, prefix: 'session-' };

/** A prefix is a page-name start: printable, no path characters, bounded. */
export const cleanPrefix = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, PREFIX_MAX);

export function loadSessionPrefs(storage: Pick<Storage, 'getItem'> | null = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })()): SessionPrefs {
  try {
    const p = JSON.parse(storage?.getItem(KEY) ?? '{}') as Partial<SessionPrefs>;
    return {
      intervalSec: INTERVALS.includes(p.intervalSec as never) ? (p.intervalSec as number) : SESSION_DEFAULTS.intervalSec,
      autoClear: p.autoClear === true,
      prefix: typeof p.prefix === 'string' ? cleanPrefix(p.prefix) : SESSION_DEFAULTS.prefix,
    };
  } catch {
    return SESSION_DEFAULTS; // blocked storage or a damaged value
  }
}

export function saveSessionPrefs(p: SessionPrefs): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, prefix: cleanPrefix(p.prefix) }));
    return true;
  } catch {
    return false; // the setting just is not remembered
  }
}

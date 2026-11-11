// Preferences, spec 3.3: one JSON document, validated field by field so a corrupt or old value falls back to its default instead of
// breaking the app. Read and written inside try/catch (private windows, blocked storage); other tabs are followed through `storage`.
// shortcut: stored under `athanor.v1.prefs` rather than the spec's `alchemy.v1.` prefix, and the per-module params and swatches still
// live in their own keys / memory; they fold into this document as their settings screens need it.
import { signal } from '@preact/signals';
import type { Binding, Overrides } from './keymap';

export const KEY = 'athanor.v1.prefs';
export const SCHEMA = 1;

export type Theme = 'system' | 'light' | 'dark';
export type Motion = 'system' | 'reduce';
export type HudMode = 'floating' | 'proximity';
export const INPUT_RATES = [60, 120, 240] as const;

export interface Prefs {
  schema: number;
  lineSmoothing: boolean;
  syntheticPressure: boolean;
  /** Resampling rate for rate-sensitive modules (4.2). Applies when the editor opens. */
  inputRateHz: (typeof INPUT_RATES)[number];
  hudMode: HudMode;
  theme: Theme;
  motion: Motion;
  /** Module ids hidden from the menus. */
  disabledModules: string[];
  keys: Overrides;
}

export const DEFAULTS: Prefs = {
  schema: SCHEMA, lineSmoothing: true, syntheticPressure: true, inputRateHz: 120, hudMode: 'floating', theme: 'system', motion: 'system', disabledModules: [], keys: {},
};

const oneOf = <T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

function validBinding(v: unknown): Binding | null {
  const o = v as Partial<Binding> | null;
  if (!o || typeof o.code !== 'string' || o.code.length === 0 || o.code.length > 24 || !/^[A-Za-z0-9]+$/.test(o.code)) return null;
  return { code: o.code, mod: o.mod === true, shift: o.shift === true, alt: o.alt === true };
}

/** Any value in, a complete valid Prefs out. Unknown keys are dropped; wrong types and out-of-range values take the default. */
export function validate(raw: unknown): Prefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const keys: Overrides = {};
  if (o.keys && typeof o.keys === 'object') {
    for (const [id, b] of Object.entries(o.keys as Record<string, unknown>)) {
      const vb = validBinding(b);
      if (vb && /^[A-Za-z]{1,24}$/.test(id)) keys[id] = vb;
    }
  }
  const disabled = Array.isArray(o.disabledModules) ? o.disabledModules.filter((m): m is string => typeof m === 'string' && /^[a-z]+\.[A-Za-z]+$/.test(m)) : [];
  return {
    schema: SCHEMA,
    lineSmoothing: bool(o.lineSmoothing, DEFAULTS.lineSmoothing),
    syntheticPressure: bool(o.syntheticPressure, DEFAULTS.syntheticPressure),
    inputRateHz: oneOf(o.inputRateHz, INPUT_RATES, DEFAULTS.inputRateHz),
    hudMode: oneOf(o.hudMode, ['floating', 'proximity'] as const, DEFAULTS.hudMode),
    theme: oneOf(o.theme, ['system', 'light', 'dark'] as const, DEFAULTS.theme),
    motion: oneOf(o.motion, ['system', 'reduce'] as const, DEFAULTS.motion),
    disabledModules: [...new Set(disabled)],
    keys,
  };
}

export function loadPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Prefs {
  try {
    const text = storage?.getItem(KEY);
    return validate(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULTS, disabledModules: [], keys: {} }; // blocked storage or damaged JSON
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A reactive prefs store. `update` validates and saves; changes from another tab arrive through the storage event. */
export function createPrefs(storage: Storage | null = safeStorage(), win: Pick<Window, 'addEventListener'> | null = typeof window === 'undefined' ? null : window) {
  const prefs = signal<Prefs>(loadPrefs(storage));
  const write = (p: Prefs): boolean => {
    try {
      storage?.setItem(KEY, JSON.stringify(p));
      return true;
    } catch {
      return false; // the change still applies for this page; it just is not remembered
    }
  };
  win?.addEventListener('storage', (e) => {
    if ((e as StorageEvent).key === KEY) prefs.value = loadPrefs(storage);
  });
  return {
    prefs,
    update(patch: Partial<Prefs>): boolean {
      prefs.value = validate({ ...prefs.value, ...patch });
      return write(prefs.value);
    },
    reset(): boolean {
      prefs.value = validate(null);
      return write(prefs.value);
    },
  };
}
export type PrefsStore = ReturnType<typeof createPrefs>;

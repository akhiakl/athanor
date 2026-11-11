import { describe, expect, it } from 'vitest';
import { DEFAULTS, KEY, createPrefs, loadPrefs, validate } from './prefs';

const mem = () => {
  const m = new Map<string, string>();
  return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as unknown as Storage };
};

describe('prefs validation', () => {
  it('fills in every default for nothing, garbage or the wrong type', () => {
    expect(validate(null)).toEqual(DEFAULTS);
    expect(validate('x')).toEqual(DEFAULTS);
    expect(validate([1, 2])).toEqual(DEFAULTS);
    expect(validate({ lineSmoothing: 'yes', inputRateHz: 100, theme: 'neon', hudMode: 3, motion: null })).toEqual(DEFAULTS);
  });
  it('keeps valid values and drops unknown keys', () => {
    const p = validate({ lineSmoothing: false, inputRateHz: 240, theme: 'dark', hudMode: 'proximity', motion: 'reduce', syntheticPressure: false, evil: 1 });
    expect(p).toMatchObject({ lineSmoothing: false, inputRateHz: 240, theme: 'dark', hudMode: 'proximity', motion: 'reduce', syntheticPressure: false });
    expect('evil' in p).toBe(false);
  });
  it('accepts only well-formed key overrides', () => {
    const p = validate({ keys: { style: { code: 'KeyF', mod: true }, bad1: { code: '' }, bad2: { code: 'a b' }, bad3: 'x', 'x y': { code: 'KeyA' } } });
    expect(p.keys).toEqual({ style: { code: 'KeyF', mod: true, shift: false, alt: false } });
  });
  it('accepts only module ids and de-duplicates them', () => {
    expect(validate({ disabledModules: ['create.scrawlShapes', 'create.scrawlShapes', 'affect.mirror', 5, '../x', 'a b'] }).disabledModules).toEqual(['create.scrawlShapes', 'affect.mirror']);
  });
});

describe('prefs store', () => {
  it('loads defaults from empty or damaged storage and never throws', () => {
    const { s, m } = mem();
    expect(loadPrefs(s)).toEqual(DEFAULTS);
    m.set(KEY, '{not json');
    expect(loadPrefs(s)).toEqual(DEFAULTS);
    expect(loadPrefs({ getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULTS);
    expect(loadPrefs(null)).toEqual(DEFAULTS);
  });
  it('update validates, saves and survives a reload', () => {
    const { s } = mem();
    const a = createPrefs(s, null);
    expect(a.update({ theme: 'dark', inputRateHz: 60 })).toBe(true);
    expect(a.update({ theme: 'bogus' as never })).toBe(true);
    expect(a.prefs.value.theme).toBe('system'); // the bad value fell back, the rest stayed
    expect(a.prefs.value.inputRateHz).toBe(60);
    expect(createPrefs(s, null).prefs.value.inputRateHz).toBe(60);
  });
  it('still applies a change when storage refuses the write', () => {
    const s = { getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } } as unknown as Storage;
    const p = createPrefs(s, null);
    expect(p.update({ lineSmoothing: false })).toBe(false);
    expect(p.prefs.value.lineSmoothing).toBe(false);
  });
  it('follows another tab through the storage event', () => {
    const { s, m } = mem();
    let handler: ((e: StorageEvent) => void) | undefined;
    const p = createPrefs(s, { addEventListener: (_t: string, h: unknown) => { handler = h as (e: StorageEvent) => void; } } as never);
    m.set(KEY, JSON.stringify({ theme: 'light' }));
    handler!({ key: 'something-else' } as StorageEvent);
    expect(p.prefs.value.theme).toBe('system');
    handler!({ key: KEY } as StorageEvent);
    expect(p.prefs.value.theme).toBe('light');
  });
  it('reset goes back to defaults', () => {
    const { s } = mem();
    const p = createPrefs(s, null);
    p.update({ theme: 'dark', keys: { style: { code: 'KeyF', mod: false, shift: false, alt: false } } });
    p.reset();
    expect(p.prefs.value).toEqual(DEFAULTS);
    expect(createPrefs(s, null).prefs.value).toEqual(DEFAULTS);
  });
});

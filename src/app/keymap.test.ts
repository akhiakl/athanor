import { describe, expect, it } from 'vitest';
import { ACTIONS, bindingFromEvent, buildKeymap, defaultKeymap, formatBinding, keyName, keyOf, rebind, resetBinding, type Binding } from './keymap';

const none = { mod: false, shift: false, alt: false };
const b = (code: string, m: Partial<typeof none> = {}): Binding => ({ code, ...none, ...m });

describe('default key map', () => {
  it('gives every action at least one binding, and no two actions the same one', () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      expect(a.defaults.length).toBeGreaterThan(0);
      for (const d of a.defaults) {
        expect(seen.get(keyOf(d)), `${a.id} clashes with ${seen.get(keyOf(d))}`).toBeUndefined();
        seen.set(keyOf(d), a.id);
      }
    }
  });
  it('never lets an action collide with the digit and numpad families', () => {
    for (const a of ACTIONS) for (const d of a.defaults) {
      const hit = defaultKeymap.match(d.code, d);
      expect(hit).toEqual(a.action);
    }
  });
  it('lists every action once with a unique id', () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
  });
});

describe('overrides', () => {
  it('a rebound action answers its new key and no longer its old one', () => {
    const r = rebind({}, 'style', b('KeyF'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const km = buildKeymap(r.overrides);
    expect(km.match('KeyF', none)).toEqual({ t: 'style' });
    expect(km.match('KeyS', none)).toBeNull();
    expect(km.bindingsOf('style')).toEqual([b('KeyF')]);
    expect(defaultKeymap.match('KeyS', none)).toEqual({ t: 'style' }); // the default map is untouched
  });
  it('rebinding replaces every default of an action (redo has two)', () => {
    const r = rebind({}, 'redo', b('KeyU', { mod: true }));
    if (!r.ok) throw new Error(r.reason);
    const km = buildKeymap(r.overrides);
    expect(km.match('KeyY', { ...none, mod: true })).toBeNull();
    expect(km.match('KeyZ', { mod: true, shift: true, alt: false })).toBeNull();
    expect(km.match('KeyU', { ...none, mod: true })).toEqual({ t: 'redo' });
  });
  it('a key freed by a rebind can be taken by another action', () => {
    const r1 = rebind({}, 'style', b('KeyF'));
    if (!r1.ok) throw new Error(r1.reason);
    expect(rebind(r1.overrides, 'cursor', b('KeyS')).ok).toBe(true);
  });
  it('reset removes one override', () => {
    const r = rebind({}, 'style', b('KeyF'));
    if (!r.ok) throw new Error(r.reason);
    expect(resetBinding(r.overrides, 'style')).toEqual({});
    expect(resetBinding({}, 'style')).toEqual({});
  });
});

describe('rebind validation', () => {
  it('rejects a lone modifier', () => {
    for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'CapsLock']) {
      const r = rebind({}, 'style', b(code));
      expect(r).toMatchObject({ ok: false });
      expect(!r.ok && r.reason).toMatch(/modifier/);
    }
  });
  it('rejects reserved keys, the number shortcuts, and keys another action uses', () => {
    expect(rebind({}, 'style', b('Escape'))).toMatchObject({ ok: false });
    expect(rebind({}, 'style', b('Digit3'))).toMatchObject({ ok: false });
    expect(rebind({}, 'style', b('Digit3', { mod: true }))).toMatchObject({ ok: false });
    expect(rebind({}, 'style', b('Numpad4'))).toMatchObject({ ok: false });
    const dup = rebind({}, 'style', b('KeyH'));
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.reason).toContain('Hide or show the cursor');
    const moved = rebind({}, 'cursor', b('KeyF'));
    if (!moved.ok) throw new Error(moved.reason);
    expect(rebind(moved.overrides, 'style', b('KeyF')).ok).toBe(false); // a key taken through an override counts too
  });
  it('accepts the action\'s own current binding and unknown ids fail cleanly', () => {
    expect(rebind({}, 'style', b('KeyS')).ok).toBe(true);
    expect(rebind({}, 'nope', b('KeyF'))).toMatchObject({ ok: false });
  });
  it('treats modifiers as part of the binding', () => {
    expect(rebind({}, 'style', b('KeyS', { shift: true })).ok).toBe(true); // Shift+S is free; plain S was this action's
    expect(rebind({}, 'style', b('KeyX', { shift: true })).ok).toBe(false); // swap colours
  });
});

describe('labels and capture', () => {
  it('formats bindings for both platforms', () => {
    expect(formatBinding(b('KeyZ', { mod: true, shift: true }))).toBe('Ctrl+Shift+Z');
    expect(formatBinding(b('KeyZ', { mod: true, shift: true }), true)).toBe('⌘⇧Z');
    expect(formatBinding(b('KeyN', { alt: true }))).toBe('Alt+N');
    expect(formatBinding(b('PageDown'))).toBe('Page Down');
    expect([keyName('Digit4'), keyName('BracketLeft'), keyName('Numpad7'), keyName('F5'), keyName('Weird')]).toEqual(['4', '[', 'Num 7', 'F5', 'Weird']);
  });
  it('captures a binding from a keydown and ignores bare modifiers', () => {
    const e = { code: 'KeyK', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(bindingFromEvent(e, false)).toEqual(b('KeyK', { mod: true }));
    expect(bindingFromEvent(e, true)).toEqual(b('KeyK')); // on a Mac Mod is Cmd, not Ctrl
    expect(bindingFromEvent({ ...e, code: 'ShiftLeft', shiftKey: true }, false)).toBeNull();
    expect(bindingFromEvent({ ...e, code: '' }, false)).toBeNull();
  });
});

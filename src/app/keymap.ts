// The hotkey table of spec 1.3.1 as data, so it can be listed, rebound and validated (spec 3.3 `keys`, Settings > Shortcuts).
// The digit families (create 1..20, affects Mod+1..20) and the numpad swatch keys are fixed: they are patterns, not single bindings.
import type { Action } from './shortcuts';

export interface Mods { mod: boolean; shift: boolean; alt: boolean }
export interface Binding extends Mods { code: string }
/** Overrides persisted in prefs: action id -> its one replacement binding. */
export type Overrides = Record<string, Binding>;

export interface ActionDef {
  id: string;
  label: string;
  group: 'Interface' | 'Drawing' | 'Colour' | 'Pages' | 'Session';
  action: Action;
  /** Defaults; a rebind replaces all of them with one. */
  defaults: Binding[];
}

const k = (code: string, m: Partial<Mods> = {}): Binding => ({ code, mod: m.mod ?? false, shift: m.shift ?? false, alt: m.alt ?? false });

export const ACTIONS: readonly ActionDef[] = [
  { id: 'hudFlip', label: 'Swatches panel (or the colour bar)', group: 'Interface', action: { t: 'hudFlip' }, defaults: [k('Tab')] },
  { id: 'hudToggle', label: 'Show or hide the toolbar', group: 'Interface', action: { t: 'hudToggle' }, defaults: [k('Space')] },
  { id: 'collapse', label: 'Collapse the toolbar to a button', group: 'Interface', action: { t: 'collapse' }, defaults: [k('Period', { mod: true })] },
  { id: 'cursor', label: 'Hide or show the cursor', group: 'Interface', action: { t: 'cursor' }, defaults: [k('KeyH')] },
  { id: 'pagesPanel', label: 'Pages panel', group: 'Pages', action: { t: 'pagesPanel' }, defaults: [k('Backslash', { mod: true })] },
  { id: 'export', label: 'Export', group: 'Pages', action: { t: 'export' }, defaults: [k('KeyE', { mod: true })] },
  { id: 'copy', label: 'Copy the canvas as an image', group: 'Pages', action: { t: 'copy' }, defaults: [k('KeyC', { mod: true })] },
  { id: 'pageNext', label: 'Next page', group: 'Pages', action: { t: 'pageNext' }, defaults: [k('PageDown')] },
  { id: 'pagePrev', label: 'Previous page', group: 'Pages', action: { t: 'pagePrev' }, defaults: [k('PageUp')] },
  { id: 'pageNew', label: 'New page', group: 'Pages', action: { t: 'pageNew' }, defaults: [k('KeyN', { alt: true })] },
  { id: 'record', label: 'Start or stop recording', group: 'Session', action: { t: 'record' }, defaults: [k('KeyR', { alt: true })] },
  { id: 'undo', label: 'Undo', group: 'Drawing', action: { t: 'undo' }, defaults: [k('KeyZ', { mod: true })] },
  { id: 'redo', label: 'Redo', group: 'Drawing', action: { t: 'redo' }, defaults: [k('KeyZ', { mod: true, shift: true }), k('KeyY', { mod: true })] },
  { id: 'clear', label: 'Clear the page', group: 'Drawing', action: { t: 'clear' }, defaults: [k('Backspace', { mod: true })] },
  { id: 'style', label: 'Stroke or fill', group: 'Drawing', action: { t: 'style' }, defaults: [k('KeyS')] },
  { id: 'widthDown', label: 'Thinner line', group: 'Drawing', action: { t: 'width', d: -1 }, defaults: [k('BracketLeft')] },
  { id: 'widthUp', label: 'Thicker line', group: 'Drawing', action: { t: 'width', d: 1 }, defaults: [k('BracketRight')] },
  { id: 'colorToBg', label: 'Switch to the background colour and back', group: 'Colour', action: { t: 'colorToBg' }, defaults: [k('KeyX')] },
  { id: 'swapColors', label: 'Swap primary and secondary colour', group: 'Colour', action: { t: 'swapColors' }, defaults: [k('KeyX', { shift: true })] },
  { id: 'alphaUp', label: 'More opaque', group: 'Colour', action: { t: 'alpha', d: 10 }, defaults: [k('NumpadMultiply'), k('Equal', { alt: true })] },
  { id: 'alphaDown', label: 'More transparent', group: 'Colour', action: { t: 'alpha', d: -10 }, defaults: [k('NumpadDivide'), k('Minus', { alt: true })] },
  { id: 'swatchNext', label: 'Next swatch', group: 'Colour', action: { t: 'swatchStep', d: 1 }, defaults: [k('NumpadAdd')] },
  { id: 'swatchPrev', label: 'Previous swatch', group: 'Colour', action: { t: 'swatchStep', d: -1 }, defaults: [k('NumpadSubtract')] },
];

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];

/** The fixed families, as [binding, action]. */
function fixed(): [Binding, Action][] {
  const out: [Binding, Action][] = [];
  DIGITS.forEach((code, i) => {
    out.push([k(code), { t: 'create', i }], [k(code, { alt: true }), { t: 'create', i: i + 10 }]);
    out.push([k(code, { mod: true }), { t: 'affect', i }], [k(code, { mod: true, shift: true }), { t: 'affect', i: i + 10 }]);
  });
  for (let n = 0; n <= 9; n++) out.push([k(`Numpad${n}`), { t: 'swatchPick', i: n }]);
  return out;
}

export const keyOf = (b: Mods & { code: string }): string => `${b.mod ? 'M' : ''}${b.shift ? 'S' : ''}${b.alt ? 'A' : ''}+${b.code}`;

/** Keys that must stay with the browser or the page, whatever the user asks. */
const RESERVED = new Set(['Escape', 'Enter', 'NumpadEnter']);
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|NumLock|ScrollLock|Fn)$/;

export interface Keymap {
  match(code: string, mods: Mods): Action | null;
  /** Effective bindings of an action (its override, or its defaults). */
  bindingsOf(id: string): Binding[];
}

export function buildKeymap(overrides: Overrides = {}): Keymap {
  const map = new Map<string, Action>();
  const effective = new Map<string, Binding[]>();
  for (const [b, a] of fixed()) map.set(keyOf(b), a);
  for (const def of ACTIONS) {
    const list = overrides[def.id] ? [overrides[def.id]] : def.defaults;
    effective.set(def.id, list);
    for (const b of list) map.set(keyOf(b), def.action);
  }
  return {
    match: (code, m) => map.get(keyOf({ ...m, code })) ?? null,
    bindingsOf: (id) => effective.get(id) ?? [],
  };
}

export const defaultKeymap = buildKeymap();

export type RebindResult = { ok: true; overrides: Overrides } | { ok: false; reason: string };

/** Validates a new binding for `id` the way the spec's editor does: no lone modifier, no reserved key, no duplicate. */
export function rebind(overrides: Overrides, id: string, b: Binding): RebindResult {
  if (!ACTIONS.some((a) => a.id === id)) return { ok: false, reason: 'Unknown action.' };
  if (MODIFIER_CODES.test(b.code)) return { ok: false, reason: 'Add a key: a modifier alone cannot be a shortcut.' };
  if (RESERVED.has(b.code)) return { ok: false, reason: `${formatBinding(b)} is reserved.` };
  const next = { ...overrides, [id]: b };
  const wanted = keyOf(b);
  for (const [fb] of fixed()) if (keyOf(fb) === wanted) return { ok: false, reason: `${formatBinding(b)} is used for the number shortcuts.` };
  for (const def of ACTIONS) {
    if (def.id === id) continue;
    const list = next[def.id] ? [next[def.id]] : def.defaults;
    if (list.some((x) => keyOf(x) === wanted)) return { ok: false, reason: `${formatBinding(b)} is already used for "${def.label}".` };
  }
  return { ok: true, overrides: next };
}

export function resetBinding(overrides: Overrides, id: string): Overrides {
  const { [id]: _gone, ...rest } = overrides;
  return rest;
}

const NAMES: Record<string, string> = {
  Backspace: 'Backspace', Tab: 'Tab', Space: 'Space', Period: '.', Comma: ',', Backslash: '\\', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', PageUp: 'Page Up', PageDown: 'Page Down',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Delete: 'Delete', Home: 'Home', End: 'End',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
};
export function keyName(code: string): string {
  if (NAMES[code]) return NAMES[code];
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m) return m[1];
  const f = /^F(\d{1,2})$/.exec(code);
  if (f) return code;
  const n = /^Numpad(\d)$/.exec(code);
  return n ? `Num ${n[1]}` : code;
}

/** "Ctrl+Shift+Z", or "⌘⇧Z" on Apple platforms. */
export function formatBinding(b: Binding, mac = false): string {
  const key = keyName(b.code);
  if (mac) return `${b.mod ? '⌘' : ''}${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${key}`;
  return [b.mod && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', key].filter(Boolean).join('+');
}

/** A binding from a keydown event, or null while only modifiers are held. */
export function bindingFromEvent(e: { code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): Binding | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  return { code: e.code, mod: mac ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
}

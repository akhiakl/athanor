// Shortcut labels for the current platform: Mod is Cmd on Apple platforms, Ctrl elsewhere (spec 1.3.1).
import { defaultKeymap, formatBinding, type Keymap } from '../app/keymap';
import { isMac } from '../app/shortcuts';

const mac = isMac();
const digit = (i: number): string => String((i + 1) % 10);

export const modLabel = mac ? '⌘' : 'Ctrl+';
export const altLabel = mac ? '⌥' : 'Alt+';
export const shiftLabel = mac ? '⇧' : 'Shift+';

/** Digit hint for item `i` of a menu whose first ten use `base` and next ten add `extra`. */
export const createHint = (i: number): string => (i < 10 ? digit(i) : `${altLabel}${digit(i - 10)}`);
export const affectHint = (i: number): string => (i < 10 ? `${modLabel}${digit(i)}` : `${modLabel}${shiftLabel}${digit(i - 10)}`);

let current: Keymap = defaultKeymap;
/** The editor tells the hints which key map is live, so tooltips follow rebinding. */
export const setHintKeymap = (k: Keymap): void => { current = k; };
/** "Ctrl+Z" for an action's first binding, or '' when it has none. */
export const shortcutLabel = (actionId: string): string => {
  const b = current.bindingsOf(actionId)[0];
  return b ? formatBinding(b, mac) : '';
};
/** "Undo (Ctrl+Z)" */
export const withKey = (label: string, actionId: string): string => {
  const k = shortcutLabel(actionId);
  return k ? `${label} (${k})` : label;
};

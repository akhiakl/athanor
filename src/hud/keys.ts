// Shortcut labels for the current platform: Mod is Cmd on Apple platforms, Ctrl elsewhere (spec 1.3.1).
import { isMac } from '../app/shortcuts';

const mac = isMac();
const digit = (i: number): string => String((i + 1) % 10);

export const modLabel = mac ? '⌘' : 'Ctrl+';
export const altLabel = mac ? '⌥' : 'Alt+';
export const shiftLabel = mac ? '⇧' : 'Shift+';

/** Digit hint for item `i` of a menu whose first ten use `base` and next ten add `extra`. */
export const createHint = (i: number): string => (i < 10 ? digit(i) : `${altLabel}${digit(i - 10)}`);
export const affectHint = (i: number): string => (i < 10 ? `${modLabel}${digit(i)}` : `${modLabel}${shiftLabel}${digit(i - 10)}`);

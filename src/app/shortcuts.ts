// Hotkey map, spec 1.3.1, matched on KeyboardEvent.code. Pure: the caller supplies the modifier state and runs the action.
// The table itself lives in keymap.ts. shortcut: only actions whose feature exists are bound; zoom and the eyedropper join with theirs.
export type Action =
  | { t: 'hudFlip' } // Tab: show the HUD keyed on, flip main bar <-> swatch bar
  | { t: 'hudToggle' } // Space
  | { t: 'cursor' } // H
  | { t: 'style' } // S
  | { t: 'width'; d: number } // [ ]
  | { t: 'create'; i: number }
  | { t: 'affect'; i: number }
  | { t: 'alpha'; d: number }
  | { t: 'swatchStep'; d: number }
  | { t: 'swatchPick'; i: number }
  | { t: 'colorToBg' } // X
  | { t: 'swapColors' } // Shift+X
  | { t: 'clear' }
  | { t: 'collapse' } // Mod+Period: floating toolbar to a dot and back
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'export' } // Mod+E: export dialog
  | { t: 'copy' } // Mod+C: copy the canvas as an image
  | { t: 'pageNext' } // PageDown
  | { t: 'pagePrev' } // PageUp
  | { t: 'pageNew' } // Alt+N
  | { t: 'pagesPanel' } // Mod+Backslash
  | { t: 'record' }; // Alt+R: session recording on or off

import { defaultKeymap, type Keymap, type Mods } from './keymap';
export type { Mods };

export const isMac = (): boolean => /Mac|iP/.test(globalThis.navigator?.platform ?? '');

/** Matches against the default key map, or against `keymap` (the user's overrides applied). */
export const matchShortcut = (code: string, mods: Mods, keymap: Keymap = defaultKeymap): Action | null => keymap.match(code, mods);

const TEXT_INPUT = /^(text|number|search|tel|url|email|password)$/;

/**
 * True when the event target takes typed text (or arrow keys for a list), so hotkeys must stay out of the way.
 * Checkboxes, radios, buttons and range sliders are not: after using one, focus stays on it and shortcuts must keep working.
 */
export function isTextEntry(t: { tagName?: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && TEXT_INPUT.test(t.type ?? 'text');
}

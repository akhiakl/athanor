// Hotkey map, spec 1.3.1, matched on KeyboardEvent.code. Pure: the caller supplies the modifier state and runs the action.
// shortcut: only actions whose feature exists are bound; export, undo, pages, session, zoom and eyedropper join with their features.
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
  | { t: 'copy' }; // Mod+C: copy the canvas as an image

export interface Mods { mod: boolean; shift: boolean; alt: boolean }

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];

export const isMac = (): boolean => /Mac|iP/.test(globalThis.navigator?.platform ?? '');

export function matchShortcut(code: string, { mod, shift, alt }: Mods): Action | null {
  const d = DIGITS.indexOf(code);
  if (d >= 0) {
    if (mod && !alt) return { t: 'affect', i: d + (shift ? 10 : 0) };
    if (!mod && !shift) return { t: 'create', i: d + (alt ? 10 : 0) };
    return null;
  }
  const n = /^Numpad(\d)$/.exec(code);
  if (n && !mod && !shift && !alt) return { t: 'swatchPick', i: Number(n[1]) };
  if (mod) {
    if (alt) return null;
    switch (code) {
      case 'Backspace': return shift ? null : { t: 'clear' };
      case 'Period': return shift ? null : { t: 'collapse' };
      case 'KeyZ': return shift ? { t: 'redo' } : { t: 'undo' };
      case 'KeyY': return shift ? null : { t: 'redo' }; // Windows and Linux redo
      case 'KeyE': return shift ? null : { t: 'export' };
      case 'KeyC': return shift ? null : { t: 'copy' };
      default: return null;
    }
  }
  if (alt) return code === 'Equal' ? { t: 'alpha', d: 10 } : code === 'Minus' ? { t: 'alpha', d: -10 } : null;
  if (shift) return code === 'KeyX' ? { t: 'swapColors' } : null;
  switch (code) {
    case 'Tab': return { t: 'hudFlip' };
    case 'Space': return { t: 'hudToggle' };
    case 'KeyH': return { t: 'cursor' };
    case 'KeyS': return { t: 'style' };
    case 'KeyX': return { t: 'colorToBg' };
    case 'BracketLeft': return { t: 'width', d: -1 };
    case 'BracketRight': return { t: 'width', d: 1 };
    case 'NumpadMultiply': return { t: 'alpha', d: 10 };
    case 'NumpadDivide': return { t: 'alpha', d: -10 };
    case 'NumpadAdd': return { t: 'swatchStep', d: 1 };
    case 'NumpadSubtract': return { t: 'swatchStep', d: -1 };
    default: return null;
  }
}

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

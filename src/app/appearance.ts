// Applies the look prefs to the document: theme (colour-scheme) and reduced motion. Runs on every route, before anything renders.
import { effect } from '@preact/signals';
import { prefsStore } from './prefsStore';
import type { Prefs } from './prefs';

export function applyAppearance(p: Pick<Prefs, 'theme' | 'motion'>, root: HTMLElement = document.documentElement): void {
  if (p.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = p.theme;
  if (p.motion === 'reduce') root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
}

/** Applies now and again whenever prefs change (including from another tab). */
export function followAppearance(): () => void {
  return effect(() => applyAppearance(prefsStore.prefs.value));
}

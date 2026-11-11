// Applies a template preset (spec 8.3.1) the first time its file opens: module, parameter values, affects, session prefs.
import type { Preset } from '../doc/docs';
import { createApp, createMenu, type App } from './app';
import type { Session } from './session';

export function applyPreset(p: Preset, app: App, session: Session): void {
  for (const [id, values] of Object.entries(p.values ?? {})) for (const [param, v] of Object.entries(values)) app.setValue(id, param, v); // values first, so affects are built with them
  if (p.create) {
    const i = createMenu.indexOf(p.create);
    if (i >= 0) app.selectCreate(i);
  }
  for (const id of p.affects ?? []) if (!app.affectsOn.value.has(id)) app.setAffect(id, true);
  if (p.session) {
    session.setInterval(p.session.intervalSec);
    session.setAutoClear(p.session.autoClear);
    if (p.session.start) void session.start();
  }
}
export type { App };

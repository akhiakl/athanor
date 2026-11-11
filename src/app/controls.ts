// Per-module control specs, spec 6.2. Changing a control rebuilds the module from its params.
// shortcut: a rebuild resets module-internal state (e.g. Mirror's moved axis); live setters can replace it when that matters.
export interface ControlSpec {
  readonly param: string;
  readonly kind: 'slider' | 'stepper' | 'toggle';
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly def: number | boolean;
  /** Maps the displayed value to the module/affect parameter (spec "Bind" column). */
  readonly map?: (v: number) => number;
}
export interface ButtonSpec { readonly action: string; readonly label: string; readonly key?: string }
export interface ModuleUi {
  readonly id: string;
  readonly title: string;
  readonly controls: readonly ControlSpec[];
  readonly buttons?: readonly ButtonSpec[];
}

export type Params = Record<string, number | boolean>;

const slider = (param: string, label: string, min: number, max: number, def: number, map?: (v: number) => number): ControlSpec =>
  ({ param, kind: 'slider', label, min, max, step: 1, def, map });
const stepper = (param: string, label: string, min: number, max: number, def: number): ControlSpec =>
  ({ param, kind: 'stepper', label, min, max, step: 1, def });
const toggle = (param: string, label: string, def: boolean): ControlSpec => ({ param, kind: 'toggle', label, def });

export const moduleUi: Record<string, ModuleUi> = {
  'create.shapes': { id: 'create.shapes', title: 'Shapes', controls: [] },
  'create.speedShapes': { id: 'create.speedShapes', title: 'Speed', controls: [toggle('freeform', 'Curves', true), slider('multiplier', 'Speed', 0, 35, 15)] },
  'create.detachShapes': { id: 'create.detachShapes', title: 'Detach', controls: [slider('distance', 'Distance', 0, 300, 100)] },
  'create.pressureShapes': { id: 'create.pressureShapes', title: 'Pressure', controls: [stepper('amount', 'Pressure', 1, 200, 25)] },
  'create.scrawlShapes': {
    id: 'create.scrawlShapes', title: 'Scrawl',
    controls: [slider('flow', 'Flow', 1, 25, 10), slider('detail', 'Detail', 2, 50, 10), slider('noise', 'Noise', 1, 50, 10)],
  },
  'affect.displace': { id: 'affect.displace', title: 'Displace', controls: [slider('displacement', 'Displacement', 1, 15, 7)] },
  'affect.gradient': { id: 'affect.gradient', title: 'Gradient', controls: [] },
  'affect.mirror': {
    id: 'affect.mirror', title: 'Mirror',
    controls: [toggle('horizontal', 'Horizontal', true), toggle('vertical', 'Vertical', false)],
    buttons: [{ action: 'mirror.move', label: 'Move axis' }, { action: 'mirror.reset', label: 'Reset' }],
  },
  'affect.blindness': {
    id: 'affect.blindness', title: 'Blindness',
    controls: [toggle('autoReveal', 'Auto-reveal', true)],
    buttons: [{ action: 'blindness.reveal', label: 'Reveal', key: 'R' }],
  },
  'affect.colorSwitcher': {
    id: 'affect.colorSwitcher', title: 'Colour Switcher',
    controls: [slider('baseRange', 'Range', 0, 100, 50), toggle('constant', 'Constant', false)],
  },
  'affect.random': { id: 'affect.random', title: 'Random', controls: [slider('distortion', 'Distortion', 1, 100, 50)] },
  'affect.smooth': { id: 'affect.smooth', title: 'Smooth', controls: [toggle('repeat', 'Repeat', false)] },
  'affect.limit': { id: 'affect.limit', title: 'Limit', controls: [stepper('limit', 'Number', 1, 100, 10)] },
  'affect.repeat': {
    id: 'affect.repeat', title: 'Repeat',
    controls: [toggle('repeat', 'Repeat', true), slider('gap', 'Interval', 0, 100, 50, (v) => 2 * v + 50)],
  },
};

/** Displayed (raw) control values at their defaults. */
export function defaultValues(id: string): Params {
  const v: Params = {};
  for (const c of moduleUi[id]?.controls ?? []) v[c.param] = c.def;
  return v;
}

/** Raw control values -> module parameters (applies each spec's `map`). */
export function toParams(id: string, values: Params): Params {
  const p: Params = {};
  for (const c of moduleUi[id]?.controls ?? []) {
    const v = values[c.param] ?? c.def;
    p[c.param] = c.map && typeof v === 'number' ? c.map(v) : v;
  }
  return p;
}

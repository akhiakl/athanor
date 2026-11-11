// Templates, spec 8.3.1: an initial page size plus a module and affect preset, stored in the file and applied the first time it opens.
// shortcut: "Trace session" arrives with TraceShapes (step 7); until then it is not offered.
import type { Preset } from '../doc/docs';

export interface Template {
  id: string;
  name: string;
  description: string;
  preset?: Preset;
}

export const templates: readonly Template[] = [
  { id: 'blank', name: 'Blank', description: 'An empty page the size of your window.' },
  { id: 'blind', name: 'Blind warm-up', description: 'Draw without seeing it; the page appears when you lift the pen.', preset: { affects: ['affect.blindness'] } },
  { id: 'mandala', name: 'Mirror mandala', description: 'Mirrored across both axes.', preset: { affects: ['affect.mirror'], values: { 'affect.mirror': { horizontal: true, vertical: true } } } },
  { id: 'timed', name: 'Timed session', description: 'Snapshots every minute and clears the page.', preset: { session: { intervalSec: 60, autoClear: true, start: false } } },
];

export const templateById = (id: string): Template => templates.find((t) => t.id === id) ?? templates[0];

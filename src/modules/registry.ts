// Static create-module registry, spec 2.9. Order: Shapes 0, Speed 2, then alphabetical.
import type { AffectModule, CreateModule } from '../engine/engine';
import { blindness } from './affect/blindness';
import { colorSwitcher } from './affect/colorSwitcher';
import { displace } from './affect/displace';
import { gradient } from './affect/gradient';
import { mirror } from './affect/mirror';
import { detachShapes } from './create/detach';
import { pressureShapes } from './create/pressure';
import { scrawlShapes } from './create/scrawl';
import { shapes } from './create/shapes';
import { speedShapes } from './create/speed';

export interface ModuleDescriptor {
  readonly id: string;
  readonly kind: 'create';
  readonly order: number;
  make(): CreateModule;
}

export const createModules: readonly ModuleDescriptor[] = [
  { id: 'create.shapes', kind: 'create', order: 0, make: shapes },
  { id: 'create.speedShapes', kind: 'create', order: 2, make: speedShapes },
  { id: 'create.detachShapes', kind: 'create', order: 101, make: detachShapes },
  { id: 'create.pressureShapes', kind: 'create', order: 102, make: pressureShapes },
  { id: 'create.scrawlShapes', kind: 'create', order: 103, make: scrawlShapes },
];

export interface AffectDescriptor {
  readonly id: string;
  readonly kind: 'affect';
  readonly order: number;
  make(): AffectModule;
}

/** ACTIVE-domain affects, spec 2.9 order: Displace 0, Gradient 1, Mirror 2, Blindness 3, then ColorSwitcher. */
export const affectModules: readonly AffectDescriptor[] = [
  { id: 'affect.displace', kind: 'affect', order: 0, make: displace },
  { id: 'affect.gradient', kind: 'affect', order: 1, make: gradient },
  { id: 'affect.mirror', kind: 'affect', order: 2, make: mirror },
  { id: 'affect.blindness', kind: 'affect', order: 3, make: blindness },
  { id: 'affect.colorSwitcher', kind: 'affect', order: 101, make: colorSwitcher },
];
